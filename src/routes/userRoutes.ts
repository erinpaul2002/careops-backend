import { Router } from "express";
import {
  AuthenticatedRequest,
  requireAuth,
  requireOwner,
  requireWorkspace,
} from "../utils/auth";
import { nowIso } from "../utils/core";
import { getOptionalString } from "../utils/http";
import { sanitizeUser, state } from "../utils/store";
import { persistEntity } from "../database/persistence";

export function createUserRoutes(): Router {
  const router = Router();

  router.get("/users", requireAuth, requireWorkspace, requireOwner, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = authReq.workspace!.id;

    const data = state.workspaceMembers
      .filter((member) => member.workspaceId === workspaceId)
      .map((member) => {
        const user = state.users.find((entry) => entry.id === member.userId);
        return {
          ...member,
          user: user ? sanitizeUser(user) : null,
        };
      });

    res.json({ data });
  });

  router.patch("/users/:id", requireAuth, requireWorkspace, requireOwner, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = authReq.workspace!.id;
    const userId = req.params.id;

    const member = state.workspaceMembers.find(
      (entry) => entry.workspaceId === workspaceId && entry.userId === userId,
    );
    if (!member) {
      res.status(404).json({ error: "user not found in workspace" });
      return;
    }

    const user = state.users.find((entry) => entry.id === userId);
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return;
    }

    const email = getOptionalString(req.body?.email)?.toLowerCase();
    const name = getOptionalString(req.body?.name);
    const status = getOptionalString(req.body?.status);

    if (email !== undefined) {
      const alreadyExists = state.users.some(
        (entry) => entry.email === email && entry.id !== user.id,
      );
      if (alreadyExists) {
        res.status(409).json({ error: "email already in use" });
        return;
      }
      user.email = email;
    }

    if (name !== undefined) {
      user.name = name;
    }

    if (status !== undefined) {
      if (status !== "invited" && status !== "active" && status !== "disabled") {
        res.status(400).json({ error: "status must be invited, active, or disabled" });
        return;
      }
      user.status = status;
    }

    user.updatedAt = nowIso();
    void persistEntity("users", user);

    res.json({ user: sanitizeUser(user) });
  });

  return router;
}
