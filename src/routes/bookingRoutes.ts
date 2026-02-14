import { Router } from "express";
import { AuthenticatedRequest, requireAuth, requireWorkspace } from "../utils/auth";
import {
  createFormRequest,
  emitEvent,
  enqueueJob,
  findIdempotency,
  findOrCreateContact,
  saveIdempotency,
  state,
} from "../utils/store";
import { AvailabilityRule, Booking, BookingStatus, Channel } from "../utils/types";
import {
  addHours,
  addMinutes,
  createId,
  dateAtTimeInTimeZoneIso,
  nowIso,
  overlap,
  sha256,
  toDateKeyInTimeZone,
  weekdayInTimeZone,
} from "../utils/core";
import {
  applyInventoryOnBookingCompleted,
  createConversationMessage,
  isBookingOverlapping,
  parseBookingStatus,
} from "../utils/domain";
import {
  deleteBookingCalendarEventIfConnected,
  upsertBookingCalendarEventIfConnected,
} from "../utils/googleIntegration";
import {
  getOptionalString,
  getString,
  getWorkspaceById,
  requireIdempotencyKey,
} from "../utils/http";
import { persistEntity } from "../database/persistence";
import {
  findSubmissionValueByFieldType,
  findSubmissionValueByKeyHints,
  findUnexpectedObjectKeys,
  getWorkspacePublicFlowConfig,
  validatePublicFieldSubmission,
} from "../utils/publicFlowConfig";
import {
  buildBookingConfirmationEmail,
  buildBookingConfirmationSms,
} from "../utils/emailTemplates";

type AvailabilityRuleType = "weekly" | "date_override" | "date_block";

interface AvailabilityWindow {
  startIso: string;
  endIso: string;
  stepMin: number;
}

interface ResolvedAvailability {
  windows: AvailabilityWindow[];
  blockedWindows: Array<{ startIso: string; endIso: string }>;
  closedAllDay: boolean;
}

function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return { firstName: "Guest", lastName: "Lead" };
  }
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "Lead" };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function getFrontendBaseUrl(): string {
  const configured = process.env.FRONTEND_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  return "http://localhost:3000";
}

function resolveRuleType(rule: AvailabilityRule): AvailabilityRuleType {
  if (
    rule.ruleType === "weekly" ||
    rule.ruleType === "date_override" ||
    rule.ruleType === "date_block"
  ) {
    return rule.ruleType;
  }
  return "weekly";
}

function toAvailabilityWindow(
  dateKey: string,
  timeZone: string,
  rule: AvailabilityRule,
  defaultStepMin: number,
): AvailabilityWindow | null {
  const startTime = typeof rule.startTime === "string" ? rule.startTime : "";
  const endTime = typeof rule.endTime === "string" ? rule.endTime : "";
  if (!startTime || !endTime) {
    return null;
  }

  const startIso = dateAtTimeInTimeZoneIso(dateKey, startTime, timeZone);
  const endIso = dateAtTimeInTimeZoneIso(dateKey, endTime, timeZone);
  if (new Date(startIso) >= new Date(endIso)) {
    return null;
  }

  const configuredStep =
    Number.isFinite(rule.slotIntervalMin) && Number(rule.slotIntervalMin) > 0
      ? Number(rule.slotIntervalMin)
      : defaultStepMin;
  return {
    startIso,
    endIso,
    stepMin: Math.max(1, configuredStep),
  };
}

function resolveAvailabilityForDate(input: {
  workspaceId: string;
  serviceId: string;
  dateKey: string;
  weekday: number;
  timeZone: string;
  serviceDurationMin: number;
}): ResolvedAvailability {
  const weeklyWindows: AvailabilityWindow[] = [];
  const overrideWindows: AvailabilityWindow[] = [];
  const blockedWindows: Array<{ startIso: string; endIso: string }> = [];
  let closedAllDay = false;

  for (const rule of state.availabilityRules) {
    if (rule.workspaceId !== input.workspaceId || rule.serviceId !== input.serviceId) {
      continue;
    }

    const ruleType = resolveRuleType(rule);
    if (ruleType === "weekly") {
      if (rule.weekday !== input.weekday) {
        continue;
      }
      const defaultStep = input.serviceDurationMin + Math.max(0, Number(rule.bufferMin ?? 0));
      const window = toAvailabilityWindow(input.dateKey, input.timeZone, rule, defaultStep);
      if (window) {
        weeklyWindows.push(window);
      }
      continue;
    }

    if (rule.date !== input.dateKey) {
      continue;
    }

    if (ruleType === "date_override") {
      const defaultStep = input.serviceDurationMin + Math.max(0, Number(rule.bufferMin ?? 0));
      const window = toAvailabilityWindow(input.dateKey, input.timeZone, rule, defaultStep);
      if (window) {
        overrideWindows.push(window);
      }
      continue;
    }

    if (rule.isClosedAllDay) {
      closedAllDay = true;
      continue;
    }

    const blocked = toAvailabilityWindow(input.dateKey, input.timeZone, rule, 1);
    if (blocked) {
      blockedWindows.push({ startIso: blocked.startIso, endIso: blocked.endIso });
    }
  }

  return {
    windows: overrideWindows.length ? overrideWindows : weeklyWindows,
    blockedWindows,
    closedAllDay,
  };
}

function isBlockedByException(
  startsAt: string,
  endsAt: string,
  resolved: ResolvedAvailability,
): boolean {
  if (resolved.closedAllDay) {
    return true;
  }
  return resolved.blockedWindows.some((blocked) =>
    overlap(startsAt, endsAt, blocked.startIso, blocked.endIso),
  );
}

function isWithinAvailabilityRule(
  workspaceId: string,
  serviceId: string,
  startsAt: string,
  endsAt: string,
  timeZone: string,
  serviceDurationMin: number,
): boolean {
  const startDate = new Date(startsAt);
  if (Number.isNaN(startDate.getTime())) {
    return false;
  }
  const dateKey = toDateKeyInTimeZone(startsAt, timeZone);
  const weekday = weekdayInTimeZone(startsAt, timeZone);

  const resolved = resolveAvailabilityForDate({
    workspaceId,
    serviceId,
    dateKey,
    weekday,
    timeZone,
    serviceDurationMin,
  });
  if (!resolved.windows.length || resolved.closedAllDay) {
    return false;
  }

  return resolved.windows.some(
    (window) =>
      new Date(startsAt) >= new Date(window.startIso) &&
      new Date(endsAt) <= new Date(window.endIso) &&
      !isBlockedByException(startsAt, endsAt, resolved),
  );
}

export function createBookingRoutes(): Router {
  const router = Router();

  router.get("/public/:workspaceId/services", (req, res) => {
    const workspace = getWorkspaceById(req.params.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }

    const services = state.services.filter(
      (service) => service.workspaceId === workspace.id && service.isActive,
    );
    res.json({ data: services });
  });

  router.get("/public/:workspaceId/slots", (req, res) => {
    const workspace = getWorkspaceById(req.params.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }

    const serviceId = getString(req.query.serviceId);
    const date = getString(req.query.date);
    if (!serviceId || !date) {
      res.status(400).json({ error: "serviceId and date are required" });
      return;
    }

    const service = state.services.find(
      (item) => item.id === serviceId && item.workspaceId === workspace.id && item.isActive,
    );
    if (!service) {
      res.status(404).json({ error: "service not found" });
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "date must use YYYY-MM-DD" });
      return;
    }

    const timezone = workspace.timezone || "UTC";
    const anchor = dateAtTimeInTimeZoneIso(date, "12:00", timezone);
    const weekday = weekdayInTimeZone(anchor, timezone);
    const resolved = resolveAvailabilityForDate({
      workspaceId: workspace.id,
      serviceId: service.id,
      dateKey: date,
      weekday,
      timeZone: timezone,
      serviceDurationMin: service.durationMin,
    });

    const slots: Array<{ startsAt: string; endsAt: string }> = [];
    const seen = new Set<string>();
    if (!resolved.closedAllDay) {
      for (const window of resolved.windows) {
        let cursor = window.startIso;
        while (new Date(cursor) < new Date(window.endIso)) {
          const end = addMinutes(cursor, service.durationMin);
          if (new Date(end) > new Date(window.endIso)) {
            break;
          }
          if (
            !isBookingOverlapping(workspace.id, cursor, end) &&
            !isBlockedByException(cursor, end, resolved) &&
            !seen.has(cursor)
          ) {
            slots.push({ startsAt: cursor, endsAt: end });
            seen.add(cursor);
          }
          cursor = addMinutes(cursor, window.stepMin);
        }
      }
    }

    slots.sort(
      (left, right) =>
        new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime(),
    );

    res.json({ date, serviceId: service.id, timezone, slots });
  });

  router.post("/public/:workspaceId/bookings", async (req, res) => {
    const workspace = getWorkspaceById(req.params.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }

    const idempotencyKey = requireIdempotencyKey(req, res);
    if (!idempotencyKey) {
      return;
    }

    const requestHash = sha256(JSON.stringify(req.body ?? {}));
    const existing = findIdempotency(workspace.id, idempotencyKey, "POST", req.path);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        res.status(409).json({ error: "Idempotency-Key reuse with different payload" });
        return;
      }
      res.json({ replayed: true, data: existing.responseSnapshot });
      return;
    }

    const publicFlowConfig = getWorkspacePublicFlowConfig(workspace);
    const allowedKeys = ["serviceId", "startsAt", "fields"];

    const unexpectedKeys = findUnexpectedObjectKeys(req.body, allowedKeys);
    if (unexpectedKeys.length) {
      res.status(400).json({
        error: `Unexpected booking payload keys: ${unexpectedKeys.join(", ")}`,
      });
      return;
    }

    const serviceId = getString(req.body?.serviceId);
    const startsAt = getString(req.body?.startsAt);

    if (!serviceId || !startsAt) {
      res.status(400).json({
        error: "serviceId and startsAt are required",
      });
      return;
    }

    const configuredFields = publicFlowConfig.booking.fields;
    const submissionCheck = validatePublicFieldSubmission(
      configuredFields,
      req.body?.fields ?? {},
    );
    if (submissionCheck.error) {
      res.status(400).json({ error: submissionCheck.error });
      return;
    }
    const customFields = submissionCheck.sanitized ?? {};

    const fullName = findSubmissionValueByKeyHints(customFields, [
      "name",
      "full_name",
      "fullname",
    ]);
    const explicitFirstName = findSubmissionValueByKeyHints(customFields, [
      "first_name",
      "firstname",
      "given_name",
      "first",
    ]);
    const explicitLastName = findSubmissionValueByKeyHints(customFields, [
      "last_name",
      "lastname",
      "surname",
      "family_name",
      "last",
    ]);
    const splitFromFullName = fullName ? splitFullName(fullName) : null;
    const firstName =
      explicitFirstName ?? splitFromFullName?.firstName ?? "Guest";
    const lastName =
      explicitLastName ?? splitFromFullName?.lastName ?? "Lead";
    const email =
      findSubmissionValueByFieldType(configuredFields, customFields, "email") ??
      findSubmissionValueByKeyHints(customFields, ["email"]);
    const phone =
      findSubmissionValueByFieldType(configuredFields, customFields, "phone") ??
      findSubmissionValueByKeyHints(customFields, ["phone", "mobile", "phone_number"]);
    const notesFromHints = findSubmissionValueByKeyHints(customFields, [
      "notes",
      "message",
      "details",
      "reason",
    ]);
    const notesFromTextarea = configuredFields
      .filter((field) => field.type.toLowerCase() === "textarea")
      .map((field) => customFields[field.key])
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const notes = notesFromHints ?? notesFromTextarea;

    const service = state.services.find(
      (item) => item.workspaceId === workspace.id && item.id === serviceId && item.isActive,
    );
    if (!service) {
      res.status(404).json({ error: "service not found" });
      return;
    }

    const parsedStartsAt = new Date(startsAt);
    if (Number.isNaN(parsedStartsAt.getTime())) {
      res.status(400).json({ error: "startsAt must be an ISO date string" });
      return;
    }

    const bookingStartsAt = parsedStartsAt.toISOString();
    const endsAt = addMinutes(bookingStartsAt, service.durationMin);

    if (
      !isWithinAvailabilityRule(
        workspace.id,
        service.id,
        bookingStartsAt,
        endsAt,
        workspace.timezone || "UTC",
        service.durationMin,
      )
    ) {
      res.status(409).json({ error: "Requested slot is outside availability rules" });
      return;
    }

    if (isBookingOverlapping(workspace.id, bookingStartsAt, endsAt)) {
      res.status(409).json({ error: "Selected time slot is not available" });
      return;
    }

    const contact = findOrCreateContact({
      workspaceId: workspace.id,
      firstName,
      lastName,
      email: email?.toLowerCase(),
      phone,
      customFields,
      source: "booking_flow",
    });

    const createdAt = nowIso();
    const booking: Booking = {
      id: createId(),
      workspaceId: workspace.id,
      contactId: contact.id,
      serviceId: service.id,
      startsAt: bookingStartsAt,
      endsAt,
      status: "pending" as BookingStatus,
      notes,
      customFields,
      createdAt,
      updatedAt: createdAt,
    };
    state.bookings.push(booking);
    void persistEntity("bookings", booking);

    try {
      const calendarResult = await upsertBookingCalendarEventIfConnected({
        booking,
        workspace,
        contact,
        service,
      });
      if (calendarResult.eventId && booking.calendarEventId !== calendarResult.eventId) {
        booking.calendarEventId = calendarResult.eventId;
        booking.updatedAt = nowIso();
        void persistEntity("bookings", booking);
      }
    } catch {
      // Keep booking flow non-blocking if calendar sync fails.
    }

    emitEvent({
      workspaceId: workspace.id,
      eventType: "booking.created",
      entityType: "booking",
      entityId: booking.id,
      payload: { startsAt: booking.startsAt, serviceId: booking.serviceId },
    });

    const reminderRunAt = new Date(
      new Date(booking.startsAt).getTime() - 24 * 60 * 60 * 1000,
    ).toISOString();
    enqueueJob({
      workspaceId: workspace.id,
      jobType: "booking.reminder",
      runAt: reminderRunAt,
      payload: { bookingId: booking.id },
      priority: "high",
    });

    const serviceTemplate = service.bookingFormTemplateId
      ? state.formTemplates.find(
          (template) =>
            template.workspaceId === workspace.id &&
            template.trigger === "post_booking" &&
            template.id === service.bookingFormTemplateId,
        )
      : undefined;
    let formRequest = undefined;
    if (serviceTemplate) {
      formRequest = createFormRequest({
        workspaceId: workspace.id,
        bookingId: booking.id,
        contactId: contact.id,
        templateId: serviceTemplate.id,
        dueAt: addHours(nowIso(), 48),
      });
      emitEvent({
        workspaceId: workspace.id,
        eventType: "form.requested",
        entityType: "form_request",
        entityId: formRequest.id,
        payload: { bookingId: booking.id },
      });
    }

    const formLink = formRequest
      ? `${getFrontendBaseUrl()}/forms/${formRequest.publicToken}`
      : undefined;
    const channel: Channel = email ? "email" : phone ? "sms" : "email";
    const bookingEmailContent =
      channel === "email"
        ? buildBookingConfirmationEmail({
            firstName: contact.firstName,
            workspaceName: workspace.name,
            serviceName: service.name,
            startsAt: booking.startsAt,
            durationMin: service.durationMin,
            timeZone: workspace.timezone || "UTC",
            formLink,
          })
        : null;
    const outboundBody =
      channel === "email"
        ? bookingEmailContent?.text ?? "Your booking has been confirmed."
        : buildBookingConfirmationSms({
            workspaceName: workspace.name,
            startsAt: booking.startsAt,
            timeZone: workspace.timezone || "UTC",
            formLink,
          });

    createConversationMessage({
      workspaceId: workspace.id,
      contactId: contact.id,
      channel,
      direction: "outbound",
      body: outboundBody,
      metadata: {
        source: "automation.booking.created",
        subject:
          bookingEmailContent?.subject ?? `Booking Confirmed - ${workspace.name}`,
        ...(bookingEmailContent ? { emailHtml: bookingEmailContent.html } : {}),
      },
    });

    const snapshot = {
      booking,
      formRequest: formRequest
        ? {
            id: formRequest.id,
            status: formRequest.status,
            publicToken: formRequest.publicToken,
            dueAt: formRequest.dueAt,
          }
        : null,
    };

    saveIdempotency({
      workspaceId: workspace.id,
      key: idempotencyKey,
      method: "POST",
      path: req.path,
      requestHash,
      responseSnapshot: snapshot,
    });

    res.status(201).json(snapshot);
  });

  router.patch("/bookings/:id/status", requireAuth, requireWorkspace, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const booking = state.bookings.find(
      (item) =>
        item.id === req.params.id &&
        item.workspaceId === authReq.workspace!.id &&
        !item.deletedAt,
    );
    if (!booking) {
      res.status(404).json({ error: "booking not found" });
      return;
    }

    const targetStatus = parseBookingStatus(req.body?.status);
    if (!targetStatus) {
      res.status(400).json({ error: "invalid status" });
      return;
    }

    const transitions: Record<BookingStatus, BookingStatus[]> = {
      pending: ["confirmed", "cancelled", "no_show"],
      confirmed: ["completed", "cancelled", "no_show"],
      completed: [],
      no_show: [],
      cancelled: [],
    };
    if (!transitions[booking.status].includes(targetStatus)) {
      res.status(400).json({
        error: `invalid status transition from ${booking.status} to ${targetStatus}`,
      });
      return;
    }

    if (targetStatus === "completed") {
      const inventoryError = applyInventoryOnBookingCompleted(
        authReq.workspace!.id,
        booking.id,
      );
      if (inventoryError) {
        res.status(409).json({ error: inventoryError });
        return;
      }
    }

    booking.status = targetStatus;
    booking.updatedAt = nowIso();
    void persistEntity("bookings", booking);

    if (targetStatus === "cancelled" || targetStatus === "no_show") {
      await deleteBookingCalendarEventIfConnected({
        workspaceId: authReq.workspace!.id,
        eventId: booking.calendarEventId,
      });
      booking.calendarEventId = undefined;
      booking.updatedAt = nowIso();
      void persistEntity("bookings", booking);
    } else {
      const service = state.services.find(
        (item) => item.id === booking.serviceId && item.workspaceId === authReq.workspace!.id,
      );
      const contact = state.contacts.find(
        (item) => item.id === booking.contactId && item.workspaceId === authReq.workspace!.id,
      );
      if (service && contact) {
        const calendarResult = await upsertBookingCalendarEventIfConnected({
          booking,
          workspace: authReq.workspace!,
          contact,
          service,
        });
        if (calendarResult.eventId && booking.calendarEventId !== calendarResult.eventId) {
          booking.calendarEventId = calendarResult.eventId;
          booking.updatedAt = nowIso();
          void persistEntity("bookings", booking);
        }
      }
    }

    const eventType =
      targetStatus === "confirmed"
        ? "booking.confirmed"
        : targetStatus === "completed"
          ? "booking.completed"
          : "booking.updated";
    emitEvent({
      workspaceId: authReq.workspace!.id,
      eventType,
      entityType: "booking",
      entityId: booking.id,
      payload: { status: booking.status },
    });

    res.json({ booking });
  });

  router.get("/bookings", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const statusFilter = parseBookingStatus(req.query.status);
    const dateFrom = getOptionalString(req.query.dateFrom);
    const dateTo = getOptionalString(req.query.dateTo);

    let data = state.bookings.filter(
      (booking) => booking.workspaceId === authReq.workspace!.id && !booking.deletedAt,
    );
    if (statusFilter) {
      data = data.filter((booking) => booking.status === statusFilter);
    }
    if (dateFrom) {
      const fromTime = new Date(dateFrom).getTime();
      if (!Number.isNaN(fromTime)) {
        data = data.filter((booking) => new Date(booking.startsAt).getTime() >= fromTime);
      }
    }
    if (dateTo) {
      const toTime = new Date(dateTo).getTime();
      if (!Number.isNaN(toTime)) {
        data = data.filter((booking) => new Date(booking.startsAt).getTime() <= toTime);
      }
    }

    const result = data
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
      .map((booking) => ({
        ...booking,
        contact: state.contacts.find((contact) => contact.id === booking.contactId),
        service: state.services.find((service) => service.id === booking.serviceId),
      }));

    res.json({ data: result });
  });

  router.get("/bookings/:id", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const booking = state.bookings.find(
      (item) =>
        item.id === req.params.id &&
        item.workspaceId === authReq.workspace!.id &&
        !item.deletedAt,
    );
    if (!booking) {
      res.status(404).json({ error: "booking not found" });
      return;
    }

    res.json({
      booking: {
        ...booking,
        contact: state.contacts.find((contact) => contact.id === booking.contactId),
        service: state.services.find((service) => service.id === booking.serviceId),
      },
    });
  });

  router.delete("/bookings/:id", requireAuth, requireWorkspace, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const booking = state.bookings.find(
      (item) =>
        item.id === req.params.id &&
        item.workspaceId === authReq.workspace!.id &&
        !item.deletedAt,
    );
    if (!booking) {
      res.status(404).json({ error: "booking not found" });
      return;
    }

    const now = nowIso();
    booking.status = "cancelled";
    booking.deletedAt = now;
    booking.updatedAt = now;
    void persistEntity("bookings", booking);

    await deleteBookingCalendarEventIfConnected({
      workspaceId: authReq.workspace!.id,
      eventId: booking.calendarEventId,
    });
    booking.calendarEventId = undefined;
    booking.updatedAt = nowIso();
    void persistEntity("bookings", booking);

    emitEvent({
      workspaceId: authReq.workspace!.id,
      eventType: "booking.updated",
      entityType: "booking",
      entityId: booking.id,
      payload: { status: booking.status, cancelledAt: now },
    });

    res.json({ booking });
  });

  router.post("/bookings/:id/reschedule", requireAuth, requireWorkspace, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const booking = state.bookings.find(
      (item) =>
        item.id === req.params.id &&
        item.workspaceId === authReq.workspace!.id &&
        !item.deletedAt,
    );
    if (!booking) {
      res.status(404).json({ error: "booking not found" });
      return;
    }
    if (
      booking.status === "completed" ||
      booking.status === "cancelled" ||
      booking.status === "no_show"
    ) {
      res.status(409).json({ error: `Cannot reschedule a ${booking.status} booking` });
      return;
    }

    const startsAtInput = getString(req.body?.startsAt);
    if (!startsAtInput) {
      res.status(400).json({ error: "startsAt is required" });
      return;
    }

    const parsedStartsAt = new Date(startsAtInput);
    if (Number.isNaN(parsedStartsAt.getTime())) {
      res.status(400).json({ error: "startsAt must be an ISO date string" });
      return;
    }

    const service = state.services.find(
      (item) => item.id === booking.serviceId && item.workspaceId === authReq.workspace!.id,
    );
    if (!service) {
      res.status(404).json({ error: "service not found" });
      return;
    }

    const startsAt = parsedStartsAt.toISOString();
    const endsAt = addMinutes(startsAt, service.durationMin);

    if (
      !isWithinAvailabilityRule(
        authReq.workspace!.id,
        service.id,
        startsAt,
        endsAt,
        authReq.workspace!.timezone || "UTC",
        service.durationMin,
      )
    ) {
      res.status(409).json({ error: "Requested slot is outside availability rules" });
      return;
    }

    if (isBookingOverlapping(authReq.workspace!.id, startsAt, endsAt, booking.id)) {
      res.status(409).json({ error: "Selected time slot is not available" });
      return;
    }

    booking.startsAt = startsAt;
    booking.endsAt = endsAt;
    booking.updatedAt = nowIso();
    void persistEntity("bookings", booking);

    const contact = state.contacts.find(
      (item) => item.id === booking.contactId && item.workspaceId === authReq.workspace!.id,
    );
    if (contact) {
      const calendarResult = await upsertBookingCalendarEventIfConnected({
        booking,
        workspace: authReq.workspace!,
        contact,
        service,
      });
      if (calendarResult.eventId && booking.calendarEventId !== calendarResult.eventId) {
        booking.calendarEventId = calendarResult.eventId;
        booking.updatedAt = nowIso();
        void persistEntity("bookings", booking);
      }
    }

    emitEvent({
      workspaceId: authReq.workspace!.id,
      eventType: "booking.updated",
      entityType: "booking",
      entityId: booking.id,
      payload: { startsAt, endsAt, rescheduled: true },
    });

    res.json({ booking });
  });

  return router;
}
