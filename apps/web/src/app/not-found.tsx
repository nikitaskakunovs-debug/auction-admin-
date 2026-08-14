import Link from "next/link";
import { Icon } from "@/components/Icon";

export const metadata = { title: "Lapa nav atrasta" };

export default function NotFound() {
  return (
    <section className="wrap" style={{ paddingTop: 48, paddingBottom: 80 }}>
      <div className="empty">
        <span className="ic" aria-hidden="true"><Icon name="search" /></span>
        <h1 style={{ fontSize: 28, letterSpacing: "-.03em" }}>Šādas lapas nav</h1>
        <p>
          Iespējams, lots jau ir pārdots vai saite ir novecojusi.
          Šobrīd aktīvi ir simtiem citu lotu.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
          <Link className="btn btn-primary" href="/katalogs">Atvērt katalogu</Link>
          <Link className="btn btn-outline" href="/">Uz sākumu</Link>
        </div>
      </div>
    </section>
  );
}
