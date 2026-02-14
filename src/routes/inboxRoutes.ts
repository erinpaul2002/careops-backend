import { Router } from "express";
import { AuthenticatedRequest, requireAuth, requireWorkspace } from "../utils/auth";
import { emitEvent, state } from "../utils/store";
import { nowIso } from "../utils/core";
import {
  createConversationMessage,
  pauseConversationAutomation,
} from "../utils/domain";
import { getOptionalString, getString } from "../utils/http";
import { getWorkspaceAiConfig } from "../utils/workspaceAiConfig";
import { generateConversationReplyDraft } from "../utils/aiMessaging";
import { isGroqConfigured } from "../utils/groq";

export function createInboxRoutes(): Router {
  const router = Router();

  router.get("/conversations", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const status = getOptionalString(req.query.status) as
      | "open"
      | "pending"
      | "closed"
      | undefined;

    let data = state.conversations.filter(
      (conversation) => conversation.workspaceId === authReq.workspace!.id,
    );
    if (status) {
      data = data.filter((conversation) => conversation.status === status);
    }

    const result = data
      .sort(
        (a, b) =>
          new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
      )
      .map((conversation) => {
        const contact = state.contacts.find((item) => item.id === conversation.contactId);
        const latestMessage = state.messages
          .filter((message) => message.conversationId === conversation.id)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

        return {
          ...conversation,
          contact,
          latestMessage: latestMessage
            ? {
                body: latestMessage.body,
                direction: latestMessage.direction,
                createdAt: latestMessage.createdAt,
              }
            : null,
        };
      });

    res.json({ data: result });
  });

  router.get("/conversations/:id/messages", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const conversation = state.conversations.find(
      (item) => item.id === req.params.id && item.workspaceId === authReq.workspace!.id,
    );
    if (!conversation) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }

    const data = state.messages
      .filter((message) => message.conversationId === conversation.id)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    res.json({ conversation, data });
  });

  router.post("/conversations/:id/messages", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const conversation = state.conversations.find(
      (item) => item.id === req.params.id && item.workspaceId === authReq.workspace!.id,
    );
    if (!conversation) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }

    const body = getString(req.body?.body);
    if (!body) {
      res.status(400).json({ error: "body is required" });
      return;
    }

    createConversationMessage({
      workspaceId: authReq.workspace!.id,
      contactId: conversation.contactId,
      channel: conversation.channel,
      direction: "outbound",
      body,
      metadata: { source: "staff.reply" },
    });
    pauseConversationAutomation(authReq.workspace!.id, conversation.id);

    emitEvent({
      workspaceId: authReq.workspace!.id,
      eventType: "conversation.staff_replied",
      entityType: "conversation",
      entityId: conversation.id,
      payload: { pausedUntil: conversation.automationPausedUntil, at: nowIso() },
    });

    res.status(201).json({ success: true });
  });

  router.post(
    "/conversations/:id/ai-draft",
    requireAuth,
    requireWorkspace,
    async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const conversation = state.conversations.find(
        (item) => item.id === req.params.id && item.workspaceId === authReq.workspace!.id,
      );
      if (!conversation) {
        res.status(404).json({ error: "conversation not found" });
        return;
      }

      const aiConfig = getWorkspaceAiConfig(authReq.workspace!);
      if (!aiConfig.inboxReplyAssistEnabled) {
        res.status(403).json({ error: "AI inbox assistant is disabled for this workspace" });
        return;
      }
      if (!isGroqConfigured()) {
        res.status(503).json({ error: "GROQ_API_KEY is not configured on server" });
        return;
      }

      const contact = state.contacts.find(
        (item) => item.id === conversation.contactId && item.workspaceId === authReq.workspace!.id,
      );
      const instruction = getOptionalString(req.body?.instruction);
      const messages = state.messages
        .filter((message) => message.conversationId === conversation.id)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      const draft = await generateConversationReplyDraft({
        workspaceName: authReq.workspace!.name,
        contactFullName:
          `${contact?.firstName ?? "Contact"} ${contact?.lastName ?? ""}`.trim(),
        channel: conversation.channel,
        messages,
        instruction,
      });

      if (!draft) {
        res.status(502).json({ error: "Unable to generate AI draft right now" });
        return;
      }

      res.json({ draft });
    },
  );

  return router;
}
