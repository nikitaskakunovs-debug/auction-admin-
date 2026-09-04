import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { formatEur } from "@auction/domain";
import type { InvoiceData } from "./invoices.js";

/**
 * PDF-счёт для клиента (макеты № 34/43/44). Рисуется из того же снимка
 * invoices.data, что и HTML-версия — после выставления счёта его цифры
 * никогда не пересчитываются.
 *
 * Шрифт — тот же Figtree, что на сайте (латиница + балтийская диакритика);
 * встроенная Helvetica в pdfkit букв ā ē ī ū ķ ļ ņ š ž не знает.
 */
const FONT_DIR = fileURLToPath(new URL("../../assets", import.meta.url));

const eur = (cents: number) => formatEur(cents).replace(/ /g, " ");

export function renderInvoicePdf(number: string, issuedAt: Date, d: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Rēķins ${number}` } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.registerFont("body", `${FONT_DIR}/figtree-400.ttf`);
    doc.registerFont("bold", `${FONT_DIR}/figtree-700.ttf`);

    const left = 48;
    const right = 547; // A4 595pt − margin
    const date = issuedAt.toISOString().slice(0, 10).split("-").reverse().join(".");

    // ── Шапка: продавец слева, номер справа ─────────────────────────────────
    doc.font("bold").fontSize(14).text(d.seller.legalName, left, 48);
    doc.font("body").fontSize(9).fillColor("#444");
    doc.text(`${d.seller.country} · ${d.marketCode}`, left);

    doc.font("bold").fontSize(12).fillColor("#000");
    doc.text(`RĒĶINS Nr. ${number}`, left, 48, { align: "right", width: right - left });
    doc.font("body").fontSize(9).fillColor("#444");
    doc.text(`Izrakstīts ${date}.`, { align: "right", width: right - left });
    doc.text(`Pasūtījums ${d.orderRef}`, { align: "right", width: right - left });

    // ── Покупатель ──────────────────────────────────────────────────────────
    let y = 130;
    doc.font("bold").fontSize(9).fillColor("#888").text("PIRCĒJS", left, y);
    y += 14;
    doc.font("bold").fontSize(10).fillColor("#000");
    const buyerName = d.buyer.company || d.buyer.name || d.buyer.alias;
    doc.text(buyerName, left, y);
    y += 14;
    doc.font("body").fontSize(9).fillColor("#444");
    if (d.buyer.company && d.buyer.regNo) { doc.text(`Reģ. Nr. ${d.buyer.regNo}`, left, y); y += 12; }
    if (d.buyer.company && d.buyer.vatNo) { doc.text(`PVN ${d.buyer.vatNo}`, left, y); y += 12; }
    if (d.buyer.address) { doc.text(d.buyer.address, left, y); y += 12; }
    doc.text(d.buyer.email, left, y);
    y += 12;
    if (d.buyer.country) { doc.text(d.buyer.country, left, y); y += 12; }
    y += 14;

    // ── Таблица позиций ─────────────────────────────────────────────────────
    const colSum = right - 90;
    const row = (label: string, value: string, opts: { bold?: boolean; gap?: number } = {}) => {
      doc.font(opts.bold ? "bold" : "body").fontSize(10).fillColor("#000");
      doc.text(label, left, y, { width: colSum - left - 12 });
      doc.text(value, colSum, y, { width: right - colSum, align: "right" });
      y += (opts.gap ?? 18);
    };
    const line = () => {
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor("#ccc").stroke();
      y += 10;
    };

    doc.font("bold").fontSize(9).fillColor("#888");
    doc.text("POZĪCIJA", left, y);
    doc.text("SUMMA", colSum, y, { width: right - colSum, align: "right" });
    y += 14;
    line();
    row(`${d.premiumCents > 0 ? "Lots" : "Prece"} ${d.item.sku} · ${d.item.title}`, eur(d.hammerCents));
    // Комиссия покупателя — плата за проведение торгов. У продажи по
    // фиксированной цене торгов не было, поэтому и строки быть не должно.
    if (d.premiumCents > 0) row("Pircēja komisija", eur(d.premiumCents));
    if (d.shippingCents > 0) row("Piegāde", eur(d.shippingCents));
    if (d.handlingCents > 0) row("Iepakošana", eur(d.handlingCents));
    if (d.shippingCents === 0) row("Saņemšana noliktavā", eur(0));
    line();
    row("Summa bez PVN", eur(d.netCents));
    row(
      d.reverseCharge ? "PVN 0 % — reverse charge" : `PVN ${(d.vatRateBp / 100).toFixed(0)} %`,
      eur(d.vatCents),
    );
    y += 4;
    doc.font("bold").fontSize(12);
    doc.text("Kopā apmaksai", left, y);
    doc.text(eur(d.totalCents), colSum - 40, y, { width: right - colSum + 40, align: "right" });
    y += 30;

    // ── Примечания ──────────────────────────────────────────────────────────
    doc.font("body").fontSize(8.5).fillColor("#666");
    if (d.reverseCharge) {
      doc.text("Nodokli maksā preču vai pakalpojumu saņēmējs (reverse charge, PVN direktīvas 196. pants).", left, y, { width: right - left });
      y += 14;
    }
    doc.text(
      `PVN aprēķināts no āmura cenas un pircēja komisijas summas. Rēķins sagatavots elektroniski un ir derīgs bez paraksta. Apmaksājot norādi rēķina numuru ${number} maksājuma mērķī.`,
      left, y, { width: right - left },
    );

    doc.end();
  });
}
