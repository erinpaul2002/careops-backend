import { Schema, model, models } from "mongoose";
import { commonSchemaOptions, formTemplateFieldSchema } from "./shared";

const formTemplateSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    fields: { type: [formTemplateFieldSchema], default: [] },
    trigger: { type: String, enum: ["post_booking"], required: true },
    isActive: { type: Boolean, default: true },
  },
  commonSchemaOptions,
);
formTemplateSchema.index({ workspaceId: 1, isActive: 1, name: 1 });
formTemplateSchema.index({ workspaceId: 1, trigger: 1 });

export const FormTemplateModel =
  models.FormTemplate ?? model("FormTemplate", formTemplateSchema, "form_templates");

