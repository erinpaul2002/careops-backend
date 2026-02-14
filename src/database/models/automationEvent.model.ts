import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const automationEventSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    eventType: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    eventHash: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    processedAt: { type: Date },
    status: { type: String, enum: ["queued", "processed", "failed"], required: true },
  },
  commonSchemaOptions,
);
automationEventSchema.index(
  { workspaceId: 1, eventType: 1, entityType: 1, entityId: 1, eventHash: 1 },
  { unique: true },
);
automationEventSchema.index({ workspaceId: 1, status: 1, createdAt: 1 });
automationEventSchema.index({ workspaceId: 1, processedAt: 1 }, { sparse: true });

export const AutomationEventModel =
  models.AutomationEvent ?? model("AutomationEvent", automationEventSchema, "automation_events");

