import { Request, Response, Router } from "express";
import {
  AuthenticatedRequest,
  requireAuth,
  requireOwner,
  requireWorkspace,
} from "../utils/auth";
import { nowIso } from "../utils/core";
import { getOptionalString } from "../utils/http";
import { state } from "../utils/store";
import { persistEntity } from "../database/persistence";
import {
  completeGoogleOAuthCallback,
  createGoogleConnectAuthUrl,
  getGoogleOAuthRedirectUrl,
  syncGoogleConnection,
} from "../utils/googleIntegration";

type GoogleConnectProviderSlug = "gmail" | "google-calendar";

function startGoogleConnect(
  provider: GoogleConnectProviderSlug,
): (req: Request, res: Response) => void {
  return (req, res) => {
    const authReq = req as AuthenticatedRequest;
    try {
      const authUrl = createGoogleConnectAuthUrl({
        provider,
        workspaceId: authReq.workspace!.id,
        userId: authReq.user.id,
      });
      res.json({
        provider,
        authUrl,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to start Google OAuth flow",
      });
    }
  };
}

export async function handleGoogleOAuthCallback(
  req: Request,
  res: Response,
): Promise<void> {
  const code = getOptionalString(req.query.code);
  const stateToken = getOptionalString(req.query.state);
  const format = getOptionalString(req.query.format);
  const wantsJson = format === "json";

  if (!code || !stateToken) {
    if (wantsJson) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }
    res.redirect(
      getGoogleOAuthRedirectUrl({
        status: "error",
        message: "Missing OAuth callback parameters",
      }),
    );
    return;
  }

  try {
    const result = await completeGoogleOAuthCallback({
      code,
      stateToken,
    });
    if (wantsJson) {
      res.status(201).json({ connection: result.connection });
      return;
    }

    res.redirect(
      getGoogleOAuthRedirectUrl({
        status: "success",
        provider: result.provider,
      }),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Google integration callback failed";
    if (wantsJson) {
      res.status(400).json({ error: message });
      return;
    }
    res.redirect(
      getGoogleOAuthRedirectUrl({
        status: "error",
        message,
      }),
    );
  }
}

export function createIntegrationRoutes(): Router {
  const router = Router();

  router.get("/integrations", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const provider = getOptionalString(req.query.provider);
    let data = state.integrationConnections.filter(
      (connection) => connection.workspaceId === authReq.workspace!.id,
    );
    if (provider) {
      data = data.filter((connection) => connection.provider === provider);
    }
    res.json({ data });
  });

  router.post(
    "/integrations/google-calendar/connect",
    requireAuth,
    requireWorkspace,
    requireOwner,
    startGoogleConnect("google-calendar"),
  );

  router.post(
    "/integrations/gmail/connect",
    requireAuth,
    requireWorkspace,
    requireOwner,
    startGoogleConnect("gmail"),
  );

  router.get("/integrations/google/callback", (req, res) => {
    void handleGoogleOAuthCallback(req, res);
  });

  router.delete("/integrations/:id", requireAuth, requireWorkspace, requireOwner, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const connection = state.integrationConnections.find(
      (entry) => entry.id === req.params.id && entry.workspaceId === authReq.workspace!.id,
    );
    if (!connection) {
      res.status(404).json({ error: "integration not found" });
      return;
    }

    connection.status = "disconnected";
    connection.errorMessage = undefined;
    connection.lastSyncAt = nowIso();
    connection.updatedAt = nowIso();
    void persistEntity("integrationConnections", connection);
    res.json({ connection });
  });

  router.post(
    "/integrations/:id/sync",
    requireAuth,
    requireWorkspace,
    requireOwner,
    async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const connection = state.integrationConnections.find(
        (entry) => entry.id === req.params.id && entry.workspaceId === authReq.workspace!.id,
      );
      if (!connection) {
        res.status(404).json({ error: "integration not found" });
        return;
      }
      if (connection.status !== "connected") {
        res.status(409).json({ error: "Integration must be connected before syncing" });
        return;
      }

      if (
        connection.provider === "gmail" ||
        connection.provider === "google_calendar"
      ) {
        const result = await syncGoogleConnection(authReq.workspace!.id, connection.provider);
        if (!result.success) {
          res.status(502).json({ error: "Google sync failed", connection });
          return;
        }
      } else {
        connection.lastSyncAt = nowIso();
        connection.updatedAt = nowIso();
        await persistEntity("integrationConnections", connection);
      }

      const refreshedConnection = state.integrationConnections.find(
        (entry) => entry.id === connection.id,
      );
      res.json({ success: true, connection: refreshedConnection ?? connection });
    },
  );

  return router;
}
