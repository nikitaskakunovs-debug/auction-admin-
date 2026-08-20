"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { PUBLIC_API_URL } from "@/lib/config";
import { ALL_LANGS, dateLocale, useT, type Lang } from "@/lib/i18n";
import type { MyOrder } from "@/lib/types";
import { Ph } from "../Ph";
import { say } from "../Toast";
import type { Me, MyBidAuction } from "./data";

/** Настройки: хаб-плитки (макет № 59) и рабочие подэкраны.
 *
 *  Плитки, чьи разделы придут со своими этапами выката (платёжные
 *  предпочтения, матрица уведомлений, сессии), появятся вместе с ними —
 *  плитка без страницы обманывает.
 */
type Sub = "hub" | "profils" | "rekviziti" | "valoda" | "dokumenti" | "sikdatnes" | "dati";

const LANG_NAMES: Record<Lang, string> = { lv: "Latviešu", ru: "Русский", en: "English", et: "Eesti", lt: "Lietuvių" };

export function SettingsHub({
  me, bids, orders, pickupCount, marketing, onMarketing, onAlias, onSignOut,
}: {
  me: Me | null;
  bids: MyBidAuction[];
  orders: MyOrder[];
  pickupCount: number;
  marketing: boolean;
  onMarketing: (next: boolean) => void;
  onAlias: (alias: string) => Promise<boolean>;
  onSignOut: () => void;
}) {
  const { t, lang } = useT();
  const [sub, setSub] = useState<Sub>("hub");

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("s") as Sub | null;
    if (q) setSub(q);
  }, []);
  const go = (next: Sub) => {
    setSub(next);
    const p = new URLSearchParams(window.location.search);
    if (next === "hub") p.delete("s"); else p.set("s", next);
    window.history.replaceState(null, "", `/account?${p}`);
  };

  if (sub === "profils") return <ProfilePage me={me} onAlias={onAlias} onBack={() => go("hub")} />;
  if (sub === "rekviziti") return <RekvizitiPage me={me} onBack={() => go("hub")} />;
  if (sub === "valoda") return <LangPage onBack={() => go("hub")} />;
  if (sub === "dokumenti") return <DocsPage marketing={marketing} onBack={() => go("hub")} />;
  if (sub === "sikdatnes") return <CookiesPage onBack={() => go("hub")} />;
  if (sub === "dati")
    return (
      <DataPage
        bids={bids} orders={orders} pickupCount={pickupCount}
        marketing={marketing} onMarketing={onMarketing} onBack={() => go("hub")}
      />
    );

  const tile = (key: Sub, icon: string, title: string, subTitle: string, state?: string) => (
    <button className="hubtile" type="button" onClick={() => go(key)}>
      <span className="ic"><Ph name={icon} size={19} /></span>
      <span className="t">
        <b>{title}</b>
        <small>{subTitle}</small>
        {state && <small className="st">{state}</small>}
      </span>
      <Ph name="caret-right" size={14} className="go" />
    </button>
  );

  return (
    <div className="acct">
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("ac.settings")}</h1>
          <p className="cnt">{t("kb.setSub")}</p>
        </div>
      </div>

      <p className="g-lbl">{t("kb.gProfile")}</p>
      <div className="hubgrid">
        {tile("profils", "gear", t("kb.gProfile"), t("kb.hProfileSub"), me ? `${me.alias} · ${me.email}` : undefined)}
        {tile("rekviziti", "file-text", t("kb.hRekv"), t("kb.hRekvSub"), t("kb.stPerson"))}
      </div>

      <p className="g-lbl">{t("kb.gSecurity")}</p>
      <div className="hubgrid">
        {tile("dati", "check", t("kb.hData"), t("kb.hDataSub"),
          marketing ? t("ac.marketingOn") : t("ac.marketingOff"))}
        {tile("sikdatnes", "shield-check", t("kb.hCookies"), t("kb.hCookiesSub"))}
      </div>

      <p className="g-lbl">{t("kb.gHelp")}</p>
      <div className="hubgrid">
        {tile("dokumenti", "file-text", t("kb.hDocs"), t("kb.hDocsSub"))}
        {tile("valoda", "map-pin", t("kb.hLang"), t("kb.hLangSub"), `${LANG_NAMES[lang]} · Rīga (GMT+3)`)}
      </div>

      <div className="acct-exit">
        <button className="btn btn-outline" type="button" onClick={onSignOut}>
          <Ph name="sign-out" size={18} /> {t("ac.signOutFull")}
        </button>
        <p className="note">{t("kb.exitNote")}</p>
      </div>
    </div>
  );
}

function Back({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <button className="btn-back" type="button" onClick={onBack}>
      <Ph name="caret-right" size={14} className="flip" /> {label}
    </button>
  );
}

function ProfilePage({ me, onAlias, onBack }: { me: Me | null; onAlias: (a: string) => Promise<boolean>; onBack: () => void }) {
  const { t } = useT();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="acct">
      <Back onBack={onBack} label={t("ac.settings")} />
      <div className="page-head"><h1 data-hero>{t("kb.gProfile")}</h1></div>
      <section className="card-b">
        <div className={`prow${draft !== null ? " editing" : ""}`}>
          <span className="t">
            <span className="k">{t("ac.alias")}</span>
            {draft === null && <span className="v">{me?.alias ?? "—"}</span>}
          </span>
          {draft === null ? (
            <button className="btn btn-outline btn-sm" type="button" onClick={() => setDraft(me?.alias ?? "")}>{t("ac.change")}</button>
          ) : (
            <span className="edit">
              <input value={draft} maxLength={24} aria-label={t("ac.alias")} onChange={(e) => setDraft(e.target.value)} />
              <button
                className="btn btn-primary btn-sm" type="button"
                onClick={() => { void onAlias(draft.trim()).then((ok) => { if (ok) setDraft(null); }); }}
              >{t("ac.save")}</button>
            </span>
          )}
        </div>
        <div className="prow">
          <span className="t">
            <span className="k">{t("kb.email")}</span>
            <span className="v">{me?.email ?? "—"}</span>
          </span>
        </div>
        <div className="prow">
          <span className="t">
            <span className="k">{t("kb.password")}</span>
            <span className="v">••••••••</span>
          </span>
          <Link className="btn btn-outline btn-sm" href="/forgot-password">{t("ac.change")}</Link>
        </div>
        <p className="note">{t("kb.passwordNote")}</p>
      </section>
    </div>
  );
}

/** Реквизиты (№ 45) — пока один получатель на существующих полях клиента
 *  (название, PVN); несколько компаний придут со схемой billing_profiles. */
function RekvizitiPage({ me, onBack }: { me: Me | null; onBack: () => void }) {
  const { t } = useT();
  const [kind, setKind] = useState<"person" | "company">("person");
  const [company, setCompany] = useState("");
  const [vatNo, setVatNo] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await publicApi.request("PATCH", "/api/public/me", {
        company: kind === "company" ? company : "",
        vatNo: kind === "company" ? vatNo : "",
        name,
      });
      say(t("kb.saved"));
    } catch { say(t("err.generic")); }
    setBusy(false);
  };

  return (
    <div className="acct">
      <Back onBack={onBack} label={t("ac.settings")} />
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("kb.hRekv")}</h1>
          <p className="cnt">{t("kb.rekvSub")}</p>
        </div>
      </div>
      <section className="card-b">
        <p className="g-lbl">{t("kb.recipient")}</p>
        <div className="seg2">
          <button className={`seg${kind === "person" ? " on" : ""}`} type="button" onClick={() => setKind("person")}>
            <b>{t("kb.person")}</b><small>{t("kb.personSub")}</small>
          </button>
          <button className={`seg${kind === "company" ? " on" : ""}`} type="button" onClick={() => setKind("company")}>
            <b>{t("kb.company")}</b><small>{t("kb.companySub")}</small>
          </button>
        </div>

        <p className="g-lbl">{t("kb.contactInfo")}</p>
        <label className="fld">
          <span>{t("kb.nameSurname")}</span>
          <input value={name} placeholder={me?.alias ?? ""} onChange={(e) => setName(e.target.value)} />
        </label>

        {kind === "company" && (
          <>
            <p className="g-lbl">{t("kb.companyReq")}</p>
            <label className="fld">
              <span>{t("kb.companyName")}</span>
              <input value={company} onChange={(e) => setCompany(e.target.value)} />
            </label>
            <label className="fld">
              <span>{t("kb.vatNoL")}</span>
              <input value={vatNo} placeholder="LV…" onChange={(e) => setVatNo(e.target.value)} />
            </label>
          </>
        )}

        <div className="acts">
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void save()}>{t("kb.saveRekv")}</button>
        </div>
        <p className="note">{t("kb.rekvNote")}</p>
      </section>
    </div>
  );
}

function LangPage({ onBack }: { onBack: () => void }) {
  const { t, lang, setLang, available } = useT();
  return (
    <div className="acct">
      <Back onBack={onBack} label={t("ac.settings")} />
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("kb.hLang")}</h1>
          <p className="cnt">{t("kb.langSub")}</p>
        </div>
      </div>
      <section className="card-b">
        <p className="g-lbl">{t("kb.uiLang")}</p>
        {ALL_LANGS.filter((l) => available.includes(l)).map((l) => (
          <button className={`langrow${l === lang ? " on" : ""}`} type="button" key={l} onClick={() => setLang(l)}>
            <span className="cc">{l.toUpperCase()}</span>
            <span className="t">
              <b>{LANG_NAMES[l]}</b>
              <small>{t("kb.langFull")}{l === "lv" ? ` · ${t("kb.langDefault")}` : ""}</small>
            </span>
            <i className="radio" aria-hidden="true" />
          </button>
        ))}
        <p className="note">{t("kb.langNote")}</p>

        <p className="g-lbl">{t("kb.region")}</p>
        <div className="prow">
          <span className="t"><span className="k">{t("kb.timezone")}</span><span className="v">Rīga · GMT+3 (EEST)</span></span>
        </div>
        <div className="prow">
          <span className="t">
            <span className="k">{t("kb.dateFormat")}</span>
            <span className="v tnum">{new Date().toLocaleDateString(dateLocale(lang))} · 24h</span>
          </span>
        </div>
        <div className="prow">
          <span className="t"><span className="k">{t("kb.currency")}</span><span className="v">EUR (€)</span></span>
        </div>
        <p className="note">{t("kb.regionNote")}</p>
      </section>
    </div>
  );
}

function DocsPage({ marketing, onBack }: { marketing: boolean; onBack: () => void }) {
  const { t, lang } = useT();
  const [cookieAt, setCookieAt] = useState<string | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("izsoli_cc_v1");
      if (raw) setCookieAt((JSON.parse(raw) as { at?: string }).at ?? null);
    } catch { /* нет записи */ }
  }, []);

  const docs: Array<{ name: string; href: string }> = [
    { name: t("f.terms"), href: "/lietosanas-noteikumi" },
    { name: t("f.privacy"), href: "/privatuma-politika" },
    { name: t("cc.policy"), href: "/sikdatnes" },
  ];
  const short = (iso: string) => new Date(iso).toLocaleDateString(dateLocale(lang));

  return (
    <div className="acct">
      <Back onBack={onBack} label={t("ac.settings")} />
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("kb.hDocs")}</h1>
          <p className="cnt">{t("kb.docsSub")}</p>
        </div>
      </div>
      <section className="card-b">
        <p className="g-lbl">{t("kb.docsRules")}</p>
        {docs.map((d) => (
          <div className="prow" key={d.href}>
            <span className="t"><span className="v">{d.name}</span></span>
            <Link className="btn btn-outline btn-sm" href={d.href}>{t("kb.read")}</Link>
          </div>
        ))}

        <p className="g-lbl">{t("kb.consentsHead")}</p>
        <div className="prow">
          <span className="t">
            <span className="k">{t("kb.consentCookies")}</span>
            <span className="v">{cookieAt ? t("kb.givenAt", { date: short(cookieAt) }) : t("kb.notGiven")}</span>
          </span>
          <button
            className="btn btn-outline btn-sm" type="button"
            onClick={() => window.dispatchEvent(new Event("izsoli:cookie-settings"))}
          >{t("ac.change")}</button>
        </div>
        <div className="prow">
          <span className="t">
            <span className="k">{t("kb.marketingHead")}</span>
            <span className="v">{marketing ? t("ac.marketingOn") : t("kb.notGiven")}</span>
          </span>
        </div>
        <p className="note">{t("kb.consentNote")}</p>
      </section>
    </div>
  );
}

/** Сīkdatnes (№ 63) — те же три категории, что в плашке; выбор уходит тем же
 *  маршрутом согласий на сервер. */
function CookiesPage({ onBack }: { onBack: () => void }) {
  const { t } = useT();
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("izsoli_cc_v1");
      if (!raw) return;
      const c = JSON.parse(raw) as { analytics?: boolean; marketing?: boolean };
      setAnalytics(c.analytics === true);
      setMarketing(c.marketing === true);
    } catch { /* нет записи */ }
  }, []);

  const save = async (nextAnalytics: boolean, nextMarketing: boolean, mode: string) => {
    setAnalytics(nextAnalytics);
    setMarketing(nextMarketing);
    try {
      let visitorId = localStorage.getItem("izsoli_visitor_v1");
      if (!visitorId) {
        visitorId = crypto.randomUUID();
        localStorage.setItem("izsoli_visitor_v1", visitorId);
      }
      const res = await fetch(`${PUBLIC_API_URL}/api/public/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(publicApi.accessToken ? { authorization: `Bearer ${publicApi.accessToken}` } : {}),
        },
        body: JSON.stringify({ mode, analytics: nextAnalytics, marketing: nextMarketing, visitorId }),
      });
      const body = (await res.json()) as { policyVersion?: string };
      localStorage.setItem("izsoli_cc_v1", JSON.stringify({
        mode, analytics: nextAnalytics, marketing: nextMarketing,
        policyVersion: body.policyVersion, at: new Date().toISOString(),
      }));
      say(t("cc.saved"));
    } catch { say(t("err.generic")); }
  };

  const row = (
    title: string, sub: string, example: string,
    value: boolean | null, onChange?: (v: boolean) => void,
  ) => (
    <div className="ckrow">
      <span className="t">
        <b>{title}</b>
        <small>{sub}</small>
        <small className="ex">{example}</small>
      </span>
      {value === null ? (
        <span className="sw on fixed" role="switch" aria-checked="true" aria-disabled="true" aria-label={title} />
      ) : (
        <button
          className={`sw${value ? " on" : ""}`} type="button" role="switch" aria-checked={value}
          aria-label={title} onClick={() => onChange?.(!value)}
        />
      )}
    </div>
  );

  return (
    <div className="acct">
      <Back onBack={onBack} label={t("ac.settings")} />
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("kb.hCookies")}</h1>
          <p className="cnt">{t("kb.hCookiesSub")}</p>
        </div>
      </div>
      <section className="card-b">
        <p className="g-lbl">{t("cc.title")}</p>
        {row(t("cc.necessary"), t("cc.necessaryD"), "sesija, CSRF", null)}
        {row(t("cc.analytics"), t("cc.analyticsD"), "apmeklējumu statistika", analytics,
          (v) => void save(v, marketing, "custom"))}
        {row(t("cc.marketing"), t("cc.marketingD"), "Meta Pixel, Google Ads", marketing,
          (v) => void save(analytics, v, "custom"))}
        <div className="acts">
          <button className="btn btn-primary" type="button" onClick={() => void save(true, true, "accept")}>{t("cc.acceptAll")}</button>
          <button className="btn btn-outline" type="button" onClick={() => void save(false, false, "reject")}>{t("cc.rejectAll")}</button>
        </div>
        <p className="note">{t("kb.consentNote")}</p>
      </section>
    </div>
  );
}

/** Konts un dati (№ 58): согласия и удаление. Проверки удаления считаются
 *  из живых данных; сам запрос идёт через поддержку, пока нет этапа GDPR. */
function DataPage({
  bids, orders, pickupCount, marketing, onMarketing, onBack,
}: {
  bids: MyBidAuction[];
  orders: MyOrder[];
  pickupCount: number;
  marketing: boolean;
  onMarketing: (v: boolean) => void;
  onBack: () => void;
}) {
  const { t } = useT();
  const liveBids = bids.filter((b) => b.status === "live").length;
  const unpaid = orders.filter((o) => o.status === "awaiting_payment").length;

  return (
    <div className="acct">
      <Back onBack={onBack} label={t("ac.settings")} />
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("kb.hData")}</h1>
          <p className="cnt">{t("kb.dataSub")}</p>
        </div>
      </div>
      <section className="card-b">
        <p className="g-lbl">{t("kb.consentsHead")}</p>
        <div className="ckrow">
          <span className="t">
            <b>{t("ac.marketing")}</b>
            <small>{t("kb.newsSub")}</small>
          </span>
          <button
            className={`sw${marketing ? " on" : ""}`} type="button" role="switch" aria-checked={marketing}
            aria-label={t("ac.marketing")} onClick={() => onMarketing(!marketing)}
          />
        </div>
        <div className="ckrow">
          <span className="t">
            <b>{t("kb.outbidToggle")}</b>
            <small>{t("kb.outbidSub")}</small>
          </span>
          <span className="sw on fixed" role="switch" aria-checked="true" aria-disabled="true" aria-label={t("kb.outbidToggle")} />
        </div>
        <p className="note">{t("kb.consentNote")}</p>

        <div className="danger">
          <b>{t("kb.deleteHead")}</b>
          <p>{t("kb.deleteIntro")}</p>
          <ul>
            <li className={liveBids === 0 ? "ok" : ""}>
              {liveBids === 0 ? t("kb.delBidsOk") : t("kb.delBids", { n: liveBids })}
            </li>
            <li className={unpaid === 0 ? "ok" : ""}>
              {unpaid === 0 ? t("kb.delUnpaidOk") : t("kb.delUnpaid", { n: unpaid })}
            </li>
            <li className={pickupCount === 0 ? "ok" : ""}>
              {pickupCount === 0 ? t("kb.delPickupOk") : t("kb.delPickup", { n: pickupCount })}
            </li>
          </ul>
          <p>{t("kb.deleteLaw")}</p>
          <p>{t("kb.deleteVia")}</p>
          <a className="btn btn-outline" href="mailto:atbalsts@izsoli.lv?subject=Konta%20dz%C4%93%C5%A1ana">
            {t("kb.writeSupport")}
          </a>
        </div>
      </section>
    </div>
  );
}
