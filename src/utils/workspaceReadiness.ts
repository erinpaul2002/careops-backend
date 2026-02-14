import { state } from "./store";
import { Workspace } from "./types";
import { getWorkspacePublicFlowConfig } from "./publicFlowConfig";

export const onboardingStepsRequired = [
  "workspace",
  "channels",
  "contact_form",
  "bookings",
  "forms",
  "inventory",
  "staff",
  "activation_review",
] as const;

type OnboardingStepKey = (typeof onboardingStepsRequired)[number];

export interface WorkspaceReadiness {
  onboardingStatus: Workspace["onboardingStatus"];
  completion: Record<OnboardingStepKey, boolean>;
  missingSteps: OnboardingStepKey[];
  warnings: string[];
  blockers: string[];
  canActivate: boolean;
}

export function evaluateWorkspaceReadiness(workspace: Workspace): WorkspaceReadiness {
  const publicFlowConfig = getWorkspacePublicFlowConfig(workspace);
  const activeServices = state.services.filter(
    (service) => service.workspaceId === workspace.id && service.isActive,
  );
  const activeServiceIds = new Set(activeServices.map((service) => service.id));
  const templates = state.formTemplates.filter(
    (template) => template.workspaceId === workspace.id && template.isActive,
  );
  const inventoryItems = state.inventoryItems.filter(
    (item) => item.workspaceId === workspace.id && item.isActive,
  );
  const members = state.workspaceMembers.filter(
    (member) => member.workspaceId === workspace.id,
  );
  const gmailConnected = state.integrationConnections.some(
    (connection) =>
      connection.workspaceId === workspace.id &&
      connection.provider === "gmail" &&
      connection.status === "connected",
  );
  const googleCalendarConnected = state.integrationConnections.some(
    (connection) =>
      connection.workspaceId === workspace.id &&
      connection.provider === "google_calendar" &&
      connection.status === "connected",
  );

  const completion: Record<OnboardingStepKey, boolean> = {
    workspace: Boolean(
      workspace.name.trim() &&
        workspace.timezone.trim() &&
        workspace.contactEmail.trim(),
    ),
    channels: gmailConnected && googleCalendarConnected,
    contact_form: (publicFlowConfig.contact.fields?.length ?? 0) > 0,
    bookings:
      activeServiceIds.size > 0 &&
      state.availabilityRules.some(
        (rule) =>
          rule.workspaceId === workspace.id &&
          activeServiceIds.has(rule.serviceId),
      ),
    forms: templates.some((template) => (template.fields?.length ?? 0) > 0),
    inventory: inventoryItems.length > 0,
    staff: members.some((member) => member.role === "staff"),
    activation_review: false,
  };
  completion.activation_review = (
    completion.workspace &&
    completion.channels &&
    completion.contact_form &&
    completion.bookings &&
    completion.forms &&
    completion.inventory &&
    completion.staff
  );

  const warnings: string[] = [];
  if (!gmailConnected) {
    warnings.push("Gmail is not connected. Automated emails will not be delivered.");
  }
  if (!googleCalendarConnected) {
    warnings.push("Google Calendar is not connected. Booking sync will not run.");
  }
  if (activeServiceIds.size === 0) {
    warnings.push("No active services found. Public booking cannot accept new bookings.");
  }
  if (!completion.contact_form) {
    warnings.push("Contact form fields are empty. Public contact submissions will fail validation.");
  }
  if (!completion.forms) {
    warnings.push("No active form template with fields is configured for post-booking forms.");
  }

  const missingSteps = onboardingStepsRequired.filter((step) => !completion[step]);
  return {
    onboardingStatus: workspace.onboardingStatus,
    completion,
    missingSteps,
    warnings,
    blockers: missingSteps.map((step) => `Onboarding step incomplete: ${step}`),
    canActivate: missingSteps.length === 0,
  };
}
