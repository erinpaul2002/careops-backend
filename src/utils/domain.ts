import { addMessage, createAlert, emitEvent, getOrCreateConversation, state } from "./store";
import { BookingStatus, Channel } from "./types";
import { addHours, dateAtTimeIso, nowIso, overlap } from "./core";
import { persistEntity } from "../database/persistence";
import { sendGmailMessageIfConnected } from "./googleIntegration";

function getMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function getConversationMessagesByNewest(conversationId: string, excludeMessageId?: string) {
  return state.messages
    .filter(
      (message) => message.conversationId === conversationId && message.id !== excludeMessageId,
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function parseBookingStatus(value: unknown): BookingStatus | null {
  if (
    value === "pending" ||
    value === "confirmed" ||
    value === "completed" ||
    value === "no_show" ||
    value === "cancelled"
  ) {
    return value;
  }
  return null;
}

export function createConversationMessage(input: {
  workspaceId: string;
  contactId: string;
  channel: Channel;
  body: string;
  direction: "inbound" | "outbound";
  metadata?: Record<string, unknown>;
  providerMessageId?: string;
}): string {
  const conversation = getOrCreateConversation({
    workspaceId: input.workspaceId,
    contactId: input.contactId,
    channel: input.channel,
  });
  const previousMessages = getConversationMessagesByNewest(conversation.id);
  const previousEmailMessages = previousMessages.filter((message) => message.channel === "email");

  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
  };
  if (input.channel === "email" && input.direction === "outbound") {
    const subject =
      getMetadataString(input.metadata, "subject") ??
      previousEmailMessages
        .map((message) => getMetadataString(message.metadata, "subject"))
        .find(Boolean) ??
      "CareOps update";
    metadata.subject = subject;
  }

  const message = addMessage({
    workspaceId: input.workspaceId,
    conversationId: conversation.id,
    channel: input.channel,
    direction: input.direction,
    body: input.body,
    metadata,
    providerMessageId: input.providerMessageId,
  });

  if (
    input.channel === "email" &&
    input.direction === "outbound" &&
    !input.providerMessageId
  ) {
    const contact = state.contacts.find(
      (entry) => entry.id === input.contactId && entry.workspaceId === input.workspaceId,
    );
    if (contact?.email) {
      const subject = getMetadataString(message.metadata, "subject") ?? "CareOps update";
      const htmlBody = getMetadataString(message.metadata, "emailHtml");

      const previousMessageWithThreadContext = previousEmailMessages.find(
        (entry) =>
          !!entry.providerMessageId ||
          !!getMetadataString(entry.metadata, "gmailThreadId") ||
          !!getMetadataString(entry.metadata, "gmailRfcMessageId") ||
          !!getMetadataString(entry.metadata, "gmailReferences"),
      );

      void sendGmailMessageIfConnected({
        workspaceId: input.workspaceId,
        to: contact.email,
        subject,
        body: input.body,
        htmlBody,
        threadId: previousMessageWithThreadContext
          ? getMetadataString(previousMessageWithThreadContext.metadata, "gmailThreadId")
          : undefined,
        inReplyToMessageId: previousMessageWithThreadContext
          ? getMetadataString(previousMessageWithThreadContext.metadata, "gmailRfcMessageId")
          : undefined,
        references: previousMessageWithThreadContext
          ? getMetadataString(previousMessageWithThreadContext.metadata, "gmailReferences")
          : undefined,
        replyToProviderMessageId: previousMessageWithThreadContext?.providerMessageId,
      }).then((result) => {
        if (result.deliveryStatus !== "sent" || !result.providerMessageId) {
          message.metadata.emailDeliveryStatus = result.deliveryStatus;
          if (result.failureReason) {
            message.metadata.emailDeliveryFailureReason = result.failureReason;
          }
          message.updatedAt = nowIso();
          void persistEntity("messages", message);

          const failureReason =
            result.failureReason ??
            (result.deliveryStatus === "not_connected"
              ? "Gmail integration is not connected"
              : "Email provider did not confirm delivery");

          createAlert({
            workspaceId: input.workspaceId,
            type: "integration.email_delivery_failed",
            severity: "warning",
            message: `Email to ${contact.email} was not sent: ${failureReason}.`,
          });
          return;
        }

        message.metadata.emailDeliveryStatus = "sent";
        message.providerMessageId = result.providerMessageId;
        if (result.providerThreadId) {
          message.metadata.gmailThreadId = result.providerThreadId;
        }
        if (result.rfcMessageId) {
          message.metadata.gmailRfcMessageId = result.rfcMessageId;
        }
        if (result.references) {
          message.metadata.gmailReferences = result.references;
        }
        message.updatedAt = nowIso();
        void persistEntity("messages", message);
      });
    }
  }

  return conversation.id;
}

export function isBookingOverlapping(
  workspaceId: string,
  startsAt: string,
  endsAt: string,
  excludeBookingId?: string,
): boolean {
  return state.bookings.some((booking) => {
    if (booking.workspaceId !== workspaceId) {
      return false;
    }
    if (excludeBookingId && booking.id === excludeBookingId) {
      return false;
    }
    if (booking.status === "cancelled" || booking.status === "no_show") {
      return false;
    }
    return (
      new Date(startsAt) < new Date(booking.endsAt) &&
      new Date(booking.startsAt) < new Date(endsAt)
    );
  });
}

export function applyInventoryOnBookingCompleted(
  workspaceId: string,
  bookingId: string,
): string | null {
  const booking = state.bookings.find(
    (item) => item.id === bookingId && item.workspaceId === workspaceId,
  );
  if (!booking) {
    return "Booking not found";
  }

  const service = state.services.find(
    (item) => item.id === booking.serviceId && item.workspaceId === workspaceId,
  );
  if (!service) {
    return "Service not found";
  }

  for (const rule of service.inventoryRules) {
    const item = state.inventoryItems.find(
      (inventoryItem) =>
        inventoryItem.workspaceId === workspaceId && inventoryItem.id === rule.itemId,
    );
    if (!item) {
      continue;
    }
    if (item.quantityOnHand < rule.quantity) {
      return `Insufficient inventory for ${item.name}`;
    }
  }

  for (const rule of service.inventoryRules) {
    const item = state.inventoryItems.find(
      (inventoryItem) =>
        inventoryItem.workspaceId === workspaceId && inventoryItem.id === rule.itemId,
    );
    if (!item) {
      continue;
    }
    item.quantityOnHand -= rule.quantity;
    item.updatedAt = nowIso();
    void persistEntity("inventoryItems", item);
    if (item.quantityOnHand <= item.lowStockThreshold) {
      createAlert({
        workspaceId,
        type: "inventory.low_stock",
        severity: "warning",
        message: `${item.name} is low on stock (${item.quantityOnHand} ${item.unit}).`,
      });
      emitEvent({
        workspaceId,
        eventType: "inventory.low_stock",
        entityType: "inventory_item",
        entityId: item.id,
        payload: {
          quantityOnHand: item.quantityOnHand,
          lowStockThreshold: item.lowStockThreshold,
        },
      });
    }
  }

  return null;
}

export function pauseConversationAutomation(workspaceId: string, conversationId: string): void {
  const conversation = state.conversations.find(
    (item) => item.id === conversationId && item.workspaceId === workspaceId,
  );
  if (!conversation) {
    return;
  }
  conversation.automationPausedUntil = addHours(nowIso(), 24);
  conversation.updatedAt = nowIso();
  void persistEntity("conversations", conversation);
}

export function hasOverlappingAvailabilityRule(
  workspaceId: string,
  serviceId: string,
  weekday: number,
  startTime: string,
  endTime: string,
): boolean {
  const start = dateAtTimeIso("2000-01-01", startTime);
  const end = dateAtTimeIso("2000-01-01", endTime);

  return state.availabilityRules.some((rule) => {
    const normalizedType =
      rule.ruleType === "weekly" || rule.ruleType === undefined
        ? "weekly"
        : rule.ruleType;
    if (
      rule.workspaceId !== workspaceId ||
      rule.serviceId !== serviceId ||
      normalizedType !== "weekly" ||
      rule.weekday !== weekday ||
      typeof rule.startTime !== "string" ||
      typeof rule.endTime !== "string"
    ) {
      return false;
    }
    const ruleStart = dateAtTimeIso("2000-01-01", rule.startTime);
    const ruleEnd = dateAtTimeIso("2000-01-01", rule.endTime);
    return overlap(start, end, ruleStart, ruleEnd);
  });
}
