import { Router } from "express";
import { createAdminRoutes } from "./adminRoutes";
import { createAuthRoutes } from "./authRoutes";
import { createBookingRoutes } from "./bookingRoutes";
import { createContactRoutes } from "./contactRoutes";
import { createDashboardRoutes } from "./dashboardRoutes";
import { createFormRoutes } from "./formRoutes";
import { createInboxRoutes } from "./inboxRoutes";
import { createIntegrationRoutes } from "./integrationRoutes";
import { createInventoryRoutes } from "./inventoryRoutes";
import { createServiceRoutes } from "./serviceRoutes";
import { createUserRoutes } from "./userRoutes";
import { createWebhookRoutes } from "./webhookRoutes";
import { createWorkspaceRoutes } from "./workspaceRoutes";

export function createApiRouter(): Router {
  const router = Router();

  router.use("/auth", createAuthRoutes());
  router.use("/", createWorkspaceRoutes());
  router.use("/", createContactRoutes());
  router.use("/", createBookingRoutes());
  router.use("/", createInboxRoutes());
  router.use("/", createWebhookRoutes());
  router.use("/", createFormRoutes());
  router.use("/", createInventoryRoutes());
  router.use("/", createDashboardRoutes());
  router.use("/", createServiceRoutes());
  router.use("/", createIntegrationRoutes());
  router.use("/", createUserRoutes());
  router.use("/", createAdminRoutes());

  return router;
}
