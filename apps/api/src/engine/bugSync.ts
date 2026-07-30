import { adminUsers, bugReportComments, bugReports } from "@auction/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { publishAdminEvent, type AppContext } from "../context.js";
import type { JiraAttachment } from "./jira.js";

/**
 * Phase E Jira glue: creating issues for reports (used on submit AND as the
 * retry path for reports queued while Jira was down/unconfigured), and pulling
 * status transitions + IT comments back. The full sweep runs from the
 * scheduler behind a 5-minute Redis marker; the webhook route calls
 * syncOneReport for near-instant updates. All safe to call from tests.
 */

type BugReportRow = typeof bugReports.$inferSelect;

const MIME_BY_EXT: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webm: "video/webm",
  mp4: "video/mp4",
};

const TYPE_LABEL: Record<string, string> = {
  bug: "Bug", visual: "Visual glitch", data: "Wrong data", slow: "Slow", idea: "Idea",
};

/** Read the report's stored attachments back for native Jira upload. */
async function loadAttachments(ctx: AppContext, urls: string[]): Promise<JiraAttachment[]> {
  const out: JiraAttachment[] = [];
  for (const url of urls) {
    const key = ctx.storage.keyFor(url);
    if (!key) continue;
    const data = await ctx.storage.get(key);
    if (!data) continue;
    const filename = key.split("/").pop() ?? "attachment";
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    out.push({ filename, data, contentType: MIME_BY_EXT[ext] ?? "application/octet-stream" });
  }
  return out;
}

/**
 * Create the Jira issue for a report (with native attachments) and backfill
 * any chat messages written while it was queued. Returns the updated row, or
 * the original when Jira is off/unreachable — the report simply stays queued.
 */
export async function sendReportToJira(ctx: AppContext, report: BugReportRow): Promise<BugReportRow> {
  if (!ctx.jira || report.jiraKey) return report;
  try {
    const summary = `[${TYPE_LABEL[report.type] ?? report.type}] ${report.body.slice(0, 90)}${report.body.length > 90 ? "…" : ""}`;
    const { key } = await ctx.jira.createIssue({
      summary,
      severity: report.severity,
      labels: [report.type],
      body: report.body,
      steps: report.steps,
      contextLines: [
        `Reported by: ${report.reporterLabel}`,
        `Screen: ${report.screen || "?"}`,
        ...Object.entries(report.context).map(([k, v]) => `${k}: ${v}`),
      ],
      consoleLog: report.consoleLog,
      panelUrl: `${ctx.config.adminBaseUrl}/#/activity`,
    });

    await ctx.jira.addAttachments(key, await loadAttachments(ctx, report.attachments)).catch(() => undefined);

    // Chat written while queued: mirror it now, oldest first.
    const pending = await ctx.db
      .select()
      .from(bugReportComments)
      .where(and(eq(bugReportComments.reportId, report.id), eq(bugReportComments.side, "panel")))
      .orderBy(asc(bugReportComments.createdAt));
    for (const c of pending) {
      if (c.jiraCommentId) continue;
      const posted = await ctx.jira.addComment(key, `${c.authorLabel} (admin panel): ${c.body}`).catch(() => null);
      if (posted) {
        await ctx.db.update(bugReportComments).set({ jiraCommentId: posted.id }).where(eq(bugReportComments.id, c.id));
      }
    }

    const [row] = await ctx.db
      .update(bugReports)
      .set({ jiraKey: key, status: "sent", updatedAt: ctx.now() })
      .where(eq(bugReports.id, report.id))
      .returning();
    return row ?? report;
  } catch {
    return report; // still queued — the next sync pass retries
  }
}

/** Reporter's email + WS ping — the "IT answered you" notification pair. */
async function notifyReporter(ctx: AppContext, report: BugReportRow, subject: string, body: string): Promise<void> {
  await publishAdminEvent(ctx, {
    type: "bug_reply",
    at: ctx.now().toISOString(),
    data: { reportId: report.id, reporterId: report.reporterId, jiraKey: report.jiraKey },
  }).catch(() => undefined);
  if (!report.reporterId) return;
  const [reporter] = await ctx.db
    .select({ email: adminUsers.email })
    .from(adminUsers)
    .where(eq(adminUsers.id, report.reporterId));
  if (!reporter) return;
  const link = `${ctx.config.adminBaseUrl}/#/activity`;
  await ctx.email
    .send({
      to: reporter.email,
      subject,
      text: `${body}\n\nJūsu ziņojums: "${report.body.slice(0, 120)}"\n\nAtvērt sarunu: ${link}\n(admin panelī — 🐞 poga sānu joslā → Mani ziņojumi)`,
    })
    .catch(() => undefined);
}

/** Pull one report's Jira state into the panel (comments + status). */
export async function syncOneReport(ctx: AppContext, report: BugReportRow): Promise<void> {
  if (!ctx.jira || !report.jiraKey) return;
  const issue = await ctx.jira.getIssue(report.jiraKey).catch(() => null);
  if (!issue) return;

  // New comments from the Jira side (anything whose id we haven't stored —
  // our own outbound comments recorded their id at post time).
  const known = await ctx.db
    .select({ jiraCommentId: bugReportComments.jiraCommentId })
    .from(bugReportComments)
    .where(eq(bugReportComments.reportId, report.id));
  const seen = new Set(known.map((k) => k.jiraCommentId).filter(Boolean));
  let lastItComment: string | null = null;
  let newItComments = 0;
  for (const c of issue.comments) {
    if (c.body.trim().length === 0) continue;
    if (!seen.has(c.id)) {
      await ctx.db.insert(bugReportComments).values({
        reportId: report.id,
        authorLabel: c.author,
        side: "it",
        jiraCommentId: c.id,
        body: c.body,
      });
      lastItComment = c.body;
      newItComments += 1;
    }
  }

  // Status transitions: to do → sent (no-op), in progress, done.
  const next =
    issue.statusCategory === "done" ? "done" :
    issue.statusCategory === "in progress" ? "in_progress" : "sent";
  if (next !== report.status) {
    if (next === "done") {
      // Resolution note: the newest IT comment (fresh from this sync, or the
      // latest already stored) — shown in the reporter's green "Fixed" box.
      let note = lastItComment;
      if (!note) {
        const [latest] = await ctx.db
          .select({ body: bugReportComments.body })
          .from(bugReportComments)
          .where(and(eq(bugReportComments.reportId, report.id), eq(bugReportComments.side, "it")))
          .orderBy(desc(bugReportComments.createdAt))
          .limit(1);
        note = latest?.body ?? null;
      }
      await ctx.db
        .update(bugReports)
        .set({ status: "done", resolutionNote: note, noticePending: true, updatedAt: ctx.now() })
        .where(eq(bugReports.id, report.id));
      await notifyReporter(ctx, report, `✓ Salabots — ${report.jiraKey}`, note ? `IT atzīmēja jūsu ziņojumu kā salabotu:\n\n${note}` : "IT atzīmēja jūsu ziņojumu kā salabotu.");
      return;
    }
    await ctx.db.update(bugReports).set({ status: next, updatedAt: ctx.now() }).where(eq(bugReports.id, report.id));
  }
  if (newItComments > 0) {
    await notifyReporter(ctx, report, `IT atbildēja — ${report.jiraKey}`, `Jauna atbilde no IT:\n\n${lastItComment}`);
  }
}

/** The scheduler's full sweep: retry queued reports, then sync unresolved. */
export async function syncBugReports(ctx: AppContext): Promise<void> {
  if (!ctx.jira) return;

  // Reports filed while Jira was down or unconfigured — send them now.
  const queued = await ctx.db.select().from(bugReports).where(eq(bugReports.status, "open")).limit(50);
  for (const report of queued) await sendReportToJira(ctx, report);

  const open = await ctx.db
    .select()
    .from(bugReports)
    .where(inArray(bugReports.status, ["sent", "in_progress"]))
    .limit(100);
  for (const report of open) await syncOneReport(ctx, report);
}
