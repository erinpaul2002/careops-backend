import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const inventoryItemSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    unit: { type: String, required: true, trim: true },
    quantityOnHand: { type: Number, required: true, min: 0 },
    lowStockThreshold: { type: Number, required: true, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  commonSchemaOptions,
);
inventoryItemSchema.index({ workspaceId: 1, isActive: 1, name: 1 });
inventoryItemSchema.index({ workspaceId: 1, quantityOnHand: 1 });

export const InventoryItemModel =
  models.InventoryItem ?? model("InventoryItem", inventoryItemSchema, "inventory_items");

