import { randomUUID } from "node:crypto";
import { bugReportComments, bugReportReads, bugReports } from "@auction/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { slackBugReported } from "../engine/slackNotify.js";
import { sendReportToJira, syncOneReport } from "../engine/bugSync.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

const TYPES = ["bug", "visual", "data", "slow", "idea"] as const;
const SEVERITIES = ["low", "normal", "high", "blocker"] as const;

const reportBody = z.object({
  body: z.string().min(5).max(4000),
  steps: z.string().max(4000).default(""),
  type: z.enum(TYPES).default("bug"),
  severity: z.enum(SEVERITIES).default("normal"),
  screen: z.string().max(120).default(""),
  context: z.record(z.string(), z.string().max(300)).default({}),
  consoleLog: z.array(z.string().max(600)).max(100).default([]),
  attachments: z.array(z.string().max(500)).max(10).default([]),
});

export function registerBugRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  /** Any signed-in admin/worker may report and read their own reports. */
  const signedIn = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.admin) await reply.code(401).send({ error: "unauthenticated" });
  };

  const canModerate = async (req: FastifyRequest): Promise<boolean> =>
    (await perms.permissionsFor(req.admin!.role)).has("audit.view");

  // ── Attachments (uploaded before the report is created) ────────────────────

  const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const VIDEO_TYPES = new Set(["video/webm", "video/mp4"]);

  app.post("/api/bugs/uploads", { preHandler: signedIn }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: "multipart_required" });
    const urls: string[] = [];
    for await (const part of req.files()) {
      const buf = await part.toBuffer();
      if (part.file.truncated) return reply.code(400).send({ error: "file_too_large" });
      if (IMAGE_TYPES.has(part.mimetype)) {
        // Screenshots keep detail: capped to 2000px, quality 85 webp.
        let processed: Buffer;
        try {
          processed = await sharp(buf).rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
        } catch {
          return reply.code(400).send({ error: "invalid_image" });
        }
        urls.push(await ctx.storage.put(`bugs/${randomUUID()}.webp`, processed, "image/webp"));
      } else if (VIDEO_TYPES.has(part.mimetype)) {
        const ext = part.mimetype === "video/mp4" ? "mp4" : "webm";
        urls.push(await ctx.storage.put(`bugs/${randomUUID()}.${ext}`, buf, part.mimetype));
      } else {
        return reply.code(400).send({ error: "unsupported_type", detail: part.mimetype });
      }
    }
    if (urls.length === 0) return reply.code(400).send({ error: "no_files" });
    return { urls };
  });

  // ── Create ─────────────────────────────────────────────────────────────────

  app.post("/api/bugs", { preHandler: signedIn }, async (req, reply) => {
    const body = reportBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    // Insert first, then send — a Jira outage leaves a queued report the
    // scheduler retries, never a lost one.
    const [inserted] = await ctx.db
      .insert(bugReports)
      .values({
        reporterId: req.admin!.sub,
        reporterLabel: req.admin!.name,
        screen: body.data.screen,
        context: body.data.context,
        body: body.data.body,
        steps: body.data.steps,
        type: body.data.type,
        severity: body.data.severity,
        attachments: body.data.attachments,
        consoleLog: body.data.consoleLog,
        status: "open",
      })
      .returning();
    const row = await sendReportToJira(ctx, inserted!);
    await writeAudit(ctx.db, actor(req), "settings", "bug_reported", row.jiraKey ?? row.id, {
      severity: body.data.severity,
      type: body.data.type,
      screen: body.data.screen,
    });
    slackBugReported(ctx, {
      jiraKey: row.jiraKey,
      severity: body.data.severity,
      reporter: actor(req).label,
      body: body.data.body,
      screen: body.data.screen,
    });
    return { report: row };
  });

  // ── Lists ──────────────────────────────────────────────────────────────────

  /** Unread IT messages per report for this admin. Correlated identifiers are
   * hand-qualified — drizzle renders sql`` column refs unqualified, and the
   * inner scope would capture them (the customers debt filter hit this too). */
  const unreadSql = (userId: string) => sql<string>`(
    select count(*) from bug_report_comments c
    left join bug_report_reads r on r.report_id = c.report_id and r.user_id = ${userId}
    where c.report_id = bug_reports.id and c.side = 'it'
      and (r.last_read_at is null or c.created_at > r.last_read_at)
  )`;

  app.get("/api/bugs/mine", { preHandler: signedIn }, async (req) => {
    const rows = await ctx.db
      .select({
        report: bugReports,
        commentCount: sql<string>`(select count(*) from bug_report_comments c where c.report_id = bug_reports.id)`,
        unread: unreadSql(req.admin!.sub),
      })
      .from(bugReports)
      .where(eq(bugReports.reporterId, req.admin!.sub))
      .orderBy(desc(bugReports.createdAt))
      .limit(100);
    return {
      reports: rows.map((r) => ({ ...r.report, commentCount: Number(r.commentCount), unread: Number(r.unread) })),
    };
  });

  app.get("/api/bugs", guard("audit.view"), async (req) => {
    const q = req.query as { status?: string };
    const rows = await ctx.db
      .select({
        report: bugReports,
        commentCount: sql<string>`(select count(*) from bug_report_comments c where c.report_id = bug_reports.id)`,
        unread: unreadSql(req.admin!.sub),
      })
      .from(bugReports)
      .where(q.status ? eq(bugReports.status, q.status) : undefined)
      .orderBy(desc(bugReports.createdAt))
      .limit(200);
    return {
      reports: rows.map((r) => ({ ...r.report, commentCount: Number(r.commentCount), unread: Number(r.unread) })),
    };
  });

  // ── Detail + chat ──────────────────────────────────────────────────────────

  const loadVisible = async (req: FastifyRequest, id: string) => {
    const [report] = await ctx.db.select().from(bugReports).where(eq(bugReports.id, id));
    if (!report) return null;
    if (report.reporterId !== req.admin!.sub && !(await canModerate(req))) return "forbidden" as const;
    return report;
  };

  app.get("/api/bugs/:id", { preHandler: signedIn }, async (req, reply) => {
    let report = await loadVisible(req, (req.params as { id: string }).id);
    if (report === null) return reply.code(404).send({ error: "not_found" });
    if (report === "forbidden") return reply.code(403).send({ error: "forbidden" });
    // Opening a chat pulls Jira right now (throttled) — replies appear on
    // open/poll instead of waiting for the 5-min sweep or the webhook.
    if (ctx.jira && report.jiraKey && (report.status === "sent" || report.status === "in_progress")) {
      const fresh = await ctx.redis.set(`bugs:syncone:${report.id}`, "1", "EX", 10, "NX");
      if (fresh) {
        await syncOneReport(ctx, report).catch(() => undefined);
        const [reloaded] = await ctx.db.select().from(bugReports).where(eq(bugReports.id, report.id));
        report = reloaded ?? report;
      }
    }
    const comments = await ctx.db
      .select()
      .from(bugReportComments)
      .where(eq(bugReportComments.reportId, report.id))
      .orderBy(bugReportComments.createdAt)
      .limit(200);
    return { report, comments };
  });

  const commentBody = z.object({ body: z.string().min(1).max(2000) });
  app.post("/api/bugs/:id/comments", { preHandler: signedIn }, async (req, reply) => {
    const body = commentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const report = await loadVisible(req, (req.params as { id: string }).id);
    if (report === null) return reply.code(404).send({ error: "not_found" });
    if (report === "forbidden") return reply.code(403).send({ error: "forbidden" });

    // Mirror into Jira first so we can store the comment id for dedupe.
    let jiraCommentId: string | null = null;
    if (ctx.jira && report.jiraKey) {
      try {
        const c = await ctx.jira.addComment(report.jiraKey, `${req.admin!.name} (admin panel): ${body.data.body}`);
        jiraCommentId = c.id;
      } catch {
        jiraCommentId = null; // chat still works panel-side
      }
    }
    const [row] = await ctx.db
      .insert(bugReportComments)
      .values({
        reportId: report.id,
        authorId: req.admin!.sub,
        authorLabel: req.admin!.name,
        side: "panel",
        jiraCommentId,
        body: body.data.body,
      })
      .returning();
    return { comment: row };
  });

  app.post("/api/bugs/:id/read", { preHandler: signedIn }, async (req, reply) => {
    const report = await loadVisible(req, (req.params as { id: string }).id);
    if (report === null) return reply.code(404).send({ error: "not_found" });
    if (report === "forbidden") return reply.code(403).send({ error: "forbidden" });
    await ctx.db
      .insert(bugReportReads)
      .values({ userId: req.admin!.sub, reportId: report.id, lastReadAt: ctx.now() })
      .onConflictDoUpdate({ target: [bugReportReads.userId, bugReportReads.reportId], set: { lastReadAt: ctx.now() } });
    return { ok: true };
  });

  /** Reporter dismisses their own "fixed ✓" banner. */
  app.post("/api/bugs/:id/ack", { preHandler: signedIn }, async (req, reply) => {
    const [row] = await ctx.db
      .update(bugReports)
      .set({ noticePending: false })
      .where(and(eq(bugReports.id, (req.params as { id: string }).id), eq(bugReports.reporterId, req.admin!.sub)))
      .returning({ id: bugReports.id });
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  /** Bugs-tab moderation: drop a non-issue. If a ticket already exists,
   * leave a note on it so IT doesn't keep working an orphan. */
  app.post("/api/bugs/:id/dismiss", guard("audit.view"), async (req, reply) => {
    const [row] = await ctx.db
      .update(bugReports)
      .set({ status: "dismissed", noticePending: false, updatedAt: ctx.now() })
      .where(eq(bugReports.id, (req.params as { id: string }).id))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (ctx.jira && row.jiraKey) {
      await ctx.jira
        .addComment(row.jiraKey, `Dismissed in the admin panel by ${req.admin!.name} — no further work needed.`)
        .catch(() => undefined);
    }
    await writeAudit(ctx.db, actor(req), "settings", "bug_dismissed", row.jiraKey ?? row.id);
    return { report: row };
  });

  // ── Connection health (the Bugs-tab status card) ───────────────────────────

  app.get("/api/bugs/jira-status", guard("audit.view"), async () => {
    // S1 — the same card reports where events are mirrored.
    const slack = ctx.slack
      ? {
          mode: ctx.config.slackMode,
          channels: [
            ctx.slack.channelName("orders"),
            ctx.slack.channelName("warehouse"),
            ctx.slack.channelName("bugs"),
          ],
        }
      : { mode: "off" as const };
    if (!ctx.jira) return { mode: "off" as const, slack };
    const conn = await ctx.jira.checkConnection();
    return {
      mode: ctx.config.jiraMode,
      project: ctx.config.jira?.project ?? "?",
      webhook: ctx.config.jiraWebhookSecret !== null,
      ...conn,
      slack,
    };
  });

  // ── Jira webhook — near-instant inbound sync (polling stays as fallback) ───

  app.post(
    "/api/jira/webhook",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const secret = ctx.config.jiraWebhookSecret;
      // Unconfigured → the endpoint doesn't exist as far as the world knows.
      if (!secret) return reply.code(404).send({ error: "not_found" });
      if ((req.query as { secret?: string }).secret !== secret) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      const key = (req.body as { issue?: { key?: string } } | null)?.issue?.key;
      if (typeof key !== "string" || key.length === 0) return reply.code(204).send();
      const [report] = await ctx.db.select().from(bugReports).where(eq(bugReports.jiraKey, key));
      if (report) await syncOneReport(ctx, report).catch(() => undefined);
      return reply.code(204).send();
    },
  );
}
