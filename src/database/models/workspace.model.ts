import { Schema, model, models } from "mongoose";
import { commonSchemaOptions, formTemplateFieldSchema } from "./shared";

const workspaceSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    timezone: { type: String, required: true, trim: true },
    address: { type: String, default: "" },
    contactEmail: { type: String, required: true, lowercase: true, trim: true },
    onboardingStatus: { type: String, enum: ["draft", "active"], required: true },
    onboardingSteps: { type: Map, of: Boolean, default: {} },
    publicFlowConfig: {
      booking: {
        fields: { type: [formTemplateFieldSchema], default: [] },
      },
      contact: {
        fields: { type: [formTemplateFieldSchema], default: [] },
      },
    },
    aiConfig: {
      contactAutoReplyEnabled: { type: Boolean, default: false },
      inboxReplyAssistEnabled: { type: Boolean, default: false },
    },
  },
  commonSchemaOptions,
);
workspaceSchema.index({ slug: 1 }, { unique: true });
workspaceSchema.index({ onboardingStatus: 1, createdAt: -1 });

export const WorkspaceModel =
  models.Workspace ?? model("Workspace", workspaceSchema, "workspaces");
