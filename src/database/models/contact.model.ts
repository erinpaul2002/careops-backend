import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const contactSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    customFields: { type: Schema.Types.Mixed },
    source: {
      type: String,
      enum: ["contact_form", "booking_flow", "import", "manual"],
      required: true,
    },
    tags: { type: [String], default: [] },
    deletedAt: { type: Date },
  },
  commonSchemaOptions,
);
contactSchema.index({ workspaceId: 1, email: 1 }, { sparse: true });
contactSchema.index({ workspaceId: 1, phone: 1 }, { sparse: true });
contactSchema.index({ workspaceId: 1, source: 1, createdAt: -1 });
contactSchema.index({ workspaceId: 1, deletedAt: 1 }, { sparse: true });

export const ContactModel = models.Contact ?? model("Contact", contactSchema, "contacts");
