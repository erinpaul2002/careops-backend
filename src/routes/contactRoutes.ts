import { Router } from "express";
import { AuthenticatedRequest, requireAuth, requireWorkspace } from "../utils/auth";
import { emitEvent, findOrCreateContact, state } from "../utils/store";
import { Channel } from "../utils/types";
import { createConversationMessage } from "../utils/domain";
import {
  getOptionalString,
  getPagination,
  getString,
  getWorkspaceById,
} from "../utils/http";
import {
  findSubmissionValueByFieldType,
  findSubmissionValueByKeyHints,
  findUnexpectedObjectKeys,
  getWorkspacePublicFlowConfig,
  validatePublicFieldSubmission,
} from "../utils/publicFlowConfig";
import { nowIso } from "../utils/core";
import {
  buildContactAcknowledgementEmail,
  buildContactAcknowledgementSms,
} from "../utils/emailTemplates";
import { getWorkspaceAiConfig } from "../utils/workspaceAiConfig";
import { generateContactAcknowledgementDraft } from "../utils/aiMessaging";

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

export function createContactRoutes(): Router {
  const router = Router();

  router.post("/public/:workspaceId/contact", async (req, res) => {
    const workspace = getWorkspaceById(req.params.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }

    const publicFlowConfig = getWorkspacePublicFlowConfig(workspace);
    const allowedKeys = ["fields"];

    const unexpectedKeys = findUnexpectedObjectKeys(req.body, allowedKeys);
    if (unexpectedKeys.length) {
      res.status(400).json({
        error: `Unexpected contact payload keys: ${unexpectedKeys.join(", ")}`,
      });
      return;
    }

    const configuredFields = publicFlowConfig.contact.fields;
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
    const message =
      findSubmissionValueByKeyHints(customFields, ["message", "details", "notes"]) ??
      configuredFields
        .filter((field) => field.type.toLowerCase() === "textarea")
        .map((field) => customFields[field.key])
        .find((value): value is string => typeof value === "string" && value.trim().length > 0);

    const contact = findOrCreateContact({
      workspaceId: workspace.id,
      firstName,
      lastName,
      email: email?.toLowerCase(),
      phone,
      customFields,
      source: "contact_form",
    });

    const channel: Channel = email ? "email" : phone ? "sms" : "email";
    const inboundBody =
      message ?? `Public contact submission: ${JSON.stringify(customFields)}`;
    const conversationId = createConversationMessage({
      workspaceId: workspace.id,
      contactId: contact.id,
      channel,
      direction: "inbound",
      body: inboundBody,
      metadata: { source: "public.contact" },
    });
    const contactEmailContent =
      channel === "email"
        ? buildContactAcknowledgementEmail({
            firstName: contact.firstName,
            workspaceName: workspace.name,
            conversationId,
            submittedMessage: message,
        receivedAt: nowIso(),
        timeZone: workspace.timezone || "UTC",
      })
        : null;
    const aiConfig = getWorkspaceAiConfig(workspace);
    const aiReply =
      aiConfig.contactAutoReplyEnabled
        ? await generateContactAcknowledgementDraft({
            workspaceName: workspace.name,
            contactFirstName: contact.firstName,
            submittedMessage: message,
            channel,
            customFields,
          })
        : null;
    const outboundBody =
      aiReply ??
      (channel === "email"
        ? contactEmailContent?.text ?? `Thanks for contacting ${workspace.name}.`
        : buildContactAcknowledgementSms({ workspaceName: workspace.name }));

    createConversationMessage({
      workspaceId: workspace.id,
      contactId: contact.id,
      channel,
      direction: "outbound",
      body: outboundBody,
      metadata: {
        source: "automation.contact.created",
        ...(aiReply ? { aiGenerated: true, aiProvider: "groq" } : {}),
        subject:
          contactEmailContent?.subject ?? `Message Received - ${workspace.name}`,
        ...(!aiReply && contactEmailContent ? { emailHtml: contactEmailContent.html } : {}),
      },
    });

    emitEvent({
      workspaceId: workspace.id,
      eventType: "contact.created",
      entityType: "contact",
      entityId: contact.id,
      payload: { source: contact.source },
    });

    res.status(201).json({ contact, conversationId });
  });

  router.get("/contacts", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = authReq.workspace!.id;
    const search = getOptionalString(req.query.search)?.toLowerCase();
    const { page, pageSize } = getPagination(req.query.page, req.query.pageSize);

    let data = state.contacts.filter(
      (contact) => contact.workspaceId === workspaceId && !contact.deletedAt,
    );

    if (search) {
      data = data.filter((contact) => {
        const haystack =
          `${contact.firstName} ${contact.lastName} ${contact.email ?? ""} ${contact.phone ?? ""}`.toLowerCase();
        return haystack.includes(search);
      });
    }

    const total = data.length;
    const start = (page - 1) * pageSize;
    const result = data.slice(start, start + pageSize);

    res.json({ page, pageSize, total, data: result });
  });

  router.post("/contacts", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const firstName = getString(req.body?.firstName);
    const lastName = getString(req.body?.lastName);
    const email = getOptionalString(req.body?.email)?.toLowerCase();
    const phone = getOptionalString(req.body?.phone);

    if (!firstName || !lastName || (!email && !phone)) {
      res
        .status(400)
        .json({ error: "firstName, lastName and one of email/phone are required" });
      return;
    }

    const contact = findOrCreateContact({
      workspaceId: authReq.workspace!.id,
      firstName,
      lastName,
      email,
      phone,
      source: "manual",
    });

    emitEvent({
      workspaceId: authReq.workspace!.id,
      eventType: "contact.created",
      entityType: "contact",
      entityId: contact.id,
      payload: { source: contact.source },
    });

    res.status(201).json({ contact });
  });

  return router;
}
