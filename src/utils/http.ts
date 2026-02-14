import { Request, Response } from "express";
import { state } from "./store";
import { Workspace } from "./types";
import { nowIso, parsePositiveInt, toDateKey } from "./core";

export function getString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getOptionalString(value: unknown): string | undefined {
  const text = getString(value);
  return text.length ? text : undefined;
}

export function requireIdempotencyKey(
  req: Request,
  res: Response,
): string | undefined {
  const key = req.header("Idempotency-Key");
  if (!key) {
    res.status(400).json({ error: "Idempotency-Key header is required" });
    return undefined;
  }
  return key;
}

export function getWorkspaceById(workspaceId: string): Workspace | undefined {
  return state.workspaces.find((workspace) => workspace.id === workspaceId);
}

export function getDateKey(input: unknown): string {
  const date = getOptionalString(input);
  if (!date) {
    return toDateKey(nowIso());
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return toDateKey(nowIso());
  }
  return parsed.toISOString().slice(0, 10);
}

export function getPagination(
  pageRaw: unknown,
  pageSizeRaw: unknown,
): { page: number; pageSize: number } {
  return {
    page: parsePositiveInt(pageRaw, 1, 10_000),
    pageSize: parsePositiveInt(pageSizeRaw, 20, 100),
  };
}
