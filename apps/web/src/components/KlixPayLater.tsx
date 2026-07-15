"use client";

import { useEffect, useState } from "react";
import { PUBLIC_API_URL } from "@/lib/config";
import { useT } from "@/lib/i18n";

/**
 * Klix Pay Later monthly-payment calculator (the official widget from
 * developers.klix.app/pay-later-widget/). The numbers come from Klix's own
 * financing API for OUR brand's agreed products — never computed locally, so
 * the displayed monthly payment always matches what the customer is offered
 * at checkout. Renders nothing while payments are off (pre-keys state), so
 * pages need no gating logic of their own.
 */

export interface PaymentsConfig {
  enabled: boolean;
  payLaterBrandId: string | null;
  providers?: { klix: boolean; inbank: boolean };
}

const OFF: PaymentsConfig = { enabled: false, payLaterBrandId: null, providers: { klix: false, inbank: false } };

let configPromise: Promise<PaymentsConfig> | null = null;
export function loadPaymentsConfig(): Promise<PaymentsConfig> {
  configPromise ??= fetch(`${PUBLIC_API_URL}/api/public/payments/config`)
    .then((r) => (r.ok ? (r.json() as Promise<PaymentsConfig>) : OFF))
    .catch(() => OFF);
  return configPromise;
}

let scriptInjected = false;
function injectWidgetScript(): void {
  if (scriptInjected || typeof document === "undefined") return;
  scriptInjected = true;
  const s = document.createElement("script");
  s.type = "module";
  s.src = "https://klix.blob.core.windows.net/public/pay-later-widget/build/klix-pay-later-widget.esm.js";
  document.head.appendChild(s);
}

/** The widget speaks lv/ru/en/lt; Estonian falls back to English. */
const WIDGET_LANGS = new Set(["lv", "ru", "en", "lt"]);

export function KlixPayLater({
  amountCents,
  view = "product",
  micro = false,
}: {
  /** The FULL amount the customer would pay (incl. premium + VAT). */
  amountCents: number;
  view?: "product" | "cart" | "checkout";
  micro?: boolean;
}) {
  const { lang } = useT();
  const [brandId, setBrandId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadPaymentsConfig().then((c) => {
      if (!alive || !c.enabled || !c.payLaterBrandId) return;
      injectWidgetScript();
      setBrandId(c.payLaterBrandId);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!brandId || amountCents <= 0) return null;
  const language = WIDGET_LANGS.has(lang) ? lang : "en";
  // Custom element — attributes must be strings.
  return (
    <klix-pay-later
      amount={String(amountCents)}
      brand_id={brandId}
      language={language}
      theme="light"
      view={view}
      {...(micro ? { type: "micro" } : {})}
    />
  );
}

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "klix-pay-later": {
        amount: string;
        brand_id: string;
        language: string;
        theme?: string;
        view?: string;
        type?: string;
      };
    }
  }
}
