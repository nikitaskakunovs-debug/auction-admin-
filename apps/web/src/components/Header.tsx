"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { LANGS, useT, type Lang } from "@/lib/i18n";

export function Header() {
  const { lang, setLang, t } = useT();
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setSignedIn(publicApi.hasSession);
    const fn = () => setSignedIn(publicApi.hasSession);
    publicApi.listeners.add(fn);
    return () => {
      publicApi.listeners.delete(fn);
    };
  }, []);

  return (
    <header style={{ background: "#0F0F0E", color: "#fff" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "14px 20px", display: "flex", alignItems: "center", gap: 18 }}>
        <Link href="/" style={{ color: "#fff", textDecoration: "none", fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ width: 26, height: 26, borderRadius: 7, background: "#2D4BFF", display: "inline-grid", placeItems: "center", fontSize: 13 }}>⚖</span>
          Baltic Auction House
        </Link>
        <nav style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 16, fontSize: 13.5 }}>
          <Link href="/" style={{ color: "rgba(255,255,255,0.8)", textDecoration: "none", fontWeight: 600 }}>{t("nav.auctions")}</Link>
          {signedIn ? (
            <>
              <Link href="/account" style={{ color: "rgba(255,255,255,0.8)", textDecoration: "none", fontWeight: 600 }}>{t("nav.account")}</Link>
              <button
                onClick={() => publicApi.logout()}
                style={{ all: "unset", cursor: "pointer", color: "rgba(255,255,255,0.55)", fontWeight: 600, fontSize: 13.5 }}
              >{t("nav.signout")}</button>
            </>
          ) : (
            <>
              <Link href="/login" style={{ color: "rgba(255,255,255,0.8)", textDecoration: "none", fontWeight: 600 }}>{t("nav.signin")}</Link>
              <Link href="/register" style={{ color: "#fff", textDecoration: "none", fontWeight: 700, background: "#2D4BFF", borderRadius: 8, padding: "7px 13px" }}>{t("nav.register")}</Link>
            </>
          )}
          <span style={{ display: "inline-flex", gap: 4, marginLeft: 6 }}>
            {LANGS.map((l: Lang) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                style={{
                  all: "unset", cursor: "pointer", padding: "3px 7px", borderRadius: 6, fontSize: 11.5,
                  fontWeight: 700, textTransform: "uppercase",
                  color: lang === l ? "#0A0A0A" : "rgba(255,255,255,0.55)",
                  background: lang === l ? "#fff" : "transparent",
                }}
              >{l}</button>
            ))}
          </span>
        </nav>
      </div>
    </header>
  );
}
