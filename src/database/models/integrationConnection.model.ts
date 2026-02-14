import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const integrationConnectionSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    provider: {
      type: String,
      enum: ["gmail", "google_calendar", "twilio"],
      required: true,
    },
    status: { type: String, enum: ["connected", "error", "disconnected"], required: true },
    scopes: { type: [String], default: [] },
    encryptedTokens: { type: String },
    lastSyncAt: { type: Date },
    errorMessage: { type: String },
  },
  commonSchemaOptions,
);
integrationConnectionSchema.index({ workspaceId: 1, provider: 1 }, { unique: true });
integrationConnectionSchema.index({ workspaceId: 1, status: 1 });

export const IntegrationConnectionModel =
  models.IntegrationConnection ??
  model("IntegrationConnection", integrationConnectionSchema, "integration_connections");

