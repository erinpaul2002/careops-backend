import { PublicFieldConfig, PublicFlowConfig, Workspace } from "./types";

const requiredCoreFields: PublicFieldConfig[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email", required: true },
];

export const defaultPublicFlowConfig: PublicFlowConfig = {
  booking: {
    fields: requiredCoreFields.map((field) => ({ ...field })),
  },
  contact: {
    fields: requiredCoreFields.map((field) => ({ ...field })),
  },
};

function normalizeFieldKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeFieldArray(input: unknown): PublicFieldConfig[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const output: PublicFieldConfig[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const payload = item as Record<string, unknown>;
    const keyInput =
      (typeof payload.key === "string" && payload.key.trim()) ||
      (typeof payload.label === "string" && payload.label.trim()) ||
      `field_${index + 1}`;
    const key = normalizeFieldKey(String(keyInput));
    if (!key || seen.has(key)) {
      continue;
    }

    const label =
      typeof payload.label === "string" && payload.label.trim()
        ? payload.label.trim()
        : key;
    const type =
      typeof payload.type === "string" && payload.type.trim()
        ? payload.type.trim()
        : "text";
    const required = Boolean(payload.required);
    const placeholder =
      typeof payload.placeholder === "string" && payload.placeholder.trim()
        ? payload.placeholder.trim()
        : undefined;

    seen.add(key);
    output.push({
      key,
      label,
      type,
      required,
      placeholder,
    });
  }

  return output;
}

function cloneFields(fields: PublicFieldConfig[]): PublicFieldConfig[] {
  return fields.map((field) => ({ ...field }));
}

function enforceRequiredCoreFields(fields: PublicFieldConfig[]): PublicFieldConfig[] {
  const normalized = cloneFields(fields);
  const byKey = new Map(
    normalized.map((field, index) => [normalizeFieldKey(field.key), index] as const),
  );

  for (const requiredField of requiredCoreFields) {
    const index = byKey.get(requiredField.key);
    if (index === undefined) {
      normalized.push({ ...requiredField });
      continue;
    }

    const existing = normalized[index];
    normalized[index] = {
      ...existing,
      key: requiredField.key,
      label: existing.label?.trim() || requiredField.label,
      type:
        requiredField.key === "email"
          ? "email"
          : existing.type?.trim() || requiredField.type,
      required: true,
    };
  }

  return normalized;
}

export function getWorkspacePublicFlowConfig(workspace: Workspace): PublicFlowConfig {
  const current = workspace.publicFlowConfig;
  if (!current) {
    return defaultPublicFlowConfig;
  }

  return {
    booking: {
      fields: enforceRequiredCoreFields(normalizeFieldArray(current.booking?.fields)),
    },
    contact: {
      fields: enforceRequiredCoreFields(normalizeFieldArray(current.contact?.fields)),
    },
  };
}

export function mergePublicFlowConfig(
  input: unknown,
  current: PublicFlowConfig,
): PublicFlowConfig | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const payload = input as Record<string, unknown>;
  const bookingInput =
    payload.booking && typeof payload.booking === "object" && !Array.isArray(payload.booking)
      ? (payload.booking as Record<string, unknown>)
      : null;
  const contactInput =
    payload.contact && typeof payload.contact === "object" && !Array.isArray(payload.contact)
      ? (payload.contact as Record<string, unknown>)
      : null;

  return {
    booking: {
      fields: enforceRequiredCoreFields(
        bookingInput && "fields" in bookingInput
          ? normalizeFieldArray(bookingInput.fields)
          : cloneFields(current.booking.fields),
      ),
    },
    contact: {
      fields: enforceRequiredCoreFields(
        contactInput && "fields" in contactInput
          ? normalizeFieldArray(contactInput.fields)
          : cloneFields(current.contact.fields),
      ),
    },
  };
}

export function findUnexpectedObjectKeys(
  payload: unknown,
  allowedKeys: string[],
): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }

  const whitelist = new Set(allowedKeys);
  return Object.keys(payload as Record<string, unknown>).filter(
    (key) => !whitelist.has(key),
  );
}

export function validatePublicFieldSubmission(
  fields: PublicFieldConfig[],
  input: unknown,
): { sanitized?: Record<string, unknown>; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "fields payload must be an object" };
  }

  const submission = input as Record<string, unknown>;
  const allowedKeys = new Set(fields.map((field) => field.key));
  const unexpectedKeys = Object.keys(submission).filter((key) => !allowedKeys.has(key));
  if (unexpectedKeys.length) {
    return {
      error: `Submission includes fields not configured by owner: ${unexpectedKeys.join(", ")}`,
    };
  }

  const sanitized: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(submission, field.key)) {
      sanitized[field.key] = submission[field.key];
    }
  }

  const missingRequired = fields.find((field) => {
    if (!field.required) {
      return false;
    }
    const value = sanitized[field.key];
    if (typeof value === "boolean") {
      return !value;
    }
    if (typeof value === "string") {
      return value.trim().length === 0;
    }
    return value === undefined || value === null;
  });

  if (missingRequired) {
    return { error: `Missing required field: ${missingRequired.label}` };
  }

  return { sanitized };
}

export function findSubmissionValueByFieldType(
  fields: PublicFieldConfig[],
  submission: Record<string, unknown>,
  type: string,
): string | undefined {
  const target = type.trim().toLowerCase();
  for (const field of fields) {
    if (field.type.trim().toLowerCase() !== target) {
      continue;
    }
    const value = submission[field.key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function findSubmissionValueByKeyHints(
  submission: Record<string, unknown>,
  keyHints: string[],
): string | undefined {
  for (const hint of keyHints) {
    const key = normalizeFieldKey(hint);
    const value = submission[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
