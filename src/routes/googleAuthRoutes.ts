import { Router } from "express";
import { handleGoogleOAuthCallback } from "./integrationRoutes";

export function createGoogleAuthRoutes(): Router {
  const router = Router();

  router.get("/google/callback", (req, res) => {
    void handleGoogleOAuthCallback(req, res);
  });

  return router;
}
