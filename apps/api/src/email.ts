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

/**
 * SMTP adapter — "our own sender": mails go out from OUR domain through
 * whatever SMTP endpoint the env points at (a relay like Resend/Brevo/SES,
 * or a self-hosted Postfix later). Swapping providers is an env change.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  /** e.g. "Baltic Auctions <noreply@example.lv>" */
  from: string;
}

export class SmtpEmailAdapter implements EmailAdapter {
  private transporter: import("nodemailer").Transporter | null = null;
  constructor(private readonly cfg: SmtpConfig) {}

  private async transport(): Promise<import("nodemailer").Transporter> {
    if (!this.transporter) {
      const { default: nodemailer } = await import("nodemailer");
      this.transporter = nodemailer.createTransport({
        host: this.cfg.host,
        port: this.cfg.port,
        secure: this.cfg.secure,
        auth: this.cfg.user ? { user: this.cfg.user, pass: this.cfg.pass } : undefined,
      });
    }
    return this.transporter;
  }

  async send(msg: EmailMessage): Promise<void> {
    const t = await this.transport();
    await t.sendMail({ from: this.cfg.from, to: msg.to, subject: msg.subject, text: msg.text });
  }
}

export function createEmailAdapter(mode: "console" | "smtp", smtp?: SmtpConfig | null): EmailAdapter {
  if (mode === "smtp" && smtp) return new SmtpEmailAdapter(smtp);
  return new ConsoleEmailAdapter();
}
