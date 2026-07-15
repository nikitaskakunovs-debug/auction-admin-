import { auditLog, type Db } from "@auction/db";

export interface Actor {
  id: string | null;
  label: string;
}

export const SYSTEM_ACTOR: Actor = { id: null, label: "System" };

/**
 * Append-only audit write-through. `dbOrTx` accepts a transaction so audit
 * rows commit atomically with the mutation they describe.
 */
export async function writeAudit(
  dbOrTx: Pick<Db, "insert">,
  actor: Actor,
  type: string,
  action: string,
  target = "",
  detail: Record<string, unknown> | null = null,
): Promise<void> {
  await dbOrTx.insert(auditLog).values({
    actorId: actor.id,
    actorLabel: actor.label,
    type,
    action,
    target,
    detail,
  });
}
