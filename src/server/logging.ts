import "server-only";
import { isPublicErrorCode, type PublicErrorCode } from "./http/errors";

const events = ["request.completed", "request.failed", "database.unavailable"] as const;
export type LogEvent = typeof events[number];
export type LogDetails = Readonly<{
  requestId: string;
  status?: number;
  durationMs?: number;
  errorCode?: PublicErrorCode;
}>;
export type LogSink = (line: string) => void;

// Do not accept free-form messages, URLs, headers, queries, actors or error objects.
// Projection drops unknown properties even if a caller bypasses TypeScript.
export function createLogger(sink: LogSink = (line) => console.info(line)) {
  return Object.freeze({
    write(event: LogEvent, details: LogDetails): void {
      if (!(events as readonly string[]).includes(event)
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(details.requestId)
        || (details.status !== undefined && (!Number.isInteger(details.status) || details.status < 100 || details.status > 599))
        || (details.durationMs !== undefined && (!Number.isFinite(details.durationMs) || details.durationMs < 0))) {
        throw new Error("Invalid safe log metadata.");
      }
      // Error codes are enum literals, never raw exception messages.
      const errorCode = details.errorCode;
      if (errorCode !== undefined && !isPublicErrorCode(errorCode)) throw new Error("Invalid safe log error code.");
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        level: event === "request.completed" ? "info" : "error",
        event, requestId: details.requestId,
        ...(details.status === undefined ? {} : { status: details.status }),
        ...(details.durationMs === undefined ? {} : { durationMs: details.durationMs }),
        ...(errorCode === undefined ? {} : { errorCode }),
      });
      // Diagnostics must not turn a completed operation into a client retry.
      try { sink(line); } catch { /* No raw sink error or fallback payload logging. */ }
    },
  });
}
