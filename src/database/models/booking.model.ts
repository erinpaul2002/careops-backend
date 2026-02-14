import { Schema, model, models } from "mongoose";
import { commonSchemaOptions } from "./shared";

const bookingSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    contactId: { type: String, required: true, index: true },
    serviceId: { type: String, required: true, index: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["pending", "confirmed", "completed", "no_show", "cancelled"],
      required: true,
    },
    calendarEventId: { type: String },
    notes: { type: String },
    customFields: { type: Schema.Types.Mixed },
    deletedAt: { type: Date },
  },
  commonSchemaOptions,
);
bookingSchema.index({ workspaceId: 1, startsAt: 1, status: 1 });
bookingSchema.index({ workspaceId: 1, contactId: 1, startsAt: -1 });
bookingSchema.index({ workspaceId: 1, serviceId: 1, startsAt: 1 });
bookingSchema.index({ workspaceId: 1, status: 1, startsAt: 1 });
bookingSchema.index({ workspaceId: 1, deletedAt: 1 }, { sparse: true });

export const BookingModel = models.Booking ?? model("Booking", bookingSchema, "bookings");
