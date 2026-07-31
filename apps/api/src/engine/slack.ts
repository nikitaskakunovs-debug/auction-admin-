import type { ApiConfig } from "../config.js";

/**
 * Slack mirroring (Phase S1). Same gating pattern as every other provider:
 * "off" → null client and no call sites do anything; "simulate" → in-memory
 * driver the tests assert against; "live" → chat.postMessage with the bot
 * token.
 *
 * Posting is deliberately fire-and-forget at the call sites: a Slack outage
 * must never roll back a sale or block a warehouse action.
 */

export type SlackChannel = "orders" | "warehouse" | "bugs";

export interface SlackMessage {
  channel: SlackChannel;
  /** Leading emoji + short headline, e.g. "🏆 Izsole noslēgusies". */
  title: string;
  /** One line of detail; already formatted for humans. */
  text: string;
  /** Optional "key: value" context lines rendered under the text. */
  fields?: string[] | undefined;
  /** Optional link back to the admin panel. */
  url?: string | null | undefined;
}

export interface SlackClient {
  post(msg: SlackMessage): Promise<void>;
  /** Channel name actually used for a logical channel (for the status card). */
  channelName(channel: SlackChannel): string;
}

export class SlackError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "SlackError";
  }
}

/** Slack's mrkdwn link syntax; plain text when there's no url. */
const linked = (url: string | null | undefined, label: string): string =>
  url ? `<${url}|${label}>` : label;

function renderText(msg: SlackMessage): string {
  const lines = [`*${msg.title}*`, msg.text];
  for (const f of msg.fields ?? []) lines.push(`· ${f}`);
  if (msg.url) lines.push(linked(msg.url, "Atvērt panelī"));
  return lines.join("\n");
}

class LiveSlackClient implements SlackClient {
  constructor(
    private token: string,
    private channels: Record<SlackChannel, string>,
  ) {}

  channelName(channel: SlackChannel): string {
    return this.channels[channel];
  }

  async post(msg: SlackMessage): Promise<void> {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: this.channels[msg.channel],
        text: renderText(msg),
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: AbortSignal.timeout(8000),
    });
    // Slack answers 200 with {ok:false, error:"channel_not_found"} — the body
    // is the real status, so both layers are checked.
    if (!res.ok) throw new SlackError(`slack http ${res.status}`, res.status);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!body.ok) throw new SlackError(body.error ?? "slack rejected the message");
  }
}

/** In-memory driver: tests read `sent` instead of hitting the network. */
export class SimulatedSlackClient implements SlackClient {
  sent: SlackMessage[] = [];

  constructor(private channels: Record<SlackChannel, string>) {}

  channelName(channel: SlackChannel): string {
    return this.channels[channel];
  }

  async post(msg: SlackMessage): Promise<void> {
    this.sent.push(msg);
  }
}

export function createSlackClient(config: ApiConfig): SlackClient | null {
  if (config.slackMode === "off" || !config.slack) return null;
  if (config.slackMode === "simulate") return new SimulatedSlackClient(config.slack.channels);
  return new LiveSlackClient(config.slack.botToken, config.slack.channels);
}
