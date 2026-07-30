import { randomUUID } from "node:crypto";
import { bugReportComments, bugReportReads, bugReports } from "@auction/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
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

const TYPE_LABEL: Record<string, string> = {
  bug: "Bug", visual: "Visual glitch", data: "Wrong data", slow: "Slow", idea: "Idea",
};

/** The Jira issue description — everything IT needs, in plain paragraphs. */
function jiraDescription(r: z.infer<typeof reportBody>, reporter: string): string {
  const parts = [
    r.body,
    r.steps ? `Steps to reproduce:\n${r.steps}` : "",
    `Reported by ${reporter} from the admin panel.\nScreen: ${r.screen || "?"}\n` +
      Object.entries(r.context).map(([k, v]) => `${k}: ${v}`).join("\n"),
    r.attachments.length > 0 ? `Attachments:\n${r.attachments.join("\n")}` : "",
    r.consoleLog.length > 0 ? `Console tail (${r.consoleLog.length} lines):\n${r.consoleLog.slice(-20).join("\n")}` : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}

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

    let jiraKey: string | null = null;
    if (ctx.jira) {
      const summary = `[${TYPE_LABEL[body.data.type]}] ${body.data.body.slice(0, 90)}${body.data.body.length > 90 ? "…" : ""}`;
      try {
        const issue = await ctx.jira.createIssue({
          summary,
          description: jiraDescription(body.data, req.admin!.name),
          severity: body.data.severity,
          labels: [body.data.type],
        });
        jiraKey = issue.key;
      } catch {
        // Jira down ≠ report lost: it stays "open" and can be re-sent later.
        jiraKey = null;
      }
    }

    const [row] = await ctx.db
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
        jiraKey,
        status: jiraKey ? "sent" : "open",
      })
      .returning();
    await writeAudit(ctx.db, actor(req), "settings", "bug_reported", jiraKey ?? row!.id, {
      severity: body.data.severity,
      type: body.data.type,
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
    const report = await loadVisible(req, (req.params as { id: string }).id);
    if (report === null) return reply.code(404).send({ error: "not_found" });
    if (report === "forbidden") return reply.code(403).send({ error: "forbidden" });
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

  /** Bugs-tab moderation: drop a non-issue without touching Jira. */
  app.post("/api/bugs/:id/dismiss", guard("audit.view"), async (req, reply) => {
    const [row] = await ctx.db
      .update(bugReports)
      .set({ status: "dismissed", noticePending: false, updatedAt: ctx.now() })
      .where(eq(bugReports.id, (req.params as { id: string }).id))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "settings", "bug_dismissed", row.jiraKey ?? row.id);
    return { report: row };
  });
}
