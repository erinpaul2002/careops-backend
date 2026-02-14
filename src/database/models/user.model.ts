import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const userSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: ["invited", "active", "disabled"], required: true },
  },
  commonSchemaOptions,
);
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ status: 1, createdAt: -1 });

export const UserModel = models.User ?? model("User", userSchema, "users");

