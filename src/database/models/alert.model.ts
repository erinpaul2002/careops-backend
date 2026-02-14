import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const alertSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    type: { type: String, required: true },
    severity: { type: String, enum: ["info", "warning", "critical"], required: true },
    message: { type: String, required: true },
    link: { type: String },
    resolvedAt: { type: Date },
  },
  commonSchemaOptions,
);
alertSchema.index({ workspaceId: 1, severity: 1, createdAt: -1 });
alertSchema.index({ workspaceId: 1, resolvedAt: 1 }, { sparse: true });
alertSchema.index({ workspaceId: 1, type: 1, resolvedAt: 1 }, { sparse: true });

export const AlertModel = models.Alert ?? model("Alert", alertSchema, "alerts");

