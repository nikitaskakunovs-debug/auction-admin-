/**
 * The one email layout, in the approved blue.
 *
 * Every message the customer receives is the same shape — logo plate, a loud
 * headline, a grey card carrying the money and the facts, one button, then
 * contacts and the footer bars. Templates describe *what* to say; this file
 * decides how it looks, so a change of mind about the design is one file.
 *
 * Written for mail clients, not browsers: tables, inline styles, no external
 * stylesheet, no flexbox, no web fonts. Outlook renders tables or nothing.
 * The hero illustration is an <img> only when a URL is configured — an email
 * with a broken image looks worse than one without a picture.
 */

const BRAND = {
  ink: "#0A0A0A",
  inkSoft: "#454542",
  muted: "#6B6B68",
  faint: "#8C8C88",
  rule: "#E8E7E3",
  card: "#F2F1EE",
  page: "#FFFFFF",
  accent: "#2D4BFF",
  ok: "#1F8A4C",
  warn: "#9A5B00",
  danger: "#B0282C",
} as const;

export type Tone = "accent" | "ok" | "warn" | "danger";

const TONE_COLOR: Record<Tone, string> = {
  accent: BRAND.accent,
  ok: BRAND.ok,
  warn: BRAND.warn,
  danger: BRAND.danger,
};

/** Company details printed in every footer. Env-driven so the real address
 * and phone are a deploy setting, never a code change. */
export interface EmailBrand {
  companyName: string;
  legalName: string;
  regNo: string;
  address: string;
  phone: string;
  email: string;
  siteUrl: string;
  /** Optional absolute URL of the header illustration (PNG). */
  heroUrl?: string | null;
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  reviewUrl?: string | null;
}

export interface MoneyLine {
  label: string;
  value: string;
}

export interface Fact {
  label: string;
  value: string;
  tone?: Tone | undefined;
}

/** A big centred credential — the pickup code. */
export interface CodeBlock {
  label: string;
  value: string;
  note?: string | undefined;
}

export interface EmailSpec {
  /** Shown in the inbox preview line, right after the subject. */
  preheader: string;
  headline: string;
  headlineTone?: Tone | undefined;
  greeting: string;
  /** One or two sentences under the greeting. */
  intro: string;
  /** The money card's headline figure. Omitted for emails about no money. */
  amount?: { label: string; value: string; lines?: MoneyLine[] | undefined } | undefined;
  facts?: Fact[] | undefined;
  code?: CodeBlock | undefined;
  cta?: { label: string; url: string } | undefined;
  /** Bold line under the button — the deadline, usually. */
  ctaNote?: string | undefined;
  /** Small grey line under that — payment methods, alternatives. */
  ctaSubnote?: string | undefined;
  /** Free paragraphs after the button. `title` is optional and bolded. */
  notes?: Array<{ title?: string | undefined; text: string; tone?: Tone | undefined }> | undefined;
  /** Footer line specific to this message, e.g. the order it concerns. */
  footNote?: string | undefined;
  /** Labels that would otherwise be hard-coded English. */
  labels: { follow: string; review: string };
}

/** HTML-escape. Every value here comes from customer data or our own copy;
 * both are escaped rather than trusted, because a lot title is user input. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** URLs are escaped and restricted to http(s)/mailto — a template that ever
 * receives a `javascript:` link renders a dead button, not a trap. */
function safeUrl(url: string): string {
  return /^(https?:|mailto:)/i.test(url) ? esc(url) : "#";
}

function codeCard(code: CodeBlock): string {
  return `
  <tr><td style="padding:18px 26px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND.ink};border-radius:12px;">
      <tr><td align="center" style="padding:22px 16px;">
        <div style="font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:#9A9A97;">${esc(code.label)}</div>
        <div style="margin-top:8px;font-size:38px;letter-spacing:.12em;font-weight:bold;color:#FFFFFF;">${esc(code.value)}</div>
        ${code.note ? `<div style="margin-top:8px;font-size:12.5px;color:#9A9A97;">${esc(code.note)}</div>` : ""}
      </td></tr>
    </table>
  </td></tr>`;
}

export function renderEmailHtml(spec: EmailSpec, brand: EmailBrand): string {
  const headlineColor = spec.headlineTone ? TONE_COLOR[spec.headlineTone] : BRAND.ink;

  const hero = brand.heroUrl
    ? `<td align="right" valign="top"><img src="${safeUrl(brand.heroUrl)}" width="180" alt="" style="display:block;border:0;max-width:180px;height:auto;"></td>`
    : "<td></td>";

  const cta = spec.cta
    ? `
  <tr><td align="center" style="padding:18px 26px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr><td align="center" bgcolor="${BRAND.accent}" style="background:${BRAND.accent};border-radius:22px;">
        <a href="${safeUrl(spec.cta.url)}" style="display:inline-block;padding:13px 44px;font-size:15.5px;font-weight:bold;color:#FFFFFF;text-decoration:none;">${esc(spec.cta.label)}</a>
      </td></tr>
    </table>
    ${spec.ctaNote ? `<div style="margin-top:12px;font-size:13.5px;color:${BRAND.inkSoft};">${esc(spec.ctaNote)}</div>` : ""}
    ${spec.ctaSubnote ? `<div style="margin-top:5px;font-size:12.5px;color:${BRAND.muted};">${esc(spec.ctaSubnote)}</div>` : ""}
  </td></tr>`
    : spec.ctaNote
      ? `<tr><td align="center" style="padding:18px 26px 0;"><div style="font-size:13.5px;color:${BRAND.inkSoft};">${esc(spec.ctaNote)}</div></td></tr>`
      : "";

  const notes = (spec.notes ?? [])
    .map(
      (n) => `
  <tr><td style="padding:18px 26px 0;">
    <div style="border-top:1px solid ${BRAND.rule};padding-top:14px;font-size:13px;line-height:1.6;color:${BRAND.inkSoft};">
      ${n.title ? `<b style="color:${n.tone ? TONE_COLOR[n.tone] : BRAND.ink};">${esc(n.title)}</b> ` : ""}${esc(n.text)}
    </div>
  </td></tr>`,
    )
    .join("");

  const social = [
    brand.facebookUrl ? { url: brand.facebookUrl, glyph: "f" } : null,
    brand.instagramUrl ? { url: brand.instagramUrl, glyph: "ig" } : null,
  ].filter((x): x is { url: string; glyph: string } => x !== null);

  // Nothing to follow yet? Then no bar — an empty blue strip reads as a
  // broken image, not as branding.
  const socialBar = social.length === 0 && !brand.reviewUrl ? "" : `
  <tr><td style="padding:20px 26px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND.accent};border-radius:10px;">
      <tr>
        <td style="padding:13px 18px;font-size:13px;font-weight:bold;color:#FFFFFF;">${esc(spec.labels.follow)}</td>
        <td align="center" style="padding:13px 0;">${social
          .map(
            (s, idx) =>
              `<a href="${safeUrl(s.url)}" style="display:inline-block;width:26px;height:26px;line-height:26px;border-radius:13px;background:#FFFFFF;color:${BRAND.accent};font-size:12.5px;font-weight:bold;text-decoration:none;text-align:center;${idx > 0 ? "margin-left:7px;" : ""}">${s.glyph}</a>`,
          )
          .join("")}</td>
        <td align="right" style="padding:13px 18px;font-size:13px;font-weight:bold;">
          ${
            brand.reviewUrl
              ? `<a href="${safeUrl(brand.reviewUrl)}" style="color:#FFFFFF;text-decoration:none;">${esc(spec.labels.review)} &rsaquo;</a>`
              : ""
          }
        </td>
      </tr>
    </table>
  </td></tr>`;

  // The preheader is what the inbox shows after the subject. It is hidden in
  // the message itself, and padded so the client does not pull body copy in
  // after it.
  return `<!doctype html>
<html lang="lv"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(spec.headline)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.card};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(spec.preheader)}${"&#8199;&#65279;".repeat(60)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND.card};">
  <tr><td align="center" style="padding:18px 10px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;background:${BRAND.page};border-radius:14px;font-family:Arial,Helvetica,sans-serif;color:${BRAND.ink};">

      <tr><td style="padding:22px 26px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td valign="top">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.accent};border-radius:8px;">
                <tr><td style="padding:8px 14px;font-size:17px;font-weight:bold;letter-spacing:.04em;color:#FFFFFF;">${esc(brand.companyName.toUpperCase())}</td></tr>
              </table>
            </td>
            ${hero}
          </tr>
        </table>
      </td></tr>

      <tr><td style="padding:16px 26px 0;">
        <div style="font-size:23px;font-weight:bold;letter-spacing:.02em;line-height:1.25;color:${headlineColor};">${esc(spec.headline)}</div>
      </td></tr>

      <tr><td style="padding:14px 26px 0;">
        <div style="font-size:14.5px;line-height:1.65;color:${BRAND.inkSoft};">
          ${esc(spec.greeting)}<br>${esc(spec.intro)}
        </div>
      </td></tr>

      ${moneyCardRows(spec)}
      ${spec.code ? codeCard(spec.code) : ""}
      ${cta}
      ${notes}

      <tr><td align="center" style="padding:24px 26px 0;">
        <div style="font-size:13.5px;line-height:1.9;color:${BRAND.inkSoft};">
          <a href="mailto:${esc(brand.email)}" style="color:${BRAND.ink};font-weight:bold;text-decoration:none;">${esc(brand.email)}</a><br>
          <b style="color:${BRAND.ink};">${esc(brand.phone)}</b><br>
          <a href="${safeUrl(brand.siteUrl)}" style="color:${BRAND.ink};font-weight:bold;text-decoration:none;">${esc(brand.siteUrl.replace(/^https?:\/\//, ""))}</a>
        </div>
      </td></tr>

      ${socialBar}

      <tr><td style="padding:20px 26px 26px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND.ink};border-radius:10px;">
          <tr><td align="center" style="padding:18px;">
            <div style="font-size:15px;font-weight:bold;letter-spacing:.04em;color:#FFFFFF;">${esc(brand.companyName.toUpperCase())}</div>
            <div style="margin-top:7px;font-size:11px;line-height:1.6;color:${BRAND.faint};">
              ${esc(brand.legalName)}${brand.regNo ? ` &middot; ${esc(brand.regNo)}` : ""} &middot; ${esc(brand.address)}<br>
              &copy; ${new Date().getUTCFullYear()} ${esc(brand.companyName)}${spec.footNote ? ` &middot; ${esc(spec.footNote)}` : ""}
            </div>
          </td></tr>
        </table>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

/** The grey card: money on the left, labelled facts on the right. Written out
 * rather than assembled by string surgery, because column widths are the one
 * thing Outlook is unforgiving about. */
function moneyCardRows(spec: EmailSpec): string {
  const { amount, facts } = spec;
  if (!amount && !facts?.length) return "";

  const moneyCell = amount
    ? `
      <div style="font-size:12.5px;color:${BRAND.muted};">${esc(amount.label)}</div>
      <div style="margin-top:8px;font-size:32px;font-weight:bold;letter-spacing:-.02em;color:${BRAND.ink};">${esc(amount.value)}</div>
      ${
        amount.lines?.length
          ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:14px;font-size:12px;color:${BRAND.muted};">${amount.lines
              .map(
                (l) =>
                  `<tr><td style="padding:2px 0;">${esc(l.label)}</td><td align="right" style="padding:2px 0;">${esc(l.value)}</td></tr>`,
              )
              .join("")}</table>`
          : ""
      }`
    : "";

  const factCell = (facts ?? [])
    .map(
      (f) =>
        `<div style="color:${BRAND.muted};">${esc(f.label)}</div>` +
        `<div style="font-weight:bold;color:${f.tone ? TONE_COLOR[f.tone] : BRAND.ink};padding-bottom:9px;">${esc(f.value)}</div>`,
    )
    .join("");

  const inner =
    amount && factCell
      ? `<tr>
          <td width="46%" valign="top" style="padding:20px 10px 20px 20px;">${moneyCell}</td>
          <td width="54%" valign="top" style="padding:20px 20px 20px 10px;font-size:12.5px;line-height:1.5;">${factCell}</td>
        </tr>`
      : `<tr><td valign="top" style="padding:20px;font-size:12.5px;line-height:1.5;">${amount ? moneyCell : factCell}</td></tr>`;

  return `
  <tr><td style="padding:20px 26px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND.card};border-radius:12px;">
      ${inner}
    </table>
  </td></tr>`;
}
