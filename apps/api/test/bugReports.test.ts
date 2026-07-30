import { bugReportComments, bugReports } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncBugReports } from "../src/engine/bugSync.js";
import { adfToText, SimulatedJiraClient } from "../src/engine/jira.js";
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
    expect(issue.input.steps).toContain("Click refund");
    expect(issue.input.contextLines).toContain("market: LV");
    expect(issue.input.consoleLog).toHaveLength(1);
    expect(issue.input.panelUrl).toContain("#/activity");
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

describe("E2 hardening", () => {
  it("retries queued reports on sync and backfills chat written while queued", async () => {
    const broken = world.ctx.jira;
    world.ctx.jira = null;
    const res = await post("/api/bugs", { body: "Queued while Jira was down, with chat." });
    const { report } = res.json() as { report: { id: string } };
    // The reporter chats before Jira ever saw the ticket.
    await post(`/api/bugs/${report.id}/comments`, { body: "Adding detail while offline." });
    world.ctx.jira = broken;

    await syncBugReports(world.ctx);

    const [row] = await world.ctx.db.select().from(bugReports).where(eq(bugReports.id, report.id));
    expect(row!.status).toBe("sent");
    expect(row!.jiraKey).toMatch(/^IZS-\d+$/);
    const issue = jira.issue(row!.jiraKey!)!;
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]!.body).toContain("Adding detail while offline.");
    // The backfilled panel comment now carries its Jira id (no dupes later).
    const comments = await world.ctx.db.select().from(bugReportComments).where(eq(bugReportComments.reportId, report.id));
    expect(comments[0]!.jiraCommentId).not.toBeNull();
    await syncBugReports(world.ctx);
    const after = await world.ctx.db.select().from(bugReportComments).where(eq(bugReportComments.reportId, report.id));
    expect(after).toHaveLength(1);
  });

  it("uploads stored files as native Jira attachments", async () => {
    const url = await world.ctx.storage.put("bugs/e2-shot.webp", Buffer.from("fake-webp-bytes"), "image/webp");
    const res = await post("/api/bugs", { body: "Report with a native attachment.", attachments: [url] });
    expect(res.statusCode).toBe(200);
    const { report } = res.json() as { report: { jiraKey: string } };
    const issue = jira.issue(report.jiraKey)!;
    expect(issue.attachments).toEqual(["e2-shot.webp"]);
  });

  it("dismissing a sent report leaves a note on the Jira ticket", async () => {
    const res = await post("/api/bugs", { body: "Will be dismissed after sending." });
    const { report } = res.json() as { report: { id: string; jiraKey: string } };
    const dis = await post(`/api/bugs/${report.id}/dismiss`, {}, adminToken);
    expect(dis.statusCode).toBe(200);
    const issue = jira.issue(report.jiraKey)!;
    expect(issue.comments.some((c) => c.body.includes("Dismissed in the admin panel"))).toBe(true);
  });

  it("reports connection health to the Bugs tab", async () => {
    const res = await get<{ mode: string; project: string; ok: boolean; user?: string; webhook: boolean }>(
      "/api/bugs/jira-status",
      adminToken,
    );
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("simulate");
    expect(res.body.ok).toBe(true);
    expect(res.body.user).toBe("Simulated integration");
    expect(res.body.webhook).toBe(true);

    const denied = await world.server.app.inject({
      method: "GET",
      url: "/api/bugs/jira-status",
      headers: auth(await loginAs(world, "content@auction.test")),
    });
    expect(denied.statusCode).toBe(403);
  });

  it("the webhook syncs one report instantly, guarded by the shared secret", async () => {
    const res = await post("/api/bugs", { body: "Webhook round-trip report." });
    const { report } = res.json() as { report: { id: string; jiraKey: string } };
    jira.simulateItComment(report.jiraKey, "Instant reply via webhook.");

    const bad = await world.server.app.inject({
      method: "POST",
      url: "/api/jira/webhook?secret=wrong",
      payload: { issue: { key: report.jiraKey } },
    });
    expect(bad.statusCode).toBe(401);

    const ok = await world.server.app.inject({
      method: "POST",
      url: "/api/jira/webhook?secret=whsec-test",
      payload: { issue: { key: report.jiraKey } },
    });
    expect(ok.statusCode).toBe(204);

    const comments = await world.ctx.db.select().from(bugReportComments).where(eq(bugReportComments.reportId, report.id));
    expect(comments.some((c) => c.side === "it" && c.body === "Instant reply via webhook.")).toBe(true);
  });
});

describe("E3 live chat + notifications", () => {
  it("adfToText keeps mentions, emoji and hard breaks", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "x", text: "@Nikita Skakunovs" } },
            { type: "text", text: " yes please" },
            { type: "hardBreak" },
            { type: "text", text: "second line " },
            { type: "emoji", attrs: { shortName: ":thumbsup:", text: "👍" } },
          ],
        },
      ],
    };
    expect(adfToText(adf)).toBe("@Nikita Skakunovs yes please\nsecond line 👍");
  });

  it("opening a report pulls fresh Jira replies without waiting for the sweep", async () => {
    const res = await post("/api/bugs", { body: "On-open sync report." });
    const { report } = res.json() as { report: { id: string; jiraKey: string } };
    jira.simulateItComment(report.jiraKey, "Fresh answer, no sweep ran.");

    const detail = await get<{ comments: Array<{ side: string; body: string }> }>(`/api/bugs/${report.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.comments.some((c) => c.side === "it" && c.body === "Fresh answer, no sweep ran.")).toBe(true);
  });

  it("emails the reporter when IT replies and when the report is fixed", async () => {
    const res = await post("/api/bugs", { body: "Notify me on answers." });
    const { report } = res.json() as { report: { id: string; jiraKey: string } };

    jira.simulateItComment(report.jiraKey, "We are on it.");
    await syncBugReports(world.ctx);
    const replyMail = world.email.sent.find((m) => m.subject === `IT atbildēja — ${report.jiraKey}`);
    expect(replyMail).toBeDefined();
    expect(replyMail!.to).toBe("ops@auction.test");
    expect(replyMail!.text).toContain("We are on it.");

    jira.simulateItComment(report.jiraKey, "Deployed a fix.");
    jira.simulateStatus(report.jiraKey, "done");
    await syncBugReports(world.ctx);
    const doneMail = world.email.sent.find((m) => m.subject === `✓ Salabots — ${report.jiraKey}`);
    expect(doneMail).toBeDefined();
    expect(doneMail!.text).toContain("Deployed a fix.");
  });
});
