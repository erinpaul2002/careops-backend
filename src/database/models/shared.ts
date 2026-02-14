import { Schema } from "mongoose";

export const commonSchemaOptions = {
  versionKey: false,
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
} as const;

export const serviceInventoryRuleSchema = new Schema(
  {
    itemId: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

export const formTemplateFieldSchema = new Schema(
  {
    key: { type: String },
    id: { type: String },
    type: { type: String, required: true },
    label: { type: String, required: true },
    required: { type: Boolean, default: false },
    placeholder: { type: String },
    options: [{ type: String }],
    validation: { type: Schema.Types.Mixed },
  },
  { _id: false },
);
