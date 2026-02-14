import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const sessionSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    token: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true, index: true },
  },
  commonSchemaOptions,
);

export const SessionModel = models.Session ?? model("Session", sessionSchema, "sessions");

