import Link from "next/link";
import { Icon } from "@/components/Icon";
import { T } from "@/lib/i18n";

export const metadata = { title: "Lapa nav atrasta" };

export default function NotFound() {
  return (
    <section className="wrap" style={{ paddingTop: 48, paddingBottom: 80 }}>
      <div className="empty">
        <span className="ic" aria-hidden="true"><Icon name="search" /></span>
        <h1 style={{ fontSize: 28, letterSpacing: "-.03em" }}><T k="nf.title" /></h1>
        <p><T k="nf.body" /></p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
          <Link className="btn btn-primary" href="/katalogs"><T k="nf.catalogue" /></Link>
          <Link className="btn btn-outline" href="/"><T k="nf.home" /></Link>
        </div>
      </div>
    </section>
  );
}
