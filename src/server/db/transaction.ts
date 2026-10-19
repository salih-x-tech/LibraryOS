import "server-only";
import type { ClientSession, Connection, mongo } from "mongoose";
import { ApplicationError } from "@/server/http/errors";

export type TransactionContext = Readonly<{ session: ClientSession }>;

// Technical execution budget, not an approved API latency SLA.
const TRANSACTION_TIMEOUT_MS = 15_000;
// Mongoose's method declares TransactionOptions; the underlying withTransaction
// also accepts timeoutMS and Mongoose forwards this options object unchanged.
const options = {
  readPreference: "primary",
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  timeoutMS: TRANSACTION_TIMEOUT_MS,
} satisfies mongo.TransactionOptions & { timeoutMS: number };

export async function runTransaction<T>(
  connection: Connection,
  work: (context: TransactionContext) => Promise<T>,
): Promise<T> {
  try {
    // Mongoose delegates transient/unknown-commit retries to withTransaction and
    // resets document change tracking on rollback. Do not add an outer retry loop.
    return await connection.transaction(
      (session) => work(Object.freeze({ session })),
      options,
    );
  } catch (error: unknown) {
    if (error instanceof ApplicationError) throw error;
    // Raw driver errors can contain URIs, query values or internal topology.
    // Unknown outcomes are not proof of rollback: resolve using idempotency.
    throw new ApplicationError("SERVICE_UNAVAILABLE");
  }
}
