/**
 * Post-deploy smoke check — is the thing we just shipped actually working?
 *
 *   docker compose -f docker-compose.prod.yml exec api node apps/api/dist/smoke.js
 *
 * Read-only by construction: it connects, fetches and counts, and writes
 * nothing anywhere. Safe to run against production at any hour, as often as
 * you like.
 *
 * It answers the questions a person would otherwise answer by clicking:
 * did the migrations run, is the clock ticking, does the panel load over
 * TLS, will an email leave the building, and is anything stuck in a queue.
 *
 * Exit code 0 when every required check passed, 1 otherwise — so it can sit
 * at the end of a deploy command with `&&` and stop the line when something
 * is wrong.
 */
import { access, constants } from "node:fs/promises";
import { createDb, migrationStatus, notifications } from "@auction/db";
import { eq, lt, and, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { createEmailAdapter } from "./email.js";

const cfg = loadConfig();
const { db, pool } = createDb(cfg.databaseUrl);
const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });

type Level = "required" | "advisory";

interface Result {
  ok: boolean;
  label: string;
  detail: string;
  level: Level;
}

const results: Result[] = [];

async function check(label: string, level: Level, run: () => Promise<string>): Promise<void> {
  try {
    results.push({ ok: true, label, detail: await run(), level });
  } catch (err) {
    results.push({ ok: false, label, detail: err instanceof Error ? err.message : String(err), level });
  }
}

/** An informational line — a fact worth printing that cannot fail. */
function note(label: string, detail: string): void {
  results.push({ ok: true, label, detail, level: "advisory" });
}

/**
 * Fetch with a deadline, and with an error a person can act on. Node's bare
 * "fetch failed" names neither the address nor the reason, which is the one
 * thing you need at 2am.
 */
async function get(url: string, timeoutMs = 8_000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctl.signal, redirect: "follow" });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    const why =
      (err as Error).name === "AbortError"
        ? `neatbild ${timeoutMs / 1000} s laikā`
        : cause === "ENOTFOUND"
          ? "domēns neatrisinās (DNS)"
          : cause === "ECONNREFUSED"
            ? "savienojums atteikts — vai serviss darbojas?"
            : cause === "CERT_HAS_EXPIRED"
              ? "sertifikāts beidzies"
              : ((err as Error).message ?? "nezināma kļūda");
    throw new Error(`${url} — ${why}`);
  } finally {
    clearTimeout(timer);
  }
}


/**
 * Fetch a URL that sits behind Caddy, giving the upstream a moment to finish
 * booting. Only the "not ready yet" statuses are retried: a 404 or a 403 is
 * an answer, and waiting thirty seconds to repeat it helps nobody.
 */
const NOT_READY = new Set([502, 503, 504]);

async function settle(url: string, waitMs = 45_000): Promise<Response> {
  const deadline = Date.now() + waitMs;
  let last = "";
  for (;;) {
    try {
      const res = await get(url, 5_000);
      if (res.ok) return res;
      last = `${url} atbild ar ${res.status}`;
      if (!NOT_READY.has(res.status)) throw new Error(last);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      // A refused connection during a deploy is "not up yet", not "broken".
      if (!/atteikts|neatbild|502|503|504/.test(last)) throw err;
    }
    if (Date.now() >= deadline) throw new Error(`${last} (gaidīts ${waitMs / 1000} s)`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  console.log("── izsoli.lv · pēc-deploy pārbaude ─────────────────────────");

  // ── The database, and whether this build's migrations actually ran ────────
  await check("Datubāze", "required", async () => {
    await db.execute(sql`select 1`);
    return "savienojums ir";
  });

  await check("Migrācijas", "required", async () => {
    const m = await migrationStatus(db);
    if (m.pending.length > 0) {
      throw new Error(
        `${m.applied}/${m.total} — trūkst ${m.pending.length}: ${m.pending.join(", ")}. ` +
          `Palaid: docker compose -f docker-compose.prod.yml exec api node packages/db/dist/migrate.js`,
      );
    }
    return `${m.applied}/${m.total} piemērotas`;
  });

  // ── Redis, and the clock that lives in it ─────────────────────────────────
  await check("Redis", "required", async () => {
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error(`negaidīta atbilde: ${pong}`);
    return "atbild";
  });

  // ── The API itself, from inside and from the outside ──────────────────────
  //
  // `docker compose up -d` returns when the container has *started*, not when
  // the process inside is listening — so a check run straight after a deploy
  // meets an API that is still opening its database pool. Waiting is the
  // difference between a useful alarm and a false one; a minute is long
  // enough for a boot and short enough that a real outage still fails.
  await check("API (konteinerā)", "required", async () => {
    const deadline = Date.now() + 60_000;
    let last = "";
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await get(`http://127.0.0.1:${cfg.port}/api/health`, 5_000);
        if (res.ok) {
          const body = (await res.json()) as { ok?: boolean };
          if (body.ok) return attempt === 1 ? "vesels" : `vesels (pēc ${attempt} mēģinājumiem)`;
          last = "health atbild, bet ne ar ok:true";
        } else {
          last = `atbild ar ${res.status}`;
        }
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      if (Date.now() >= deadline) throw new Error(`${last} (gaidīts 60 s)`);
      if (attempt === 1) console.log("  … gaida, līdz API pieceļas");
      await new Promise((r) => setTimeout(r, 2_000));
    }
  });

  await check("Plānotājs (izsoļu pulkstenis)", cfg.schedulerEnabled ? "required" : "advisory", async () => {
    if (!cfg.schedulerEnabled) return "izslēgts konfigurācijā (SCHEDULER_ENABLED)";
    let beat = await redis.get("scheduler:beat");
    // The first beat lands one tick after boot; on a fresh deploy the API can
    // be answering a moment before the clock has swung once.
    for (let i = 0; !beat && i < 5; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      beat = await redis.get("scheduler:beat");
    }
    if (!beat) {
      throw new Error("nav pulsa pēdējo 2 minūšu laikā — izsoles var nenoslēgties un e-pasti neaiziet");
    }
    const ageSec = Math.round((Date.now() - new Date(beat).getTime()) / 1000);
    if (ageSec > 60) throw new Error(`pēdējais aplis pirms ${ageSec} s — pulkstenis atpaliek`);
    return `dzīvs, pēdējais aplis pirms ${ageSec} s`;
  });

  await check("API (publiski, caur Caddy/TLS)", "required", async () => {
    // 502 here means Caddy is up but its upstream is not answering yet —
    // the same post-deploy race, one layer out.
    await settle(`${cfg.publicBaseUrl}/api/health`);
    return `${cfg.publicBaseUrl} — sertifikāts un starpniekserveris kārtībā`;
  });

  await check("TV tablo", "required", async () => {
    const res = await get(`${cfg.publicBaseUrl}/api/public/pickup/board`);
    if (!res.ok) throw new Error(`atbild ar ${res.status}`);
    const body = (await res.json()) as { tickets?: unknown[] };
    if (!Array.isArray(body.tickets)) throw new Error("atbilde bez talonu saraksta");
    return `${body.tickets.length} aktīvi taloni`;
  });

  await check("Admin panelis", "required", async () => {
    const res = await get(cfg.adminBaseUrl);
    if (!res.ok) throw new Error(`${cfg.adminBaseUrl} atbild ar ${res.status}`);
    const html = await res.text();
    // The SPA shell must carry its bundle; a Caddy that serves an empty
    // index.html looks "up" and is useless.
    if (!/<script[^>]+src=/.test(html)) throw new Error("lapa ielādējas, bet bez JS pakotnes — būvējums nav iekšā");
    return `${cfg.adminBaseUrl} ielādējas`;
  });

  await check("Veikals (storefront)", "required", async () => {
    await settle(cfg.storefrontBaseUrl);
    return `${cfg.storefrontBaseUrl} ielādējas`;
  });

  // ── Will an email actually leave the building? ────────────────────────────
  await check("E-pasta sūtīšana", cfg.emailMode === "smtp" ? "required" : "advisory", async () => {
    if (cfg.emailMode !== "smtp") return "console režīms — vēstules netiek sūtītas, tikai reģistrētas";
    const adapter = createEmailAdapter(cfg.emailMode, cfg.smtp);
    if (!adapter.verify) return "adapteris bez pārbaudes";
    await adapter.verify();
    return `${cfg.smtp?.host}:${cfg.smtp?.port} pieņem savienojumu`;
  });

  // ── The outbox: nothing quietly stuck ─────────────────────────────────────
  await check("Vēstuļu rinda", "required", async () => {
    const [failed] = await db
      .select({ n: sql<string>`count(*)` })
      .from(notifications)
      .where(eq(notifications.status, "failed"));
    const [stale] = await db
      .select({ n: sql<string>`count(*)` })
      .from(notifications)
      .where(
        and(
          eq(notifications.status, "pending"),
          lt(notifications.createdAt, new Date(Date.now() - 15 * 60_000)),
        ),
      );
    const failedN = Number(failed?.n ?? 0);
    const staleN = Number(stale?.n ?? 0);
    if (staleN > 0) throw new Error(`${staleN} vēstules gaida ilgāk par 15 min — sūtīšana ir apstājusies`);
    if (failedN > 0) throw new Error(`${failedN} vēstules neizdevās nosūtīt (skat. Paziņojumi panelī)`);
    return "nekas nav iestrēdzis";
  });

  // ── Local photo storage ───────────────────────────────────────────────────
  if (cfg.storageDriver === "local") {
    await check("Bilžu glabātuve", "required", async () => {
      await access(cfg.uploadDir, constants.W_OK);
      return `${cfg.uploadDir} ir rakstāma`;
    });
  }

  // ── What is switched on, for the record ───────────────────────────────────
  const onOff = (on: boolean) => (on ? "IESLĒGTS" : "izslēgts");
  note("Maksājumi", `Klix ${cfg.klixMode} · Inbank ${cfg.inbankMode}`);
  note("Piegāde", `Omniva ${cfg.omnivaMode}`);
  note("Uzņēmuma dati vēstulēs", cfg.emailBrand.regNo ? "aizpildīti" : "TRŪKST reģ. numura un, iespējams, adreses");
  note("Slack", onOff(Boolean(cfg.slack?.botToken)));

  // ── Report ────────────────────────────────────────────────────────────────
  console.log("");
  const pad = (s: string) => s.padEnd(34, " ");
  for (const r of results) {
    const mark = r.ok ? "✓" : r.level === "required" ? "✗" : "!";
    console.log(`  ${mark} ${pad(r.label)} ${r.detail}`);
  }

  const failures = results.filter((r) => !r.ok && r.level === "required");
  const warnings = results.filter((r) => !r.ok && r.level === "advisory");
  console.log("");
  console.log("───────────────────────────────────────────────────────────");
  if (failures.length === 0) {
    console.log(`viss kārtībā · ${results.filter((r) => r.ok).length} pārbaudes · ${Date.now() - started} ms`);
    if (warnings.length > 0) console.log(`${warnings.length} brīdinājums(-i) — nav kritiski`);
  } else {
    console.log(`${failures.length} PĀRBAUDE(-S) NEIZDEVĀS:`);
    for (const f of failures) console.log(`  ✗ ${f.label}: ${f.detail}`);
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error("pārbaude avarēja:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    redis.disconnect();
  });
