import { NextFunction, Request, Response } from "express";
import { state } from "./store";
import { User, Workspace, WorkspaceMember } from "./types";

export interface AuthenticatedRequest extends Request {
  user: User;
  workspace?: Workspace;
  membership?: WorkspaceMember;
}

function getBearerToken(header?: string): string | null {
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }
  return token;
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = getBearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const session = state.sessions.find((item) => item.token === token);
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  const user = state.users.find((item) => item.id === session.userId);
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  (req as AuthenticatedRequest).user = user;
  next();
}

export function requireWorkspace(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authReq = req as AuthenticatedRequest;
  const user = authReq.user;

  const workspaceIdHeader = req.header("x-workspace-id");
  const userMemberships = state.workspaceMembers.filter(
    (member) => member.userId === user.id,
  );

  if (!userMemberships.length) {
    res.status(403).json({ error: "User is not assigned to any workspace" });
    return;
  }

  const membership = workspaceIdHeader
    ? userMemberships.find((item) => item.workspaceId === workspaceIdHeader)
    : userMemberships[0];

  if (!membership) {
    res
      .status(403)
      .json({ error: "Workspace access denied. Use x-workspace-id header." });
    return;
  }

  const workspace = state.workspaces.find(
    (item) => item.id === membership.workspaceId,
  );
  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }

  authReq.workspace = workspace;
  authReq.membership = membership;
  next();
}

export function requireOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authReq = req as AuthenticatedRequest;
  if (authReq.membership?.role !== "owner") {
    res.status(403).json({ error: "Owner role required" });
    return;
  }
  next();
}
