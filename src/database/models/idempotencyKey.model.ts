import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const idempotencyKeySchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    method: { type: String, required: true },
    path: { type: String, required: true },
    requestHash: { type: String, required: true },
    responseSnapshot: { type: Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
  },
  commonSchemaOptions,
);
idempotencyKeySchema.index({ workspaceId: 1, key: 1, method: 1, path: 1 }, { unique: true });
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyKeyModel =
  models.IdempotencyKey ?? model("IdempotencyKey", idempotencyKeySchema, "idempotency_keys");

