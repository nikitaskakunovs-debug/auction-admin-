"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { publicApi } from "@/lib/api";
import type { FixedListing, PublicAuction } from "@/lib/types";
import { Banners } from "./Banners";
import { Hero } from "./Hero";
import { Icon } from "./Icon";
import { LotCard, LotSkeleton, type CardLot } from "./LotCard";
import { Brands, Faq, LiveBand, MyBids, SecHead, SeoBlock, WhyUs } from "./Sections";

/** Главная страница утверждённого макета.
 *  Порядок блоков менять нельзя — он и есть макет. */
export function HomeSections({
  auctions, listings,
}: { auctions: PublicAuction[]; listings: FixedListing[] }) {
  const [signedIn, setSignedIn] = useState(false);
  const [rounds, setRounds] = useState(0);
  const [busy, setBusy] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSignedIn(publicApi.hasSession);
    const fn = () => setSignedIn(publicApi.hasSession);
    publicApi.listeners.add(fn);
    return () => { publicApi.listeners.delete(fn); };
  }, []);

  const live = auctions.filter((a) => a.status === "live");
  const byEnd = [...live].sort(
    (a, b) => new Date(a.endsAt).getTime() - new Date(b.endsAt).getTime(),
  );
  const closing = byEnd.slice(0, 4) as CardLot[];
  const recommended = byEnd.slice(4, 10) as CardLot[];
  const explore = auctions.slice(0, 8 + rounds * 8) as CardLot[];
  const exhausted = explore.length >= auctions.length;

  const loadMore = () => {
    if (busy || exhausted) return;
    setBusy(true);
    setTimeout(() => { setRounds((r) => r + 1); setBusy(false); }, 300);
  };

  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((e) => { if (e[0]?.isIntersecting) loadMore(); },
      { rootMargin: "320px" });
    io.observe(el);
    return () => io.disconnect();
  });

  return (
    <>
      <Hero />

      <section className="section wrap" id="lots" style={{ paddingTop: 0 }}>
        <SecHead icon="timer" title="Drīz noslēdzas" sub="Loti, kuriem atlikušas dažas stundas"
                 link={`Visi ${auctions.length} loti`} href="/katalogs" />
        <div className="grid-4" aria-live="polite">
          {closing.map((a) => <LotCard key={a.id} lot={a} />)}
          {closing.length === 0 && Array.from({ length: 4 }, (_, i) => <LotSkeleton key={i} />)}
        </div>
        <p className="note" style={{ marginTop: 16 }}>
          Ieteiktā cena — ražotāja ieteiktā mazumtirdzniecības cena preces izlaišanas brīdī, nevis mūsu iepriekšējā cena.
          Taimeri rāda faktisko izsoles beigu laiku serverī; solījums pēdējā minūtē pagarina izsoli.
        </p>
      </section>

      <Banners />

      <MyBids signedIn={signedIn} />

      {recommended.length > 0 && (
        <section className="section wrap">
          <SecHead title="Tev varētu patikt" sub="Pēc skatītajām kategorijām"
                   link="Skatīt visu" href="/katalogs" />
          <div className="hrail">
            {recommended.map((a) => <LotCard key={a.id} lot={a} />)}
          </div>
        </section>
      )}

      <LiveBand sales={[]} />

      <section className="section wrap">
        <SecHead title="Viss katalogs" sub={`${auctions.length} aktīvi loti`}
                 link="Atvērt katalogu" href="/katalogs" />
        <div className="grid-4">
          {explore.map((a) => <LotCard key={a.id} lot={a} />)}
          {busy && Array.from({ length: 4 }, (_, i) => <LotSkeleton key={`s${i}`} />)}
        </div>
        <div className="more" ref={sentinel}>
          {busy && <span className="spin" aria-hidden="true" />}
          {!exhausted && !busy && (
            <button className="btn btn-outline btn-lg" type="button" onClick={loadMore}>Rādīt vēl lotus</button>
          )}
          {exhausted && (
            <p className="end">
              Tu esi apskatījis visus <b>{auctions.length}</b> aktīvos lotus.{" "}
              <Link className="link" href="/katalogs" style={{ fontSize: 15 }}>
                Atvērt pilno katalogu <Icon name="arrow" size={14} />
              </Link>
            </p>
          )}
        </div>
      </section>

      {listings.length > 0 && (
        <section className="section wrap">
          <SecHead title="Pērc uzreiz" sub="Fiksēta cena, bez solīšanas"
                   link="Visi piedāvājumi" href="/katalogs?type=fixed" />
          <div className="grid-4">
            {listings.slice(0, 4).map((l) => (
              <article className="lot" key={l.id}>
                <div className="lot-art">
                  <div className="gal">
                    <span className="frame frame-1 on"><Icon name="box" className="pic" /></span>
                  </div>
                  <span className="lot-cat"><Icon name="box" /></span>
                </div>
                <div className="lot-body">
                  <p className="lot-top"><span className="id">{l.sku}</span></p>
                  <h3><Link href={`/listing/${l.id}`}>{l.title}</Link></h3>
                  <Link className="btn btn-primary btn-block" href={`/listing/${l.id}`}>Pirkt</Link>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <Brands />
      <WhyUs />
      <SeoBlock />
      <Faq />
    </>
  );
}
