"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { publicApi, PublicApiError } from "@/lib/api";
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
type Sub = "hub" | "profils" | "rekviziti" | "valoda" | "dokumenti" | "sikdatnes" | "dati" | "pazinojumi" | "drosiba";

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
  if (sub === "pazinojumi") return <NotifPrefsPage onBack={() => go("hub")} />;
  if (sub === "drosiba") return <SecurityPage me={me} onBack={() => go("hub")} />;
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
        {tile("profils", "gear", t("kb.gProfile"), t("kb.hProfileSub"),
          me ? `${me.alias} · ${me.emailPending ? t("kb.emailNone") : me.email}` : undefined)}
        {tile("rekviziti", "file-text", t("kb.hRekv"), t("kb.hRekvSub"), t("kb.stPerson"))}
      </div>

      <p className="g-lbl">{t("kb.gOrders")}</p>
      <div className="hubgrid">
        {tile("pazinojumi", "bell", t("kb.hNotifs"), t("kb.hNotifsSub"))}
        {tile("drosiba", "shield-check", t("kb.hSecurity"), t("kb.hSecuritySub"))}
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
  const [emailDraft, setEmailDraft] = useState<string | null>(null);
  const [pwDraft, setPwDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // № 50: после Telegram адрес служебный — показываем «не указан» и
  // сразу открываем поле, а не светим tg…@nav.izsoli.lv.
  const pending = me?.emailPending === true;
  useEffect(() => {
    if (pending) setEmailDraft("");
  }, [pending]);

  const saveEmail = async () => {
    const email = (emailDraft ?? "").trim().toLowerCase();
    if (!email) return;
    setBusy(true);
    try {
      await publicApi.request("PATCH", "/api/public/me", { email });
      say(t("kb.emailSent2", { email }));
      setEmailDraft(null);
      window.dispatchEvent(new Event("izsoli:me-refresh"));
    } catch (err) {
      say(err instanceof Error && err.message === "email_exists" ? t("kb.emailTaken") : t("err.generic"));
    }
    setBusy(false);
  };

  const savePassword = async () => {
    const password = pwDraft ?? "";
    if (password.length < 8) { say(t("kb.pwShort")); return; }
    setBusy(true);
    try {
      await publicApi.post("/api/public/auth/password/set", { password });
      say(t("kb.pwCreated"));
      setPwDraft(null);
      window.dispatchEvent(new Event("izsoli:me-refresh"));
    } catch { say(t("err.generic")); }
    setBusy(false);
  };

  return (
    <div className="acct">
      <Back onBack={onBack} label={t("ac.settings")} />
      <div className="page-head"><h1 data-hero>{t("kb.gProfile")}</h1></div>
      {pending && <p className="bb-status info">{t("kb.pabeidzBanner")}</p>}
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
        <div className={`prow${emailDraft !== null ? " editing" : ""}`}>
          <span className="t">
            <span className="k">{t("kb.email")}</span>
            {emailDraft === null && <span className="v">{pending ? t("kb.emailNone") : me?.email ?? "—"}</span>}
          </span>
          {emailDraft === null ? (
            <button className="btn btn-outline btn-sm" type="button" onClick={() => setEmailDraft(pending ? "" : me?.email ?? "")}>{t("ac.change")}</button>
          ) : (
            <span className="edit">
              <input value={emailDraft} type="email" inputMode="email" aria-label={t("kb.email")}
                     placeholder="epasts@piemers.lv" onChange={(e) => setEmailDraft(e.target.value)} />
              <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => void saveEmail()}>{t("ac.save")}</button>
            </span>
          )}
        </div>
        <p className="note">{t("kb.emailChangeNote")}</p>
        {me?.hasPassword === false ? (
          <>
            <div className={`prow${pwDraft !== null ? " editing" : ""}`}>
              <span className="t">
                <span className="k">{t("kb.password")}</span>
                {pwDraft === null && <span className="v">{t("kb.pwNone")}</span>}
              </span>
              {pwDraft === null ? (
                <button className="btn btn-outline btn-sm" type="button" onClick={() => setPwDraft("")}>{t("kb.pwCreate")}</button>
              ) : (
                <span className="edit">
                  <input value={pwDraft} type="password" minLength={8} aria-label={t("kb.password")}
                         placeholder="••••••••" onChange={(e) => setPwDraft(e.target.value)} />
                  <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => void savePassword()}>{t("ac.save")}</button>
                </span>
              )}
            </div>
            <p className="note">{t("kb.pwCreateNote")}</p>
          </>
        ) : (
          <>
            <div className="prow">
              <span className="t">
                <span className="k">{t("kb.password")}</span>
                <span className="v">••••••••</span>
              </span>
              <Link className="btn btn-outline btn-sm" href="/forgot-password">{t("ac.change")}</Link>
            </div>
            <p className="note">{t("kb.passwordNote")}</p>
          </>
        )}
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

/** Konts un dati (№ 58): согласия, выгрузка и удаление. Блокеры считает
 *  сервер; здесь — предварительная сверка по уже загруженным данным. */
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
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverBlockers, setServerBlockers] = useState<{ liveBids: number; unpaidOrders: number; uncollected: number; creditCents: number } | null>(null);

  const exportData = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${PUBLIC_API_URL}/api/public/me/export`, {
        headers: publicApi.accessToken ? { authorization: `Bearer ${publicApi.accessToken}` } : {},
      });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "izsoli-mani-dati.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch { say(t("err.generic")); }
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true);
    try {
      await publicApi.post("/api/public/me/delete");
      // Аккаунт обезличен, сессии отозваны — токены больше не действуют.
      publicApi.logout();
      say(t("kb.deletedBye"));
      window.location.assign("/");
    } catch (err) {
      const body = err instanceof PublicApiError ? err.body : null;
      const blockers = body && typeof body.blockers === "object"
        ? (body.blockers as { liveBids: number; unpaidOrders: number; uncollected: number; creditCents: number })
        : null;
      if (blockers) { setServerBlockers(blockers); setConfirming(false); }
      else say(t("err.generic"));
      setBusy(false);
    }
  };

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

        <p className="g-lbl">{t("kb.exportHead")}</p>
        <div className="prow">
          <span className="t">
            <span className="k">{t("kb.exportRow")}</span>
            <span className="v">{t("kb.exportSub")}</span>
          </span>
          <button className="btn btn-outline btn-sm" type="button" disabled={busy} onClick={() => void exportData()}>
            {t("kb.exportBtn")}
          </button>
        </div>

        <div className="danger">
          <b>{t("kb.deleteHead")}</b>
          <p>{t("kb.deleteIntro")}</p>
          <ul>
            <li className={(serverBlockers ? serverBlockers.liveBids : liveBids) === 0 ? "ok" : ""}>
              {(serverBlockers ? serverBlockers.liveBids : liveBids) === 0
                ? t("kb.delBidsOk") : t("kb.delBids", { n: serverBlockers ? serverBlockers.liveBids : liveBids })}
            </li>
            <li className={(serverBlockers ? serverBlockers.unpaidOrders : unpaid) === 0 ? "ok" : ""}>
              {(serverBlockers ? serverBlockers.unpaidOrders : unpaid) === 0
                ? t("kb.delUnpaidOk") : t("kb.delUnpaid", { n: serverBlockers ? serverBlockers.unpaidOrders : unpaid })}
            </li>
            <li className={(serverBlockers ? serverBlockers.uncollected : pickupCount) === 0 ? "ok" : ""}>
              {(serverBlockers ? serverBlockers.uncollected : pickupCount) === 0
                ? t("kb.delPickupOk") : t("kb.delPickup", { n: serverBlockers ? serverBlockers.uncollected : pickupCount })}
            </li>
            {serverBlockers && serverBlockers.creditCents > 0 && (
              <li>{t("kb.delCredit", { sum: (serverBlockers.creditCents / 100).toFixed(2) })}</li>
            )}
          </ul>
          <p>{t("kb.deleteLaw")}</p>
          {confirming ? (
            <>
              <p><b>{t("kb.deleteSure")}</b></p>
              <div className="acts">
                <button className="btn btn-outline btn-del" type="button" disabled={busy} onClick={() => void remove()}>
                  {t("kb.deleteConfirm")}
                </button>
                <button className="btn btn-outline" type="button" onClick={() => setConfirming(false)}>
                  {t("ac.cancel")}
                </button>
              </div>
            </>
          ) : (
            <button className="btn btn-outline" type="button" disabled={busy} onClick={() => setConfirming(true)}>
              {t("kb.deleteBtn")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}


/** Paziņojumi (№ 60): матрица «событие × канал». Сегодня доставляется только
 *  e-pasts; push и Telegram появятся со своими интеграциями — их слēdži
 *  выключены и подписаны честно. */
function NotifPrefsPage({ onBack }: { onBack: () => void }) {
  const { t } = useT();
  const [prefs, setPrefs] = useState<Array<{ event: string; email: boolean }>>([]);

  useEffect(() => {
    void publicApi
      .get<{ prefs: Array<{ event: string; email: boolean }> }>("/api/public/me/notification-prefs")
      .then((r) => setPrefs(r.prefs))
      .catch(() => undefined);
  }, []);

  const set = (event: string, email: boolean) => {
    setPrefs((cur) => cur.map((p) => (p.event === event ? { ...p, email } : p)));
    void publicApi.request("PUT", "/api/public/me/notification-prefs", { event, email })
      .then(() => say(t("kb.saved")))
      .catch(() => say(t("err.generic")));
  };

  const EVENTS: Array<[string, string, string, boolean]> = [
    ["outbid", t("kb.evOutbid"), t("kb.evOutbidD"), true],
    ["ending", t("kb.evEnding"), t("kb.evEndingD"), true],
    ["watchlist", t("kb.evWatch"), t("kb.evWatchD"), true],
    ["marketing", t("kb.evMarketing"), t("kb.evMarketingD"), true],
  ];
  const MANDATORY: Array<[string, string]> = [
    [t("kb.fWon"), t("acc.awaiting")],
  ];
  void MANDATORY;

  const row = (event: string, title: string, subT: string) => {
    const p = prefs.find((x) => x.event === event);
    return (
      <div className="ckrow" key={event}>
        <span className="t">
          <b>{title}</b>
          <small>{subT}</small>
          <small className="ex">{t("kb.chPush")} · {t("kb.chTg")} — {t("kb.chSoon")}</small>
        </span>
        <button
          className={`sw${(p?.email ?? true) ? " on" : ""}`} type="button" role="switch"
          aria-checked={p?.email ?? true} aria-label={`${title} — ${t("kb.chEmail")}`}
          onClick={() => set(event, !(p?.email ?? true))}
        />
      </div>
    );
  };

  return (
    <div className="acct">
      <Back onBack={onBack} label={t("ac.settings")} />
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("kb.hNotifs")}</h1>
          <p className="cnt">{t("kb.notifSub")}</p>
        </div>
      </div>
      <section className="card-b">
        <p className="g-lbl">{t("kb.channels")} · {t("kb.chEmail")}</p>
        {EVENTS.map(([event, title, subT]) => row(event, title, subT))}
        <div className="ckrow">
          <span className="t">
            <b>{t("kb.fWon")} · {t("kb.invoiceRecipient")} · {t("ac.pickup")}</b>
            <small>{t("kb.mandatoryNote")}</small>
          </span>
          <span className="sw on fixed" role="switch" aria-checked="true" aria-disabled="true"
                aria-label={t("kb.mandatoryNote")} />
        </div>
      </section>
    </div>
  );
}

/** Drošība (№ 57): способы входа и активные сессии. */
function SecurityPage({ me, onBack }: { me: Me | null; onBack: () => void }) {
  const { t, lang } = useT();
  const [sessions, setSessions] = useState<Array<{ id: string; ua: string | null; ip: string | null; lastUsedAt: string | null; createdAt: string; current: boolean }>>([]);

  const load = () =>
    void publicApi
      .get<{ sessions: typeof sessions }>("/api/public/me/sessions")
      .then((r) => setSessions(r.sessions))
      .catch(() => undefined);
  useEffect(load, []);

  const device = (ua: string | null) => {
    if (!ua) return "—";
    const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac OS/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
    const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
    return [os, br].filter(Boolean).join(" · ") || ua.slice(0, 40);
  };
  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(dateLocale(lang), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

  return (
    <div className="acct">
      <Back onBack={onBack} label={t("ac.settings")} />
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 data-hero>{t("kb.hSecurity")}</h1>
          <p className="cnt">{t("kb.secSub")}</p>
        </div>
      </div>
      <section className="card-b">
        <p className="g-lbl">{t("kb.loginWays")}</p>
        <div className="prow">
          <span className="t"><span className="k">{t("kb.email")}</span><span className="v">{me?.email ?? "—"}</span></span>
        </div>
        <div className="prow">
          <span className="t"><span className="k">{t("kb.password")}</span><span className="v">••••••••</span></span>
          <Link className="btn btn-outline btn-sm" href="/forgot-password">{t("ac.change")}</Link>
        </div>

        <p className="g-lbl">{t("kb.activeSessions")}</p>
        {sessions.map((sn) => (
          <div className="ckrow" key={sn.id}>
            <span className="t">
              <b>{device(sn.ua)} {sn.current && <i className="tag-lead">{t("kb.thisDevice")}</i>}</b>
              <small>
                {sn.ip ?? "—"} · {sn.current ? t("kb.activeNow") : when(sn.lastUsedAt ?? sn.createdAt)}
              </small>
            </span>
            {!sn.current && (
              <button
                className="btn btn-outline btn-sm" type="button"
                onClick={() => void publicApi.request("DELETE", `/api/public/me/sessions/${sn.id}`).then(load).catch(() => say(t("err.generic")))}
              >{t("kb.endSession")}</button>
            )}
          </div>
        ))}
        {sessions.filter((sn) => !sn.current).length > 0 && (
          <div className="acts">
            <button
              className="btn btn-outline" type="button"
              onClick={() => void publicApi.post("/api/public/me/sessions/signout-others").then(() => { say(t("kb.saved")); load(); }).catch(() => say(t("err.generic")))}
            >{t("kb.signOutAll")}</button>
          </div>
        )}
        <p className="note">{t("kb.sessionsNote")}</p>
      </section>
    </div>
  );
}
