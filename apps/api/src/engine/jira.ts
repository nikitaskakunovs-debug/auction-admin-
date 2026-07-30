import type { ApiConfig } from "../config.js";

/**
 * Jira Cloud client (REST v3) for Phase E problem reports. Same gating
 * pattern as the payment providers: "off" → null client, reports stay
 * in-app; "simulate" → in-memory driver the test suite can poke.
 *
 * Issues are created with a structured ADF document (headings, a code block
 * for the console tail, and a link back to the admin panel); comments travel
 * as single-paragraph ADF and round-trip cleanly.
 */

export interface JiraIssueInput {
  summary: string;
  /** low | normal | high | blocker — mapped to Jira priority names. */
  severity: string;
  /** Extra labels, e.g. the report type ('visual', 'idea'). */
  labels: string[];
  /** The reporter's description, verbatim. */
  body: string;
  /** Optional steps-to-reproduce text. */
  steps: string;
  /** "key: value" context lines (reporter, screen, role, version…). */
  contextLines: string[];
  /** Console/API-failure tail — rendered as a code block. */
  consoleLog: string[];
  /** Deep link to the report + chat in the admin panel. */
  panelUrl: string | null;
}

export interface JiraAttachment {
  filename: string;
  data: Buffer;
  contentType: string;
}

export interface JiraComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface JiraIssueState {
  /** Lowercased status category: "to do" | "in progress" | "done". */
  statusCategory: string;
  comments: JiraComment[];
}

export interface JiraConnection {
  ok: boolean;
  /** Display name of the integration account when ok. */
  user?: string;
  error?: string;
}

export interface JiraClient {
  createIssue(input: JiraIssueInput): Promise<{ key: string }>;
  addAttachments(key: string, files: JiraAttachment[]): Promise<void>;
  addComment(key: string, body: string): Promise<{ id: string }>;
  getIssue(key: string): Promise<JiraIssueState | null>;
  checkConnection(): Promise<JiraConnection>;
}

export class JiraError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/** Severity → Jira default-scheme priority. */
const PRIORITY: Record<string, string> = {
  blocker: "Highest",
  high: "High",
  normal: "Medium",
  low: "Low",
};

// ── ADF helpers ──────────────────────────────────────────────────────────────

type AdfNode = Record<string, unknown>;

const text = (t: string): AdfNode => ({ type: "text", text: t });
const paragraph = (t: string): AdfNode => ({ type: "paragraph", content: [text(t)] });
const heading = (t: string): AdfNode => ({ type: "heading", attrs: { level: 3 }, content: [text(t)] });
const codeBlock = (t: string): AdfNode => ({ type: "codeBlock", attrs: {}, content: [text(t)] });
const linkParagraph = (label: string, href: string): AdfNode => ({
  type: "paragraph",
  content: [{ type: "text", text: label, marks: [{ type: "link", attrs: { href } }] }],
});

/** The full issue description as an ADF document. */
export function issueDescriptionAdf(input: JiraIssueInput): AdfNode {
  const content: AdfNode[] = input.body
    .split(/\n{2,}/)
    .filter((b) => b.trim().length > 0)
    .map(paragraph);
  if (input.steps.trim().length > 0) {
    content.push(heading("Steps to reproduce"));
    content.push(...input.steps.split(/\n{2,}/).filter((b) => b.trim()).map(paragraph));
  }
  if (input.contextLines.length > 0) {
    content.push(heading("Context"));
    content.push(paragraph(input.contextLines.join("\n")));
  }
  if (input.consoleLog.length > 0) {
    content.push(heading(`Console tail (${input.consoleLog.length} lines)`));
    content.push(codeBlock(input.consoleLog.slice(-30).join("\n")));
  }
  if (input.panelUrl) {
    content.push(linkParagraph("Open the report & chat in the admin panel", input.panelUrl));
  }
  return { type: "doc", version: 1, content: content.length > 0 ? content : [paragraph(" ")] };
}

/** Plain text → minimal ADF document (paragraph per line-block). */
function commentAdf(body: string): AdfNode {
  const blocks = body.split(/\n{2,}/).filter((b) => b.trim().length > 0);
  return { type: "doc", version: 1, content: (blocks.length > 0 ? blocks : [" "]).map(paragraph) };
}

/** ADF (or string) → readable plain text; tolerant of unknown node types. */
export function adfToText(body: unknown): string {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; text?: string; content?: unknown };
    if (n.type === "text" && typeof n.text === "string") out.push(n.text);
    if (n.type === "paragraph") out.push("\n");
    if (n.content) walk(n.content);
  };
  walk(body);
  return out.join("").replace(/\n+/g, "\n").trim();
}

// ── Live client ──────────────────────────────────────────────────────────────

class LiveJiraClient implements JiraClient {
  private auth: string;

  constructor(
    private baseUrl: string,
    email: string,
    apiToken: string,
    private project: string,
  ) {
    this.auth = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/rest/api/3${path}`, {
      method,
      headers: {
        authorization: this.auth,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 404) throw new JiraError("not_found", 404);
    if (!res.ok) throw new JiraError(`jira ${method} ${path} failed: ${res.status} ${await res.text().catch(() => "")}`, res.status);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async createIssue(input: JiraIssueInput): Promise<{ key: string }> {
    const r = await this.call<{ key: string }>("POST", "/issue", {
      fields: {
        project: { key: this.project },
        issuetype: { name: input.labels.includes("idea") ? "Task" : "Bug" },
        summary: input.summary,
        description: issueDescriptionAdf(input),
        labels: ["izsoli-admin", ...input.labels],
        priority: { name: PRIORITY[input.severity] ?? "Medium" },
      },
    });
    return { key: r.key };
  }

  async addAttachments(key: string, files: JiraAttachment[]): Promise<void> {
    if (files.length === 0) return;
    const form = new FormData();
    for (const f of files) {
      form.append("file", new Blob([new Uint8Array(f.data)], { type: f.contentType }), f.filename);
    }
    const res = await fetch(`${this.baseUrl}/rest/api/3/issue/${key}/attachments`, {
      method: "POST",
      headers: {
        authorization: this.auth,
        // Required by Jira for multipart endpoints (XSRF protection opt-out).
        "x-atlassian-token": "no-check",
      },
      body: form,
    });
    if (!res.ok) throw new JiraError(`jira attachments failed: ${res.status}`, res.status);
  }

  async addComment(key: string, body: string): Promise<{ id: string }> {
    const r = await this.call<{ id: string }>("POST", `/issue/${key}/comment`, { body: commentAdf(body) });
    return { id: r.id };
  }

  async getIssue(key: string): Promise<JiraIssueState | null> {
    try {
      const r = await this.call<{
        fields: {
          status: { statusCategory: { name: string } };
          comment: { comments: Array<{ id: string; author: { displayName: string }; body: unknown; created: string }> };
        };
      }>("GET", `/issue/${key}?fields=status,comment`);
      return {
        statusCategory: r.fields.status.statusCategory.name.toLowerCase(),
        comments: r.fields.comment.comments.map((c) => ({
          id: c.id,
          author: c.author.displayName,
          body: adfToText(c.body),
          createdAt: c.created,
        })),
      };
    } catch (err) {
      if (err instanceof JiraError && err.status === 404) return null;
      throw err;
    }
  }

  async checkConnection(): Promise<JiraConnection> {
    try {
      const me = await this.call<{ displayName: string }>("GET", "/myself");
      return { ok: true, user: me.displayName };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "unknown error" };
    }
  }
}

// ── Simulated client (tests) ─────────────────────────────────────────────────

interface SimIssue {
  key: string;
  input: JiraIssueInput;
  attachments: string[];
  statusCategory: string;
  comments: JiraComment[];
  nextCommentId: number;
}

export class SimulatedJiraClient implements JiraClient {
  private issues = new Map<string, SimIssue>();
  private seq = 0;

  constructor(private project = "IZS") {}

  async createIssue(input: JiraIssueInput): Promise<{ key: string }> {
    const key = `${this.project}-${++this.seq + 40}`;
    this.issues.set(key, { key, input, attachments: [], statusCategory: "to do", comments: [], nextCommentId: 1 });
    return { key };
  }

  async addAttachments(key: string, files: JiraAttachment[]): Promise<void> {
    const issue = this.issues.get(key);
    if (!issue) throw new JiraError(`no simulated issue ${key}`, 404);
    issue.attachments.push(...files.map((f) => f.filename));
  }

  async addComment(key: string, body: string): Promise<{ id: string }> {
    const issue = this.issues.get(key);
    if (!issue) throw new JiraError(`no simulated issue ${key}`, 404);
    const id = String(issue.nextCommentId++);
    issue.comments.push({ id, author: "Integration", body, createdAt: new Date(0).toISOString() });
    return { id };
  }

  async getIssue(key: string): Promise<JiraIssueState | null> {
    const issue = this.issues.get(key);
    if (!issue) return null;
    return { statusCategory: issue.statusCategory, comments: [...issue.comments] };
  }

  async checkConnection(): Promise<JiraConnection> {
    return { ok: true, user: "Simulated integration" };
  }

  // ── Test hooks ─────────────────────────────────────────────────────────────

  /** Pretend IT commented on the Jira side. */
  simulateItComment(key: string, body: string, author = "IT · Roberts"): string {
    const issue = this.issues.get(key);
    if (!issue) throw new Error(`no simulated issue ${key}`);
    const id = `it-${issue.nextCommentId++}`;
    issue.comments.push({ id, author, body, createdAt: new Date(0).toISOString() });
    return id;
  }

  /** Pretend IT transitioned the issue ("to do" | "in progress" | "done"). */
  simulateStatus(key: string, statusCategory: string): void {
    const issue = this.issues.get(key);
    if (!issue) throw new Error(`no simulated issue ${key}`);
    issue.statusCategory = statusCategory;
  }

  issue(key: string): SimIssue | null {
    return this.issues.get(key) ?? null;
  }

  lastIssue(): SimIssue | null {
    return [...this.issues.values()].at(-1) ?? null;
  }
}

export function createJiraClient(config: ApiConfig): JiraClient | null {
  if (config.jiraMode === "off" || !config.jira) return null;
  if (config.jiraMode === "simulate") return new SimulatedJiraClient(config.jira.project);
  return new LiveJiraClient(config.jira.baseUrl, config.jira.email, config.jira.apiToken, config.jira.project);
}
