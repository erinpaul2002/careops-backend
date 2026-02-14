import {
  Alert,
  AppState,
  AutomationEvent,
  Booking,
  Channel,
  Contact,
  Conversation,
  FormRequest,
  IdempotencyKey,
  IntegrationConnection,
  JobPriority,
  Message,
  ScheduledJob,
  Session,
  User,
  Workspace,
  WorkspaceMember,
} from "./types";
import {
  addDays,
  createId,
  createToken,
  nowIso,
  randomPublicToken,
  sha256,
} from "./core";
import {
  cleanupExpiredFromDatabase,
  persistEntity,
  removeEntityById,
} from "../database/persistence";
import { defaultPublicFlowConfig } from "./publicFlowConfig";
import { defaultWorkspaceAiConfig } from "./workspaceAiConfig";

const baseState: AppState = {
  users: [],
  workspaces: [],
  workspaceMembers: [],
  contacts: [],
  conversations: [],
  messages: [],
  services: [],
  availabilityRules: [],
  bookings: [],
  formTemplates: [],
  formRequests: [],
  inventoryItems: [],
  automationEvents: [],
  scheduledJobs: [],
  integrationConnections: [],
  idempotencyKeys: [],
  alerts: [],
  sessions: [],
};

export const state: AppState = structuredClone(baseState);

export function sanitizeUser(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _, ...rest } = user;
  return rest;
}

export function getWorkspacesForUser(userId: string): Workspace[] {
  const workspaceIds = state.workspaceMembers
    .filter((member) => member.userId === userId)
    .map((member) => member.workspaceId);
  return state.workspaces.filter((workspace) => workspaceIds.includes(workspace.id));
}

export function getMembership(
  userId: string,
  workspaceId: string,
): WorkspaceMember | undefined {
  return state.workspaceMembers.find(
    (member) => member.userId === userId && member.workspaceId === workspaceId,
  );
}

export function createSession(userId: string, ttlHours = 24): Session {
  const createdAt = nowIso();
  const session: Session = {
    id: createId(),
    userId,
    token: createToken(32),
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(Date.now() + ttlHours * 3_600_000).toISOString(),
  };
  state.sessions.push(session);
  void persistEntity("sessions", session);
  return session;
}

export function removeExpiredSessions(): void {
  const now = Date.now();
  for (let i = state.sessions.length - 1; i >= 0; i -= 1) {
    if (new Date(state.sessions[i].expiresAt).getTime() <= now) {
      const removed = state.sessions[i];
      state.sessions.splice(i, 1);
      void removeEntityById("sessions", removed.id);
    }
  }
}

export function createUser(input: {
  email: string;
  passwordHash: string;
  name: string;
  status?: User["status"];
}): User {
  const createdAt = nowIso();
  const user: User = {
    id: createId(),
    email: input.email.trim().toLowerCase(),
    passwordHash: input.passwordHash,
    name: input.name.trim(),
    status: input.status ?? "active",
    createdAt,
    updatedAt: createdAt,
  };
  state.users.push(user);
  void persistEntity("users", user);
  return user;
}

export function createWorkspace(input: {
  name: string;
  timezone: string;
  address?: string;
  contactEmail: string;
}): Workspace {
  const createdAt = nowIso();
  const workspaceId = createId();
  const workspace: Workspace = {
    id: workspaceId,
    name: input.name.trim(),
    slug: workspaceId.toLowerCase(),
    timezone: input.timezone,
    address: input.address ?? "",
    contactEmail: input.contactEmail.trim().toLowerCase(),
    onboardingStatus: "draft",
    onboardingSteps: {},
    publicFlowConfig: {
      booking: {
        fields: defaultPublicFlowConfig.booking.fields.map((field) => ({ ...field })),
      },
      contact: {
        fields: defaultPublicFlowConfig.contact.fields.map((field) => ({ ...field })),
      },
    },
    aiConfig: {
      ...defaultWorkspaceAiConfig,
    },
    createdAt,
    updatedAt: createdAt,
  };
  state.workspaces.push(workspace);
  void persistEntity("workspaces", workspace);
  return workspace;
}

export function addWorkspaceMember(input: {
  workspaceId: string;
  userId: string;
  role: "owner" | "staff";
}): WorkspaceMember {
  const createdAt = nowIso();
  const member: WorkspaceMember = {
    id: createId(),
    workspaceId: input.workspaceId,
    userId: input.userId,
    role: input.role,
    createdAt,
    updatedAt: createdAt,
  };
  state.workspaceMembers.push(member);
  void persistEntity("workspaceMembers", member);
  return member;
}

export function findOrCreateContact(input: {
  workspaceId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  customFields?: Record<string, unknown>;
  source: Contact["source"];
}): Contact {
  const normalizedEmail = input.email?.trim().toLowerCase();
  const normalizedPhone = input.phone?.trim();

  let existing = state.contacts.find(
    (contact) =>
      contact.workspaceId === input.workspaceId &&
      ((normalizedEmail && contact.email === normalizedEmail) ||
        (normalizedPhone && contact.phone === normalizedPhone)),
  );

  if (existing) {
    const now = nowIso();
    if (normalizedEmail && !existing.email) {
      existing.email = normalizedEmail;
    }
    if (normalizedPhone && !existing.phone) {
      existing.phone = normalizedPhone;
    }
    if (input.customFields && Object.keys(input.customFields).length) {
      existing.customFields = {
        ...(existing.customFields ?? {}),
        ...input.customFields,
      };
    }
    existing.updatedAt = now;
    void persistEntity("contacts", existing);
    return existing;
  }

  const createdAt = nowIso();
  existing = {
    id: createId(),
    workspaceId: input.workspaceId,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    email: normalizedEmail,
    phone: normalizedPhone,
    customFields:
      input.customFields && Object.keys(input.customFields).length
        ? input.customFields
        : undefined,
    source: input.source,
    tags: [],
    createdAt,
    updatedAt: createdAt,
  };
  state.contacts.push(existing);
  void persistEntity("contacts", existing);
  return existing;
}

export function getOrCreateConversation(input: {
  workspaceId: string;
  contactId: string;
  channel: Channel;
}): Conversation {
  const existing = state.conversations.find(
    (conversation) =>
      conversation.workspaceId === input.workspaceId &&
      conversation.contactId === input.contactId &&
      conversation.channel === input.channel,
  );
  if (existing) {
    return existing;
  }

  const createdAt = nowIso();
  const conversation: Conversation = {
    id: createId(),
    workspaceId: input.workspaceId,
    contactId: input.contactId,
    channel: input.channel,
    status: "open",
    automationPausedUntil: null,
    lastMessageAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
  state.conversations.push(conversation);
  void persistEntity("conversations", conversation);
  return conversation;
}

export function addMessage(input: {
  workspaceId: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  channel: Channel;
  body: string;
  providerMessageId?: string;
  metadata?: Record<string, unknown>;
}): Message {
  const createdAt = nowIso();
  const message: Message = {
    id: createId(),
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    direction: input.direction,
    channel: input.channel,
    providerMessageId: input.providerMessageId,
    body: input.body,
    metadata: input.metadata ?? {},
    createdAt,
    updatedAt: createdAt,
  };
  state.messages.push(message);
  void persistEntity("messages", message);

  const conversation = state.conversations.find(
    (item) =>
      item.id === input.conversationId && item.workspaceId === input.workspaceId,
  );
  if (conversation) {
    conversation.lastMessageAt = createdAt;
    conversation.updatedAt = createdAt;
    void persistEntity("conversations", conversation);
  }

  return message;
}

export function emitEvent(input: {
  workspaceId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
}): AutomationEvent {
  const eventHash = sha256(
    JSON.stringify({
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
    }),
  );
  const existing = state.automationEvents.find(
    (event) =>
      event.workspaceId === input.workspaceId &&
      event.eventType === input.eventType &&
      event.entityType === input.entityType &&
      event.entityId === input.entityId &&
      event.eventHash === eventHash,
  );
  if (existing) {
    return existing;
  }

  const createdAt = nowIso();
  const event: AutomationEvent = {
    id: createId(),
    workspaceId: input.workspaceId,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload,
    status: "processed",
    processedAt: createdAt,
    eventHash,
    createdAt,
    updatedAt: createdAt,
  };
  state.automationEvents.push(event);
  void persistEntity("automationEvents", event);
  return event;
}

export function createAlert(input: {
  workspaceId: string;
  type: string;
  severity: Alert["severity"];
  message: string;
  link?: string;
}): Alert {
  const createdAt = nowIso();
  const alert: Alert = {
    id: createId(),
    workspaceId: input.workspaceId,
    type: input.type,
    severity: input.severity,
    message: input.message,
    link: input.link,
    createdAt,
    updatedAt: createdAt,
  };
  state.alerts.push(alert);
  void persistEntity("alerts", alert);
  return alert;
}

export function enqueueJob(input: {
  workspaceId: string;
  jobType: ScheduledJob["jobType"];
  runAt: string;
  payload: Record<string, unknown>;
  priority?: JobPriority;
}): ScheduledJob {
  const createdAt = nowIso();
  const job: ScheduledJob = {
    id: createId(),
    workspaceId: input.workspaceId,
    jobType: input.jobType,
    runAt: input.runAt,
    status: "queued",
    priority: input.priority ?? "normal",
    payload: input.payload,
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
  };
  state.scheduledJobs.push(job);
  void persistEntity("scheduledJobs", job);
  return job;
}

export function upsertIntegrationConnection(input: {
  workspaceId: string;
  provider: IntegrationConnection["provider"];
  status: IntegrationConnection["status"];
  scopes?: string[];
  encryptedTokens?: string;
  errorMessage?: string;
  lastSyncAt?: string;
}): IntegrationConnection {
  const existing = state.integrationConnections.find(
    (connection) =>
      connection.workspaceId === input.workspaceId &&
      connection.provider === input.provider,
  );

  const now = nowIso();
  if (existing) {
    existing.status = input.status;
    existing.scopes = input.scopes ?? existing.scopes;
    existing.encryptedTokens = input.encryptedTokens ?? existing.encryptedTokens;
    existing.errorMessage = input.errorMessage;
    existing.lastSyncAt = input.lastSyncAt ?? existing.lastSyncAt;
    existing.updatedAt = now;
    void persistEntity("integrationConnections", existing);
    return existing;
  }

  const connection: IntegrationConnection = {
    id: createId(),
    workspaceId: input.workspaceId,
    provider: input.provider,
    status: input.status,
    scopes: input.scopes ?? [],
    encryptedTokens: input.encryptedTokens,
    errorMessage: input.errorMessage,
    lastSyncAt: input.lastSyncAt,
    createdAt: now,
    updatedAt: now,
  };
  state.integrationConnections.push(connection);
  void persistEntity("integrationConnections", connection);
  return connection;
}

export function createFormRequest(input: {
  workspaceId: string;
  bookingId: string;
  contactId: string;
  templateId: string;
  dueAt: string;
}): FormRequest {
  const createdAt = nowIso();
  const request: FormRequest = {
    id: createId(),
    workspaceId: input.workspaceId,
    bookingId: input.bookingId,
    contactId: input.contactId,
    templateId: input.templateId,
    status: "pending",
    dueAt: input.dueAt,
    publicToken: randomPublicToken(),
    createdAt,
    updatedAt: createdAt,
  };
  state.formRequests.push(request);
  void persistEntity("formRequests", request);
  enqueueJob({
    workspaceId: input.workspaceId,
    jobType: "form.overdue_check",
    runAt: addDays(request.createdAt, 2),
    payload: { formRequestId: request.id },
    priority: "normal",
  });
  return request;
}

export function findIdempotency(
  workspaceId: string,
  key: string,
  method: string,
  path: string,
): IdempotencyKey | undefined {
  return state.idempotencyKeys.find(
    (item) =>
      item.workspaceId === workspaceId &&
      item.key === key &&
      item.method === method &&
      item.path === path,
  );
}

export function saveIdempotency(input: {
  workspaceId: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
  responseSnapshot: unknown;
}): IdempotencyKey {
  const createdAt = nowIso();
  const record: IdempotencyKey = {
    id: createId(),
    workspaceId: input.workspaceId,
    key: input.key,
    method: input.method,
    path: input.path,
    requestHash: input.requestHash,
    responseSnapshot: input.responseSnapshot,
    expiresAt: addDays(createdAt, 1),
    createdAt,
    updatedAt: createdAt,
  };
  state.idempotencyKeys.push(record);
  void persistEntity("idempotencyKeys", record);
  return record;
}

export function cleanupExpiredRecords(): void {
  const now = Date.now();
  const nowDate = new Date(now);
  removeExpiredSessions();
  for (let i = state.idempotencyKeys.length - 1; i >= 0; i -= 1) {
    if (new Date(state.idempotencyKeys[i].expiresAt).getTime() <= now) {
      const removed = state.idempotencyKeys[i];
      state.idempotencyKeys.splice(i, 1);
      void removeEntityById("idempotencyKeys", removed.id);
    }
  }
  void cleanupExpiredFromDatabase(nowDate);
}

export function isBookingOverlapping(
  workspaceId: string,
  startsAt: string,
  endsAt: string,
  excludeBookingId?: string,
): boolean {
  return state.bookings.some((booking: Booking) => {
    if (booking.workspaceId !== workspaceId) {
      return false;
    }
    if (excludeBookingId && booking.id === excludeBookingId) {
      return false;
    }
    if (booking.status === "cancelled" || booking.status === "no_show") {
      return false;
    }
    return (
      new Date(startsAt) < new Date(booking.endsAt) &&
      new Date(booking.startsAt) < new Date(endsAt)
    );
  });
}

export function createWorkspaceAndOwner(input: {
  ownerUserId: string;
  name: string;
  timezone: string;
  address?: string;
  contactEmail: string;
}): Workspace {
  const workspace = createWorkspace({
    name: input.name,
    timezone: input.timezone,
    address: input.address,
    contactEmail: input.contactEmail,
  });
  addWorkspaceMember({
    workspaceId: workspace.id,
    userId: input.ownerUserId,
    role: "owner",
  });
  return workspace;
}
