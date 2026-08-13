"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { say } from "./Toast";

const KEY = "izsoli_cc_v1";

/** Плашка согласия на cookie из макета. Выбор храним локально —
 *  до появления серверного эндпоинта согласий. */
export function CookieBanner() {
  const [shown, setShown] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    try { if (!localStorage.getItem(KEY)) setShown(true); } catch { setShown(true); }
  }, []);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close("reject", "Neobligātās sīkdatnes noraidītas");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const close = (mode: string, message: string) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        mode,
        analytics: mode === "accept" ? true : mode === "reject" ? false : analytics,
        marketing: mode === "accept" ? true : mode === "reject" ? false : marketing,
      }));
    } catch { /* приватный режим — просто прячем плашку */ }
    setShown(false);
    say(message);
  };

  if (!shown) return null;

  return (
    <section className="cc" aria-label="Sīkdatņu piekrišana">
      <h3>Sīkdatnes</h3>
      <p>
        Nepieciešamās sīkdatnes uztur vietnes darbību. Pārējās ieslēdzam tikai ar tavu piekrišanu —
        pēc noklusējuma tās ir izslēgtas.
      </p>
      <details className="cc-tune">
        <summary>Pielāgot izvēli <Icon name="chev" /></summary>
        <div className="cc-opts">
          <div className="cc-opt">
            <span>Nepieciešamās<small>Pieteikšanās, grozs, drošība</small></span>
            <span className="sw" role="switch" aria-checked="true" aria-disabled="true"
                  aria-label="Nepieciešamās sīkdatnes — vienmēr ieslēgtas" />
          </div>
          <div className="cc-opt">
            <span>Analītika<small>Palīdz saprast, kā vietne tiek lietota</small></span>
            <button className="sw" type="button" role="switch" aria-checked={analytics}
                    aria-label="Analītikas sīkdatnes" onClick={() => setAnalytics((v) => !v)} />
          </div>
          <div className="cc-opt">
            <span>Mārketings<small>Personalizēta reklāma citās vietnēs</small></span>
            <button className="sw" type="button" role="switch" aria-checked={marketing}
                    aria-label="Mārketinga sīkdatnes" onClick={() => setMarketing((v) => !v)} />
          </div>
        </div>
      </details>
      <div className="cc-actions">
        <button className="btn btn-outline" type="button"
                onClick={() => close("reject", "Neobligātās sīkdatnes noraidītas")}>Noraidīt visas</button>
        <button className="btn btn-outline" type="button"
                onClick={() => close("accept", "Visas sīkdatnes pieņemtas")}>Pieņemt visas</button>
      </div>
      <p className="cc-more">
        <Link href="/sikdatnes">Sīkdatņu politika</Link> ·{" "}
        <button type="button" onClick={() => close("custom", "Izvēle saglabāta")}>Saglabāt manu izvēli</button>
      </p>
    </section>
  );
}
