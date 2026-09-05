import Link from "next/link";

/**
 * Каркас партнёрского поддомена. Витринная шапка с каталогом, поиском и
 * корзиной поставщику не нужна: здесь только логотип, подпись «кабинет
 * поставщика» и узкий подвал с контактом — чтобы человек, получивший письмо,
 * видел ровно то, зачем пришёл.
 */
export function PartnerHeader() {
  return (
    <header className="partner-head">
      <div className="wrap partner-head-in">
        <Link href="/piegadatajs" className="logo" aria-label="Izsoli.lv">
          <span className="logo-mark" aria-hidden="true">I</span>Izsoli.lv
        </Link>
        <span className="partner-tag">Piegādātāja kabinets</span>
      </div>
    </header>
  );
}

export function PartnerFooter() {
  return (
    <footer className="partner-foot">
      <div className="wrap">
        <p>
          Izsoli.lv SIA · <a href="mailto:info@izsoli.lv">info@izsoli.lv</a> ·{" "}
          <a href="https://izsoli.lv" target="_blank" rel="noreferrer">izsoli.lv</a>
        </p>
      </div>
    </footer>
  );
}
