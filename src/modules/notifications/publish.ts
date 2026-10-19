import "server-only";
import type { Connection } from "mongoose";
import type { TransactionContext } from "@/server/db/transaction";
import type { TenantScope } from "@/server/db/scope";
import { identifier, label, requireTransaction } from "@/server/db/persistence";
import { getOutboxModel } from "./outbox-model";

export type OutboxInput = Readonly<{
  eventType: string;
  resourceId: string;
  eventKey: string;
  payload: Readonly<{ recipientUserId?: string; memberId?: string }>;
}>;

export async function publishOutbox(connection: Connection, context: TransactionContext, scope: TenantScope, input: OutboxInput): Promise<void> {
  requireTransaction(context);
  if (!scope) throw new Error("Outbox requires tenant scope.");
  const payload = {
    ...(input.payload.recipientUserId === undefined ? {} : { recipientUserId: identifier(input.payload.recipientUserId) }),
    ...(input.payload.memberId === undefined ? {} : { memberId: identifier(input.payload.memberId) }),
  };
  await getOutboxModel(connection).create([{
    organizationId: identifier(scope.organizationId), eventType: label(input.eventType), resourceId: identifier(input.resourceId),
    eventKey: label(input.eventKey), payload, status: "pending", availableAt: new Date(), attemptCount: 0,
  }], { session: context.session });
}
