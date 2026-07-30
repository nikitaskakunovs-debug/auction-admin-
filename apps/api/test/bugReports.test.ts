import { bugReportComments, bugReports } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncBugReports } from "../src/engine/bugSync.js";
import { SimulatedJiraClient } from "../src/engine/jira.js";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/** Phase E — report-a-problem + Jira round-trip against the simulated client. */

let world: TestWorld;
let adminToken: string; // super_admin — audit.view (Bugs tab / IT side)
let opsToken: string; // operations — a regular reporter
let jira: SimulatedJiraClient;

beforeAll(async () => {
  world = await createWorld();
  adminToken = await loginAs(world, "super@auction.test");
  opsToken = await loginAs(world, "ops@auction.test");
  jira = world.ctx.jira as SimulatedJiraClient;
});
afterAll(async () => {
  await world.close();
});

const post = (url: string, payload: unknown, token = opsToken) =>
  world.server.app.inject({ method: "POST", url, headers: auth(token), payload: payload as Record<string, unknown> });
const get = <T>(url: string, token = opsToken) =>
  world.server.app.inject({ method: "GET", url, headers: auth(token) }).then((r) => ({ status: r.statusCode, body: r.json() as T }));

describe("report-a-problem", () => {
  let reportId: string;
  let jiraKey: string;

  it("creates a report and a Jira issue with mapped priority + labels", async () => {
    const res = await post("/api/bugs", {
      body: "The refund button spins forever on order ORD-1.",
      steps: "1. Open order\n2. Click refund",
      type: "bug",
      severity: "blocker",
      screen: "orders · ORD-1",
      context: { role: "operations", market: "LV", version: "v1.34" },
      consoleLog: ["POST /api/orders/x/refund → 500"],
      attachments: [],
    });
    expect(res.statusCode).toBe(200);
    const { report } = res.json() as { report: { id: string; jiraKey: string | null; status: string } };
    expect(report.jiraKey).toMatch(/^IZS-\d+$/);
    expect(report.status).toBe("sent");
    reportId = report.id;
    jiraKey = report.jiraKey!;

    const issue = jira.lastIssue()!;
    expect(issue.key).toBe(jiraKey);
    expect(issue.input.severity).toBe("blocker");
    expect(issue.input.labels).toContain("bug");
    expect(issue.input.description).toContain("Steps to reproduce");
    expect(issue.input.description).toContain("market: LV");
  });

  it("panel replies mirror into Jira with the author prefix and store the comment id", async () => {
    const res = await post(`/api/bugs/${reportId}/comments`, { body: "It happens on every order, not just ORD-1." });
    expect(res.statusCode).toBe(200);
    const { comment } = res.json() as { comment: { side: string; jiraCommentId: string | null } };
    expect(comment.side).toBe("panel");
    expect(comment.jiraCommentId).not.toBeNull();

    const issue = await jira.getIssue(jiraKey);
    expect(issue!.comments).toHaveLength(1);
    expect(issue!.comments[0]!.body).toContain("(admin panel):");
  });

  it("sync pulls IT comments + status into the panel without duplicating our own", async () => {
    jira.simulateItComment(jiraKey, "Which browser version?");
    jira.simulateStatus(jiraKey, "in progress");
    await syncBugReports(world.ctx);
    await syncBugReports(world.ctx); // idempotent — no dupes on the second pass

    const rows = await world.ctx.db.select().from(bugReportComments).where(eq(bugReportComments.reportId, reportId));
    expect(rows).toHaveLength(2); // our panel reply + IT's question, once each
    expect(rows.filter((r) => r.side === "it")).toHaveLength(1);

    const [report] = await world.ctx.db.select().from(bugReports).where(eq(bugReports.id, reportId));
    expect(report!.status).toBe("in_progress");
  });

  it("unread IT messages surface in /mine and the mybugs badge; reading clears them", async () => {
    const mine = await get<{ reports: Array<{ id: string; unread: number; commentCount: number }> }>("/api/bugs/mine");
    const row = mine.body.reports.find((r) => r.id === reportId)!;
    expect(row.unread).toBe(1);
    expect(row.commentCount).toBe(2);

    const badges = await get<{ badges: Record<string, number> }>("/api/badges");
    expect(badges.body.badges.mybugs).toBe(1);

    await post(`/api/bugs/${reportId}/read`, {});
    const after = await get<{ badges: Record<string, number> }>("/api/badges");
    expect(after.body.badges.mybugs).toBe(0);
  });

  it("Done in Jira → done + resolution note + fixed-notice; ack clears it", async () => {
    jira.simulateItComment(jiraKey, "Fixed in v1.35 — refund settles instantly now.");
    jira.simulateStatus(jiraKey, "done");
    await syncBugReports(world.ctx);

    const [report] = await world.ctx.db.select().from(bugReports).where(eq(bugReports.id, reportId));
    expect(report!.status).toBe("done");
    expect(report!.noticePending).toBe(true);
    expect(report!.resolutionNote).toContain("Fixed in v1.35");

    // Only the reporter can ack their banner.
    const wrong = await post(`/api/bugs/${reportId}/ack`, {}, adminToken);
    expect(wrong.statusCode).toBe(404);
    const ok = await post(`/api/bugs/${reportId}/ack`, {});
    expect(ok.statusCode).toBe(200);
  });

  it("visibility: reporters see their own, audit.view sees all, others 403 on foreign reports", async () => {
    const all = await get<{ reports: unknown[] }>("/api/bugs", adminToken);
    expect(all.status).toBe(200);
    expect(all.body.reports.length).toBeGreaterThan(0);

    // content_editor holds no audit.view: no team list, no foreign detail.
    const contentToken = await loginAs(world, "content@auction.test");
    const denied = await world.server.app.inject({ method: "GET", url: "/api/bugs", headers: auth(contentToken) });
    expect(denied.statusCode).toBe(403);
    const foreign = await world.server.app.inject({ method: "GET", url: `/api/bugs/${reportId}`, headers: auth(contentToken) });
    expect(foreign.statusCode).toBe(403);
  });

  it("dismiss keeps Jira untouched and audits", async () => {
    const res = await post("/api/bugs", { body: "Maybe darker table headers?", type: "idea", severity: "low" });
    const { report } = res.json() as { report: { id: string } };
    const dis = await post(`/api/bugs/${report.id}/dismiss`, {}, adminToken);
    expect(dis.statusCode).toBe(200);
    expect((dis.json() as { report: { status: string } }).report.status).toBe("dismissed");
  });

  it("reports survive a Jira outage as status=open", async () => {
    const broken = world.ctx.jira;
    world.ctx.jira = null; // simulate JIRA_MODE=off / outage path
    const res = await post("/api/bugs", { body: "Filed while Jira is down." });
    expect(res.statusCode).toBe(200);
    const { report } = res.json() as { report: { status: string; jiraKey: string | null } };
    expect(report.status).toBe("open");
    expect(report.jiraKey).toBeNull();
    world.ctx.jira = broken;
  });
});
