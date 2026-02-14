import { Router } from "express";
import {
  AuthenticatedRequest,
  requireAuth,
  requireWorkspace,
} from "../utils/auth";
import { createAlert, emitEvent, state } from "../utils/store";
import { createId, nowIso } from "../utils/core";
import { getOptionalString, getString } from "../utils/http";
import { persistEntity } from "../database/persistence";

export function createInventoryRoutes(): Router {
  const router = Router();

  router.get("/inventory-items", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const data = state.inventoryItems.filter(
      (item) => item.workspaceId === authReq.workspace!.id && item.isActive,
    );
    res.json({ data });
  });

  router.get("/inventory-items/:id", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const item = state.inventoryItems.find(
      (entry) =>
        entry.id === req.params.id &&
        entry.workspaceId === authReq.workspace!.id &&
        entry.isActive,
    );
    if (!item) {
      res.status(404).json({ error: "inventory item not found" });
      return;
    }
    res.json({ item });
  });

  router.post(
    "/inventory-items",
    requireAuth,
    requireWorkspace,
    (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const name = getString(req.body?.name);
      const unit = getString(req.body?.unit);
      const quantityOnHand = Number(req.body?.quantityOnHand);
      const lowStockThreshold = Number(req.body?.lowStockThreshold);

      if (
        !name ||
        !unit ||
        !Number.isFinite(quantityOnHand) ||
        !Number.isFinite(lowStockThreshold)
      ) {
        res.status(400).json({
          error: "name, unit, quantityOnHand and lowStockThreshold are required",
        });
        return;
      }
      if (quantityOnHand < 0 || lowStockThreshold < 0) {
        res
          .status(400)
          .json({ error: "quantityOnHand and lowStockThreshold must be >= 0" });
        return;
      }

      const createdAt = nowIso();
      const item = {
        id: createId(),
        workspaceId: authReq.workspace!.id,
        name,
        unit,
        quantityOnHand,
        lowStockThreshold,
        isActive: true,
        createdAt,
        updatedAt: createdAt,
      };
      state.inventoryItems.push(item);
      void persistEntity("inventoryItems", item);

      res.status(201).json({ item });
    },
  );

  router.patch(
    "/inventory-items/:id",
    requireAuth,
    requireWorkspace,
    (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const item = state.inventoryItems.find(
        (entry) =>
          entry.id === req.params.id && entry.workspaceId === authReq.workspace!.id,
      );
      if (!item) {
        res.status(404).json({ error: "inventory item not found" });
        return;
      }

      const name = getOptionalString(req.body?.name);
      const unit = getOptionalString(req.body?.unit);
      const lowStockThreshold = req.body?.lowStockThreshold;
      const isActive = req.body?.isActive;

      if (name !== undefined) {
        item.name = name;
      }
      if (unit !== undefined) {
        item.unit = unit;
      }
      if (lowStockThreshold !== undefined) {
        const parsedThreshold = Number(lowStockThreshold);
        if (!Number.isFinite(parsedThreshold) || parsedThreshold < 0) {
          res.status(400).json({ error: "lowStockThreshold must be >= 0" });
          return;
        }
        item.lowStockThreshold = parsedThreshold;
      }
      if (isActive !== undefined) {
        item.isActive = Boolean(isActive);
      }

      item.updatedAt = nowIso();
      void persistEntity("inventoryItems", item);
      res.json({ item });
    },
  );

  router.post(
    "/inventory-items/:id/adjust",
    requireAuth,
    requireWorkspace,
    (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const item = state.inventoryItems.find(
        (entry) =>
          entry.id === req.params.id && entry.workspaceId === authReq.workspace!.id,
      );
      if (!item) {
        res.status(404).json({ error: "inventory item not found" });
        return;
      }

      const delta = Number(req.body?.delta);
      if (!Number.isFinite(delta) || delta === 0) {
        res.status(400).json({ error: "delta must be a non-zero number" });
        return;
      }
      if (item.quantityOnHand + delta < 0) {
        res.status(409).json({ error: "inventory quantity cannot be negative" });
        return;
      }

      item.quantityOnHand += delta;
      item.updatedAt = nowIso();
      void persistEntity("inventoryItems", item);
      if (item.quantityOnHand <= item.lowStockThreshold) {
        createAlert({
          workspaceId: item.workspaceId,
          type: "inventory.low_stock",
          severity: "warning",
          message: `${item.name} is low on stock (${item.quantityOnHand} ${item.unit}).`,
        });
        emitEvent({
          workspaceId: item.workspaceId,
          eventType: "inventory.low_stock",
          entityType: "inventory_item",
          entityId: item.id,
          payload: {
            quantityOnHand: item.quantityOnHand,
            lowStockThreshold: item.lowStockThreshold,
          },
        });
      }

      res.json({ item });
    },
  );

  router.delete(
    "/inventory-items/:id",
    requireAuth,
    requireWorkspace,
    (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const item = state.inventoryItems.find(
        (entry) =>
          entry.id === req.params.id && entry.workspaceId === authReq.workspace!.id,
      );
      if (!item) {
        res.status(404).json({ error: "inventory item not found" });
        return;
      }

      item.isActive = false;
      item.updatedAt = nowIso();
      void persistEntity("inventoryItems", item);
      res.json({ success: true, item });
    },
  );

  return router;
}
