"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { publicApi } from "@/lib/api";
import { Icon } from "./Icon";

/** Нижний док макета: прячется при скролле вниз, возвращается при скролле вверх. */
export function Dock() {
  const path = usePathname();
  const [hidden, setHidden] = useState(false);
  const [initial, setInitial] = useState("N");

  useEffect(() => {
    let last = 0, tick = false;
    const on = () => {
      const y = window.scrollY;
      if (y > 320 && y > last + 6) setHidden(true);
      else if (y < last - 6 || y <= 320) setHidden(false);
      last = y; tick = false;
    };
    const onScroll = () => { if (!tick) { tick = true; requestAnimationFrame(on); } };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const sync = () => setInitial(publicApi.hasSession ? "•" : "N");
    sync();
    publicApi.listeners.add(sync);
    return () => { publicApi.listeners.delete(sync); };
  }, []);

  const cur = (href: string) => (path === href ? "page" : undefined);

  return (
    <nav className={`dock${hidden ? " is-hidden" : ""}`} aria-label="Galvenā navigācija">
      <Link href="/" aria-current={cur("/")}><Icon name="home" /><span className="lbl">Sākums</span></Link>
      <Link href="/tiesraide">
        <Icon name="bolt" /><span className="lbl">Tiešraide</span>
        <i className="badge-dot" aria-hidden="true" />
      </Link>
      <Link href="/meklet"><Icon name="search" /><span className="lbl">Meklēt</span></Link>
      <Link href="/velmes"><Icon name="heart" /><span className="lbl">Vēlmes</span></Link>
      <Link href="/account">
        <span className="ava" aria-hidden="true">{initial}</span><span className="lbl">Profils</span>
      </Link>
    </nav>
  );
}
