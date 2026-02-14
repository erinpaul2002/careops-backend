import { Router } from "express";
import { state } from "../utils/store";
import { nowIso } from "../utils/core";

export function createHealthRoutes(): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({
      name: "CareOps Backend",
      version: "mvp",
      basePath: "/api/v1",
    });
  });

  router.get("/health/live", (_req, res) => {
    res.json({ status: "ok", timestamp: nowIso() });
  });

  router.get("/health/ready", (_req, res) => {
    res.json({
      status: "ready",
      timestamp: nowIso(),
      counts: {
        users: state.users.length,
        workspaces: state.workspaces.length,
        sessions: state.sessions.length,
        jobs: state.scheduledJobs.length,
      },
    });
  });

  return router;
}
