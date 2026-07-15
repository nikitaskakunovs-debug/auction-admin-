import { customerFees, type Db } from "@auction/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * Restock-fee ledger helpers. Two births:
 *  - no_pickup_restock: deducted from held funds → born `settled`.
 *  - unpaid_restock: we hold no money → born `outstanding`, and the customer
 *    is barred from bidding/buying until it is settled or waived.
 */

type Tx = Pick<Db, "select" | "insert">;

export async function recordFee(
  tx: Tx,
  args: {
    customerId: string;
    orderId: string;
    orderRef: string;
    type: "unpaid_restock" | "no_pickup_restock";
    amountCents: number;
    status: "outstanding" | "settled";
    note?: string;
    now: Date;
  },
): Promise<void> {
  if (args.amountCents <= 0) return; // a zero-rate market records nothing
  await tx.insert(customerFees).values({
    customerId: args.customerId,
    orderId: args.orderId,
    orderRef: args.orderRef,
    type: args.type,
    amountCents: args.amountCents,
    status: args.status,
    note: args.note ?? "",
    settledAt: args.status === "settled" ? args.now : null,
  });
}

/** Sum of the customer's outstanding fees — > 0 blocks bidding and buying. */
export async function outstandingFeeCents(db: Pick<Db, "select">, customerId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${customerFees.amountCents}), 0)` })
    .from(customerFees)
    .where(and(eq(customerFees.customerId, customerId), eq(customerFees.status, "outstanding")));
  return Number(row?.total ?? 0);
}
