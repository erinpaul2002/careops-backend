import { Router } from "express";
import { AuthenticatedRequest, requireAuth, requireWorkspace } from "../utils/auth";
import { state } from "../utils/store";
import { parsePositiveInt, toDateKey } from "../utils/core";
import { getDateKey, getOptionalString } from "../utils/http";

export function createDashboardRoutes(): Router {
  const router = Router();

  router.get("/dashboard/summary", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = authReq.workspace!.id;
    const dateKey = getDateKey(req.query.date);

    const bookingsToday = state.bookings.filter(
      (booking) =>
        booking.workspaceId === workspaceId &&
        !booking.deletedAt &&
        toDateKey(booking.startsAt) === dateKey,
    ).length;

    const newLeadsToday = state.contacts.filter(
      (contact) =>
        contact.workspaceId === workspaceId &&
        !contact.deletedAt &&
        toDateKey(contact.createdAt) === dateKey,
    ).length;

    const unansweredConversations = state.conversations.filter((conversation) => {
      if (conversation.workspaceId !== workspaceId) {
        return false;
      }
      const messages = state.messages
        .filter((message) => message.conversationId === conversation.id)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      if (!messages.length) {
        return false;
      }
      return messages[messages.length - 1].direction === "inbound";
    }).length;

    const pendingForms = state.formRequests.filter(
      (request) =>
        request.workspaceId === workspaceId &&
        (request.status === "pending" || request.status === "overdue"),
    ).length;

    const lowStockItems = state.inventoryItems.filter(
      (item) =>
        item.workspaceId === workspaceId &&
        item.isActive &&
        item.quantityOnHand <= item.lowStockThreshold,
    ).length;

    const alerts = state.alerts
      .filter((alert) => alert.workspaceId === workspaceId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 20);

    res.json({
      date: dateKey,
      bookingsToday,
      newLeadsToday,
      unansweredConversations,
      pendingForms,
      lowStockItems,
      alerts,
    });
  });

  router.get("/dashboard/calendar", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = authReq.workspace!.id;
    const dateKey = getDateKey(req.query.date);
    const weeks = parsePositiveInt(req.query.weeks, 2, 12);

    const startDate = new Date(`${dateKey}T00:00:00.000Z`);
    const startMs = startDate.getTime();
    const endMs = startMs + weeks * 7 * 86_400_000;

    const bookings = state.bookings
      .filter((booking) => {
        if (booking.workspaceId !== workspaceId || booking.deletedAt) {
          return false;
        }
        const startsAtMs = new Date(booking.startsAt).getTime();
        return startsAtMs >= startMs && startsAtMs < endMs;
      })
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

    const bookingsByDate = new Map<string, typeof bookings>();
    for (const booking of bookings) {
      const key = toDateKey(booking.startsAt);
      const existing = bookingsByDate.get(key) ?? [];
      existing.push(booking);
      bookingsByDate.set(key, existing);
    }

    const days: Array<{
      date: string;
      bookings: Array<Record<string, unknown>>;
    }> = [];
    for (let day = 0; day < weeks * 7; day += 1) {
      const date = new Date(startMs + day * 86_400_000).toISOString().slice(0, 10);
      const dayBookings = (bookingsByDate.get(date) ?? []).map((booking) => ({
        ...booking,
        contact: state.contacts.find((contact) => contact.id === booking.contactId),
        service: state.services.find((service) => service.id === booking.serviceId),
      }));
      days.push({ date, bookings: dayBookings });
    }

    res.json({
      date: dateKey,
      weeks,
      days,
    });
  });

  router.get("/dashboard/metrics", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = authReq.workspace!.id;

    const rawPeriod = getOptionalString(req.query.period) ?? "30d";
    const periodMatch = rawPeriod.match(/^(\d{1,3})d$/);
    const periodDays = periodMatch
      ? Math.max(1, Math.min(Number(periodMatch[1]), 365))
      : 30;

    const now = Date.now();
    const periodStart = now - periodDays * 86_400_000;

    const bookings = state.bookings.filter((booking) => {
      if (booking.workspaceId !== workspaceId || booking.deletedAt) {
        return false;
      }
      return new Date(booking.createdAt).getTime() >= periodStart;
    });

    const leads = state.contacts.filter((contact) => {
      if (contact.workspaceId !== workspaceId || contact.deletedAt) {
        return false;
      }
      return new Date(contact.createdAt).getTime() >= periodStart;
    });

    const completedBookings = bookings.filter((booking) => booking.status === "completed");
    const cancelledBookings = bookings.filter((booking) => booking.status === "cancelled");
    const noShowBookings = bookings.filter((booking) => booking.status === "no_show");
    const confirmedBookings = bookings.filter((booking) => booking.status === "confirmed");

    const bookingConversionRatePct =
      leads.length === 0 ? 0 : Number(((bookings.length / leads.length) * 100).toFixed(2));
    const completionRatePct =
      bookings.length === 0
        ? 0
        : Number(((completedBookings.length / bookings.length) * 100).toFixed(2));

    res.json({
      period: `${periodDays}d`,
      generatedAt: new Date(now).toISOString(),
      metrics: {
        leads: leads.length,
        bookings: bookings.length,
        confirmedBookings: confirmedBookings.length,
        completedBookings: completedBookings.length,
        cancelledBookings: cancelledBookings.length,
        noShowBookings: noShowBookings.length,
        bookingConversionRatePct,
        completionRatePct,
      },
    });
  });

  router.get("/dashboard/alerts", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const workspaceId = authReq.workspace!.id;
    const severity = getOptionalString(req.query.severity);
    const limit = parsePositiveInt(req.query.limit, 50, 200);

    let data = state.alerts.filter((alert) => alert.workspaceId === workspaceId);
    if (severity === "info" || severity === "warning" || severity === "critical") {
      data = data.filter((alert) => alert.severity === severity);
    }

    data = data
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

    res.json({ data });
  });

  return router;
}
