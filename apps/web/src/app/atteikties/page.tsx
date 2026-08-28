"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { publicApi } from "@/lib/api";
import { useT } from "@/lib/i18n";

type State = "ask" | "working" | "done" | "back" | "invalid";

/**
 * Страница отписки по ссылке из письма.
 *
 * Вход в аккаунт не нужен и не предлагается: человек, который хочет перестать
 * получать письма, не обязан вспоминать пароль. Само нажатие обязательно —
 * ссылку могут открыть предпросмотрщик почты или антивирус, и молча выключать
 * рассылку от их визита нельзя.
 */
export default function UnsubscribePage() {
  const { t } = useT();
  const token = useSearchParams().get("t") ?? "";
  const [state, setState] = useState<State>(token ? "ask" : "invalid");

  async function call(path: string, next: State) {
    setState("working");
    try {
      await publicApi.post(path, { t: token });
      setState(next);
    } catch {
      setState("invalid");
    }
  }

  return (
    <section className="wrap" style={{ paddingTop: 40, paddingBottom: 80 }}>
      <div className="card-b auth-card">
        {(state === "ask" || state === "working") && (
          <>
            <span className="ic-round warn" aria-hidden="true"><Icon name="mail" /></span>
            <h1>{t("un.title")}</h1>
            <p className="note" style={{ fontSize: 15 }}>{t("un.lead")}</p>
            <button
              className="btn btn-primary"
              type="button"
              disabled={state === "working"}
              onClick={() => void call("/api/public/unsubscribe", "done")}
            >
              {state === "working" ? t("un.working") : t("un.confirm")}
            </button>
          </>
        )}

        {state === "done" && (
          <>
            <span className="ic-round ok" aria-hidden="true"><Icon name="check" /></span>
            <h1>{t("un.done")}</h1>
            <p className="note" style={{ fontSize: 15 }}>{t("un.doneD")}</p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button
                className="btn btn-outline"
                type="button"
                onClick={() => void call("/api/public/resubscribe", "back")}
              >
                {t("un.undo")}
              </button>
              <Link className="btn btn-outline" href="/katalogs">{t("catalog.all")}</Link>
            </div>
          </>
        )}

        {state === "back" && (
          <>
            <span className="ic-round ok" aria-hidden="true"><Icon name="check" /></span>
            <h1>{t("un.back")}</h1>
            <p className="note" style={{ fontSize: 15 }}>{t("un.backD")}</p>
            <Link className="btn btn-primary" href="/katalogs">{t("catalog.all")}</Link>
          </>
        )}

        {state === "invalid" && (
          <>
            <span className="ic-round warn" aria-hidden="true"><Icon name="x" /></span>
            <h1>{t("un.invalid")}</h1>
            <p className="note" style={{ fontSize: 15 }}>{t("un.invalidD")}</p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link className="btn btn-primary" href="/account">{t("un.settings")}</Link>
              <Link className="btn btn-outline" href="/kontakti">{t("misc.contactUs")}</Link>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
