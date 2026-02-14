import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const conversationSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    contactId: { type: String, required: true, index: true },
    channel: { type: String, enum: ["email", "sms"], required: true },
    status: { type: String, enum: ["open", "pending", "closed"], required: true },
    automationPausedUntil: { type: Date, default: null },
    lastMessageAt: { type: Date, required: true },
  },
  commonSchemaOptions,
);
conversationSchema.index({ workspaceId: 1, contactId: 1, channel: 1 }, { unique: true });
conversationSchema.index({ workspaceId: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index({ workspaceId: 1, automationPausedUntil: 1 }, { sparse: true });

export const ConversationModel =
  models.Conversation ?? model("Conversation", conversationSchema, "conversations");

