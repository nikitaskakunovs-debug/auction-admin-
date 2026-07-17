/**
 * Dependency-free table exporters — a typed port of the Shhh admin generators
 * (admin-screens-1.jsx): CSV with a UTF-8 BOM and RFC 4180 quoting, Excel via
 * an MS-Office HTML table (.xls), and PDF via a hidden-iframe print dialog
 * (A4 landscape). Generic over any headers + string rows so every list screen
 * can reuse them.
 */

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try {
      document.body.removeChild(a);
    } catch {
      /* already removed */
    }
    URL.revokeObjectURL(url);
  }, 800);
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** yyyy-mm-dd, appended to download filenames. */
const stamp = (): string => new Date().toISOString().slice(0, 10);

/** CSV download: UTF-8 BOM so Excel opens diacritics correctly, RFC quoting. */
export function exportCSV(filename: string, headers: string[], rows: string[][]): void {
  const cell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = [headers.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\r\n");
  triggerDownload(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }), `${filename}-${stamp()}.csv`);
}

/**
 * Excel download: the classic MS-Office HTML-table .xls trick — no library,
 * opens in Excel/LibreOffice with styled header row; every cell is forced to
 * text (mso-number-format '@') so refs and phone-like values survive.
 */
export function exportXLS(filename: string, headers: string[], rows: string[][], sheetName = "Export"): void {
  const thead =
    "<tr>" +
    headers
      .map((h) => `<th style="background:#0F0F0E;color:#fff;text-align:left;padding:6px 10px;border:1px solid #cccccc;font-family:Arial">${esc(h)}</th>`)
      .join("") +
    "</tr>";
  const tbody = rows
    .map((r) => "<tr>" + r.map((c) => `<td style="border:1px solid #dddddd;padding:5px 9px;font-family:Arial;mso-number-format:'\\@'">${esc(c)}</td>`).join("") + "</tr>")
    .join("");
  const html =
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8">' +
    `<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${esc(sheetName)}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->` +
    `</head><body><table>${thead}${tbody}</table></body></html>`;
  triggerDownload(new Blob([html], { type: "application/vnd.ms-excel" }), `${filename}-${stamp()}.xls`);
}

/**
 * PDF export: renders the table into a hidden iframe and opens the browser's
 * print dialog (A4 landscape) — the operator saves as PDF from there. Zero
 * dependencies, native print quality.
 */
export function exportPDFPrint(title: string, headers: string[], rows: string[][]): void {
  const thead = "<tr>" + headers.map((h) => `<th>${esc(h)}</th>`).join("") + "</tr>";
  const tbody = rows.map((r) => "<tr>" + r.map((c) => `<td>${esc(c)}</td>`).join("") + "</tr>").join("");
  const css =
    "body{font-family:Arial,Helvetica,sans-serif;color:#0A0A0A;margin:24px}" +
    "h1{font-size:18px;margin:0 0 4px}.sub{color:#666;font-size:12px;margin:0 0 16px}" +
    "table{border-collapse:collapse;width:100%;font-size:10px}" +
    "th{background:#0F0F0E;color:#fff;text-align:left;padding:6px 8px}" +
    "td{border-bottom:1px solid #e3e3e3;padding:5px 8px}" +
    "tr:nth-child(even) td{background:#f6f6f4}" +
    "@page{size:A4 landscape;margin:12mm}";
  const doc =
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head>` +
    `<body><h1>${esc(title)}</h1><p class="sub">${rows.length} rows · generated ${stamp()}</p>` +
    `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table></body></html>`;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(iframe);
  const win = iframe.contentWindow;
  if (!win) {
    document.body.removeChild(iframe);
    return;
  }
  win.document.open();
  win.document.write(doc);
  win.document.close();
  setTimeout(() => {
    try {
      win.focus();
      win.print();
    } catch {
      /* print blocked — nothing else to do */
    }
    setTimeout(() => {
      try {
        document.body.removeChild(iframe);
      } catch {
        /* already removed */
      }
    }, 1500);
  }, 350);
}
