import { createId } from "./core";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_PRESIGN_TTL_SECONDS = 900;
const DEFAULT_MAX_FILE_SIZE_MB = 10;
const MIN_PRESIGN_TTL_SECONDS = 60;
const MAX_PRESIGN_TTL_SECONDS = 3600;
const MAX_FILE_NAME_LENGTH = 120;

const allowedContentTypeSet = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

export const FILE_STORAGE_ALLOWED_CONTENT_TYPES = Array.from(
  allowedContentTypeSet,
);

const rawEndpoint = process.env.MINIO_ENDPOINT?.trim() ?? "";
const rawAccessKey = process.env.MINIO_ACCESS_KEY?.trim() ?? "";
const rawSecretKey = process.env.MINIO_SECRET_KEY?.trim() ?? "";
const rawBucket = process.env.MINIO_BUCKET?.trim() ?? "";
const rawRegion = process.env.MINIO_REGION?.trim() ?? DEFAULT_REGION;

let client: S3Client | null = null;
let ensureBucketPromise: Promise<void> | null = null;

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function getSignedUrlTtlSeconds(): number {
  const requested = parsePositiveInteger(
    process.env.MINIO_PRESIGNED_URL_TTL_SEC,
    DEFAULT_PRESIGN_TTL_SECONDS,
  );
  if (requested < MIN_PRESIGN_TTL_SECONDS) {
    return MIN_PRESIGN_TTL_SECONDS;
  }
  if (requested > MAX_PRESIGN_TTL_SECONDS) {
    return MAX_PRESIGN_TTL_SECONDS;
  }
  return requested;
}

export function getMaxUploadBytes(): number {
  const maxMb = parsePositiveInteger(
    process.env.MINIO_MAX_FILE_SIZE_MB,
    DEFAULT_MAX_FILE_SIZE_MB,
  );
  return maxMb * 1024 * 1024;
}

export function isFileStorageConfigured(): boolean {
  return Boolean(rawEndpoint && rawAccessKey && rawSecretKey && rawBucket);
}

function getClient(): S3Client {
  if (!isFileStorageConfigured()) {
    throw new Error(
      "File storage is not configured. Set MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, and MINIO_BUCKET.",
    );
  }

  if (client) {
    return client;
  }

  client = new S3Client({
    region: rawRegion,
    endpoint: rawEndpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: rawAccessKey,
      secretAccessKey: rawSecretKey,
    },
  });
  return client;
}

function isMissingBucketError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const typedError = error as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    typedError.name === "NotFound" ||
    typedError.name === "NoSuchBucket" ||
    typedError.Code === "NoSuchBucket" ||
    typedError.code === "NoSuchBucket" ||
    typedError.$metadata?.httpStatusCode === 404
  );
}

async function ensureBucketExists(): Promise<void> {
  if (ensureBucketPromise) {
    return ensureBucketPromise;
  }

  ensureBucketPromise = (async () => {
    const s3Client = getClient();
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: rawBucket }));
      return;
    } catch (error) {
      if (!isMissingBucketError(error)) {
        throw error;
      }
    }

    await s3Client.send(new CreateBucketCommand({ Bucket: rawBucket }));
  })().catch((error) => {
    ensureBucketPromise = null;
    throw error;
  });

  return ensureBucketPromise;
}

function sanitizeFileName(fileName: string): string {
  const fromPath = fileName.split(/[\\/]/).pop() ?? "file";
  const normalized = fromPath
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) {
    return "file";
  }
  return normalized.slice(0, MAX_FILE_NAME_LENGTH);
}

export function isAllowedUploadContentType(contentType: string): boolean {
  return allowedContentTypeSet.has(contentType.toLowerCase());
}

export function getFormFileKeyPrefix(
  workspaceId: string,
  formRequestId: string,
): string {
  return `workspace/${workspaceId}/forms/${formRequestId}/`;
}

export function buildFormObjectKey(input: {
  workspaceId: string;
  formRequestId: string;
  fileName: string;
}): string {
  const prefix = getFormFileKeyPrefix(input.workspaceId, input.formRequestId);
  return `${prefix}${createId()}-${sanitizeFileName(input.fileName)}`;
}

export async function createUploadUrl(input: {
  key: string;
  contentType: string;
  size: number;
}): Promise<{ url: string; expiresInSeconds: number }> {
  await ensureBucketExists();
  const s3Client = getClient();
  const expiresInSeconds = getSignedUrlTtlSeconds();

  const command = new PutObjectCommand({
    Bucket: rawBucket,
    Key: input.key,
    ContentType: input.contentType,
    ContentLength: input.size,
  });

  const url = await getSignedUrl(s3Client, command, {
    expiresIn: expiresInSeconds,
  });
  return { url, expiresInSeconds };
}

export async function createDownloadUrl(key: string): Promise<{
  url: string;
  expiresInSeconds: number;
}> {
  await ensureBucketExists();
  const s3Client = getClient();
  const expiresInSeconds = getSignedUrlTtlSeconds();
  const command = new GetObjectCommand({
    Bucket: rawBucket,
    Key: key,
  });

  const url = await getSignedUrl(s3Client, command, {
    expiresIn: expiresInSeconds,
  });
  return { url, expiresInSeconds };
}
