import { customers, notifications, type Db } from "@auction/db";
import { formatEur } from "@auction/domain";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";

/**
 * Notification enqueue + dispatch. Enqueue writes an outbox row (inside the
 * caller's transaction when durability matters); dispatch drains pending rows
 * and hands each to the email adapter, marking sent/failed with retry.
 */

export type NotificationType =
  | "outbid"
  | "won"
  | "purchased"
  | "payment_reminder"
  | "order_paid"
  | "pickup_ready"
  | "pickup_reminder"
  | "no_pickup_cancelled"
  | "unpaid_cancelled"
  | "shipped";

type Lang = "lv" | "en";

/** Bidder country → template language (lv for Latvia, en elsewhere for now). */
function langForCountry(country: string | null): Lang {
  return country === "LV" ? "lv" : "en";
}

interface TemplateInput {
  alias: string;
  lotTitle: string;
  amountCents?: number | undefined;
  orderRef?: string | undefined;
  totalCents?: number | undefined;
  deadline?: Date | undefined;
  /** Pickup pass credential (pickup_ready / pickup_reminder). */
  pickupCode?: string | undefined;
  /** No-show settlement (no_pickup_cancelled). */
  feeCents?: number | undefined;
  refundCents?: number | undefined;
  /** One-click Klix checkout link (won / purchased / payment_reminder). */
  payUrl?: string | null | undefined;
  /** Carrier tracking (shipped). */
  barcode?: string | undefined;
  machineName?: string | undefined;
  carrier?: string | undefined;
  trackingUrl?: string | undefined;
}

/** type → (lang → {subject, body}). Body carries a machine tag `[type]` used
 * by tests and for traceability; it is harmless in the rendered email. */
function render(type: NotificationType, lang: Lang, i: TemplateInput): { subject: string; body: string } {
  const money = (c: number | undefined) => (c === undefined ? "" : formatEur(c));
  // Appended to payment-due emails when online payments are on: one click
  // opens the Klix checkout (cards, Pay Later, banklinks) — no login needed.
  // The KLIX_PL_EXAMPLE placeholder is resolved at DISPATCH time (see
  // resolvePayLaterExample) into Klix's representative example — the
  // legally-required consumer-credit wording with the real monthly payment
  // for this exact amount. Enqueue stays free of network calls (it runs
  // inside the caller's transaction).
  const plExample = i.payUrl && i.totalCents ? `{{KLIX_PL_EXAMPLE:${i.totalCents}:${lang}}}` : "";
  const payLine = i.payUrl
    ? lang === "lv"
      ? `\nApmaksāt tiešsaistē (karte, banklinks, Klix Pay Later):\n${i.payUrl}\n${plExample}`
      : `\nPay online (card, bank link, Klix Pay Later):\n${i.payUrl}\n${plExample}`
    : "";
  const t: Record<NotificationType, Record<Lang, { subject: string; body: string }>> = {
    outbid: {
      lv: {
        subject: `Jūsu solījums pārsolīts — ${i.lotTitle}`,
        body: `Sveiki, ${i.alias}!\n\nJūsu solījums izsolē "${i.lotTitle}" ir pārsolīts. Pašreizējā cena: ${money(i.amountCents)}.\nJa vēlaties turpināt, paaugstiniet savu maksimālo cenu.\n\n[outbid]`,
      },
      en: {
        subject: `You have been outbid — ${i.lotTitle}`,
        body: `Hi ${i.alias},\n\nYou have been outbid on "${i.lotTitle}". Current price: ${money(i.amountCents)}.\nRaise your maximum bid if you'd like to stay in.\n\n[outbid]`,
      },
    },
    won: {
      lv: {
        subject: `Apsveicam — jūs uzvarējāt izsolē ${i.lotTitle}`,
        body: `Sveiki, ${i.alias}!\n\nJūs uzvarējāt izsolē "${i.lotTitle}". Rēķina numurs: ${i.orderRef}. Kopā apmaksai: ${money(i.totalCents)}.\nLūdzu, apmaksājiet līdz ${i.deadline?.toISOString().slice(0, 10)}.\n${payLine}\n[won]`,
      },
      en: {
        subject: `Congratulations — you won ${i.lotTitle}`,
        body: `Hi ${i.alias},\n\nYou won "${i.lotTitle}". Order ${i.orderRef}. Total due: ${money(i.totalCents)}.\nPlease pay by ${i.deadline?.toISOString().slice(0, 10)}.\n${payLine}\n[won]`,
      },
    },
    purchased: {
      lv: {
        subject: `Pirkums apstiprināts — ${i.lotTitle}`,
        body: `Sveiki, ${i.alias}!\n\nPaldies par pirkumu "${i.lotTitle}". Rēķina numurs: ${i.orderRef}. Kopā apmaksai: ${money(i.totalCents)}.\nLūdzu, apmaksājiet līdz ${i.deadline?.toISOString().slice(0, 10)}.\n${payLine}\n[purchased]`,
      },
      en: {
        subject: `Purchase confirmed — ${i.lotTitle}`,
        body: `Hi ${i.alias},\n\nThank you for buying "${i.lotTitle}". Order ${i.orderRef}. Total due: ${money(i.totalCents)}.\nPlease pay by ${i.deadline?.toISOString().slice(0, 10)}.\n${payLine}\n[purchased]`,
      },
    },
    payment_reminder: {
      lv: {
        subject: `Atgādinājums par apmaksu — ${i.orderRef}`,
        body: `Sveiki, ${i.alias}!\n\nRēķins ${i.orderRef} (${money(i.totalCents)}) vēl nav apmaksāts. Termiņš: ${i.deadline?.toISOString().slice(0, 16).replace("T", " ")}.\nNeapmaksāšanas gadījumā pasūtījums tiks atcelts.\n${payLine}\n[payment_reminder]`,
      },
      en: {
        subject: `Payment reminder — ${i.orderRef}`,
        body: `Hi ${i.alias},\n\nOrder ${i.orderRef} (${money(i.totalCents)}) is not yet paid. Deadline: ${i.deadline?.toISOString().slice(0, 16).replace("T", " ")}.\nIf unpaid, the order will be cancelled.\n${payLine}\n[payment_reminder]`,
      },
    },
    order_paid: {
      lv: {
        subject: `Apmaksa saņemta — ${i.orderRef}`,
        body: `Sveiki, ${i.alias}!\n\nMēs saņēmām apmaksu par pasūtījumu ${i.orderRef} (${money(i.totalCents)}). Paldies!\n\n[order_paid]`,
      },
      en: {
        subject: `Payment received — ${i.orderRef}`,
        body: `Hi ${i.alias},\n\nWe received payment for order ${i.orderRef} (${money(i.totalCents)}). Thank you!\n\n[order_paid]`,
      },
    },
    pickup_ready: {
      lv: {
        subject: `Gatavs saņemšanai — ${i.orderRef}`,
        body: `Sveiki, ${i.alias}!\n\nPasūtījums ${i.orderRef} ir gatavs saņemšanai noliktavā. Saņemšanas kods: ${i.pickupCode}.\nLūdzu, izņemiet līdz ${i.deadline?.toISOString().slice(0, 10)} — pēc termiņa pasūtījums tiek atcelts ar 5% uzglabāšanas maksu.\n\n[pickup_ready]`,
      },
      en: {
        subject: `Ready for pickup — ${i.orderRef}`,
        body: `Hi ${i.alias},\n\nOrder ${i.orderRef} is ready for collection at the warehouse. Pickup code: ${i.pickupCode}.\nPlease collect by ${i.deadline?.toISOString().slice(0, 10)} — after the deadline the order is cancelled with a 5% restocking fee.\n\n[pickup_ready]`,
      },
    },
    pickup_reminder: {
      lv: {
        subject: `Atgādinājums: saņemiet pasūtījumu ${i.orderRef}`,
        body: `Sveiki, ${i.alias}!\n\nPasūtījums ${i.orderRef} joprojām gaida noliktavā. Saņemšanas kods: ${i.pickupCode}.\nTermiņš: ${i.deadline?.toISOString().slice(0, 10)}. Pēc termiņa pasūtījums tiek atcelts ar 5% uzglabāšanas maksu.\n\n[pickup_reminder]`,
      },
      en: {
        subject: `Reminder: collect order ${i.orderRef}`,
        body: `Hi ${i.alias},\n\nOrder ${i.orderRef} is still waiting at the warehouse. Pickup code: ${i.pickupCode}.\nDeadline: ${i.deadline?.toISOString().slice(0, 10)}. After the deadline the order is cancelled with a 5% restocking fee.\n\n[pickup_reminder]`,
      },
    },
    unpaid_cancelled: {
      lv: {
        subject: `Pasūtījums atcelts (nav apmaksāts) — ${i.orderRef}`,
        body: `Sveiki, ${i.alias}!\n\nPasūtījums ${i.orderRef} netika apmaksāts līdz termiņam un ir atcelts. Saskaņā ar noteikumiem tiek piemērota 5% uzglabāšanas maksa: ${money(i.feeCents)}.\nKamēr maksa nav nokārtota, solīšana un pirkšana jūsu kontā ir apturēta.\n\n[unpaid_cancelled]`,
      },
      en: {
        subject: `Order cancelled (not paid) — ${i.orderRef}`,
        body: `Hi ${i.alias},\n\nOrder ${i.orderRef} was not paid by the deadline and has been cancelled. Per our terms a 5% restocking fee applies: ${money(i.feeCents)}.\nBidding and buying on your account are paused until the fee is settled.\n\n[unpaid_cancelled]`,
      },
    },
    shipped: {
      lv: {
        subject: `Sūtījums ceļā — ${i.orderRef}`,
        body: `Sveiki, ${i.alias}!\n\nPasūtījums ${i.orderRef} ir nodots ${i.carrier ?? "Omniva"} un ceļā uz pakomātu "${i.machineName}".\nSūtījuma numurs: ${i.barcode}\nSekot sūtījumam: ${i.trackingUrl}\n\nKad paka būs pakomātā, ${i.carrier ?? "Omniva"} nosūtīs SMS ar durvju kodu.\n\n[shipped]`,
      },
      en: {
        subject: `Your parcel is on its way — ${i.orderRef}`,
        body: `Hi ${i.alias},\n\nOrder ${i.orderRef} has been handed to ${i.carrier ?? "Omniva"} and is on its way to the "${i.machineName}" locker.\nTracking number: ${i.barcode}\nTrack it here: ${i.trackingUrl}\n\n${i.carrier ?? "Omniva"} will text you a door code when the parcel arrives.\n\n[shipped]`,
      },
    },
    no_pickup_cancelled: {
      lv: {
        subject: `Pasūtījums atcelts (nav izņemts) — ${i.orderRef}`,
        body: `Sveiki, ${i.alias}!\n\nPasūtījums ${i.orderRef} netika izņemts līdz termiņam un ir atcelts. Uzglabāšanas maksa: ${money(i.feeCents)}. Atmaksa: ${money(i.refundCents)}.\nAtmaksa tiks veikta uz jūsu maksājuma līdzekli.\n\n[no_pickup_cancelled]`,
      },
      en: {
        subject: `Order cancelled (not collected) — ${i.orderRef}`,
        body: `Hi ${i.alias},\n\nOrder ${i.orderRef} was not collected by the deadline and has been cancelled. Restocking fee: ${money(i.feeCents)}. Refund: ${money(i.refundCents)}.\nThe refund will be returned to your payment method.\n\n[no_pickup_cancelled]`,
      },
    },
  };
  return t[type][lang];
}

type Tx = Pick<Db, "select" | "insert">;

/**
 * Enqueue a notification for a customer. Looks up the recipient's email +
 * language snapshot. Skips silently for erased/missing recipients. `dedupeKey`
 * (when given) makes the enqueue idempotent via the unique index.
 */
export async function enqueueNotification(
  tx: Tx,
  args: { customerId: string; type: NotificationType; template: TemplateInput; dedupeKey?: string },
): Promise<void> {
  const [recipient] = await tx
    .select({ email: customers.email, alias: customers.alias, country: customers.country, erasedAt: customers.erasedAt })
    .from(customers)
    .where(eq(customers.id, args.customerId));
  if (!recipient || recipient.erasedAt !== null) return;

  const lang = langForCountry(recipient.country);
  // The greeting name always comes from the current record, never the caller.
  const { subject, body } = render(args.type, lang, { ...args.template, alias: recipient.alias });
  await tx
    .insert(notifications)
    .values({
      customerId: args.customerId,
      type: args.type,
      toEmail: recipient.email,
      lang,
      subject,
      body,
      dedupeKey: args.dedupeKey ?? null,
    })
    .onConflictDoNothing(); // dedupeKey collision → already enqueued
}

const MAX_ATTEMPTS = 5;

const PL_EXAMPLE_TOKEN = /\{\{KLIX_PL_EXAMPLE:(\d+):(\w+)\}\}/;
const PL_EXAMPLE_CACHE_TTL_SEC = 24 * 3600;

/**
 * Resolve the Pay Later representative-example placeholder into Klix's
 * actual consumer-credit text for the amount (cached in Redis for a day —
 * the financing endpoint is rate-limited and the text is deterministic per
 * amount/language). Degrades to removing the placeholder: a Klix hiccup
 * must never block the "you won" email.
 */
async function resolvePayLaterExample(ctx: AppContext, body: string): Promise<string> {
  const m = body.match(PL_EXAMPLE_TOKEN);
  if (!m) return body;
  let text = "";
  if (ctx.klix) {
    const [, amount, lang] = m as unknown as [string, string, string];
    const cacheKey = `klix:pl_example:${amount}:${lang}`;
    try {
      const cached = await ctx.redis.get(cacheKey);
      if (cached !== null) {
        text = cached;
      } else {
        text = (await ctx.klix.representativeExample(Number(amount), lang)) ?? "";
        await ctx.redis.set(cacheKey, text, "EX", PL_EXAMPLE_CACHE_TTL_SEC);
      }
    } catch {
      text = "";
    }
  }
  return body.replace(PL_EXAMPLE_TOKEN, text ? `${text}\n` : "");
}

/** Drain pending notifications and send them. Returns how many were sent. */
export async function dispatchNotifications(ctx: AppContext, batch = 50): Promise<number> {
  const pending = await ctx.db
    .select()
    .from(notifications)
    .where(eq(notifications.status, "pending"))
    .orderBy(asc(notifications.createdAt))
    .limit(batch);

  let sent = 0;
  for (const n of pending) {
    try {
      const body = await resolvePayLaterExample(ctx, n.body);
      await ctx.email.send({ to: n.toEmail, subject: n.subject, text: body });
      await ctx.db
        .update(notifications)
        .set({ status: "sent", sentAt: ctx.now(), attempts: n.attempts + 1, body })
        .where(eq(notifications.id, n.id));
      sent += 1;
    } catch (err) {
      const attempts = n.attempts + 1;
      await ctx.db
        .update(notifications)
        .set({
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          attempts,
          lastError: (err as Error).message.slice(0, 500),
        })
        .where(eq(notifications.id, n.id));
    }
  }
  return sent;
}

/** Convenience for tests/ops: count outbox rows by status. */
export async function notificationCounts(ctx: AppContext): Promise<Record<string, number>> {
  const rows = await ctx.db
    .select({ status: notifications.status, n: sql<string>`count(*)` })
    .from(notifications)
    .groupBy(notifications.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

/** Reminders due: awaiting-payment orders whose deadline is within the window. */
export function reminderDedupeKey(orderId: string): string {
  return `payment_reminder:${orderId}`;
}

/** One pickup reminder per window (3 days out, 1 day out) per order. */
export function pickupReminderDedupeKey(orderId: string, window: "3d" | "1d"): string {
  return `pickup_reminder:${window}:${orderId}`;
}
