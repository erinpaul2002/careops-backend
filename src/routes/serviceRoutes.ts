import { Router } from "express";
import {
  AuthenticatedRequest,
  requireAuth,
  requireWorkspace,
} from "../utils/auth";
import { state } from "../utils/store";
import { createId, dateAtTimeIso, nowIso, overlap } from "../utils/core";
import { getOptionalString, getString } from "../utils/http";
import { persistEntity, removeEntityById } from "../database/persistence";
import { AvailabilityRule } from "../utils/types";

const HHMM_PATTERN = /^\d{2}:\d{2}$/;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type AvailabilityRuleType = "weekly" | "date_override" | "date_block";

interface NormalizedAvailabilityRuleInput {
  ruleType: AvailabilityRuleType;
  weekday?: number;
  date?: string;
  startTime?: string;
  endTime?: string;
  bufferMin?: number;
  slotIntervalMin?: number;
  isClosedAllDay?: boolean;
}

function parseInventoryRules(input: unknown): Array<{ itemId: string; quantity: number }> {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((rule) => {
      const payload = rule as Record<string, unknown>;
      return {
        itemId: getString(payload.itemId),
        quantity: Number(payload.quantity),
      };
    })
    .filter((rule) => rule.itemId && Number.isFinite(rule.quantity) && rule.quantity > 0);
}

function resolveRuleType(rawType: unknown): AvailabilityRuleType | null {
  if (rawType === undefined || rawType === null || rawType === "") {
    return "weekly";
  }
  if (rawType === "weekly" || rawType === "date_override" || rawType === "date_block") {
    return rawType;
  }
  return null;
}

function resolveExistingRuleType(rule: AvailabilityRule): AvailabilityRuleType {
  return resolveRuleType(rule.ruleType) ?? "weekly";
}

function normalizeAvailabilityRule(rule: AvailabilityRule): AvailabilityRule {
  const normalizedType = resolveExistingRuleType(rule);
  if (normalizedType === "date_block") {
    return {
      ...rule,
      ruleType: normalizedType,
      isClosedAllDay: Boolean(rule.isClosedAllDay),
    };
  }

  return {
    ...rule,
    ruleType: normalizedType,
    bufferMin: Number.isFinite(rule.bufferMin) ? Number(rule.bufferMin) : 0,
  };
}

function parseAvailabilityRuleInput(
  payload: Record<string, unknown>,
  existing?: AvailabilityRule,
): { value?: NormalizedAvailabilityRuleInput; error?: string } {
  const existingType = existing ? resolveExistingRuleType(existing) : undefined;
  const ruleType = resolveRuleType(payload.ruleType ?? existingType);
  if (!ruleType) {
    return { error: "ruleType must be one of weekly, date_override, date_block" };
  }

  if (ruleType === "weekly") {
    const fallbackWeekday =
      existingType === "weekly" && Number.isInteger(existing?.weekday)
        ? Number(existing?.weekday)
        : undefined;
    const weekdayRaw = payload.weekday ?? fallbackWeekday;
    const weekday = Number(weekdayRaw);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { error: "weekday must be in range 0-6 for weekly rules" };
    }

    const fallbackStartTime = existingType === "weekly" ? existing?.startTime : undefined;
    const fallbackEndTime = existingType === "weekly" ? existing?.endTime : undefined;
    const startTime = String(payload.startTime ?? fallbackStartTime ?? "").trim();
    const endTime = String(payload.endTime ?? fallbackEndTime ?? "").trim();
    if (!HHMM_PATTERN.test(startTime) || !HHMM_PATTERN.test(endTime)) {
      return { error: "startTime and endTime must use HH:mm format" };
    }
    if (dateAtTimeIso("2000-01-01", startTime) >= dateAtTimeIso("2000-01-01", endTime)) {
      return { error: "startTime must be before endTime" };
    }

    const fallbackBuffer =
      existingType === "weekly" && Number.isFinite(existing?.bufferMin)
        ? Number(existing?.bufferMin)
        : 0;
    const bufferMin = Number(payload.bufferMin ?? fallbackBuffer);
    if (!Number.isFinite(bufferMin) || bufferMin < 0) {
      return { error: "bufferMin must be >= 0" };
    }

    const slotIntervalRaw = payload.slotIntervalMin;
    let slotIntervalMin: number | undefined;
    if (slotIntervalRaw !== undefined) {
      if (slotIntervalRaw === null || slotIntervalRaw === "") {
        slotIntervalMin = undefined;
      } else {
        const parsed = Number(slotIntervalRaw);
        if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
          return { error: "slotIntervalMin must be a positive integer or null" };
        }
        slotIntervalMin = parsed;
      }
    } else if (
      existingType === "weekly" &&
      Number.isFinite(existing?.slotIntervalMin) &&
      Number(existing?.slotIntervalMin) > 0
    ) {
      slotIntervalMin = Number(existing?.slotIntervalMin);
    }

    return {
      value: {
        ruleType,
        weekday,
        startTime,
        endTime,
        bufferMin,
        slotIntervalMin,
        isClosedAllDay: false,
      },
    };
  }

  const fallbackDate =
    existingType && existingType !== "weekly"
      ? String(existing?.date ?? "").trim()
      : "";
  const date = String(payload.date ?? fallbackDate).trim();
  if (!DATE_KEY_PATTERN.test(date)) {
    return { error: "date must use YYYY-MM-DD format for exception rules" };
  }

  if (ruleType === "date_block") {
    const fallbackClosedAllDay =
      existingType === "date_block" ? Boolean(existing?.isClosedAllDay) : false;
    const isClosedAllDay =
      payload.isClosedAllDay === undefined
        ? fallbackClosedAllDay
        : Boolean(payload.isClosedAllDay);

    if (isClosedAllDay) {
      return {
        value: {
          ruleType,
          date,
          isClosedAllDay: true,
        },
      };
    }

    const fallbackStartTime = existingType === "date_block" ? existing?.startTime : undefined;
    const fallbackEndTime = existingType === "date_block" ? existing?.endTime : undefined;
    const startTime = String(payload.startTime ?? fallbackStartTime ?? "").trim();
    const endTime = String(payload.endTime ?? fallbackEndTime ?? "").trim();
    if (!HHMM_PATTERN.test(startTime) || !HHMM_PATTERN.test(endTime)) {
      return {
        error: "startTime and endTime are required for partial date blocks and must use HH:mm format",
      };
    }
    if (dateAtTimeIso("2000-01-01", startTime) >= dateAtTimeIso("2000-01-01", endTime)) {
      return { error: "startTime must be before endTime" };
    }

    return {
      value: {
        ruleType,
        date,
        startTime,
        endTime,
        isClosedAllDay: false,
      },
    };
  }

  const fallbackStartTime = existingType === "date_override" ? existing?.startTime : undefined;
  const fallbackEndTime = existingType === "date_override" ? existing?.endTime : undefined;
  const startTime = String(payload.startTime ?? fallbackStartTime ?? "").trim();
  const endTime = String(payload.endTime ?? fallbackEndTime ?? "").trim();
  if (!HHMM_PATTERN.test(startTime) || !HHMM_PATTERN.test(endTime)) {
    return { error: "startTime and endTime must use HH:mm format" };
  }
  if (dateAtTimeIso("2000-01-01", startTime) >= dateAtTimeIso("2000-01-01", endTime)) {
    return { error: "startTime must be before endTime" };
  }

  const fallbackBuffer =
    existingType === "date_override" && Number.isFinite(existing?.bufferMin)
      ? Number(existing?.bufferMin)
      : 0;
  const bufferMin = Number(payload.bufferMin ?? fallbackBuffer);
  if (!Number.isFinite(bufferMin) || bufferMin < 0) {
    return { error: "bufferMin must be >= 0" };
  }

  const slotIntervalRaw = payload.slotIntervalMin;
  let slotIntervalMin: number | undefined;
  if (slotIntervalRaw !== undefined) {
    if (slotIntervalRaw === null || slotIntervalRaw === "") {
      slotIntervalMin = undefined;
    } else {
      const parsed = Number(slotIntervalRaw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
        return { error: "slotIntervalMin must be a positive integer or null" };
      }
      slotIntervalMin = parsed;
    }
  } else if (
    existingType === "date_override" &&
    Number.isFinite(existing?.slotIntervalMin) &&
    Number(existing?.slotIntervalMin) > 0
  ) {
    slotIntervalMin = Number(existing?.slotIntervalMin);
  }

  return {
    value: {
      ruleType,
      date,
      startTime,
      endTime,
      bufferMin,
      slotIntervalMin,
      isClosedAllDay: false,
    },
  };
}

function hasOverlappingRule(
  workspaceId: string,
  serviceId: string,
  candidate: NormalizedAvailabilityRuleInput,
  excludeRuleId?: string,
): boolean {
  return state.availabilityRules.some((rawRule) => {
    if (
      rawRule.workspaceId !== workspaceId ||
      rawRule.serviceId !== serviceId ||
      (excludeRuleId && rawRule.id === excludeRuleId)
    ) {
      return false;
    }

    const rule = normalizeAvailabilityRule(rawRule);
    if (rule.ruleType !== candidate.ruleType) {
      return false;
    }

    if (candidate.ruleType === "weekly") {
      if (rule.weekday !== candidate.weekday) {
        return false;
      }
      const leftStart = dateAtTimeIso("2000-01-01", candidate.startTime ?? "00:00");
      const leftEnd = dateAtTimeIso("2000-01-01", candidate.endTime ?? "00:00");
      const rightStart = dateAtTimeIso("2000-01-01", rule.startTime ?? "00:00");
      const rightEnd = dateAtTimeIso("2000-01-01", rule.endTime ?? "00:00");
      return overlap(leftStart, leftEnd, rightStart, rightEnd);
    }

    if (rule.date !== candidate.date) {
      return false;
    }

    if (candidate.ruleType === "date_block") {
      if (candidate.isClosedAllDay || rule.isClosedAllDay) {
        return true;
      }
      const leftStart = dateAtTimeIso("2000-01-01", candidate.startTime ?? "00:00");
      const leftEnd = dateAtTimeIso("2000-01-01", candidate.endTime ?? "00:00");
      const rightStart = dateAtTimeIso("2000-01-01", rule.startTime ?? "00:00");
      const rightEnd = dateAtTimeIso("2000-01-01", rule.endTime ?? "00:00");
      return overlap(leftStart, leftEnd, rightStart, rightEnd);
    }

    const leftStart = dateAtTimeIso("2000-01-01", candidate.startTime ?? "00:00");
    const leftEnd = dateAtTimeIso("2000-01-01", candidate.endTime ?? "00:00");
    const rightStart = dateAtTimeIso("2000-01-01", rule.startTime ?? "00:00");
    const rightEnd = dateAtTimeIso("2000-01-01", rule.endTime ?? "00:00");
    return overlap(leftStart, leftEnd, rightStart, rightEnd);
  });
}

function applyRuleShape(target: AvailabilityRule, input: NormalizedAvailabilityRuleInput): void {
  target.ruleType = input.ruleType;

  target.weekday = input.ruleType === "weekly" ? input.weekday : undefined;
  target.date = input.ruleType === "weekly" ? undefined : input.date;

  if (input.ruleType === "date_block") {
    target.isClosedAllDay = Boolean(input.isClosedAllDay);
    if (target.isClosedAllDay) {
      target.startTime = undefined;
      target.endTime = undefined;
    } else {
      target.startTime = input.startTime;
      target.endTime = input.endTime;
    }
    target.bufferMin = undefined;
    target.slotIntervalMin = undefined;
    return;
  }

  target.isClosedAllDay = false;
  target.startTime = input.startTime;
  target.endTime = input.endTime;
  target.bufferMin = input.bufferMin ?? 0;
  target.slotIntervalMin = input.slotIntervalMin;
}

function resolveBookingFormTemplateId(
  workspaceId: string,
  rawValue: unknown,
): { value: string | undefined; error?: string } {
  if (rawValue === undefined || rawValue === null) {
    return { value: undefined };
  }
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return {
      value: undefined,
      error: "bookingFormTemplateId must be a non-empty string or null",
    };
  }

  const templateId = rawValue.trim();
  const template = state.formTemplates.find(
    (item) =>
      item.id === templateId &&
      item.workspaceId === workspaceId &&
      item.trigger === "post_booking",
  );
  if (!template) {
    return {
      value: undefined,
      error: "bookingFormTemplateId must reference an existing post_booking template",
    };
  }
  return { value: templateId };
}

export function createServiceRoutes(): Router {
  const router = Router();

  router.get("/services", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const includeInactive = req.query.includeInactive === "true";
    const data = state.services.filter(
      (service) =>
        service.workspaceId === authReq.workspace!.id && (includeInactive || service.isActive),
    );
    res.json({ data });
  });

  router.post("/services", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const name = getString(req.body?.name);
    const durationMin = Number(req.body?.durationMin);
    const locationType = getString(req.body?.locationType);
    const inventoryRules = parseInventoryRules(req.body?.inventoryRules);
    const bookingFormTemplate = resolveBookingFormTemplateId(
      authReq.workspace!.id,
      req.body?.bookingFormTemplateId,
    );
    if (bookingFormTemplate.error) {
      res.status(400).json({ error: bookingFormTemplate.error });
      return;
    }

    if (
      !name ||
      !Number.isFinite(durationMin) ||
      durationMin <= 0 ||
      (locationType !== "in_person" && locationType !== "virtual")
    ) {
      res.status(400).json({ error: "Invalid service payload" });
      return;
    }

    const createdAt = nowIso();
    const service = {
      id: createId(),
      workspaceId: authReq.workspace!.id,
      name,
      durationMin,
      locationType: locationType as "in_person" | "virtual",
      inventoryRules,
      bookingFormTemplateId: bookingFormTemplate.value,
      isActive: true,
      createdAt,
      updatedAt: createdAt,
    };
    state.services.push(service);
    void persistEntity("services", service);
    res.status(201).json({ service });
  });

  router.patch("/services/:id", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const service = state.services.find(
      (item) => item.id === req.params.id && item.workspaceId === authReq.workspace!.id,
    );
    if (!service) {
      res.status(404).json({ error: "service not found" });
      return;
    }

    const name = getOptionalString(req.body?.name);
    const durationMinRaw = req.body?.durationMin;
    const locationType = getOptionalString(req.body?.locationType);
    const isActive = req.body?.isActive;
    const inventoryRules = req.body?.inventoryRules;
    const bookingFormTemplateIdRaw = req.body?.bookingFormTemplateId;
    const bookingFormTemplate =
      bookingFormTemplateIdRaw !== undefined
        ? resolveBookingFormTemplateId(authReq.workspace!.id, bookingFormTemplateIdRaw)
        : null;
    if (bookingFormTemplate?.error) {
      res.status(400).json({ error: bookingFormTemplate.error });
      return;
    }

    if (name !== undefined) {
      service.name = name;
    }
    if (durationMinRaw !== undefined) {
      const durationMin = Number(durationMinRaw);
      if (!Number.isFinite(durationMin) || durationMin <= 0) {
        res.status(400).json({ error: "durationMin must be > 0" });
        return;
      }
      service.durationMin = durationMin;
    }
    if (locationType !== undefined) {
      if (locationType !== "in_person" && locationType !== "virtual") {
        res.status(400).json({ error: "locationType must be in_person or virtual" });
        return;
      }
      service.locationType = locationType;
    }
    if (inventoryRules !== undefined) {
      service.inventoryRules = parseInventoryRules(inventoryRules);
    }
    if (isActive !== undefined) {
      service.isActive = Boolean(isActive);
    }
    if (bookingFormTemplateIdRaw !== undefined && bookingFormTemplate) {
      service.bookingFormTemplateId = bookingFormTemplate.value;
    }

    service.updatedAt = nowIso();
    void persistEntity("services", service);
    res.json({ service });
  });

  router.delete("/services/:id", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const serviceIndex = state.services.findIndex(
      (item) => item.id === req.params.id && item.workspaceId === authReq.workspace!.id,
    );
    if (serviceIndex === -1) {
      res.status(404).json({ error: "service not found" });
      return;
    }

    const [removedService] = state.services.splice(serviceIndex, 1);
    void removeEntityById("services", removedService.id);

    const removedRules = state.availabilityRules.filter(
      (rule) =>
        rule.workspaceId === authReq.workspace!.id &&
        rule.serviceId === removedService.id,
    );
    state.availabilityRules = state.availabilityRules.filter(
      (rule) =>
        !(
          rule.workspaceId === authReq.workspace!.id &&
          rule.serviceId === removedService.id
        ),
    );
    removedRules.forEach((rule) => {
      void removeEntityById("availabilityRules", rule.id);
    });

    res.json({ success: true });
  });

  router.get("/availability-rules", requireAuth, requireWorkspace, (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const serviceId = getOptionalString(req.query.serviceId);

    let data = state.availabilityRules.filter(
      (rule) => rule.workspaceId === authReq.workspace!.id,
    );
    if (serviceId) {
      data = data.filter((rule) => rule.serviceId === serviceId);
    }
    res.json({ data: data.map((rule) => normalizeAvailabilityRule(rule)) });
  });

  router.post(
    "/availability-rules",
    requireAuth,
    requireWorkspace,
    (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const serviceId = getString(req.body?.serviceId);
      if (!serviceId) {
        res.status(400).json({ error: "serviceId is required" });
        return;
      }

      const service = state.services.find(
        (item) => item.id === serviceId && item.workspaceId === authReq.workspace!.id,
      );
      if (!service) {
        res.status(404).json({ error: "Service not found" });
        return;
      }

      const parsedInput = parseAvailabilityRuleInput(
        (req.body ?? {}) as Record<string, unknown>,
      );
      if (!parsedInput.value) {
        res.status(400).json({ error: parsedInput.error ?? "Invalid availability rule payload" });
        return;
      }

      if (
        hasOverlappingRule(
          authReq.workspace!.id,
          serviceId,
          parsedInput.value,
        )
      ) {
        res.status(409).json({ error: "Overlapping availability rule exists" });
        return;
      }

      const createdAt = nowIso();
      const rule: AvailabilityRule = {
        id: createId(),
        workspaceId: authReq.workspace!.id,
        serviceId,
        ruleType: parsedInput.value.ruleType,
        createdAt,
        updatedAt: createdAt,
      };
      applyRuleShape(rule, parsedInput.value);

      state.availabilityRules.push(rule);
      void persistEntity("availabilityRules", rule);

      res.status(201).json({ rule: normalizeAvailabilityRule(rule) });
    },
  );

  router.patch(
    "/availability-rules/:id",
    requireAuth,
    requireWorkspace,
    (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const rule = state.availabilityRules.find(
        (item) => item.id === req.params.id && item.workspaceId === authReq.workspace!.id,
      );
      if (!rule) {
        res.status(404).json({ error: "availability rule not found" });
        return;
      }

      const parsedInput = parseAvailabilityRuleInput(
        (req.body ?? {}) as Record<string, unknown>,
        rule,
      );
      if (!parsedInput.value) {
        res.status(400).json({ error: parsedInput.error ?? "Invalid availability rule payload" });
        return;
      }

      if (
        hasOverlappingRule(
          authReq.workspace!.id,
          rule.serviceId,
          parsedInput.value,
          rule.id,
        )
      ) {
        res.status(409).json({ error: "Overlapping availability rule exists" });
        return;
      }

      applyRuleShape(rule, parsedInput.value);
      rule.updatedAt = nowIso();
      void persistEntity("availabilityRules", rule);
      res.json({ rule: normalizeAvailabilityRule(rule) });
    },
  );

  router.delete(
    "/availability-rules/:id",
    requireAuth,
    requireWorkspace,
    (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const ruleIndex = state.availabilityRules.findIndex(
        (item) => item.id === req.params.id && item.workspaceId === authReq.workspace!.id,
      );
      if (ruleIndex === -1) {
        res.status(404).json({ error: "availability rule not found" });
        return;
      }

      const [removed] = state.availabilityRules.splice(ruleIndex, 1);
      void removeEntityById("availabilityRules", removed.id);
      res.json({ success: true });
    },
  );

  return router;
}
