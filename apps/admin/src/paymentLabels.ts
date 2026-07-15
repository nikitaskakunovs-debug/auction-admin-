/**
 * Human labels for provider payment-method ids, so an admin can tell at a
 * glance HOW an order was paid: card vs banklink vs BNPL, and through whom.
 * Unknown ids fall back to the raw id — never hidden.
 */

const METHOD_LABELS: Record<string, string> = {
  // Klix
  klix: "Card (Klix)",
  klix_apple_pay: "Apple Pay (Klix)",
  klix_google_pay: "Google Pay (Klix)",
  klix_pay_later: "Pay Later — BNPL (Klix)",
  swedbank_lv_pis: "Swedbank banklink",
  seb_lv_pis: "SEB banklink",
  luminor_lv_pis: "Luminor banklink",
  citadele_lv_digilink: "Citadele banklink",
  paysera_lv_pis: "Paysera banklink",
  indexo_lv_pis: "Indexo banklink",
  revolut_pis: "Revolut",
  swedbank_ee_pis: "Swedbank banklink (EE)",
  seb_ee_pis: "SEB banklink (EE)",
  luminor_ee_pis: "Luminor banklink (EE)",
  swedbank_lt_pis: "Swedbank banklink (LT)",
  seb_lt_pis: "SEB banklink (LT)",
  luminor_lt_pis: "Luminor banklink (LT)",
  // Inbank
  inbank_installments: "Installments — BNPL (Inbank)",
};

export function methodLabel(method: string | null): string {
  if (!method) return "—";
  return METHOD_LABELS[method] ?? method;
}

/** True when the method is a buy-now-pay-later product. */
export function isBnpl(method: string | null): boolean {
  return method === "klix_pay_later" || method === "inbank_installments";
}

export function providerLabel(provider: string): string {
  return provider === "inbank" ? "Inbank" : provider === "klix" ? "Klix" : provider;
}
