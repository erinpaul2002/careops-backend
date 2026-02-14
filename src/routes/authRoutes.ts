import { Router } from "express";
import { requireAuth, requireOwner, requireWorkspace } from "../utils/auth";
import {
  addWorkspaceMember,
  createSession,
  createUser,
  createWorkspaceAndOwner,
  getWorkspacesForUser,
  sanitizeUser,
  state,
} from "../utils/store";
import {
  addHours,
  createToken,
  hashPassword,
  nowIso,
  verifyPassword,
} from "../utils/core";
import { AuthenticatedRequest } from "../utils/auth";
import { getOptionalString, getString } from "../utils/http";
import { persistEntity } from "../database/persistence";

interface InviteRecord {
  token: string;
  workspaceId: string;
  userId: string;
  role: "owner" | "staff";
  expiresAt: string;
}

const inviteStore = new Map<string, InviteRecord>();

export function createAuthRoutes(): Router {
  const router = Router();

  router.post("/register-owner", (req, res) => {
    const name = getString(req.body?.name);
    const email = getString(req.body?.email).toLowerCase();
    const password = getString(req.body?.password);

    if (!name || !email || !password) {
      res.status(400).json({ error: "name, email and password are required" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "password must have at least 8 characters" });
      return;
    }
    if (state.users.some((user) => user.email === email)) {
      res.status(409).json({ error: "user already exists" });
      return;
    }

    const user = createUser({
      name,
      email,
      passwordHash: hashPassword(password),
    });
    const session = createSession(user.id);

    const workspaceName = getOptionalString(req.body?.workspaceName);
    let workspace = undefined;

    if (workspaceName) {
      workspace = createWorkspaceAndOwner({
        ownerUserId: user.id,
        name: workspaceName,
        timezone: getOptionalString(req.body?.timezone) ?? "UTC",
        address: getOptionalString(req.body?.address),
        contactEmail: getOptionalString(req.body?.contactEmail) ?? email,
      });
    }

    res.status(201).json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: sanitizeUser(user),
      workspace,
    });
  });

  router.post("/login", (req, res) => {
    const email = getString(req.body?.email).toLowerCase();
    const password = getString(req.body?.password);

    if (!email || !password) {
      res.status(400).json({ error: "email and password are required" });
      return;
    }

    const user = state.users.find((item) => item.email === email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    const hasOwnerMembership = state.workspaceMembers.some(
      (member) => member.userId === user.id && member.role === "owner",
    );
    if (!hasOwnerMembership) {
      res.status(403).json({
        error: "Staff users must sign in with email and password",
      });
      return;
    }

    const session = createSession(user.id);
    res.json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: sanitizeUser(user),
    });
  });

  router.post("/staff-login", (req, res) => {
    const email = getString(req.body?.email).toLowerCase();
    const password = getString(req.body?.password);

    if (!email || !password) {
      res.status(400).json({ error: "email and password are required" });
      return;
    }

    const user = state.users.find((item) => item.email === email);
    if (
      !user ||
      user.status !== "active" ||
      !verifyPassword(password, user.passwordHash)
    ) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }

    const membership = state.workspaceMembers.find(
      (member) => member.userId === user.id && member.role === "staff",
    );
    if (!membership) {
      res.status(403).json({ error: "owner users must use owner login" });
      return;
    }

    const workspace = state.workspaces.find(
      (item) => item.id === membership.workspaceId,
    );
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }

    const session = createSession(user.id);
    res.json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: sanitizeUser(user),
      workspace: {
        ...workspace,
        role: membership.role,
      },
    });
  });

  router.get("/me", requireAuth, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const workspaces = getWorkspacesForUser(authReq.user.id).map((workspace) => {
      const membership = state.workspaceMembers.find(
        (member) =>
          member.workspaceId === workspace.id && member.userId === authReq.user.id,
      );
      return {
        ...workspace,
        role: membership?.role ?? "staff",
      };
    });

    res.json({
      user: sanitizeUser(authReq.user),
      workspaces,
    });
  });

  router.post("/invite", requireAuth, requireWorkspace, requireOwner, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = authReq.workspace!.id;

    const email = getOptionalString(req.body?.email)?.toLowerCase();
    const userId = getOptionalString(req.body?.userId);
    const name = getOptionalString(req.body?.name) ?? "Invited User";
    const roleRaw = getOptionalString(req.body?.role);
    const role = roleRaw === "owner" ? "owner" : "staff";

    let user =
      (userId ? state.users.find((candidate) => candidate.id === userId) : undefined) ??
      (email ? state.users.find((candidate) => candidate.email === email) : undefined);

    if (!user && !email) {
      res.status(400).json({ error: "Provide either email or userId" });
      return;
    }

    if (!user) {
      user = createUser({
        email: email!,
        name,
        passwordHash: hashPassword(createToken(16)),
        status: "invited",
      });
    }

    const existingMembership = state.workspaceMembers.find(
      (member) => member.workspaceId === workspaceId && member.userId === user.id,
    );
    if (existingMembership) {
      res.status(409).json({ error: "User is already a workspace member" });
      return;
    }

    const member = addWorkspaceMember({
      workspaceId,
      userId: user.id,
      role,
    });

    const token = createToken(24);
    const expiresAt = addHours(nowIso(), 72);
    inviteStore.set(token, {
      token,
      workspaceId,
      userId: user.id,
      role: member.role,
      expiresAt,
    });

    res.status(201).json({
      invitation: {
        token,
        expiresAt,
        workspaceId,
        role: member.role,
        user: sanitizeUser(user),
      },
    });
  });

  router.post("/accept-invite", (req, res) => {
    const token = getString(req.body?.token);
    const password = getString(req.body?.password);
    const name = getOptionalString(req.body?.name);

    if (!token || !password) {
      res.status(400).json({ error: "token and password are required" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "password must have at least 8 characters" });
      return;
    }

    const invite = inviteStore.get(token);
    if (!invite) {
      res.status(404).json({ error: "invite not found or expired" });
      return;
    }
    if (new Date(invite.expiresAt).getTime() <= Date.now()) {
      inviteStore.delete(token);
      res.status(410).json({ error: "invite has expired" });
      return;
    }

    const user = state.users.find((candidate) => candidate.id === invite.userId);
    if (!user) {
      inviteStore.delete(token);
      res.status(404).json({ error: "invited user not found" });
      return;
    }

    user.passwordHash = hashPassword(password);
    user.status = "active";
    if (name) {
      user.name = name;
    }
    user.updatedAt = nowIso();
    void persistEntity("users", user);

    inviteStore.delete(token);

    const session = createSession(user.id);
    const workspaces = getWorkspacesForUser(user.id).map((workspace) => {
      const membership = state.workspaceMembers.find(
        (member) => member.workspaceId === workspace.id && member.userId === user.id,
      );
      return {
        ...workspace,
        role: membership?.role ?? "staff",
      };
    });

    res.json({
      token: session.token,
      expiresAt: session.expiresAt,
      user: sanitizeUser(user),
      workspaces,
    });
  });

  return router;
}
