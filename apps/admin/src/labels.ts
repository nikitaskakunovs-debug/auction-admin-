import { api } from "./api.js";

/** Fetch an authorized label page (item/consignment/bin labels) and hand it
 * to a print window — the pages call window.print() themselves. */
export async function openLabelWindow(url: string, onError: (msg: string) => void): Promise<void> {
  try {
    const res = await fetch(url, { headers: api.token ? { authorization: `Bearer ${api.token}` } : {} });
    if (!res.ok) throw new Error(`label fetch failed (${res.status})`);
    const html = await res.text();
    const w = window.open("", "_blank");
    if (!w) throw new Error("popup blocked — allow popups to print labels");
    w.document.write(html);
    w.document.close();
  } catch (err) {
    onError(err instanceof Error ? err.message : "Print failed");
  }
}
