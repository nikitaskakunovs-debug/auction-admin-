"use client";

import Link from "next/link";
import { type ReactNode } from "react";
import { useT } from "@/lib/i18n";

/** Хлебные крошки.
 *
 *  Отдельный клиентский компонент, потому что серверные страницы не могут
 *  звать хук, а `aria-label` крошек — это строка, а не элемент, и через
 *  `<T />` его не подставить. Раньше из-за этого в восьми файлах и подпись
 *  навигации, и слово «Начало» оставались латышскими на любом языке. */
export function Crumbs({
  trail = [],
  here,
}: {
  /** Промежуточные звенья между главной и текущей страницей. */
  trail?: { href: string; label: ReactNode }[];
  /** Текущая страница — последнее звено, уже без ссылки. */
  here: ReactNode;
}) {
  const { t } = useT();
  return (
    <nav className="crumbs" aria-label={t("nav.breadcrumb")}>
      <ol>
        <li><Link href="/">{t("nav.home")}</Link></li>
        {trail.map((c) => <li key={c.href}><Link href={c.href}>{c.label}</Link></li>)}
        <li aria-current="page">{here}</li>
      </ol>
    </nav>
  );
}
