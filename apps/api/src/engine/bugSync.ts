import { bugReportComments, bugReports } from "@auction/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context.js";

/**
 * Phase E sync: pull Jira status transitions and IT comments back into the
 * panel. Runs from the scheduler behind a 5-minute Redis marker; safe to call
 * directly from tests.
 */
export async function syncBugReports(ctx: AppContext): Promise<void> {
  if (!ctx.jira) return;
  const open = await ctx.db
    .select()
    .from(bugReports)
    .where(inArray(bugReports.status, ["sent", "in_progress"]))
    .limit(100);

  for (const report of open) {
    if (!report.jiraKey) continue;
    const issue = await ctx.jira.getIssue(report.jiraKey).catch(() => null);
    if (!issue) continue;

    // New comments from the Jira side (anything whose id we haven't stored —
    // our own outbound comments recorded their id at post time).
    const known = await ctx.db
      .select({ jiraCommentId: bugReportComments.jiraCommentId })
      .from(bugReportComments)
      .where(eq(bugReportComments.reportId, report.id));
    const seen = new Set(known.map((k) => k.jiraCommentId).filter(Boolean));
    let lastItComment: string | null = null;
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
      } else {
        await ctx.db.update(bugReports).set({ status: next, updatedAt: ctx.now() }).where(eq(bugReports.id, report.id));
      }
    }
  }
}
