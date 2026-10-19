import "server-only";
import type { Connection } from "mongoose";
import type { TransactionContext } from "@/server/db/transaction";
import { identifier, label, persistenceScope, requestId, requireTransaction, type PersistenceScope } from "@/server/db/persistence";
import { getAuditModel } from "./model";

export type AuditInput = Readonly<{
  scope: PersistenceScope;
  actor: Readonly<{ userId: string }> | Readonly<{ systemIdentity: string }>;
  action: string;
  resourceType: string;
  resourceId: string;
  branchIds: readonly string[];
  requestId: string;
  // Server-declared schema labels only; never user values or prose summaries.
  changedFields: readonly string[];
}>;

export async function appendAudit(connection: Connection, context: TransactionContext, input: AuditInput): Promise<void> {
  requireTransaction(context);
  if (input.branchIds.length > 100 || input.changedFields.length > 50) throw new Error("Audit metadata exceeds bounds.");
  const actor = "userId" in input.actor ? { actorId: identifier(input.actor.userId) } : { systemIdentity: label(input.actor.systemIdentity) };
  await getAuditModel(connection).create([{
    ...persistenceScope(input.scope), ...actor,
    action: label(input.action), resourceType: label(input.resourceType), resourceId: identifier(input.resourceId),
    branchIds: input.branchIds.map(identifier), requestId: requestId(input.requestId),
    changedFields: input.changedFields.map(label), timestamp: new Date(),
  }], { session: context.session });
}
