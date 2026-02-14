import { Schema, model, models } from "mongoose";
import { commonSchemaOptions, serviceInventoryRuleSchema } from "./shared";

const serviceSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    durationMin: { type: Number, required: true, min: 1 },
    locationType: { type: String, enum: ["in_person", "virtual"], required: true },
    inventoryRules: { type: [serviceInventoryRuleSchema], default: [] },
    bookingFormTemplateId: { type: String, default: undefined },
    isActive: { type: Boolean, default: true },
  },
  commonSchemaOptions,
);
serviceSchema.index({ workspaceId: 1, isActive: 1, name: 1 });
serviceSchema.index({ workspaceId: 1, locationType: 1 });
serviceSchema.index({ workspaceId: 1, bookingFormTemplateId: 1 });

export const ServiceModel = models.Service ?? model("Service", serviceSchema, "services");
