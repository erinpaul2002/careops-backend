import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const formRequestSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    bookingId: { type: String, required: true, index: true },
    contactId: { type: String, required: true, index: true },
    templateId: { type: String, required: true, index: true },
    status: { type: String, enum: ["pending", "completed", "overdue"], required: true },
    publicToken: { type: String, required: true },
    dueAt: { type: Date, required: true },
    completedAt: { type: Date },
    submission: { type: Schema.Types.Mixed },
  },
  commonSchemaOptions,
);
formRequestSchema.index({ workspaceId: 1, publicToken: 1 }, { unique: true });
formRequestSchema.index({ workspaceId: 1, status: 1, dueAt: 1 });
formRequestSchema.index({ workspaceId: 1, contactId: 1, createdAt: -1 });
formRequestSchema.index({ workspaceId: 1, bookingId: 1 }, { sparse: true });

export const FormRequestModel =
  models.FormRequest ?? model("FormRequest", formRequestSchema, "form_requests");

