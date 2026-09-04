/**
 * Единый макет письма — по бренд-буку «Price Moves» и HTML-шаблону дизайнера
 * (v8): Warm White фон, белая карточка 620px, izsoli.lv + жёлтая стрелка,
 * АПЕРКЕЙС-заголовок, line-art иллюстрация, серый summary-блок «фото · прece ·
 * цена», полоса «следующий шаг» с бейджем, жёлтая CTA, чёрный подвал с
 * соцсетями. Шаблоны описывают ЧТО сказать; этот файл решает, как это
 * выглядит, — смена дизайна остаётся правкой одного файла.
 *
 * Написано для почтовых клиентов, не браузеров: таблицы, инлайн-стили,
 * медиазапросы в <style> (Gmail их уважает), никаких веб-шрифтов. Картинки —
 * НЕ data:URI (Gmail их режет), а PNG с нашего же сайта {siteUrl}/email/*.png.
 */

const BRAND = {
  ink: "#161A17",
  inkSoft: "#252925",
  muted: "#71766F",
  faint: "#AEB2AC",
  rule: "#E4E6DF",
  panel: "#F5F6F2",
  page: "#FFFFFF",
  shell: "#F5F5EC",
  accent: "#EFFF38",
  ok: "#174C3C",
  warn: "#9A5B00",
  danger: "#FF5A5F",
} as const;

export type Tone = "accent" | "ok" | "warn" | "danger";

const TONE_COLOR: Record<Tone, string> = {
  accent: BRAND.ink, // на жёлтом бренде акцентный заголовок остаётся чёрным
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
  tiktokUrl?: string | null;
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
  /** Видимая ссылка отписки. Есть только у рассылки: у письма о заказе её
   *  нет и быть не должно — от счёта не отписываются. */
  unsubscribe?: { url: string; label: string; note: string } | undefined;
  /** Labels that would otherwise be hard-coded English. */
  labels: { follow: string; review: string };
  /** Ключ иллюстрации — обычно тип письма; подбирается в renderNotification. */
  art?: string | undefined;
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

/** Тип письма → файл иллюстрации в {siteUrl}/email/. */
const ART_BY_TYPE: Record<string, string> = {
  verify_email: "art-mail",
  outbid: "art-watch",
  won: "art-trophy",
  purchased: "art-box",
  payment_reminder: "art-wallet",
  order_paid: "art-check",
  pickup_ready: "art-box",
  pickup_reminder: "art-hourglass",
  no_pickup_cancelled: "art-hourglass",
  unpaid_cancelled: "art-wallet",
  shipped: "art-truck",
  refunded: "art-refund",
  checked_in: "art-box",
  saved_search_hits: "art-bell",
  watchlist_ending: "art-hourglass",
  welcome_reminder: "art-tag",
  inactive_nudge: "art-search",
  winback_offer: "art-tag",
  lost_bid_similar: "art-search",
  review_request: "art-star",
  referral_invite: "art-gift",
  abandoned_bid: "art-hourglass",
  second_purchase: "art-box",
  gift_card_received: "art-gift",
  campaign: "art-bell",
  // Пробелы покупательской переписки (часть A плана писем).
  password_reset: "art-mail",
  points_expiring: "art-hourglass",
  security_alert: "art-watch",
  delivered: "art-box",
  bid_voided: "art-watch",
  lot_withdrawn: "art-search",
  payment_failed: "art-wallet",
  // Догоняющие письма по товарам «Pērc uzreiz» (BN-1, BN-2).
  bnpl_pending: "art-hourglass",
  bnpl_declined: "art-wallet",
  storage_started: "art-box",
  cart_reminder: "art-box",
  price_drop: "art-tag",
  // Письма поставщикам (S1…S10).
  sup_invite: "art-mail",
  sup_welcome: "art-check",
  sup_intake_done: "art-box",
  sup_discrepancy: "art-search",
  sup_invoice_accepted: "art-check",
  sup_invoice_rejected: "art-refund",
  sup_payment_sent: "art-wallet",
  sup_monthly_report: "art-star",
  sup_sales_report: "art-trophy",
  sup_unsold: "art-hourglass",
};

const CSS = `
html,body{margin:0!important;padding:0!important;width:100%!important;background:${BRAND.shell};color:${BRAND.ink};font-family:Arial,Helvetica,sans-serif}
table{border-collapse:collapse;border-spacing:0} img{border:0;display:block;max-width:100%} a{text-decoration:none}
.shell{width:100%;background:${BRAND.shell};padding:26px 10px}
.email{width:100%;max-width:620px;background:#fff;border:1px solid #E7E8E2;border-radius:16px;overflow:hidden}
.pad{padding:28px 32px 0}.brand{font-size:25px;line-height:1;font-weight:800;letter-spacing:-1px;color:${BRAND.ink}}.arrow{width:54px;height:54px}
.headline{font-size:34px;line-height:1.04;font-weight:900;letter-spacing:-1.2px;margin:26px 0 14px;text-transform:uppercase}
.greeting{font-size:16px;line-height:1.45;font-weight:800;margin:0 0 9px;color:${BRAND.ink}}
.copy{font-size:15.5px;line-height:1.52;margin:0;color:${BRAND.inkSoft}}
.heroIllo{width:154px;padding-left:18px;vertical-align:top}.heroIllo img{width:150px}.mobileIllo{display:none}
.summary{margin-top:22px;background:${BRAND.panel};border-radius:14px}.summary td{vertical-align:middle}
.photoCell{width:94px;padding:14px 0 14px 14px}.photo{width:88px;height:88px;border-radius:12px;overflow:hidden;background:#fff}
.productCell{padding:14px 12px 14px 14px}
.eyebrow{font-size:11px;line-height:1.25;color:${BRAND.muted};font-weight:700;text-transform:uppercase;letter-spacing:.45px;margin-bottom:5px}
.productName{font-size:16px;line-height:1.3;font-weight:800;color:${BRAND.ink}}
.priceCell{width:128px;padding:14px 18px;text-align:left;border-left:1px solid #DADCDA;vertical-align:top}
.priceLabel{font-size:11px;line-height:1.25;color:${BRAND.muted};margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:.45px}
.price{font-size:27px;line-height:1.15;font-weight:900;white-space:nowrap;color:${BRAND.ink}}
.lines{margin-top:12px;background:${BRAND.panel};border-radius:12px}.lines td{font-size:13px;padding:5px 16px;color:${BRAND.muted}}
.lines td.v{text-align:right;font-weight:700;color:${BRAND.ink}}
.factRow td{font-size:13.5px;padding:8px 2px;border-bottom:1px solid ${BRAND.rule};color:${BRAND.muted}}
.factRow td.v{text-align:right;font-weight:700;color:${BRAND.ink}}
.codeCard{margin-top:18px;background:${BRAND.ink};border-radius:14px}
.next{margin-top:14px;border:1px solid ${BRAND.rule};border-radius:12px}.next td{vertical-align:middle}
.payIcon{width:44px;padding:12px 10px 12px 14px}.payIcon img{width:40px;height:40px}
.nextCopy{padding:12px 6px 12px 0}.nextTitle{font-size:14px;line-height:1.3;font-weight:800;margin:0 0 3px;color:${BRAND.ink}}
.nextText{font-size:13px;line-height:1.35;color:#676B66;margin:0}
.deadline{width:92px;padding:12px 14px 12px 8px;text-align:right}
.badge{display:inline-block;background:${BRAND.accent};color:${BRAND.ink};border-radius:999px;padding:8px 10px;font-size:10px;line-height:1;font-weight:900;white-space:nowrap;letter-spacing:.2px}
.ctaWrap{padding:18px 0 10px;text-align:center}
.cta{display:block;background:${BRAND.accent};color:${BRAND.ink};border-radius:9px;padding:15px 18px;font-size:14px;line-height:1;font-weight:900;text-transform:uppercase;text-align:center}
.ctaNote{font-size:13.5px;font-weight:700;color:${BRAND.ink};text-align:center;margin:10px 0 0}
.ctaSub{font-size:12px;color:${BRAND.muted};text-align:center;margin:4px 0 0}
.noteBlock{font-size:13px;line-height:1.5;color:${BRAND.inkSoft};border-top:1px solid ${BRAND.rule};margin-top:16px;padding-top:13px}
.note{font-size:12px;line-height:1.45;color:#737772;text-align:center;margin:0;padding:14px 18px 24px}
.footer{background:${BRAND.ink};color:#fff;padding:18px 22px;font-size:12px;line-height:1.5}.footer a{color:#fff}
.social{text-align:right;white-space:nowrap}.social a{display:inline-block;margin-left:10px;vertical-align:middle}
.social img{width:22px;height:22px;display:inline-block!important}
.unsub{color:${BRAND.faint}!important;padding-top:10px}.unsub a{color:#fff;text-decoration:underline}

@media screen and (max-width:620px){
  .shell{padding:0!important;background:#fff!important}.email{border:0!important;border-radius:0!important}.pad{padding:22px 20px 0!important}
  .brand{font-size:22px!important}.arrow{width:44px!important;height:44px!important}
  .headline{font-size:29px!important;margin-top:20px!important}
  .greeting,.copy{font-size:15px!important}
  .heroIllo{display:none!important}.mobileIllo{display:block!important}.mobileIllo img{width:118px!important;margin:8px auto 10px!important}
  .summary,.summary tbody,.summary tr,.summary td{display:block!important;width:100%!important;box-sizing:border-box!important}.summary{position:relative}
  .photoCell{padding:12px 12px 0!important}.photo{width:82px!important;height:82px!important}
  .productCell{padding:8px 12px 12px!important;position:absolute!important;left:104px!important;right:10px!important;top:12px!important;width:auto!important}
  .productName{font-size:15px!important}
  .priceCell{border-left:0!important;border-top:1px solid #DADCDA!important;text-align:left!important;padding:12px!important}
  .price{font-size:25px!important}
  .next{margin-top:12px!important}.payIcon{width:42px!important;padding-left:12px!important;padding-right:8px!important}
  .payIcon img{width:38px!important;height:38px!important}
  .deadline{width:78px!important;padding-right:12px!important}.badge{font-size:9px!important;padding:7px 8px!important}
  .ctaWrap{padding-top:14px!important}.cta{font-size:13px!important;padding:14px!important}
  .footer td{display:block!important;width:100%!important;text-align:center!important}
  .social{padding-top:12px!important;text-align:center!important}.social a{margin:0 5px!important}
}`;

export function renderEmailHtml(spec: EmailSpec, brand: EmailBrand): string {
  const assets = `${brand.siteUrl}/email`;
  const headlineColor = spec.headlineTone ? TONE_COLOR[spec.headlineTone] : BRAND.ink;
  const artFile = spec.art ? (ART_BY_TYPE[spec.art] ?? null) : null;
  const artImg = artFile ? `<img src="${assets}/${artFile}.png" width="150" alt="">` : "";
  const host = brand.siteUrl.replace(/^https?:\/\//, "");

  // Summary «фото · прece · цена»: товаром становится факт «Prece/Товар/Item»
  // (или первый), amount — цена. Без товара — цена на всю ширину.
  const allFacts = spec.facts ?? [];
  const product =
    allFacts.find((f) => /prece|товар|item/i.test(f.label)) ?? allFacts[0];
  const restFacts = allFacts.filter((f) => f !== product);
  const summary = spec.amount || product
    ? `
  <table role="presentation" width="100%" class="summary"><tr>
    <td class="photoCell"><div class="photo"><img src="${assets}/photo-placeholder.png" width="88" height="88" alt=""></div></td>
    ${product ? `<td class="productCell"><div class="eyebrow">${esc(product.label.replace(/:$/, ""))}</div><div class="productName">${esc(product.value)}</div></td>` : ""}
    ${spec.amount ? `<td class="priceCell"><div class="priceLabel">${esc(spec.amount.label.replace(/:$/, ""))}</div><div class="price">${esc(spec.amount.value)}</div></td>` : ""}
  </tr></table>`
    : "";

  // Раскладка счёта (комиссия, НДС…) — отдельной серой таблицей под summary.
  const lines = spec.amount?.lines?.length
    ? `<table role="presentation" width="100%" class="lines"><tr><td style="padding-top:10px;"></td><td></td></tr>${spec.amount.lines
        .map((l) => `<tr><td>${esc(l.label)}</td><td class="v">${esc(l.value)}</td></tr>`)
        .join("")}<tr><td style="padding-bottom:10px;"></td><td></td></tr></table>`
    : "";

  const facts = restFacts.length
    ? `<table role="presentation" width="100%" style="margin-top:10px;">${restFacts
        .map((f) => `<tr class="factRow"><td>${esc(f.label)}</td><td class="v"${f.tone ? ` style="color:${TONE_COLOR[f.tone]}!important;"` : ""}>${esc(f.value)}</td></tr>`)
        .join("")}</table>`
    : "";

  const code = spec.code
    ? `
  <table role="presentation" width="100%" class="codeCard"><tr><td align="center" style="padding:20px 16px;">
    <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#9A9A97;">${esc(spec.code.label)}</div>
    <div style="margin-top:7px;font-size:34px;letter-spacing:.1em;font-weight:900;color:${BRAND.accent};">${esc(spec.code.value)}</div>
    ${spec.code.note ? `<div style="margin-top:7px;font-size:12.5px;color:#9A9A97;">${esc(spec.code.note)}</div>` : ""}
  </td></tr></table>`
    : "";

  // «Следующий шаг»: строка с иконкой и дедлайном — только когда есть ctaNote.
  const next = spec.ctaNote
    ? `
  <table role="presentation" width="100%" class="next"><tr>
    <td class="payIcon"><img src="${assets}/pay-clock.png" width="40" height="40" alt=""></td>
    <td class="nextCopy"><p class="nextTitle">${esc(spec.ctaNote)}</p>${spec.ctaSubnote ? `<p class="nextText">${esc(spec.ctaSubnote)}</p>` : ""}</td>
  </tr></table>`
    : "";

  const cta = spec.cta
    ? `<div class="ctaWrap"><a class="cta" href="${safeUrl(spec.cta.url)}" target="_blank">${esc(spec.cta.label)}</a></div>`
    : "";

  const notes = (spec.notes ?? [])
    .map((n) => `<div class="noteBlock">${n.title ? `<b style="color:${n.tone ? TONE_COLOR[n.tone] : BRAND.ink};">${esc(n.title)}</b> ` : ""}${esc(n.text)}</div>`)
    .join("");

  const social = [
    brand.facebookUrl ? { url: brand.facebookUrl, icon: "social-fb", alt: "Facebook" } : null,
    brand.instagramUrl ? { url: brand.instagramUrl, icon: "social-ig", alt: "Instagram" } : null,
    brand.tiktokUrl ? { url: brand.tiktokUrl, icon: "social-tt", alt: "TikTok" } : null,
  ].filter((x): x is { url: string; icon: string; alt: string } => x !== null);

  return `<!doctype html>
<html lang="lv"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(spec.headline)}</title>
<style>${CSS}</style>
</head>
<body>
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(spec.preheader)}${"&#8199;&#65279;".repeat(60)}</div>
<table role="presentation" width="100%" class="shell"><tr><td align="center">
<table role="presentation" width="620" class="email">
<tr><td class="pad">

<table role="presentation" width="100%"><tr>
  <td class="brand">${esc(host)}</td>
  <td align="right"><img class="arrow" src="${assets}/arrow.png" width="54" height="54" alt=""></td>
</tr></table>

<table role="presentation" width="100%"><tr>
  <td valign="top">
    <div class="headline" style="color:${headlineColor};">${esc(spec.headline)}</div>
    <p class="greeting">${esc(spec.greeting)}</p>
    <p class="copy">${esc(spec.intro)}</p>
  </td>
  ${artImg ? `<td class="heroIllo">${artImg}</td>` : ""}
</tr></table>
${artImg ? `<div class="mobileIllo">${artImg.replace('width="150"', 'width="118"')}</div>` : ""}

${summary}
${lines}
${facts}
${code}
${next}
${cta}
${spec.ctaSubnote && !spec.ctaNote ? `<p class="ctaSub">${esc(spec.ctaSubnote)}</p>` : ""}
${notes}
${spec.footNote ? `<p class="note">${esc(spec.footNote)}</p>` : `<div style="height:22px;"></div>`}
</td></tr>

<tr><td class="footer">
<table role="presentation" width="100%"><tr>
<td><a href="mailto:${esc(brand.email)}">${esc(brand.email)}</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="${safeUrl(brand.siteUrl)}" target="_blank">${esc(host)}</a><br>
<span style="color:${BRAND.faint};">${esc(brand.legalName)}${brand.regNo ? ` &middot; ${esc(brand.regNo)}` : ""} &middot; &copy; ${new Date().getUTCFullYear()} ${esc(brand.companyName)}. Visas ties&#299;bas aizsarg&#257;tas.</span>
${brand.reviewUrl ? `<br><a href="${safeUrl(brand.reviewUrl)}" style="color:${BRAND.accent};">${esc(spec.labels.review)} &#8599;</a>` : ""}
</td>
<td class="social">${social.map((s) => `<a href="${safeUrl(s.url)}" aria-label="${s.alt}"><img src="${assets}/${s.icon}.png" width="22" height="22" alt="${s.alt}"></a>`).join("")}</td>
</tr></table>
${spec.unsubscribe ? `<div class="unsub">${esc(spec.unsubscribe.note)}<br><a href="${safeUrl(spec.unsubscribe.url)}">${esc(spec.unsubscribe.label)}</a></div>` : ""}
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
