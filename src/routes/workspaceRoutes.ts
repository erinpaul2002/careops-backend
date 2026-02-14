import { Request, Response, Router } from "express";
import {
  AuthenticatedRequest,
  requireAuth,
  requireOwner,
  requireWorkspace,
} from "../utils/auth";
import {
  addWorkspaceMember,
  createUser,
  createWorkspaceAndOwner,
  getMembership,
  sanitizeUser,
  state,
} from "../utils/store";
import { createToken, hashPassword, nowIso } from "../utils/core";
import { getOptionalString, getString } from "../utils/http";
import { persistEntity, removeEntityById } from "../database/persistence";
import {
  getWorkspacePublicFlowConfig,
  mergePublicFlowConfig,
} from "../utils/publicFlowConfig";
import {
  getWorkspaceAiConfig,
  mergeWorkspaceAiConfig,
} from "../utils/workspaceAiConfig";
import { isGroqConfigured } from "../utils/groq";
import {
  evaluateWorkspaceReadiness,
} from "../utils/workspaceReadiness";

export function createWorkspaceRoutes(): Router {
  const router = Router();

  router.get("/public/:workspaceId/public-flow-config", (req, res) => {
    const workspace = state.workspaces.find(
      (item) => item.id === req.params.workspaceId,
    );
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }

    res.json({ publicFlowConfig: getWorkspacePublicFlowConfig(workspace) });
  });

  const createWorkspace = (req: Request, res: Response): void => {
    const typedReq = req as AuthenticatedRequest;
    const name = getString(typedReq.body?.name);
    const timezone = getOptionalString(typedReq.body?.timezone) ?? "UTC";
    const address = getOptionalString(typedReq.body?.address);
    const contactEmail = getOptionalString(typedReq.body?.contactEmail) ?? typedReq.user.email;
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const workspace = createWorkspaceAndOwner({
      ownerUserId: typedReq.user.id,
      name,
      timezone,
      address,
      contactEmail,
    });

    res.status(201).json({ workspace });
  };

  router.post("/", requireAuth, createWorkspace);
  router.post("/workspaces", requireAuth, createWorkspace);

  router.get("/public-flow-config", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const config = getWorkspacePublicFlowConfig(authReq.workspace!);
    res.json({ publicFlowConfig: config });
  });

  router.get("/workspace-readiness", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const readiness = evaluateWorkspaceReadiness(authReq.workspace!);
    res.json({ readiness });
  });

  router.patch(
    "/public-flow-config",
    requireAuth,
    requireWorkspace,
    (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const workspace = authReq.workspace!;
      const currentConfig = getWorkspacePublicFlowConfig(workspace);
      const mergedConfig = mergePublicFlowConfig(req.body, currentConfig);

      if (!mergedConfig) {
        res.status(400).json({
          error: "Invalid public flow config payload.",
        });
        return;
      }

      workspace.publicFlowConfig = mergedConfig;
      workspace.updatedAt = nowIso();
      void persistEntity("workspaces", workspace);
      res.json({ publicFlowConfig: mergedConfig });
    },
  );

  router.get("/ai-config", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const aiConfig = getWorkspaceAiConfig(authReq.workspace!);
    res.json({
      aiConfig,
      groqConfigured: isGroqConfigured(),
    });
  });

  router.patch(
    "/ai-config",
    requireAuth,
    requireWorkspace,
    requireOwner,
    (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const workspace = authReq.workspace!;
      const currentConfig = getWorkspaceAiConfig(workspace);
      const mergedConfig = mergeWorkspaceAiConfig(req.body, currentConfig);

      if (!mergedConfig) {
        res.status(400).json({
          error: "Invalid AI config payload.",
        });
        return;
      }

      workspace.aiConfig = mergedConfig;
      workspace.updatedAt = nowIso();
      void persistEntity("workspaces", workspace);
      res.json({
        aiConfig: mergedConfig,
        groqConfigured: isGroqConfigured(),
      });
    },
  );

  const patchOnboarding = (req: Request, res: Response): void => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = getString(req.params.id);

    if (!getMembership(authReq.user.id, workspaceId)) {
      res.status(403).json({ error: "Workspace access denied" });
      return;
    }

    const workspace = state.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }

    const onboardingSteps = req.body?.onboardingSteps as
      | Record<string, unknown>
      | undefined;
    const step = getOptionalString(req.body?.step);
    const completed = req.body?.completed;

    if (onboardingSteps && typeof onboardingSteps === "object") {
      for (const [key, value] of Object.entries(onboardingSteps)) {
        workspace.onboardingSteps[key] = Boolean(value);
      }
    } else if (step) {
      workspace.onboardingSteps[step] = Boolean(completed);
    } else {
      res.status(400).json({ error: "Provide onboardingSteps or step/completed" });
      return;
    }

    workspace.updatedAt = nowIso();
    void persistEntity("workspaces", workspace);
    res.json({ workspace });
  };

  router.patch("/:id/onboarding", requireAuth, patchOnboarding);
  router.patch("/workspaces/:id/onboarding", requireAuth, patchOnboarding);

  const activateWorkspace = (req: Request, res: Response): void => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = getString(req.params.id);

    const membership = getMembership(authReq.user.id, workspaceId);
    if (!membership) {
      res.status(403).json({ error: "Workspace access denied" });
      return;
    }
    if (membership.role !== "owner") {
      res.status(403).json({ error: "Only workspace owner can activate workspace" });
      return;
    }

    const workspace = state.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }

    const readiness = evaluateWorkspaceReadiness(workspace);
    const missingSteps = readiness.missingSteps;
    if (missingSteps.length) {
      res.status(400).json({
        error: "Cannot activate workspace. Missing onboarding steps.",
        missingSteps,
      });
      return;
    }

    workspace.onboardingStatus = "active";
    workspace.updatedAt = nowIso();
    void persistEntity("workspaces", workspace);
    res.json({ workspace });
  };

  router.post("/:id/activate", requireAuth, activateWorkspace);
  router.post("/workspaces/:id/activate", requireAuth, activateWorkspace);

  const deactivateWorkspace = (req: Request, res: Response): void => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = getString(req.params.id);

    const membership = getMembership(authReq.user.id, workspaceId);
    if (!membership) {
      res.status(403).json({ error: "Workspace access denied" });
      return;
    }
    if (membership.role !== "owner") {
      res.status(403).json({ error: "Only workspace owner can deactivate workspace" });
      return;
    }

    const workspace = state.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }

    workspace.onboardingStatus = "draft";
    workspace.updatedAt = nowIso();
    void persistEntity("workspaces", workspace);
    res.json({ workspace });
  };

  router.post("/:id/deactivate", requireAuth, deactivateWorkspace);
  router.post("/workspaces/:id/deactivate", requireAuth, deactivateWorkspace);

  router.get("/workspaces/:id/members", requireAuth, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = getString(req.params.id);

    const requesterMembership = getMembership(authReq.user.id, workspaceId);
    if (!requesterMembership) {
      res.status(403).json({ error: "Workspace access denied" });
      return;
    }
    if (requesterMembership.role !== "owner") {
      res.status(403).json({ error: "Owner role required" });
      return;
    }

    const workspace = state.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }

    const members = state.workspaceMembers
      .filter((member) => member.workspaceId === workspaceId)
      .map((member) => {
        const user = state.users.find((entry) => entry.id === member.userId);
        return {
          ...member,
          user: user ? sanitizeUser(user) : null,
        };
      });

    res.json({ workspace, data: members });
  });

  router.post("/workspaces/:id/members", requireAuth, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = getString(req.params.id);
    const requesterMembership = getMembership(authReq.user.id, workspaceId);

    if (!requesterMembership) {
      res.status(403).json({ error: "Workspace access denied" });
      return;
    }
    if (requesterMembership.role !== "owner") {
      res.status(403).json({ error: "Owner role required" });
      return;
    }

    const workspace = state.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }

    const roleRaw = getOptionalString(req.body?.role);
    const role = roleRaw === "owner" ? "owner" : "staff";
    const userId = getOptionalString(req.body?.userId);
    const email = getOptionalString(req.body?.email)?.toLowerCase();
    const name = getOptionalString(req.body?.name) ?? email ?? "Invited User";
    const password = getOptionalString(req.body?.password);

    if (role === "staff" && !password) {
      res.status(400).json({ error: "password is required for staff account creation" });
      return;
    }
    if (password && password.length < 8) {
      res.status(400).json({ error: "password must have at least 8 characters" });
      return;
    }

    let user =
      (userId ? state.users.find((candidate) => candidate.id === userId) : undefined) ??
      (email ? state.users.find((candidate) => candidate.email === email) : undefined);

    if (!user && !email) {
      res.status(400).json({ error: "Provide either userId or email" });
      return;
    }

    if (!user) {
      user = createUser({
        email: email!,
        name,
        passwordHash: hashPassword(password ?? createToken(16)),
        status: password ? "active" : "invited",
      });
    } else if (password) {
      user.passwordHash = hashPassword(password);
      user.status = "active";
      user.updatedAt = nowIso();
      void persistEntity("users", user);
    }

    const existingMember = getMembership(user.id, workspaceId);
    if (existingMember) {
      res.status(409).json({ error: "User is already a workspace member" });
      return;
    }

    const member = addWorkspaceMember({
      workspaceId,
      userId: user.id,
      role,
    });
    res.status(201).json({ member, user: sanitizeUser(user) });
  });

  router.delete("/workspaces/:id/members/:userId", requireAuth, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = getString(req.params.id);
    const userId = getString(req.params.userId);

    const requesterMembership = getMembership(authReq.user.id, workspaceId);
    if (!requesterMembership) {
      res.status(403).json({ error: "Workspace access denied" });
      return;
    }
    if (requesterMembership.role !== "owner") {
      res.status(403).json({ error: "Owner role required" });
      return;
    }

    const memberIndex = state.workspaceMembers.findIndex(
      (member) => member.workspaceId === workspaceId && member.userId === userId,
    );
    if (memberIndex === -1) {
      res.status(404).json({ error: "member not found" });
      return;
    }

    const member = state.workspaceMembers[memberIndex];
    if (member.role === "owner") {
      const ownerCount = state.workspaceMembers.filter(
        (entry) => entry.workspaceId === workspaceId && entry.role === "owner",
      ).length;
      if (ownerCount <= 1) {
        res.status(409).json({ error: "Cannot remove the only owner" });
        return;
      }
    }

    state.workspaceMembers.splice(memberIndex, 1);
    void removeEntityById("workspaceMembers", member.id);
    res.json({ success: true });
  });

  router.patch("/workspaces/:id/members/:userId/role", requireAuth, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = getString(req.params.id);
    const userId = getString(req.params.userId);
    const roleInput = getString(req.body?.role);

    if (roleInput !== "owner" && roleInput !== "staff") {
      res.status(400).json({ error: "role must be owner or staff" });
      return;
    }

    const requesterMembership = getMembership(authReq.user.id, workspaceId);
    if (!requesterMembership) {
      res.status(403).json({ error: "Workspace access denied" });
      return;
    }
    if (requesterMembership.role !== "owner") {
      res.status(403).json({ error: "Owner role required" });
      return;
    }

    const member = getMembership(userId, workspaceId);
    if (!member) {
      res.status(404).json({ error: "member not found" });
      return;
    }

    if (member.role === "owner" && roleInput === "staff") {
      const ownerCount = state.workspaceMembers.filter(
        (entry) => entry.workspaceId === workspaceId && entry.role === "owner",
      ).length;
      if (ownerCount <= 1) {
        res.status(409).json({ error: "Cannot demote the only owner" });
        return;
      }
    }

    member.role = roleInput;
    member.updatedAt = nowIso();
    void persistEntity("workspaceMembers", member);

    res.json({ member });
  });

  return router;
}
