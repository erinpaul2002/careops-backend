import { Router } from "express";
import {
  AuthenticatedRequest,
  requireAuth,
  requireOwner,
  requireWorkspace,
} from "../utils/auth";
import { isDatabaseConnected } from "../database/connection";
import { persistEntity, removeEntityById } from "../database/persistence";
import { nowIso } from "../utils/core";
import { cleanupExpiredRecords, state } from "../utils/store";
import { onboardingStepsRequired } from "../utils/workspaceReadiness";

export function createAdminRoutes(): Router {
  const router = Router();

  router.post("/admin/cleanup", requireAuth, requireWorkspace, requireOwner, (req, res) => {
    cleanupExpiredRecords();

    const olderThanDays = Number(req.body?.olderThanDays ?? 30);
    const thresholdMs =
      Date.now() -
      (Number.isFinite(olderThanDays) && olderThanDays > 0 ? olderThanDays : 30) * 86_400_000;

    let removedJobs = 0;
    for (let i = state.scheduledJobs.length - 1; i >= 0; i -= 1) {
      const job = state.scheduledJobs[i];
      const createdAtMs = new Date(job.createdAt).getTime();
      if (
        createdAtMs < thresholdMs &&
        (job.status === "done" || job.status === "failed")
      ) {
        state.scheduledJobs.splice(i, 1);
        removedJobs += 1;
        void removeEntityById("scheduledJobs", job.id);
      }
    }

    res.json({
      success: true,
      removedJobs,
      at: nowIso(),
    });
  });

  router.get(
    "/admin/health/detailed",
    requireAuth,
    requireWorkspace,
    requireOwner,
    (_req, res) => {
      const queue = {
        queued: state.scheduledJobs.filter((job) => job.status === "queued").length,
        running: state.scheduledJobs.filter((job) => job.status === "running").length,
        failed: state.scheduledJobs.filter((job) => job.status === "failed").length,
      };

      res.json({
        status: "ok",
        timestamp: nowIso(),
        database: {
          connected: isDatabaseConnected(),
        },
        counts: {
          users: state.users.length,
          workspaces: state.workspaces.length,
          workspaceMembers: state.workspaceMembers.length,
          contacts: state.contacts.length,
          conversations: state.conversations.length,
          messages: state.messages.length,
          bookings: state.bookings.length,
          formRequests: state.formRequests.length,
          inventoryItems: state.inventoryItems.length,
          integrations: state.integrationConnections.length,
          alerts: state.alerts.length,
          sessions: state.sessions.length,
          queue,
        },
      });
    },
  );

  router.post("/admin/migrate", requireAuth, requireWorkspace, requireOwner, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const action = typeof req.body?.action === "string" ? req.body.action : "";

    if (!action) {
      res.status(400).json({ error: "action is required" });
      return;
    }

    if (action === "normalize-user-emails") {
      let updated = 0;
      for (const user of state.users) {
        const nextEmail = user.email.trim().toLowerCase();
        if (user.email !== nextEmail) {
          user.email = nextEmail;
          user.updatedAt = nowIso();
          updated += 1;
          void persistEntity("users", user);
        }
      }
      res.json({ success: true, action, updated });
      return;
    }

    if (action === "backfill-workspace-onboarding") {
      let updated = 0;
      for (const workspace of state.workspaces) {
        let changed = false;
        for (const step of onboardingStepsRequired) {
          if (workspace.onboardingSteps[step] === undefined) {
            workspace.onboardingSteps[step] = false;
            changed = true;
          }
        }
        if (changed) {
          workspace.updatedAt = nowIso();
          updated += 1;
          void persistEntity("workspaces", workspace);
        }
      }
      res.json({ success: true, action, updated });
      return;
    }

    if (action === "repair-conversation-last-message") {
      let updated = 0;
      for (const conversation of state.conversations) {
        if (conversation.workspaceId !== authReq.workspace!.id) {
          continue;
        }
        const lastMessage = state.messages
          .filter((message) => message.conversationId === conversation.id)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
        if (lastMessage && conversation.lastMessageAt !== lastMessage.createdAt) {
          conversation.lastMessageAt = lastMessage.createdAt;
          conversation.updatedAt = nowIso();
          updated += 1;
          void persistEntity("conversations", conversation);
        }
      }
      res.json({ success: true, action, updated });
      return;
    }

    res.status(400).json({
      error: "Unsupported migration action",
      supportedActions: [
        "normalize-user-emails",
        "backfill-workspace-onboarding",
        "repair-conversation-last-message",
      ],
    });
  });

  return router;
}
