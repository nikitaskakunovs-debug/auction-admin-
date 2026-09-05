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
  /** Designed body. Always sent alongside `text`, never instead of it — a
   * client that refuses HTML still gets every fact. */
  html?: string;
  /** Служебные заголовки письма. Сегодня это List-Unsubscribe: без него
   * Gmail не показывает свою кнопку отписки и хуже пропускает рассылку. */
  headers?: Record<string, string>;
  /** Куда уйдёт ответ на это письмо. Пусто — общий ящик из конфига. */
  replyTo?: string;
}

export interface EmailAdapter {
  send(msg: EmailMessage): Promise<void>;
  /** Prove the transport works without sending a message. Absent on adapters
   * that have nothing to connect to. */
  verify?(): Promise<void>;
}

/** Logs each message; used in dev/staging where no provider is wired yet. */
export class ConsoleEmailAdapter implements EmailAdapter {
  async send(msg: EmailMessage): Promise<void> {
    console.log(`[email] → ${msg.to} · ${msg.subject}${msg.html ? " · html" : ""}`);
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
  /** e.g. "Izsoli.lv <noreply@izsoli.lv>" */
  from: string;
  /**
   * Живой ящик, куда попадёт ответ человека.
   *
   * Письма уходят с noreply-адреса — так принято, и он защищён от автоответов.
   * Но человек, получивший «товар готов к выдаче», нажимает «Ответить», а не
   * ищет контакты на сайте. Без этого заголовка его вопрос уходит в никуда, и
   * он уверен, что написал нам.
   */
  replyTo?: string;
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

  async verify(): Promise<void> {
    const t = await this.transport();
    await t.verify();
  }

  async send(msg: EmailMessage): Promise<void> {
    const t = await this.transport();
    await t.sendMail({
      from: this.cfg.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
      ...(msg.headers ? { headers: msg.headers } : {}),
      // Отправитель — noreply, отвечать надо в живой ящик. Письмо может
      // назвать свой стол (счета — бухгалтерии); иначе общий ящик из конфига.
      // Умолчание стоит здесь, а не в каждом вызове: забыть его нельзя.
      ...(msg.replyTo || this.cfg.replyTo ? { replyTo: msg.replyTo || this.cfg.replyTo } : {}),
    });
  }
}

export function createEmailAdapter(mode: "console" | "smtp", smtp?: SmtpConfig | null): EmailAdapter {
  if (mode === "smtp" && smtp) return new SmtpEmailAdapter(smtp);
  return new ConsoleEmailAdapter();
}
