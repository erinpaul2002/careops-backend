import crypto from "crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(): string {
  return crypto.randomUUID();
}

export function createToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(slug);
}

export function addMinutes(dateIso: string, minutes: number): string {
  const date = new Date(dateIso);
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

export function addHours(dateIso: string, hours: number): string {
  return addMinutes(dateIso, hours * 60);
}

export function addDays(dateIso: string, days: number): string {
  const date = new Date(dateIso);
  return new Date(date.getTime() + days * 86_400_000).toISOString();
}

export function dateAtTimeIso(date: string, hhmm: string): string {
  const [hoursStr, minutesStr] = hhmm.split(":");
  const hours = Number(hoursStr);
  const minutes = Number(minutesStr);
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCHours(hours, minutes, 0, 0);
  return day.toISOString();
}

function toPartsInTimeZone(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const pick = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value ?? "0";
    return Number(value);
  };

  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = toPartsInTimeZone(date, timeZone);
  const reconstructedUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return reconstructedUtc - date.getTime();
}

export function dateAtTimeInTimeZoneIso(
  date: string,
  hhmm: string,
  timeZone: string,
): string {
  const [yearStr, monthStr, dayStr] = date.split("-");
  const [hoursStr, minutesStr] = hhmm.split(":");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hours = Number(hoursStr);
  const minutes = Number(minutesStr);

  const utcGuessMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
  const firstGuess = new Date(utcGuessMs);
  const firstOffset = getTimeZoneOffsetMs(firstGuess, timeZone);
  const adjusted = new Date(utcGuessMs - firstOffset);
  const secondOffset = getTimeZoneOffsetMs(adjusted, timeZone);
  const finalDate =
    secondOffset === firstOffset ? adjusted : new Date(utcGuessMs - secondOffset);
  return finalDate.toISOString();
}

export function toDateKeyInTimeZone(dateIso: string, timeZone: string): string {
  const date = new Date(dateIso);
  const parts = toPartsInTimeZone(date, timeZone);
  const year = String(parts.year).padStart(4, "0");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function weekdayInTimeZone(dateIso: string, timeZone: string): number {
  const dateKey = toDateKeyInTimeZone(dateIso, timeZone);
  const midday = new Date(`${dateKey}T12:00:00.000Z`);
  return midday.getUTCDay();
}

export function toDateKey(dateIso: string): string {
  return new Date(dateIso).toISOString().slice(0, 10);
}

export function randomPublicToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(plain, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(plain: string, hash: string): boolean {
  const [salt, original] = hash.split(":");
  if (!salt || !original) {
    return false;
  }
  const candidate = crypto.scryptSync(plain, salt, 64).toString("hex");
  return crypto.timingSafeEqual(
    Buffer.from(candidate, "hex"),
    Buffer.from(original, "hex"),
  );
}

export function parsePositiveInt(
  input: unknown,
  fallback: number,
  max: number,
): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(value), max);
}

export function overlap(
  startA: string,
  endA: string,
  startB: string,
  endB: string,
): boolean {
  return new Date(startA) < new Date(endB) && new Date(startB) < new Date(endA);
}
