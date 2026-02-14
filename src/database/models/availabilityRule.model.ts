import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const availabilityRuleSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    serviceId: { type: String, required: true, index: true },
    ruleType: {
      type: String,
      required: true,
      enum: ["weekly", "date_override", "date_block"],
      default: "weekly",
    },
    weekday: { type: Number, required: false, min: 0, max: 6 },
    date: { type: String, required: false, index: true },
    startTime: { type: String, required: false },
    endTime: { type: String, required: false },
    bufferMin: { type: Number, required: false, min: 0 },
    slotIntervalMin: { type: Number, required: false, min: 1 },
    isClosedAllDay: { type: Boolean, required: false, default: false },
  },
  commonSchemaOptions,
);
availabilityRuleSchema.index({ workspaceId: 1, serviceId: 1, weekday: 1 });
availabilityRuleSchema.index({ workspaceId: 1, serviceId: 1, date: 1, ruleType: 1 });
availabilityRuleSchema.index({ workspaceId: 1, serviceId: 1 });

export const AvailabilityRuleModel =
  models.AvailabilityRule ??
  model("AvailabilityRule", availabilityRuleSchema, "availability_rules");
