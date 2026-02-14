import { cleanupExpiredRecords, createAlert, emitEvent, state } from "./store";
import { Channel } from "./types";
import { nowIso } from "./core";
import { createConversationMessage } from "./domain";
import { persistEntity } from "../database/persistence";
import {
  buildBookingReminderEmail,
  buildBookingReminderSms,
} from "./emailTemplates";

function processJob(jobId: string): void {
  const job = state.scheduledJobs.find((item) => item.id === jobId);
  if (!job) {
    return;
  }

  try {
    if (job.jobType === "booking.reminder") {
      const bookingId =
        typeof job.payload.bookingId === "string" ? job.payload.bookingId : "";
      const booking = state.bookings.find(
        (item) => item.id === bookingId && item.workspaceId === job.workspaceId,
      );
      if (booking && booking.status !== "cancelled" && booking.status !== "completed") {
        const contact = state.contacts.find(
          (item) => item.id === booking.contactId && item.workspaceId === booking.workspaceId,
        );
        if (contact) {
          const channel: Channel = contact.email ? "email" : "sms";
          const workspace = state.workspaces.find((item) => item.id === booking.workspaceId);
          const service = state.services.find((item) => item.id === booking.serviceId);
          const workspaceName = workspace?.name ?? "CareOps";
          const timeZone = workspace?.timezone || "UTC";
          const serviceName = service?.name ?? "Appointment";
          const durationMin =
            Number.isFinite(service?.durationMin) && Number(service?.durationMin) > 0
              ? Number(service?.durationMin)
              : 0;
          const reminderEmailContent =
            channel === "email"
              ? buildBookingReminderEmail({
                  firstName: contact.firstName,
                  workspaceName,
                  serviceName,
                  startsAt: booking.startsAt,
                  durationMin,
                  timeZone,
                })
              : null;
          createConversationMessage({
            workspaceId: booking.workspaceId,
            contactId: contact.id,
            channel,
            direction: "outbound",
            body:
              channel === "email"
                ? reminderEmailContent?.text ??
                  buildBookingReminderSms({
                    workspaceName,
                    startsAt: booking.startsAt,
                    timeZone,
                  })
                : buildBookingReminderSms({
                    workspaceName,
                    startsAt: booking.startsAt,
                    timeZone,
                  }),
            metadata: {
              source: "job.booking.reminder",
              ...(reminderEmailContent?.subject
                ? { subject: reminderEmailContent.subject }
                : {}),
              ...(reminderEmailContent ? { emailHtml: reminderEmailContent.html } : {}),
            },
          });
          emitEvent({
            workspaceId: booking.workspaceId,
            eventType: "booking.reminder_due",
            entityType: "booking",
            entityId: booking.id,
            payload: { startsAt: booking.startsAt },
          });
        }
      }
    }

    if (job.jobType === "form.overdue_check") {
      const formRequestId =
        typeof job.payload.formRequestId === "string" ? job.payload.formRequestId : "";
      const formRequest = state.formRequests.find(
        (item) => item.id === formRequestId && item.workspaceId === job.workspaceId,
      );
      if (
        formRequest &&
        formRequest.status === "pending" &&
        Date.now() >= new Date(formRequest.dueAt).getTime()
      ) {
        formRequest.status = "overdue";
        formRequest.updatedAt = nowIso();
        void persistEntity("formRequests", formRequest);
        createAlert({
          workspaceId: formRequest.workspaceId,
          type: "form.overdue",
          severity: "warning",
          message: `Form request ${formRequest.id} is overdue.`,
          link: `/forms/${formRequest.id}`,
        });
        emitEvent({
          workspaceId: formRequest.workspaceId,
          eventType: "form.overdue",
          entityType: "form_request",
          entityId: formRequest.id,
          payload: { dueAt: formRequest.dueAt },
        });
      }
    }

    job.status = "done";
    job.attempts += 1;
    job.updatedAt = nowIso();
    void persistEntity("scheduledJobs", job);
  } catch (error) {
    job.status = "failed";
    job.attempts += 1;
    job.lastError = error instanceof Error ? error.message : "Unknown job error";
    job.updatedAt = nowIso();
    void persistEntity("scheduledJobs", job);
    createAlert({
      workspaceId: job.workspaceId,
      type: "job.failed",
      severity: "critical",
      message: `Job ${job.jobType} failed: ${job.lastError}`,
    });
  }
}

function runWorkerTick(): void {
  cleanupExpiredRecords();

  const priorityWeight = (priority: "high" | "normal" | "low"): number => {
    if (priority === "high") {
      return 0;
    }
    if (priority === "normal") {
      return 1;
    }
    return 2;
  };

  const dueJobs = state.scheduledJobs
    .filter(
      (job) =>
        job.status === "queued" && new Date(job.runAt).getTime() <= new Date().getTime(),
    )
    .sort((a, b) => {
      const priorityDelta = priorityWeight(a.priority) - priorityWeight(b.priority);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return new Date(a.runAt).getTime() - new Date(b.runAt).getTime();
    })
    .slice(0, 10);

  for (const job of dueJobs) {
    job.status = "running";
    job.lockedAt = nowIso();
    job.lockOwner = "local-worker-1";
    job.updatedAt = nowIso();
    void persistEntity("scheduledJobs", job);
    processJob(job.id);
  }
}

export function startWorker(pollingMs = 30_000): NodeJS.Timeout {
  return setInterval(runWorkerTick, pollingMs);
}
