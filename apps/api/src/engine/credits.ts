import { creditEntries, credits, type Db } from "@auction/db";
import { eq } from "drizzle-orm";

/**
 * Аванс клиента (экраны № 69b, 71–73). Инварианты:
 *  - баланс меняется только вместе с записью в credit_entries;
 *  - плюс — пополнение (переплата, возврат, ручное начисление),
 *    минус — списание (зачёт в заказ, возврат на счёт клиента);
 *  - баланс никогда не уходит ниже нуля — списание больше остатка
 *    отвергается, а не молча обрезается.
 */
type Tx = Pick<Db, "select" | "insert" | "update">;

export interface CreditMove {
  kind: "overpay" | "refund_to_credit" | "used_for_order" | "withdrawn" | "expired" | "grant";
  amountCents: number;
  orderRef?: string | null;
  note?: string;
  actorLabel?: string;
}

export async function getOrCreateCredit(tx: Tx, customerId: string): Promise<{ id: string; balanceCents: number; expiresAt: Date | null }> {
  const [existing] = await tx.select().from(credits).where(eq(credits.customerId, customerId));
  if (existing) return { id: existing.id, balanceCents: existing.balanceCents, expiresAt: existing.expiresAt };
  const [row] = await tx
    .insert(credits)
    .values({ customerId })
    .onConflictDoNothing()
    .returning({ id: credits.id });
  if (row) return { id: row.id, balanceCents: 0, expiresAt: null };
  const [raced] = await tx.select().from(credits).where(eq(credits.customerId, customerId));
  return { id: raced!.id, balanceCents: raced!.balanceCents, expiresAt: raced!.expiresAt };
}

export class InsufficientCreditError extends Error {
  constructor(public readonly balanceCents: number) {
    super("insufficient credit");
  }
}

/** Провести движение аванса. Отрицательная сумма — списание. */
export async function moveCredit(
  tx: Tx,
  customerId: string,
  move: CreditMove,
  now: Date,
  expiryMonths = 12,
): Promise<{ balanceCents: number }> {
  const credit = await getOrCreateCredit(tx, customerId);
  const next = credit.balanceCents + move.amountCents;
  if (next < 0) throw new InsufficientCreditError(credit.balanceCents);
  // Срок сгорания отсчитывается от последнего пополнения.
  const expiresAt =
    move.amountCents > 0 ? new Date(now.getTime() + expiryMonths * 30 * 86_400_000) : undefined;
  await tx
    .update(credits)
    .set({ balanceCents: next, updatedAt: now, ...(expiresAt ? { expiresAt } : {}) })
    .where(eq(credits.id, credit.id));
  await tx.insert(creditEntries).values({
    creditId: credit.id,
    kind: move.kind,
    amountCents: move.amountCents,
    orderRef: move.orderRef ?? null,
    note: move.note ?? "",
    actorLabel: move.actorLabel ?? null,
  });
  return { balanceCents: next };
}
