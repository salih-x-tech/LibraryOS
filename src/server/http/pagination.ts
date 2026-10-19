import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ApplicationError } from "./errors";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 2048;

export type CursorScope = Readonly<{
  organizationId: string;
  resource: string;
  direction: "asc" | "desc";
  // Only normalized, allowlisted filters from the service, including branch scope.
  filters: Readonly<Record<string, string>>;
}>;

export type CursorPosition = Readonly<{ createdAt: string; id: string }>;

function invalid(): never {
  throw new ApplicationError("BAD_REQUEST");
}

export function parsePageSize(value: string | null): number {
  if (value === null) return DEFAULT_PAGE_SIZE;
  if (!/^[1-9][0-9]{0,2}$/.test(value)) return invalid();
  const size = Number(value);
  if (size > MAX_PAGE_SIZE) return invalid();
  return size;
}

export function readPaginationParams(params: URLSearchParams) {
  if (params.getAll("limit").length > 1 || params.getAll("cursor").length > 1) return invalid();
  const cursor = params.get("cursor");
  if (cursor !== null && (!cursor || cursor.length > MAX_CURSOR_LENGTH)) return invalid();
  return { limit: parsePageSize(params.get("limit")), cursor };
}

function isPosition(value: unknown): value is CursorPosition {
  if (value === null || typeof value !== "object") return false;
  const position = value as Record<string, unknown>;
  return Object.keys(position).length === 2
    && typeof position.id === "string" && /^[a-f0-9]{24}$/.test(position.id)
    && typeof position.createdAt === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(position.createdAt)
    && Number.isFinite(Date.parse(position.createdAt))
    && new Date(position.createdAt).toISOString() === position.createdAt;
}

function scopeHash(scope: CursorScope): string {
  const filters = Object.keys(scope.filters).sort().map((key) => [key, scope.filters[key]]);
  return createHash("sha256").update(JSON.stringify([
    scope.organizationId, scope.resource, "createdAt,_id", scope.direction, filters,
  ])).digest("hex");
}

// Supply a shared persistent secret from server configuration when routes are added.
// No generated per-process key: replicas/restarts must agree on cursor signatures.
export function createCursorCodec(secret: Uint8Array) {
  if (secret.byteLength < 32) throw new Error("Cursor signing requires at least 32 secret bytes.");
  const key = Buffer.from(secret);
  function sign(payload: string): Buffer {
    return createHmac("sha256", key).update(payload).digest();
  }

  return Object.freeze({
    encode(position: CursorPosition, scope: CursorScope): string {
      if (!isPosition(position)) throw new Error("Invalid server cursor position.");
      const payload = Buffer.from(JSON.stringify({ v: 1, scope: scopeHash(scope), position })).toString("base64url");
      return `${payload}.${sign(payload).toString("base64url")}`;
    },
    decode(cursor: string, scope: CursorScope): CursorPosition {
      try {
        if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) return invalid();
        const [payload, signature] = cursor.split(".");
        if (!payload || !signature) return invalid();
        const actual = Buffer.from(signature, "base64url");
        if (actual.toString("base64url") !== signature || !timingSafeEqual(sign(payload), actual)) return invalid();
        const bytes = Buffer.from(payload, "base64url");
        if (bytes.toString("base64url") !== payload) return invalid();
        const decoded: unknown = JSON.parse(bytes.toString("utf8"));
        if (!decoded || typeof decoded !== "object") return invalid();
        const data = decoded as Record<string, unknown>;
        if (Object.keys(data).length !== 3 || data.v !== 1 || data.scope !== scopeHash(scope) || !isPosition(data.position)) return invalid();
        return Object.freeze({ ...data.position });
      } catch {
        return invalid();
      }
    },
  });
}

// Services fetch limit + 1 in stable (createdAt, _id) order, after authorization.
export function slicePage<T>(rows: readonly T[], limit: number): { data: T[]; hasMore: boolean } {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE || rows.length > limit + 1) {
    throw new Error("Invalid server pagination window.");
  }
  return { data: rows.slice(0, limit), hasMore: rows.length > limit };
}
