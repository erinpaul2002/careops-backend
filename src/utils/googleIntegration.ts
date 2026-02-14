import crypto from "crypto";
import { Booking, Contact, IntegrationConnection, Service, Workspace } from "./types";
import { createToken, nowIso } from "./core";
import { state, upsertIntegrationConnection } from "./store";
import { persistEntity } from "../database/persistence";

type GoogleProvider = "gmail" | "google_calendar";
type GoogleConnectProviderSlug = "gmail" | "google-calendar";

interface GoogleOAuthStatePayload {
  workspaceId: string;
  userId: string;
  provider: GoogleProvider;
  redirectUri: string;
  nonce: string;
  issuedAt: number;
}

interface GoogleTokenPayload {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
  tokenType?: string;
  scope?: string;
  idToken?: string;
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
}

interface CalendarEventResponse {
  id?: string;
}

interface GmailMessageResponse {
  id?: string;
  threadId?: string;
  payload?: {
    headers?: Array<{
      name?: string;
      value?: string;
    }>;
  };
}

interface GmailMessageMetadata {
  threadId?: string;
  rfcMessageId?: string;
  references?: string;
}

const GOOGLE_AUTH_BASE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_GMAIL_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

function providerFromSlug(provider: GoogleConnectProviderSlug): GoogleProvider {
  return provider === "google-calendar" ? "google_calendar" : "gmail";
}

export function providerToSlug(provider: GoogleProvider): GoogleConnectProviderSlug {
  return provider === "google_calendar" ? "google-calendar" : "gmail";
}

function scopesForProvider(provider: GoogleProvider): string[] {
  if (provider === "gmail") {
    return [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
    ];
  }
  return [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.readonly",
  ];
}

function getGoogleClientId(): string {
  const value = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!value) {
    throw new Error("GOOGLE_CLIENT_ID is not configured");
  }
  return value;
}

function getGoogleClientSecret(): string {
  const value = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!value) {
    throw new Error("GOOGLE_CLIENT_SECRET is not configured");
  }
  return value;
}

function getGoogleRedirectUri(): string {
  const configured = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (configured) {
    return configured;
  }
  const port = process.env.PORT?.trim() || "8000";
  return `http://localhost:${port}/api/v1/integrations/google/callback`;
}

function getOAuthStateSecret(): string {
  const value =
    process.env.OAUTH_STATE_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!value) {
    throw new Error("OAUTH_STATE_SECRET or JWT_SECRET must be configured");
  }
  return value;
}

function getFrontendSettingsUrl(): string {
  const configured = process.env.INTEGRATIONS_OAUTH_REDIRECT_URL?.trim();
  if (configured) {
    return configured;
  }
  const frontendUrl = process.env.FRONTEND_URL?.trim();
  if (frontendUrl) {
    return `${frontendUrl.replace(/\/$/, "")}/onboarding`;
  }
  return "http://localhost:3000/onboarding";
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(value: string): string {
  return crypto.createHmac("sha256", getOAuthStateSecret()).update(value).digest("base64url");
}

function createSignedOAuthState(payload: GoogleOAuthStatePayload): string {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function parseSignedOAuthState(rawState: string): GoogleOAuthStatePayload {
  const [encodedPayload, signature] = rawState.split(".");
  if (!encodedPayload || !signature) {
    throw new Error("Invalid OAuth state");
  }

  const expectedSignature = signPayload(encodedPayload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw new Error("OAuth state signature mismatch");
  }

  const parsed = JSON.parse(fromBase64Url(encodedPayload)) as Partial<GoogleOAuthStatePayload>;
  if (
    !parsed.workspaceId ||
    !parsed.userId ||
    !parsed.provider ||
    !parsed.redirectUri ||
    !parsed.issuedAt
  ) {
    throw new Error("OAuth state payload is incomplete");
  }

  if (parsed.provider !== "gmail" && parsed.provider !== "google_calendar") {
    throw new Error("Unsupported OAuth provider");
  }

  if (Date.now() - parsed.issuedAt > OAUTH_STATE_MAX_AGE_MS) {
    throw new Error("OAuth state has expired");
  }

  return {
    workspaceId: parsed.workspaceId,
    userId: parsed.userId,
    provider: parsed.provider,
    redirectUri: parsed.redirectUri,
    nonce: parsed.nonce ?? "",
    issuedAt: parsed.issuedAt,
  };
}

function encodeTokens(tokens: GoogleTokenPayload): string {
  return Buffer.from(JSON.stringify(tokens)).toString("base64");
}

function decodeTokens(raw?: string): GoogleTokenPayload | null {
  if (!raw) {
    return null;
  }

  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Partial<GoogleTokenPayload>;
    if (!parsed.accessToken) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiryDate: parsed.expiryDate,
      tokenType: parsed.tokenType,
      scope: parsed.scope,
      idToken: parsed.idToken,
    };
  } catch {
    return {
      accessToken: raw,
    };
  }
}

function normalizeScopeList(scopeText?: string): string[] {
  if (!scopeText) {
    return [];
  }
  return scopeText
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toGoogleTokenPayload(
  tokenResponse: GoogleTokenResponse,
  fallbackRefreshToken?: string,
): GoogleTokenPayload {
  const expiresAt =
    typeof tokenResponse.expires_in === "number"
      ? Date.now() + tokenResponse.expires_in * 1000
      : undefined;

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? fallbackRefreshToken,
    expiryDate: expiresAt,
    tokenType: tokenResponse.token_type,
    scope: tokenResponse.scope,
    idToken: tokenResponse.id_token,
  };
}

function getConnectedConnection(
  workspaceId: string,
  provider: GoogleProvider,
): IntegrationConnection | null {
  const connection = state.integrationConnections.find(
    (entry) =>
      entry.workspaceId === workspaceId &&
      entry.provider === provider &&
      entry.status === "connected",
  );
  return connection ?? null;
}

async function markConnectionError(
  connection: IntegrationConnection,
  errorMessage: string,
): Promise<void> {
  connection.status = "error";
  connection.errorMessage = errorMessage;
  connection.updatedAt = nowIso();
  await persistEntity("integrationConnections", connection);
}

async function exchangeAuthorizationCode(input: {
  code: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code: input.code,
    client_id: getGoogleClientId(),
    client_secret: getGoogleClientSecret(),
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = (await response.json().catch(() => ({}))) as Partial<
    GoogleTokenResponse
  > & {
    error?: string;
    error_description?: string;
  };
  if (!response.ok || typeof payload.access_token !== "string") {
    const detail =
      typeof payload.error_description === "string"
        ? payload.error_description
        : typeof payload.error === "string"
          ? payload.error
          : `OAuth token exchange failed with status ${response.status}`;
    throw new Error(detail);
  }
  return payload as GoogleTokenResponse;
}

async function refreshAccessToken(
  connection: IntegrationConnection,
  refreshToken: string,
): Promise<GoogleTokenPayload | null> {
  const body = new URLSearchParams({
    client_id: getGoogleClientId(),
    client_secret: getGoogleClientSecret(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<
    GoogleTokenResponse
  > & {
    error?: string;
    error_description?: string;
  };

  if (!response.ok || typeof payload.access_token !== "string") {
    const detail =
      typeof payload.error_description === "string"
        ? payload.error_description
        : typeof payload.error === "string"
          ? payload.error
          : `Google token refresh failed with status ${response.status}`;
    await markConnectionError(connection, detail);
    return null;
  }

  const nextTokens = toGoogleTokenPayload(payload as GoogleTokenResponse, refreshToken);
  connection.encryptedTokens = encodeTokens(nextTokens);
  connection.scopes = normalizeScopeList(payload.scope);
  connection.errorMessage = undefined;
  connection.updatedAt = nowIso();
  await persistEntity("integrationConnections", connection);
  return nextTokens;
}

async function getValidAccessToken(
  connection: IntegrationConnection,
): Promise<string | null> {
  const parsed = decodeTokens(connection.encryptedTokens);
  if (!parsed?.accessToken) {
    await markConnectionError(connection, "Missing Google access token");
    return null;
  }

  if (!parsed.expiryDate || parsed.expiryDate > Date.now() + 60_000) {
    return parsed.accessToken;
  }

  if (!parsed.refreshToken) {
    await markConnectionError(connection, "Google refresh token is missing");
    return null;
  }

  const refreshed = await refreshAccessToken(connection, parsed.refreshToken);
  if (!refreshed?.accessToken) {
    return null;
  }
  return refreshed.accessToken;
}

async function googleApiRequest<T>(
  connection: IntegrationConnection,
  input: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    body?: Record<string, unknown>;
    tolerateNotFound?: boolean;
  },
): Promise<T | null> {
  const accessToken = await getValidAccessToken(connection);
  if (!accessToken) {
    return null;
  }

  const response = await fetch(input.url, {
    method: input.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });

  if (input.tolerateNotFound && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    await markConnectionError(
      connection,
      detail || `Google API request failed with status ${response.status}`,
    );
    return null;
  }

  const raw = await response.text().catch(() => "");
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as T;
}

function buildCalendarEventPayload(input: {
  booking: Booking;
  contact: Contact;
  service: Service;
  workspace: Workspace;
}): Record<string, unknown> {
  const fullName = `${input.contact.firstName} ${input.contact.lastName}`.trim();
  const descriptionParts = [
    `CareOps booking id: ${input.booking.id}`,
    `Service: ${input.service.name}`,
    `Client: ${fullName || "Unknown client"}`,
  ];

  if (input.contact.email) {
    descriptionParts.push(`Email: ${input.contact.email}`);
  }
  if (input.contact.phone) {
    descriptionParts.push(`Phone: ${input.contact.phone}`);
  }
  if (input.booking.notes) {
    descriptionParts.push(`Notes: ${input.booking.notes}`);
  }

  return {
    summary: `${input.service.name} - ${fullName || "Client"}`,
    description: descriptionParts.join("\n"),
    start: {
      dateTime: input.booking.startsAt,
      timeZone: input.workspace.timezone || "UTC",
    },
    end: {
      dateTime: input.booking.endsAt,
      timeZone: input.workspace.timezone || "UTC",
    },
    attendees: input.contact.email
      ? [
          {
            email: input.contact.email,
            displayName: fullName || undefined,
          },
        ]
      : undefined,
  };
}

function toUrlSafeBase64(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sanitizeHeaderValue(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const safe = value.replace(/[\r\n]+/g, " ").trim();
  return safe || undefined;
}

function getHeaderValue(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string | undefined {
  if (!headers?.length) {
    return undefined;
  }
  const target = name.trim().toLowerCase();
  if (!target) {
    return undefined;
  }
  const match = headers.find((header) => header.name?.trim().toLowerCase() === target);
  return match?.value;
}

function joinReferences(
  references: string | undefined,
  inReplyToMessageId: string | undefined,
): string | undefined {
  if (!inReplyToMessageId) {
    return references;
  }
  if (!references) {
    return inReplyToMessageId;
  }
  if (references.includes(inReplyToMessageId)) {
    return references;
  }
  return `${references} ${inReplyToMessageId}`;
}

async function getGmailMessageMetadata(
  connection: IntegrationConnection,
  providerMessageId: string,
): Promise<GmailMessageMetadata | null> {
  const safeProviderMessageId = providerMessageId.trim();
  if (!safeProviderMessageId) {
    return null;
  }

  const accessToken = await getValidAccessToken(connection);
  if (!accessToken) {
    return null;
  }

  const response = await fetch(
    `${GOOGLE_GMAIL_BASE_URL}/messages/${encodeURIComponent(safeProviderMessageId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json().catch(() => ({}))) as GmailMessageResponse;
  return {
    threadId: sanitizeHeaderValue(payload.threadId),
    rfcMessageId: sanitizeHeaderValue(getHeaderValue(payload.payload?.headers, "Message-ID")),
    references: sanitizeHeaderValue(getHeaderValue(payload.payload?.headers, "References")),
  };
}

export function createGoogleConnectAuthUrl(input: {
  provider: GoogleConnectProviderSlug;
  workspaceId: string;
  userId: string;
}): string {
  const provider = providerFromSlug(input.provider);
  const redirectUri = getGoogleRedirectUri();
  const oauthState = createSignedOAuthState({
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider,
    redirectUri,
    nonce: createToken(12),
    issuedAt: Date.now(),
  });

  const params = new URLSearchParams({
    client_id: getGoogleClientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: scopesForProvider(provider).join(" "),
    state: oauthState,
  });

  return `${GOOGLE_AUTH_BASE_URL}?${params.toString()}`;
}

export async function completeGoogleOAuthCallback(input: {
  code: string;
  stateToken: string;
}): Promise<{
  connection: IntegrationConnection;
  provider: GoogleProvider;
  workspaceId: string;
}> {
  const oauthState = parseSignedOAuthState(input.stateToken);
  const tokenResponse = await exchangeAuthorizationCode({
    code: input.code,
    redirectUri: oauthState.redirectUri,
  });
  const parsedTokens = toGoogleTokenPayload(tokenResponse);

  if (!parsedTokens.accessToken) {
    throw new Error("Google OAuth token exchange did not return an access token");
  }

  const connection = upsertIntegrationConnection({
    workspaceId: oauthState.workspaceId,
    provider: oauthState.provider,
    status: "connected",
    scopes: normalizeScopeList(tokenResponse.scope),
    encryptedTokens: encodeTokens(parsedTokens),
    errorMessage: undefined,
    lastSyncAt: nowIso(),
  });

  return {
    connection,
    provider: oauthState.provider,
    workspaceId: oauthState.workspaceId,
  };
}

export function getGoogleOAuthRedirectUrl(input: {
  status: "success" | "error";
  provider?: GoogleProvider;
  message?: string;
}): string {
  const redirectUrl = new URL(getFrontendSettingsUrl());
  redirectUrl.searchParams.set("integration_oauth", input.status);
  if (input.provider) {
    redirectUrl.searchParams.set("provider", providerToSlug(input.provider));
  }
  if (input.message) {
    redirectUrl.searchParams.set("message", input.message);
  }
  return redirectUrl.toString();
}

export async function syncGoogleConnection(
  workspaceId: string,
  provider: GoogleProvider,
): Promise<{ success: boolean; syncedCount: number }> {
  const connection = getConnectedConnection(workspaceId, provider);
  if (!connection) {
    return { success: false, syncedCount: 0 };
  }

  if (provider === "gmail") {
    const payload = await googleApiRequest<{ messages?: Array<{ id: string }> }>(connection, {
      method: "GET",
      url: `${GOOGLE_GMAIL_BASE_URL}/messages?maxResults=10`,
    });
    if (!payload) {
      return { success: false, syncedCount: 0 };
    }
    const count = payload?.messages?.length ?? 0;
    connection.lastSyncAt = nowIso();
    connection.errorMessage = undefined;
    connection.updatedAt = nowIso();
    await persistEntity("integrationConnections", connection);
    return { success: true, syncedCount: count };
  }

  const payload = await googleApiRequest<{ items?: Array<{ id: string }> }>(connection, {
    method: "GET",
    url: `${GOOGLE_CALENDAR_BASE_URL}?maxResults=25&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(nowIso())}`,
  });
  if (!payload) {
    return { success: false, syncedCount: 0 };
  }
  const count = payload?.items?.length ?? 0;
  connection.lastSyncAt = nowIso();
  connection.errorMessage = undefined;
  connection.updatedAt = nowIso();
  await persistEntity("integrationConnections", connection);
  return { success: true, syncedCount: count };
}

export async function sendGmailMessageIfConnected(input: {
  workspaceId: string;
  to: string;
  body: string;
  htmlBody?: string;
  subject?: string;
  threadId?: string;
  inReplyToMessageId?: string;
  references?: string;
  replyToProviderMessageId?: string;
}): Promise<{
  deliveryStatus: "sent" | "not_connected" | "failed";
  failureReason?: string;
  providerMessageId?: string;
  providerThreadId?: string;
  rfcMessageId?: string;
  references?: string;
}> {
  const connection = getConnectedConnection(input.workspaceId, "gmail");
  if (!connection) {
    return {
      deliveryStatus: "not_connected",
      failureReason: "Gmail integration is not connected",
    };
  }

  const safeTo = input.to.replace(/[\r\n]+/g, " ").trim();
  const safeSubject = (input.subject?.trim() || "CareOps update")
    .replace(/[\r\n]+/g, " ")
    .trim();

  let threadId = sanitizeHeaderValue(input.threadId);
  let inReplyToMessageId = sanitizeHeaderValue(input.inReplyToMessageId);
  let references = sanitizeHeaderValue(input.references);

  const replyToProviderMessageId = input.replyToProviderMessageId?.trim();
  if (replyToProviderMessageId && (!threadId || !inReplyToMessageId || !references)) {
    const repliedMessageMetadata = await getGmailMessageMetadata(
      connection,
      replyToProviderMessageId,
    );
    if (repliedMessageMetadata) {
      threadId = threadId ?? repliedMessageMetadata.threadId;
      inReplyToMessageId = inReplyToMessageId ?? repliedMessageMetadata.rfcMessageId;
      references =
        references ?? repliedMessageMetadata.references ?? repliedMessageMetadata.rfcMessageId;
    }
  }
  references = joinReferences(references, inReplyToMessageId);

  const replyHeaders: string[] = [];
  if (inReplyToMessageId) {
    replyHeaders.push(`In-Reply-To: ${inReplyToMessageId}`);
  }
  if (references) {
    replyHeaders.push(`References: ${references}`);
  }

  const htmlBody = input.htmlBody?.trim();
  let rawMime = "";
  if (htmlBody) {
    const boundary = `careops-${crypto.randomBytes(8).toString("hex")}`;
    rawMime = [
      `To: ${safeTo}`,
      `Subject: ${safeSubject}`,
      ...replyHeaders,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      input.body,
      "",
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      htmlBody,
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else {
    rawMime = [
      `To: ${safeTo}`,
      `Subject: ${safeSubject}`,
      ...replyHeaders,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      input.body,
    ].join("\r\n");
  }

  const payload = await googleApiRequest<{ id?: string; threadId?: string }>(connection, {
    method: "POST",
    url: `${GOOGLE_GMAIL_BASE_URL}/messages/send`,
    body: {
      raw: toUrlSafeBase64(rawMime),
      ...(threadId ? { threadId } : {}),
    },
  });

  if (!payload?.id) {
    return {
      deliveryStatus: "failed",
      failureReason:
        connection.errorMessage?.trim() || "Gmail API did not return a sent message id",
    };
  }

  const sentMessageMetadata = await getGmailMessageMetadata(connection, payload.id);

  connection.lastSyncAt = nowIso();
  connection.errorMessage = undefined;
  connection.updatedAt = nowIso();
  await persistEntity("integrationConnections", connection);

  return {
    deliveryStatus: "sent",
    providerMessageId: payload.id,
    providerThreadId:
      sanitizeHeaderValue(payload.threadId) ?? sentMessageMetadata?.threadId ?? threadId,
    rfcMessageId: sentMessageMetadata?.rfcMessageId,
    references: sentMessageMetadata?.references ?? references,
  };
}

export async function upsertBookingCalendarEventIfConnected(input: {
  booking: Booking;
  workspace: Workspace;
  contact: Contact;
  service: Service;
}): Promise<{ eventId?: string }> {
  const connection = getConnectedConnection(input.booking.workspaceId, "google_calendar");
  if (!connection) {
    return {};
  }

  const eventPayload = buildCalendarEventPayload(input);
  const eventId = input.booking.calendarEventId;
  const response = eventId
    ? await googleApiRequest<CalendarEventResponse>(connection, {
        method: "PATCH",
        url: `${GOOGLE_CALENDAR_BASE_URL}/${encodeURIComponent(eventId)}`,
        body: eventPayload,
      })
    : await googleApiRequest<CalendarEventResponse>(connection, {
        method: "POST",
        url: GOOGLE_CALENDAR_BASE_URL,
        body: eventPayload,
      });

  if (!response?.id) {
    return {};
  }

  connection.lastSyncAt = nowIso();
  connection.errorMessage = undefined;
  connection.updatedAt = nowIso();
  await persistEntity("integrationConnections", connection);

  return {
    eventId: response.id,
  };
}

export async function deleteBookingCalendarEventIfConnected(input: {
  workspaceId: string;
  eventId?: string;
}): Promise<void> {
  if (!input.eventId) {
    return;
  }

  const connection = getConnectedConnection(input.workspaceId, "google_calendar");
  if (!connection) {
    return;
  }

  await googleApiRequest(connection, {
    method: "DELETE",
    url: `${GOOGLE_CALENDAR_BASE_URL}/${encodeURIComponent(input.eventId)}`,
    tolerateNotFound: true,
  });

  connection.lastSyncAt = nowIso();
  connection.errorMessage = undefined;
  connection.updatedAt = nowIso();
  await persistEntity("integrationConnections", connection);
}
