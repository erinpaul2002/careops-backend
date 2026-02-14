import { Router } from "express";
import {
  AuthenticatedRequest,
  requireAuth,
  requireWorkspace,
} from "../utils/auth";
import { emitEvent, findIdempotency, saveIdempotency, state } from "../utils/store";
import { createId, nowIso, sha256 } from "../utils/core";
import {
  getOptionalString,
  getString,
  requireIdempotencyKey,
} from "../utils/http";
import { persistEntity, removeEntityById } from "../database/persistence";
import {
  buildFormObjectKey,
  createDownloadUrl,
  createUploadUrl,
  FILE_STORAGE_ALLOWED_CONTENT_TYPES,
  getFormFileKeyPrefix,
  getMaxUploadBytes,
  isAllowedUploadContentType,
  isFileStorageConfigured,
} from "../utils/fileStorage";

interface FormFileSubmission {
  key: string;
  fileName: string;
  contentType: string;
  size: number;
}

function templateFieldKey(field: Record<string, unknown>, index: number): string {
  const keyCandidate = field.key;
  if (typeof keyCandidate === "string" && keyCandidate.trim()) {
    return keyCandidate.trim();
  }

  const nameCandidate = field.name;
  if (typeof nameCandidate === "string" && nameCandidate.trim()) {
    return nameCandidate.trim();
  }

  const labelCandidate = field.label;
  if (typeof labelCandidate === "string" && labelCandidate.trim()) {
    const normalized = labelCandidate
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (normalized) {
      return normalized;
    }
  }

  return `field_${index + 1}`;
}

function templateFieldType(field: Record<string, unknown>): string {
  const type = field.type;
  if (typeof type !== "string") {
    return "text";
  }
  const normalized = type.trim().toLowerCase();
  return normalized || "text";
}

function normalizeTemplateFieldKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeTemplateFields(input: unknown): Record<string, unknown>[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const normalized: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!isRecord(item)) {
      continue;
    }

    const keyCandidate = templateFieldKey(item, index);
    const key = normalizeTemplateFieldKey(keyCandidate) || `field_${index + 1}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const label =
      typeof item.label === "string" && item.label.trim()
        ? item.label.trim()
        : key;
    const type = templateFieldType(item);
    const required = Boolean(item.required);
    const placeholder =
      typeof item.placeholder === "string" && item.placeholder.trim()
        ? item.placeholder.trim()
        : undefined;

    normalized.push({
      key,
      label,
      type,
      required,
      ...(placeholder ? { placeholder } : {}),
    });
  }

  return normalized;
}

function enforceRequiredTemplateCoreFields(
  fields: Record<string, unknown>[],
): Record<string, unknown>[] {
  const requiredCore = [
    { key: "name", label: "Name", type: "text" },
    { key: "email", label: "Email", type: "email" },
  ] as const;

  const normalized = [...fields];
  const byKey = new Map<string, number>();
  normalized.forEach((field, index) => {
    const key = normalizeTemplateFieldKey(String(field.key ?? ""));
    if (key) {
      byKey.set(key, index);
    }
  });

  for (const requiredField of requiredCore) {
    const index = byKey.get(requiredField.key);
    if (index === undefined) {
      normalized.push({
        key: requiredField.key,
        label: requiredField.label,
        type: requiredField.type,
        required: true,
      });
      continue;
    }

    const field = normalized[index];
    normalized[index] = {
      ...field,
      key: requiredField.key,
      label:
        typeof field.label === "string" && field.label.trim()
          ? field.label.trim()
          : requiredField.label,
      type:
        requiredField.key === "email"
          ? "email"
          : (typeof field.type === "string" && field.type.trim()
            ? field.type.trim().toLowerCase()
            : requiredField.type),
      required: true,
    };
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseFileSubmission(
  value: unknown,
  keyPrefix: string,
): FormFileSubmission | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const key = getOptionalString(value.key);
  const fileName = getOptionalString(value.fileName);
  const contentTypeRaw = getOptionalString(value.contentType)?.toLowerCase();
  const sizeRaw = Number(value.size);

  if (!key || !key.startsWith(keyPrefix)) {
    return undefined;
  }
  if (!fileName) {
    return undefined;
  }
  if (!contentTypeRaw || !isAllowedUploadContentType(contentTypeRaw)) {
    return undefined;
  }
  if (
    !Number.isFinite(sizeRaw) ||
    sizeRaw <= 0 ||
    sizeRaw > getMaxUploadBytes()
  ) {
    return undefined;
  }

  return {
    key,
    fileName,
    contentType: contentTypeRaw,
    size: Math.trunc(sizeRaw),
  };
}

function isFormFileSubmission(value: unknown): value is FormFileSubmission {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.fileName === "string" &&
    typeof value.contentType === "string" &&
    typeof value.size === "number"
  );
}

function extractSubmittedFileKeys(submission?: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  if (!submission) {
    return keys;
  }

  for (const value of Object.values(submission)) {
    if (isRecord(value) && typeof value.key === "string" && value.key.trim()) {
      keys.add(value.key);
      continue;
    }

    if (!Array.isArray(value)) {
      continue;
    }

    for (const item of value) {
      if (isRecord(item) && typeof item.key === "string" && item.key.trim()) {
        keys.add(item.key);
      }
    }
  }

  return keys;
}

export function createFormRoutes(): Router {
  const router = Router();

  router.get("/form-templates", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const includeInactive = req.query.includeInactive === "true";
    const data = state.formTemplates.filter(
      (template) =>
        template.workspaceId === authReq.workspace!.id &&
        (includeInactive || template.isActive),
    );
    res.json({ data });
  });

  router.post("/form-templates", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const name = getString(req.body?.name);
    const fields = normalizeTemplateFields(req.body?.fields);
    const isActive = req.body?.isActive !== false;

    if (!name || !fields.length) {
      res.status(400).json({ error: "name and fields are required" });
      return;
    }

    const createdAt = nowIso();
    const template = {
      id: createId(),
      workspaceId: authReq.workspace!.id,
      name,
      fields: enforceRequiredTemplateCoreFields(fields),
      trigger: "post_booking" as const,
      isActive,
      createdAt,
      updatedAt: createdAt,
    };
    state.formTemplates.push(template);
    void persistEntity("formTemplates", template);

    res.status(201).json({ template });
  });

  router.patch(
    "/form-templates/:id",
    requireAuth,
    requireWorkspace,
    (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const template = state.formTemplates.find(
        (item) => item.id === req.params.id && item.workspaceId === authReq.workspace!.id,
      );
      if (!template) {
        res.status(404).json({ error: "form template not found" });
        return;
      }

      const name = getOptionalString(req.body?.name);
      const fields = req.body?.fields;
      const isActive = req.body?.isActive;

      if (name !== undefined) {
        template.name = name;
      }
      if (fields !== undefined) {
        const normalizedFields = normalizeTemplateFields(fields);
        if (normalizedFields.length === 0) {
          res.status(400).json({ error: "fields must be a non-empty array" });
          return;
        }
        template.fields = enforceRequiredTemplateCoreFields(normalizedFields);
      }
      if (isActive !== undefined) {
        template.isActive = Boolean(isActive);
      }

      template.updatedAt = nowIso();
      void persistEntity("formTemplates", template);
      res.json({ template });
    },
  );

  router.delete(
    "/form-templates/:id",
    requireAuth,
    requireWorkspace,
    (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const templateIndex = state.formTemplates.findIndex(
        (item) => item.id === req.params.id && item.workspaceId === authReq.workspace!.id,
      );
      if (templateIndex === -1) {
        res.status(404).json({ error: "form template not found" });
        return;
      }

      const [template] = state.formTemplates.splice(templateIndex, 1);
      void removeEntityById("formTemplates", template.id);

      state.services
        .filter(
          (service) =>
            service.workspaceId === authReq.workspace!.id &&
            service.bookingFormTemplateId === template.id,
        )
        .forEach((service) => {
          service.bookingFormTemplateId = undefined;
          service.updatedAt = nowIso();
          void persistEntity("services", service);
        });

      res.json({ success: true });
    },
  );

  router.get("/form-requests", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const status = getOptionalString(req.query.status);

    let data = state.formRequests.filter(
      (request) => request.workspaceId === authReq.workspace!.id,
    );
    if (status === "pending" || status === "completed" || status === "overdue") {
      data = data.filter((request) => request.status === status);
    }
    data = data.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    res.json({
      data: data.map((request) => ({
        ...request,
        template: state.formTemplates.find((template) => template.id === request.templateId),
        booking: state.bookings.find((booking) => booking.id === request.bookingId),
        contact: state.contacts.find((contact) => contact.id === request.contactId),
      })),
    });
  });

  router.get(
    "/form-requests/:id/files/download-url",
    requireAuth,
    requireWorkspace,
    async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const formRequest = state.formRequests.find(
        (item) =>
          item.id === req.params.id && item.workspaceId === authReq.workspace!.id,
      );
      if (!formRequest) {
        res.status(404).json({ error: "form request not found" });
        return;
      }

      const key = getOptionalString(req.query.key);
      if (!key) {
        res.status(400).json({ error: "key query parameter is required" });
        return;
      }

      const keyPrefix = getFormFileKeyPrefix(
        formRequest.workspaceId,
        formRequest.id,
      );
      if (!key.startsWith(keyPrefix)) {
        res.status(400).json({ error: "invalid file key for this form request" });
        return;
      }

      const submittedFileKeys = extractSubmittedFileKeys(formRequest.submission);
      if (!submittedFileKeys.has(key)) {
        res.status(404).json({ error: "file key not found in this form submission" });
        return;
      }

      if (!isFileStorageConfigured()) {
        res.status(503).json({ error: "File storage is not configured" });
        return;
      }

      try {
        const signed = await createDownloadUrl(key);
        res.json({
          key,
          downloadUrl: signed.url,
          expiresInSeconds: signed.expiresInSeconds,
        });
      } catch (error) {
        console.error("Failed to create download URL", error);
        res.status(500).json({ error: "Failed to generate download URL" });
      }
    },
  );

  router.get("/public/forms/:token", (req, res) => {
    const formRequest = state.formRequests.find(
      (request) => request.publicToken === req.params.token,
    );
    if (!formRequest) {
      res.status(404).json({ error: "form request not found" });
      return;
    }

    const template = state.formTemplates.find(
      (item) =>
        item.id === formRequest.templateId && item.workspaceId === formRequest.workspaceId,
    );
    if (!template) {
      res.status(404).json({ error: "form template not found" });
      return;
    }

    res.json({
      formRequest: {
        id: formRequest.id,
        status: formRequest.status,
        dueAt: formRequest.dueAt,
      },
      template: {
        id: template.id,
        name: template.name,
        fields: template.fields,
      },
    });
  });

  router.post("/public/forms/:token/files/presign-upload", async (req, res) => {
    const formRequest = state.formRequests.find(
      (request) => request.publicToken === req.params.token,
    );
    if (!formRequest) {
      res.status(404).json({ error: "form request not found" });
      return;
    }
    if (formRequest.status === "completed") {
      res.status(409).json({ error: "form request already completed" });
      return;
    }

    const body = req.body;
    if (!isRecord(body)) {
      res.status(400).json({ error: "request body must be an object" });
      return;
    }

    const fieldKey = getString(body.fieldKey);
    const fileName = getString(body.fileName);
    const contentType = getString(body.contentType).toLowerCase();
    const size = Number(body.size);
    if (!fieldKey || !fileName || !contentType || !Number.isFinite(size)) {
      res
        .status(400)
        .json({ error: "fieldKey, fileName, contentType, and size are required" });
      return;
    }

    const template = state.formTemplates.find(
      (item) =>
        item.id === formRequest.templateId &&
        item.workspaceId === formRequest.workspaceId,
    );
    if (!template) {
      res.status(404).json({ error: "form template not found" });
      return;
    }

    const matchedField = template.fields.find((field, index) => {
      const key = templateFieldKey(field as Record<string, unknown>, index);
      return key === fieldKey;
    });
    if (!matchedField) {
      res.status(400).json({ error: "fieldKey is not configured in this template" });
      return;
    }
    if (templateFieldType(matchedField as Record<string, unknown>) !== "file") {
      res.status(400).json({ error: "fieldKey is not a file field" });
      return;
    }

    if (!isAllowedUploadContentType(contentType)) {
      res.status(400).json({
        error: `Unsupported content type. Allowed: ${FILE_STORAGE_ALLOWED_CONTENT_TYPES.join(", ")}`,
      });
      return;
    }

    const maxUploadBytes = getMaxUploadBytes();
    if (size <= 0 || size > maxUploadBytes) {
      res.status(400).json({
        error: `File size must be between 1 and ${maxUploadBytes} bytes`,
      });
      return;
    }

    if (!isFileStorageConfigured()) {
      res.status(503).json({ error: "File storage is not configured" });
      return;
    }

    const key = buildFormObjectKey({
      workspaceId: formRequest.workspaceId,
      formRequestId: formRequest.id,
      fileName,
    });

    try {
      const signed = await createUploadUrl({
        key,
        contentType,
        size: Math.trunc(size),
      });
      res.json({
        key,
        uploadUrl: signed.url,
        expiresInSeconds: signed.expiresInSeconds,
        maxSizeBytes: maxUploadBytes,
        allowedContentTypes: FILE_STORAGE_ALLOWED_CONTENT_TYPES,
      });
    } catch (error) {
      console.error("Failed to create upload URL", error);
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  });

  router.post("/public/forms/:token/submit", (req, res) => {
    const idempotencyKey = requireIdempotencyKey(req, res);
    if (!idempotencyKey) {
      return;
    }

    const formRequest = state.formRequests.find(
      (request) => request.publicToken === req.params.token,
    );
    if (!formRequest) {
      res.status(404).json({ error: "form request not found" });
      return;
    }

    const submission =
      req.body && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : null;
    if (!submission || Array.isArray(submission)) {
      res.status(400).json({ error: "submission payload must be an object" });
      return;
    }

    const requestHash = sha256(JSON.stringify(submission));
    const existing = findIdempotency(
      formRequest.workspaceId,
      idempotencyKey,
      "POST",
      req.path,
    );
    if (existing) {
      if (existing.requestHash !== requestHash) {
        res.status(409).json({ error: "Idempotency-Key reuse with different payload" });
        return;
      }
      res.json({ replayed: true, data: existing.responseSnapshot });
      return;
    }

    if (formRequest.status === "completed") {
      res.status(409).json({ error: "form request already completed" });
      return;
    }

    const template = state.formTemplates.find(
      (item) =>
        item.id === formRequest.templateId &&
        item.workspaceId === formRequest.workspaceId,
    );
    if (!template) {
      res.status(404).json({ error: "form template not found" });
      return;
    }

    const templateFieldDefs = template.fields.map((field, index) => {
      const typedField = field as Record<string, unknown>;
      return {
        field: typedField,
        key: templateFieldKey(typedField, index),
        type: templateFieldType(typedField),
      };
    });
    const templateKeys = templateFieldDefs.map((item) => item.key);
    const allowedKeySet = new Set(templateKeys);
    const unexpectedKeys = Object.keys(submission).filter(
      (key) => !allowedKeySet.has(key),
    );
    if (unexpectedKeys.length) {
      res.status(400).json({
        error: `Submission includes fields not configured by owner: ${unexpectedKeys.join(", ")}`,
      });
      return;
    }

    const sanitizedSubmission: Record<string, unknown> = {};
    const keyPrefix = getFormFileKeyPrefix(formRequest.workspaceId, formRequest.id);
    const invalidFileFields: string[] = [];
    for (const fieldDef of templateFieldDefs) {
      if (!Object.prototype.hasOwnProperty.call(submission, fieldDef.key)) {
        continue;
      }

      const submittedValue = submission[fieldDef.key];
      if (fieldDef.type === "file") {
        const parsedFile = parseFileSubmission(submittedValue, keyPrefix);
        if (!parsedFile) {
          invalidFileFields.push(fieldDef.key);
          continue;
        }
        sanitizedSubmission[fieldDef.key] = parsedFile;
        continue;
      }

      sanitizedSubmission[fieldDef.key] = submittedValue;
    }
    if (invalidFileFields.length) {
      res.status(400).json({
        error: `Invalid file metadata for fields: ${invalidFileFields.join(", ")}`,
      });
      return;
    }

    const missingRequiredField = templateFieldDefs.some((fieldDef) => {
      const required = Boolean(fieldDef.field.required);
      if (!required) {
        return false;
      }
      const value = sanitizedSubmission[fieldDef.key];
      if (fieldDef.type === "file") {
        return !isFormFileSubmission(value);
      }
      if (typeof value === "boolean") {
        return !value;
      }
      return typeof value !== "string" || value.trim().length === 0;
    });
    if (missingRequiredField) {
      res.status(400).json({ error: "Missing required form fields" });
      return;
    }

    formRequest.status = "completed";
    formRequest.completedAt = nowIso();
    formRequest.submission = sanitizedSubmission;
    formRequest.updatedAt = nowIso();
    void persistEntity("formRequests", formRequest);

    emitEvent({
      workspaceId: formRequest.workspaceId,
      eventType: "form.completed",
      entityType: "form_request",
      entityId: formRequest.id,
      payload: { completedAt: formRequest.completedAt },
    });

    const snapshot = {
      formRequestId: formRequest.id,
      status: formRequest.status,
      completedAt: formRequest.completedAt,
    };
    saveIdempotency({
      workspaceId: formRequest.workspaceId,
      key: idempotencyKey,
      method: "POST",
      path: req.path,
      requestHash,
      responseSnapshot: snapshot,
    });

    res.json(snapshot);
  });

  return router;
}
