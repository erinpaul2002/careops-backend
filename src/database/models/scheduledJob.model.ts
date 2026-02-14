import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const scheduledJobSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    jobType: { type: String, required: true },
    runAt: { type: Date, required: true },
    status: { type: String, enum: ["queued", "running", "done", "failed"], required: true },
    priority: { type: String, enum: ["high", "normal", "low"], required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String },
    lockedAt: { type: Date },
    lockOwner: { type: String },
  },
  commonSchemaOptions,
);
scheduledJobSchema.index({ status: 1, runAt: 1, priority: -1 });
scheduledJobSchema.index({ workspaceId: 1, jobType: 1, status: 1 });
scheduledJobSchema.index({ lockedAt: 1 }, { sparse: true });

export const ScheduledJobModel =
  models.ScheduledJob ?? model("ScheduledJob", scheduledJobSchema, "scheduled_jobs");

