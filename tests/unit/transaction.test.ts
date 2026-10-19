import { describe, expect, it, vi } from "vitest";
import type { ClientSession, Connection } from "mongoose";
import { ApplicationError } from "@/server/http/errors";
import { runTransaction } from "@/server/db/transaction";

describe("transaction boundary", () => {
  it("uses Mongoose ownership with snapshot reads, majority commit and a finite retry budget", async () => {
    const session = {} as ClientSession;
    const transaction = vi.fn(async (work: (session: ClientSession) => Promise<unknown>) => work(session));
    const connection = { transaction } as unknown as Connection;
    const result = await runTransaction(connection, async (context) => {
      expect(context.session).toBe(session);
      expect(Object.isFrozen(context)).toBe(true);
      return { result: "committed" };
    });
    expect(result).toEqual({ result: "committed" });
    expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      readPreference: "primary", readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" }, timeoutMS: 15_000,
    });
  });

  it("preserves safe business errors without adding an outer retry", async () => {
    const error = new ApplicationError("CONFLICT");
    const transaction = vi.fn().mockRejectedValue(error);
    await expect(runTransaction({ transaction } as unknown as Connection, async () => undefined)).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("sanitizes unexpected failures without retaining raw causes", async () => {
    const transaction = vi.fn().mockRejectedValue(new Error("mongodb://private:secret@host"));
    try {
      await runTransaction({ transaction } as unknown as Connection, async () => undefined);
      expect.fail("Expected a sanitized failure");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      expect(String(error)).not.toMatch(/private|secret|mongodb/);
      expect(error).not.toHaveProperty("cause");
    }
  });
});
