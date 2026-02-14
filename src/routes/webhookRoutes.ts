import { Router } from "express";
import { createId, nowIso } from "../utils/core";
import { emitEvent, findOrCreateContact, state } from "../utils/store";
import { createConversationMessage } from "../utils/domain";
import { getOptionalString, getString, getWorkspaceById } from "../utils/http";

export function createWebhookRoutes(): Router {
  const router = Router();

  router.post("/webhooks/test", (req, res) => {
    res.status(200).json({
      ok: true,
      receivedAt: nowIso(),
      provider: getOptionalString(req.body?.provider) ?? "test",
      payload: req.body ?? {},
    });
  });

  router.post("/webhooks/email/:provider", (req, res) => {
    const workspaceId = getString(req.body?.workspaceId);
    const fromEmail = getOptionalString(req.body?.fromEmail)?.toLowerCase();
    const fromName = getOptionalString(req.body?.fromName) ?? "Customer";
    const body = getString(req.body?.body);
    const providerMessageId = getOptionalString(req.body?.providerMessageId);

    if (!workspaceId || !fromEmail || !body) {
      res.status(400).json({ error: "workspaceId, fromEmail and body are required" });
      return;
    }

    const workspace = getWorkspaceById(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }

    if (
      providerMessageId &&
      state.messages.some(
        (message) =>
          message.workspaceId === workspace.id &&
          message.providerMessageId === providerMessageId &&
          message.channel === "email",
      )
    ) {
      res.status(200).json({ deduped: true });
      return;
    }

    const contact = findOrCreateContact({
      workspaceId: workspace.id,
      firstName: fromName,
      lastName: "",
      email: fromEmail,
      source: "import",
    });

    createConversationMessage({
      workspaceId: workspace.id,
      contactId: contact.id,
      channel: "email",
      direction: "inbound",
      body,
      metadata: { provider: req.params.provider },
      providerMessageId,
    });

    res.status(202).json({ accepted: true });
  });

  router.post("/webhooks/sms/:provider", (req, res) => {
    const workspaceId = getString(req.body?.workspaceId);
    const fromPhone = getOptionalString(req.body?.fromPhone);
    const firstName = getOptionalString(req.body?.firstName) ?? "Customer";
    const body = getString(req.body?.body);
    const providerMessageId = getOptionalString(req.body?.providerMessageId);

    if (!workspaceId || !fromPhone || !body) {
      res.status(400).json({ error: "workspaceId, fromPhone and body are required" });
      return;
    }

    const workspace = getWorkspaceById(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }

    if (
      providerMessageId &&
      state.messages.some(
        (message) =>
          message.workspaceId === workspace.id &&
          message.providerMessageId === providerMessageId &&
          message.channel === "sms",
      )
    ) {
      res.status(200).json({ deduped: true });
      return;
    }

    const contact = findOrCreateContact({
      workspaceId: workspace.id,
      firstName,
      lastName: "",
      phone: fromPhone,
      source: "import",
    });

    createConversationMessage({
      workspaceId: workspace.id,
      contactId: contact.id,
      channel: "sms",
      direction: "inbound",
      body,
      metadata: { provider: req.params.provider },
      providerMessageId,
    });

    res.status(202).json({ accepted: true });
  });

  router.post("/webhooks/calendar/:provider", (req, res) => {
    const workspaceId = getString(req.body?.workspaceId);
    const providerEventId = getOptionalString(req.body?.providerEventId);
    const eventType = getOptionalString(req.body?.eventType) ?? "calendar.updated";
    const entityType = getOptionalString(req.body?.entityType) ?? "calendar_event";
    const entityId = getOptionalString(req.body?.entityId) ?? createId();
    const payload =
      req.body?.payload && typeof req.body.payload === "object"
        ? (req.body.payload as Record<string, unknown>)
        : {};

    if (!workspaceId) {
      res.status(400).json({ error: "workspaceId is required" });
      return;
    }

    const workspace = getWorkspaceById(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }

    if (
      providerEventId &&
      state.automationEvents.some(
        (event) =>
          event.workspaceId === workspace.id &&
          event.payload.providerEventId === providerEventId &&
          event.entityType === entityType,
      )
    ) {
      res.status(200).json({ deduped: true });
      return;
    }

    const event = emitEvent({
      workspaceId: workspace.id,
      eventType,
      entityType,
      entityId,
      payload: {
        provider: req.params.provider,
        providerEventId,
        ...payload,
      },
    });

    res.status(202).json({ accepted: true, eventId: event.id });
  });

  return router;
}
