"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n";
import { pickLocalized, type Localized } from "./CmsBlocks";

export function Footer({ pages }: { pages: Array<{ slug: string; title: Localized }> }) {
  const { lang } = useT();
  return (
    <footer style={{ borderTop: "1px solid rgba(10,10,10,0.08)", padding: "26px 20px", marginTop: 30 }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "#6B6B68" }}>Izsoli.lv · Skakunov’s SIA · Rīga</span>
        <nav style={{ marginLeft: "auto", display: "flex", gap: 16, flexWrap: "wrap" }}>
          {pages.map((p) => (
            <Link key={p.slug} href={`/p/${p.slug}`} style={{ fontSize: 12.5, fontWeight: 600, color: "#454542", textDecoration: "none" }}>
              {pickLocalized(p.title, lang)}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
