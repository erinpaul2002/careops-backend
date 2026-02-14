export type Role = "owner" | "staff";
export type Channel = "email" | "sms";
export type ConversationStatus = "open" | "pending" | "closed";
export type BookingStatus =
  | "pending"
  | "confirmed"
  | "completed"
  | "no_show"
  | "cancelled";
export type FormRequestStatus = "pending" | "completed" | "overdue";
export type JobStatus = "queued" | "running" | "done" | "failed";
export type JobPriority = "high" | "normal" | "low";
export type IntegrationProvider =
  | "gmail"
  | "google_calendar"
  | "twilio";
export type IntegrationStatus = "connected" | "error" | "disconnected";

export interface BaseEntity {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface User extends BaseEntity {
  email: string;
  passwordHash: string;
  name: string;
  status: "invited" | "active" | "disabled";
}

export interface Workspace extends BaseEntity {
  name: string;
  slug: string;
  timezone: string;
  address: string;
  contactEmail: string;
  onboardingStatus: "draft" | "active";
  onboardingSteps: Record<string, boolean>;
  publicFlowConfig?: PublicFlowConfig;
  aiConfig?: WorkspaceAiConfig;
}

export interface PublicFieldConfig {
  key: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string;
}

export interface PublicFlowConfig {
  booking: {
    fields: PublicFieldConfig[];
  };
  contact: {
    fields: PublicFieldConfig[];
  };
}

export interface WorkspaceAiConfig {
  contactAutoReplyEnabled: boolean;
  inboxReplyAssistEnabled: boolean;
}

export interface WorkspaceMember extends BaseEntity {
  workspaceId: string;
  userId: string;
  role: Role;
}

export interface Contact extends BaseEntity {
  workspaceId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  customFields?: Record<string, unknown>;
  source: "contact_form" | "booking_flow" | "import" | "manual";
  tags: string[];
  deletedAt?: string;
}

export interface Conversation extends BaseEntity {
  workspaceId: string;
  contactId: string;
  channel: Channel;
  status: ConversationStatus;
  automationPausedUntil: string | null;
  lastMessageAt: string;
}

export interface Message extends BaseEntity {
  workspaceId: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  channel: Channel;
  providerMessageId?: string;
  body: string;
  metadata: Record<string, unknown>;
}

export interface ServiceInventoryRule {
  itemId: string;
  quantity: number;
}

export interface Service extends BaseEntity {
  workspaceId: string;
  name: string;
  durationMin: number;
  locationType: "in_person" | "virtual";
  inventoryRules: ServiceInventoryRule[];
  bookingFormTemplateId?: string;
  isActive: boolean;
}

export interface AvailabilityRule extends BaseEntity {
  workspaceId: string;
  serviceId: string;
  ruleType?: "weekly" | "date_override" | "date_block";
  weekday?: number;
  date?: string;
  startTime?: string;
  endTime?: string;
  bufferMin?: number;
  slotIntervalMin?: number;
  isClosedAllDay?: boolean;
}

export interface Booking extends BaseEntity {
  workspaceId: string;
  contactId: string;
  serviceId: string;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  calendarEventId?: string;
  notes?: string;
  customFields?: Record<string, unknown>;
  deletedAt?: string;
}

export interface FormTemplate extends BaseEntity {
  workspaceId: string;
  name: string;
  fields: Record<string, unknown>[];
  trigger: "post_booking";
  isActive: boolean;
}

export interface FormRequest extends BaseEntity {
  workspaceId: string;
  bookingId: string;
  contactId: string;
  templateId: string;
  status: FormRequestStatus;
  dueAt: string;
  completedAt?: string;
  publicToken: string;
  submission?: Record<string, unknown>;
}

export interface InventoryItem extends BaseEntity {
  workspaceId: string;
  name: string;
  unit: string;
  quantityOnHand: number;
  lowStockThreshold: number;
  isActive: boolean;
}

export interface AutomationEvent extends BaseEntity {
  workspaceId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  processedAt?: string;
  status: "queued" | "processed" | "failed";
  eventHash: string;
}

export interface ScheduledJob extends BaseEntity {
  workspaceId: string;
  jobType: "booking.reminder" | "form.overdue_check";
  runAt: string;
  status: JobStatus;
  priority: JobPriority;
  payload: Record<string, unknown>;
  attempts: number;
  lastError?: string;
  lockedAt?: string;
  lockOwner?: string;
}

export interface IntegrationConnection extends BaseEntity {
  workspaceId: string;
  provider: IntegrationProvider;
  status: IntegrationStatus;
  scopes: string[];
  encryptedTokens?: string;
  lastSyncAt?: string;
  errorMessage?: string;
}

export interface IdempotencyKey extends BaseEntity {
  workspaceId: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
  responseSnapshot: unknown;
  expiresAt: string;
}

export interface Alert extends BaseEntity {
  workspaceId: string;
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
  link?: string;
}

export interface Session extends BaseEntity {
  userId: string;
  token: string;
  expiresAt: string;
}

export interface AppState {
  users: User[];
  workspaces: Workspace[];
  workspaceMembers: WorkspaceMember[];
  contacts: Contact[];
  conversations: Conversation[];
  messages: Message[];
  services: Service[];
  availabilityRules: AvailabilityRule[];
  bookings: Booking[];
  formTemplates: FormTemplate[];
  formRequests: FormRequest[];
  inventoryItems: InventoryItem[];
  automationEvents: AutomationEvent[];
  scheduledJobs: ScheduledJob[];
  integrationConnections: IntegrationConnection[];
  idempotencyKeys: IdempotencyKey[];
  alerts: Alert[];
  sessions: Session[];
}
