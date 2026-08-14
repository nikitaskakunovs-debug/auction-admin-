"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { useT } from "@/lib/i18n";

/** Каркас информационной страницы: хлебные крошки, заголовок, проза
 *  и блок «остались вопросы». Все страницы подвала собраны на нём,
 *  чтобы вёрстка и отступы были одни и те же. */
export type InfoBlock =
  | { h: string }
  | { p: ReactNode }
  | { list: string[] }
  | { bad: string[] }
  | { facts: Array<[string, string]> }
  | { steps: Array<[string, string]> }
  | { note: string };

export function InfoPage({
  title, sub, lead, blocks, related,
}: {
  title: string;
  sub?: string;
  lead?: string;
  blocks: InfoBlock[];
  related?: Array<[string, string]>;
}) {
  const { t } = useT();
  return (
    <section className="wrap" style={{ paddingTop: 24 }}>
      <nav className="crumbs" aria-label={t("nav.breadcrumb")}>
        <ol>
          <li><Link href="/">{t("nav.home")}</Link></li>
          <li aria-current="page">{title}</li>
        </ol>
      </nav>

      <div className="page-head">
        <div>
          <h1 data-hero>{title}</h1>
          {sub && <p className="cnt">{sub}</p>}
        </div>
        <Link className="link" href="/buj">{t("f.faq")} <Icon name="arrow" size={16} /></Link>
      </div>

      {lead && <p className="lead" style={{ maxWidth: "56ch", marginBottom: "var(--s5)" }}>{lead}</p>}

      <article className="prose">
        {blocks.map((b, i) => {
          if ("h" in b) return <h2 key={i}>{b.h}</h2>;
          if ("p" in b) return <p key={i}>{b.p}</p>;
          if ("note" in b) return <p className="note" key={i}>{b.note}</p>;
          if ("list" in b) return (
            <ul className="rep-list" key={i}>
              {b.list.map((x) => <li className="in" key={x}><Icon name="check" size={16} />{x}</li>)}
            </ul>
          );
          if ("bad" in b) return (
            <ul className="rep-list" key={i}>
              {b.bad.map((x) => <li className="out" key={x}><Icon name="x" size={16} />{x}</li>)}
            </ul>
          );
          if ("facts" in b) return (
            <div className="facts" key={i}>
              {b.facts.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)}
            </div>
          );
          if ("steps" in b) return (
            <div className="steps" key={i}>
              {b.steps.map(([h, p], k) => (
                <div className="step" key={h}>
                  <span className="n" aria-hidden="true">{k + 1}</span>
                  <h3>{h}</h3><p>{p}</p>
                </div>
              ))}
            </div>
          );
          return null;
        })}
      </article>

      {related && related.length > 0 && (
        <nav className="f-links" aria-label={t("misc.relatedPages")} style={{ marginTop: "var(--s6)", borderTop: 0 }}>
          {related.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}
        </nav>
      )}

      <div className="mybids" style={{ marginTop: "var(--s5)", marginBottom: "var(--s6)" }}>
        <span className="ic" aria-hidden="true"><Icon name="mail" /></span>
        <div className="t">
          <h3>{t("misc.stillQuestion")}</h3>
          <p>{t("misc.writeUsReply")}</p>
        </div>
        <Link className="btn btn-dark" href="/kontakti">{t("misc.contactUs")}</Link>
      </div>
    </section>
  );
}
