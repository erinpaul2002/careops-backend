import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const workspaceMemberSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    role: { type: String, enum: ["owner", "staff"], required: true },
  },
  commonSchemaOptions,
);
workspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
workspaceMemberSchema.index({ userId: 1, workspaceId: 1 });
workspaceMemberSchema.index({ workspaceId: 1, role: 1 });

export const WorkspaceMemberModel =
  models.WorkspaceMember ??
  model("WorkspaceMember", workspaceMemberSchema, "workspace_members");
