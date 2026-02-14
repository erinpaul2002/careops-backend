import { Workspace, WorkspaceAiConfig } from "./types";

export const defaultWorkspaceAiConfig: WorkspaceAiConfig = {
  contactAutoReplyEnabled: false,
  inboxReplyAssistEnabled: false,
};

function toBooleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeWorkspaceAiConfig(input: unknown): WorkspaceAiConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...defaultWorkspaceAiConfig };
  }

  const payload = input as Record<string, unknown>;
  return {
    contactAutoReplyEnabled: toBooleanOrDefault(
      payload.contactAutoReplyEnabled,
      defaultWorkspaceAiConfig.contactAutoReplyEnabled,
    ),
    inboxReplyAssistEnabled: toBooleanOrDefault(
      payload.inboxReplyAssistEnabled,
      defaultWorkspaceAiConfig.inboxReplyAssistEnabled,
    ),
  };
}

export function getWorkspaceAiConfig(workspace: Workspace): WorkspaceAiConfig {
  return normalizeWorkspaceAiConfig(workspace.aiConfig);
}

export function mergeWorkspaceAiConfig(
  input: unknown,
  current: WorkspaceAiConfig,
): WorkspaceAiConfig | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const payload = input as Record<string, unknown>;
  return {
    contactAutoReplyEnabled: toBooleanOrDefault(
      payload.contactAutoReplyEnabled,
      current.contactAutoReplyEnabled,
    ),
    inboxReplyAssistEnabled: toBooleanOrDefault(
      payload.inboxReplyAssistEnabled,
      current.inboxReplyAssistEnabled,
    ),
  };
}
