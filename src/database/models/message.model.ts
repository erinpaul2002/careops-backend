import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const messageSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    conversationId: { type: String, required: true, index: true },
    direction: { type: String, enum: ["inbound", "outbound"], required: true },
    channel: { type: String, enum: ["email", "sms"], required: true },
    providerMessageId: { type: String },
    body: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  commonSchemaOptions,
);
messageSchema.index({ workspaceId: 1, conversationId: 1, createdAt: 1 });
messageSchema.index({ workspaceId: 1, providerMessageId: 1 }, { sparse: true });
messageSchema.index({ workspaceId: 1, channel: 1, createdAt: -1 });

export const MessageModel = models.Message ?? model("Message", messageSchema, "messages");

