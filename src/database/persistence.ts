import { Model } from "mongoose";
import {
  AlertModel,
  AutomationEventModel,
  AvailabilityRuleModel,
  BookingModel,
  ContactModel,
  ConversationModel,
  FormRequestModel,
  FormTemplateModel,
  IdempotencyKeyModel,
  IntegrationConnectionModel,
  InventoryItemModel,
  MessageModel,
  ScheduledJobModel,
  ServiceModel,
  SessionModel,
  UserModel,
  WorkspaceMemberModel,
  WorkspaceModel,
} from "./models";
import { isDatabaseConnected } from "./connection";
import { AppState } from "../utils/types";

type PersistedCollection = keyof AppState;
type AnyEntity = AppState[PersistedCollection][number];
type LeanEntity = Record<string, unknown>;

const dateFields: Record<PersistedCollection, string[]> = {
  users: [],
  workspaces: [],
  workspaceMembers: [],
  contacts: ["deletedAt"],
  conversations: ["automationPausedUntil", "lastMessageAt"],
  messages: [],
  services: [],
  availabilityRules: [],
  bookings: ["startsAt", "endsAt", "deletedAt"],
  formTemplates: [],
  formRequests: ["dueAt", "completedAt"],
  inventoryItems: [],
  automationEvents: ["processedAt"],
  scheduledJobs: ["runAt", "lockedAt"],
  integrationConnections: ["lastSyncAt"],
  idempotencyKeys: ["expiresAt"],
  alerts: ["resolvedAt"],
  sessions: ["expiresAt"],
};

const modelByCollection: Record<PersistedCollection, Model<any>> = {
  users: UserModel,
  workspaces: WorkspaceModel,
  workspaceMembers: WorkspaceMemberModel,
  contacts: ContactModel,
  conversations: ConversationModel,
  messages: MessageModel,
  services: ServiceModel,
  availabilityRules: AvailabilityRuleModel,
  bookings: BookingModel,
  formTemplates: FormTemplateModel,
  formRequests: FormRequestModel,
  inventoryItems: InventoryItemModel,
  automationEvents: AutomationEventModel,
  scheduledJobs: ScheduledJobModel,
  integrationConnections: IntegrationConnectionModel,
  idempotencyKeys: IdempotencyKeyModel,
  alerts: AlertModel,
  sessions: SessionModel,
};

function toIsoString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return undefined;
}

function toDateValue(value: unknown): Date | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return undefined;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const next = { ...obj };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) {
      delete next[key];
    }
  }
  return next;
}

function deserializeEntity<T extends AnyEntity>(
  collection: PersistedCollection,
  raw: LeanEntity,
): T {
  const output: Record<string, unknown> = { ...raw };
  delete output._id;

  const createdAt = toIsoString(raw.createdAt);
  const updatedAt = toIsoString(raw.updatedAt);
  if (createdAt) {
    output.createdAt = createdAt;
  }
  if (updatedAt) {
    output.updatedAt = updatedAt;
  }

  for (const field of dateFields[collection]) {
    const currentValue = raw[field];
    if (currentValue === null) {
      output[field] = null;
      continue;
    }
    const parsed = toIsoString(currentValue);
    if (parsed) {
      output[field] = parsed;
    }
  }

  if (collection === "workspaces") {
    const onboarding = raw.onboardingSteps;
    if (onboarding instanceof Map) {
      output.onboardingSteps = Object.fromEntries(onboarding.entries());
    } else if (onboarding && typeof onboarding === "object") {
      output.onboardingSteps = onboarding as Record<string, boolean>;
    } else {
      output.onboardingSteps = {};
    }
  }

  if (collection === "conversations" && output.automationPausedUntil === undefined) {
    output.automationPausedUntil = null;
  }

  return output as T;
}

function serializeEntity(
  collection: PersistedCollection,
  entity: AnyEntity,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...entity };
  output.createdAt = toDateValue(entity.createdAt);
  output.updatedAt = toDateValue(entity.updatedAt);

  for (const field of dateFields[collection]) {
    if (output[field] === null) {
      continue;
    }
    output[field] = toDateValue(output[field]);
  }

  return stripUndefined(output);
}

async function loadCollection<T extends AnyEntity>(
  collection: PersistedCollection,
): Promise<T[]> {
  const model = modelByCollection[collection];
  const rows = await model.find({}).lean().exec();
  return rows.map((row: LeanEntity) => deserializeEntity<T>(collection, row));
}

export async function hydrateStateFromDatabase(state: AppState): Promise<void> {
  if (!isDatabaseConnected()) {
    return;
  }

  const [
    users,
    workspaces,
    workspaceMembers,
    contacts,
    conversations,
    messages,
    services,
    availabilityRules,
    bookings,
    formTemplates,
    formRequests,
    inventoryItems,
    automationEvents,
    scheduledJobs,
    integrationConnections,
    idempotencyKeys,
    alerts,
    sessions,
  ] = await Promise.all([
    loadCollection("users"),
    loadCollection("workspaces"),
    loadCollection("workspaceMembers"),
    loadCollection("contacts"),
    loadCollection("conversations"),
    loadCollection("messages"),
    loadCollection("services"),
    loadCollection("availabilityRules"),
    loadCollection("bookings"),
    loadCollection("formTemplates"),
    loadCollection("formRequests"),
    loadCollection("inventoryItems"),
    loadCollection("automationEvents"),
    loadCollection("scheduledJobs"),
    loadCollection("integrationConnections"),
    loadCollection("idempotencyKeys"),
    loadCollection("alerts"),
    loadCollection("sessions"),
  ]);

  state.users = users as AppState["users"];
  state.workspaces = workspaces as AppState["workspaces"];
  state.workspaceMembers = workspaceMembers as AppState["workspaceMembers"];
  state.contacts = contacts as AppState["contacts"];
  state.conversations = conversations as AppState["conversations"];
  state.messages = messages as AppState["messages"];
  state.services = services as AppState["services"];
  state.availabilityRules = availabilityRules as AppState["availabilityRules"];
  state.bookings = bookings as AppState["bookings"];
  state.formTemplates = formTemplates as AppState["formTemplates"];
  state.formRequests = formRequests as AppState["formRequests"];
  state.inventoryItems = inventoryItems as AppState["inventoryItems"];
  state.automationEvents = automationEvents as AppState["automationEvents"];
  state.scheduledJobs = scheduledJobs as AppState["scheduledJobs"];
  state.integrationConnections = integrationConnections as AppState["integrationConnections"];
  state.idempotencyKeys = idempotencyKeys as AppState["idempotencyKeys"];
  state.alerts = alerts as AppState["alerts"];
  state.sessions = sessions as AppState["sessions"];
}

export async function persistEntity(
  collection: PersistedCollection,
  entity: AnyEntity,
): Promise<void> {
  if (!isDatabaseConnected()) {
    return;
  }
  const model = modelByCollection[collection];
  const serialized = serializeEntity(collection, entity);

  if (collection === "automationEvents") {
    const workspaceId = String(serialized.workspaceId ?? "");
    const eventType = String(serialized.eventType ?? "");
    const entityType = String(serialized.entityType ?? "");
    const entityId = String(serialized.entityId ?? "");
    const eventHash = String(serialized.eventHash ?? "");

    if (workspaceId && eventType && entityType && entityId && eventHash) {
      await model
        .updateOne(
          { workspaceId, eventType, entityType, entityId, eventHash },
          { $setOnInsert: serialized },
          { upsert: true, timestamps: false },
        )
        .exec();
      return;
    }
  }

  await model
    .updateOne({ id: entity.id }, { $set: serialized }, { upsert: true, timestamps: false })
    .exec();
}

export async function removeEntityById(
  collection: PersistedCollection,
  id: string,
): Promise<void> {
  if (!isDatabaseConnected()) {
    return;
  }
  const model = modelByCollection[collection];
  await model.deleteOne({ id }).exec();
}

export async function cleanupExpiredFromDatabase(now: Date): Promise<void> {
  if (!isDatabaseConnected()) {
    return;
  }
  await Promise.all([
    SessionModel.deleteMany({ expiresAt: { $lte: now } }).exec(),
    IdempotencyKeyModel.deleteMany({ expiresAt: { $lte: now } }).exec(),
  ]);
}
