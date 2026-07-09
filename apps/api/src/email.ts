/**
 * Email transport abstraction. The engine only knows this interface; the
 * concrete adapter is chosen by config. Today: a console adapter (dev/staging)
 * and a capturing adapter (tests). A real SMTP/provider adapter drops in here
 * later without touching any caller — the same seam Klix/carriers will use.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailAdapter {
  send(msg: EmailMessage): Promise<void>;
}

/** Logs each message; used in dev/staging where no provider is wired yet. */
export class ConsoleEmailAdapter implements EmailAdapter {
  async send(msg: EmailMessage): Promise<void> {
    console.log(`[email] → ${msg.to} · ${msg.subject}`);
  }
}

/** Records messages in memory so tests can assert on them. */
export class CapturingEmailAdapter implements EmailAdapter {
  readonly sent: EmailMessage[] = [];
  /** When set, the next N sends throw — exercises retry/failure handling. */
  failNext = 0;

  async send(msg: EmailMessage): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("simulated transport failure");
    }
    this.sent.push(msg);
  }

  forType(type: string): EmailMessage[] {
    return this.sent.filter((m) => m.subject.length > 0 && m.text.includes(`[${type}]`));
  }
}

export function createEmailAdapter(mode: "console"): EmailAdapter {
  return new ConsoleEmailAdapter();
}
