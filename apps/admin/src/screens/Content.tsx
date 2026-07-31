import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate } from "../format.js";
import { useT, type TKey } from "../i18n.js";
import { AT } from "../theme.js";
import {
  ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput, APills,
  ATable, ATd, ATr, useConfirm, useToast,
} from "../ui.js";

type Localized = { lv: string; ru: string; en: string };
type Block =
  | { type: "heading"; text: Localized }
  | { type: "text"; text: Localized }
  | { type: "image"; url: string; alt: Localized }
  | { type: "faq"; question: Localized; answer: Localized }
  | { type: "divider" };

interface CmsPage {
  id: string;
  slug: string;
  title: Localized;
  blocks: Block[];
  seo: { title: Localized; description: Localized } | null;
  status: string;
  inFooter: boolean;
  position: number;
  updatedAt: string;
}

const LANGS = ["lv", "ru", "en"] as const;
type Lang = (typeof LANGS)[number];

const emptyL = (): Localized => ({ lv: "", ru: "", en: "" });

const BLOCK_FACTORY: Record<string, () => Block> = {
  heading: () => ({ type: "heading", text: emptyL() }),
  text: () => ({ type: "text", text: emptyL() }),
  image: () => ({ type: "image", url: "", alt: emptyL() }),
  faq: () => ({ type: "faq", question: emptyL(), answer: emptyL() }),
  divider: () => ({ type: "divider" }),
};

const BLOCK_KEYS: Record<Block["type"], TKey> = {
  heading: "cms.b.heading",
  text: "cms.b.text",
  image: "cms.b.image",
  faq: "cms.b.faq",
  divider: "cms.b.divider",
};

export function ContentScreen({ nav: _nav }: { nav: Nav }) {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [pages, setPages] = useState<CmsPage[]>([]);
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState<CmsPage | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [lang, setLang] = useState<Lang>("lv");
  const editable = can("content.edit");

  const load = () => {
    void api.get<{ pages: CmsPage[] }>("/api/cms/pages").then((r) => setPages(r.pages)).catch(() => undefined);
  };
  useEffect(load, []);

  const counts = useMemo(
    () => ({
      all: pages.length,
      published: pages.filter((p) => p.status === "published").length,
      draft: pages.filter((p) => p.status === "draft").length,
    }),
    [pages],
  );
  const visible = filter === "all" ? pages : pages.filter((p) => p.status === filter);

  const openNew = () => {
    setIsNew(true);
    setLang("lv");
    setEditing({
      id: "",
      slug: "",
      title: emptyL(),
      blocks: [],
      seo: null,
      status: "draft",
      inFooter: true,
      position: pages.length + 1,
      updatedAt: "",
    });
  };

  const save = async (publishToggle?: "published" | "draft") => {
    if (!editing) return;
    const body = {
      slug: editing.slug,
      title: editing.title,
      blocks: editing.blocks,
      seo: editing.seo,
      status: publishToggle ?? editing.status,
      inFooter: editing.inFooter,
      position: editing.position,
    };
    try {
      if (isNew) {
        await api.post("/api/cms/pages", body);
      } else {
        await api.patch(`/api/cms/pages/${editing.id}`, body);
      }
      toast(publishToggle === "published" ? t("cms.pagePublished") : t("cms.pageSaved"), "ok");
      setEditing(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("cms.saveFailed"), "danger");
    }
  };

  const remove = async () => {
    if (!editing || isNew) return;
    const r = await confirm({
      title: `${t("cms.deletePage")} /${editing.slug}?`,
      body: t("cms.deleteBody"),
      danger: true,
      typeToConfirm: editing.slug,
      confirmLabel: t("c.delete"),
    });
    if (!r.ok) return;
    try {
      await api.delete(`/api/cms/pages/${editing.id}`);
      toast(t("cms.pageDeleted"), "ok");
      setEditing(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("cms.deleteFailed"), "danger");
    }
  };

  const patchBlock = (i: number, block: Block) =>
    setEditing((p) => (p ? { ...p, blocks: p.blocks.map((b, j) => (j === i ? block : b)) } : p));
  const moveBlock = (i: number, dir: -1 | 1) =>
    setEditing((p) => {
      if (!p) return p;
      const j = i + dir;
      if (j < 0 || j >= p.blocks.length) return p;
      const blocks = [...p.blocks];
      [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
      return { ...p, blocks };
    });

  const setL = (obj: Localized, value: string): Localized => ({ ...obj, [lang]: value });

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>{t("cms.title")}</h1>
        {editable && (
          <ABtn onClick={openNew}>
            <AIcon name="plus" size={15} color="#fff" /> {t("cms.newPage")}
          </ABtn>
        )}
      </div>

      <APills
        options={[
          { id: "all", label: t("c.all"), count: counts.all },
          { id: "published", label: t("cms.published"), count: counts.published },
          { id: "draft", label: t("cms.draft"), count: counts.draft },
        ]}
        value={filter}
        onChange={setFilter}
      />

      <ACard pad={false}>
        {visible.length === 0 ? (
          <AEmpty text={t("cms.noPages")} />
        ) : (
          <ATable head={[t("cms.thPage"), t("cms.thSlug"), t("cms.thBlocks"), t("cms.thFooter"), t("cms.thUpdated"), t("c.status")]}>
            {visible.map((p) => (
              <ATr key={p.id} onClick={() => { setIsNew(false); setLang("lv"); setEditing(p); }}>
                <ATd><span style={{ fontWeight: 600 }}>{p.title.lv || p.title.en || t("cms.untitled")}</span></ATd>
                <ATd mono>/{p.slug}</ATd>
                <ATd right>{p.blocks.length}</ATd>
                <ATd>{p.inFooter ? t("cms.yes") : "—"}</ATd>
                <ATd>{formatDate(p.updatedAt)}</ATd>
                <ATd><ABadge tone={p.status === "published" ? "ok" : "neutral"}>{p.status === "published" ? t("cms.st.published") : p.status === "draft" ? t("cms.st.draft") : p.status}</ABadge></ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>

      {editing && (
        <ADrawer
          width={720}
          title={isNew ? t("cms.newPage") : <span>{t("cms.editPage")} <span style={{ fontFamily: AT.mono, fontSize: 13 }}>/{editing.slug}</span></span>}
          onClose={() => setEditing(null)}
          footer={
            <>
              {!isNew && editable && <ABtn kind="danger" onClick={() => void remove()}>{t("c.delete")}</ABtn>}
              <ABtn kind="ghost" onClick={() => setEditing(null)}>{t("c.close")}</ABtn>
              {editable && editing.status === "published" && !isNew && (
                <ABtn kind="soft" onClick={() => void save("draft")}>{t("cms.unpublish")}</ABtn>
              )}
              {editable && <ABtn kind="dark" onClick={() => void save(editing.status === "published" ? undefined : "published")}>
                {editing.status === "published" ? t("c.save") : t("cms.savePublish")}
              </ABtn>}
              {editable && editing.status !== "published" && (
                <ABtn onClick={() => void save()}>{t("cms.saveDraft")}</ABtn>
              )}
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 110px", gap: 12 }}>
              <AField label={t("cms.slug")} hint={t("cms.slugHint")}>
                <AInput value={editing.slug} onChange={(v) => setEditing({ ...editing, slug: v.toLowerCase() })} placeholder="about" />
              </AField>
              <AField label={t("cms.position")}>
                <AInput value={String(editing.position)} onChange={(v) => setEditing({ ...editing, position: Number(v) || 0 })} />
              </AField>
              <AField label={t("cms.inFooter")}>
                <ABtn size="sm" kind={editing.inFooter ? "dark" : "ghost"} onClick={() => setEditing({ ...editing, inFooter: !editing.inFooter })}>
                  {editing.inFooter ? t("cms.shown") : t("cms.hidden")}
                </ABtn>
              </AField>
            </div>

            {/* Language tabs (Shhh CMS pattern) */}
            <div style={{ display: "flex", gap: 6 }}>
              {LANGS.map((l) => {
                const filled =
                  (editing.title[l] ?? "").length > 0 ||
                  editing.blocks.some((b) => "text" in b && (b.text as Localized)[l]);
                return (
                  <button key={l} onClick={() => setLang(l)} style={{
                    all: "unset", cursor: "pointer", padding: "5px 12px", borderRadius: 999,
                    fontFamily: AT.body, fontWeight: 700, fontSize: 12, textTransform: "uppercase",
                    background: lang === l ? AT.ink : AT.panel, color: lang === l ? "#fff" : filled ? AT.ink : AT.inkSoft,
                    border: `1px solid ${lang === l ? AT.ink : AT.rule}`,
                  }}>{l}{!filled && lang !== l ? " ·" : ""}</button>
                );
              })}
              <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, alignSelf: "center" }}>
                {t("cms.editingA")} <strong>{lang.toUpperCase()}</strong>{t("cms.editingB")}
              </span>
            </div>

            <AField label={`${t("cms.pageTitle")} (${lang})`}>
              <AInput value={editing.title[lang]} onChange={(v) => setEditing({ ...editing, title: setL(editing.title, v) })} />
            </AField>

            {/* Blocks */}
            <div>
              <div style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700, color: AT.ink, marginBottom: 7 }}>{t("cms.blocks")}</div>
              <div style={{ display: "grid", gap: 10 }}>
                {editing.blocks.map((b, i) => (
                  <div key={i} style={{ border: `1px solid ${AT.rule}`, borderRadius: AT.radiusSm, padding: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                      <ABadge tone="accent">{t(BLOCK_KEYS[b.type])}</ABadge>
                      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
                        <ABtn size="sm" kind="soft" onClick={() => moveBlock(i, -1)} disabled={i === 0}>↑</ABtn>
                        <ABtn size="sm" kind="soft" onClick={() => moveBlock(i, 1)} disabled={i === editing.blocks.length - 1}>↓</ABtn>
                        <ABtn size="sm" kind="soft" onClick={() => setEditing({ ...editing, blocks: editing.blocks.filter((_, j) => j !== i) })}>
                          <AIcon name="close" size={12} />
                        </ABtn>
                      </span>
                    </div>
                    {b.type === "heading" && (
                      <AInput value={b.text[lang]} onChange={(v) => patchBlock(i, { ...b, text: setL(b.text, v) })} placeholder={`${t("cms.b.heading")} (${lang})`} />
                    )}
                    {b.type === "text" && (
                      <textarea
                        value={b.text[lang]}
                        onChange={(e) => patchBlock(i, { ...b, text: setL(b.text, e.target.value) })}
                        rows={3}
                        placeholder={`${t("cms.b.text")} (${lang})`}
                        style={{ width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, padding: 10, resize: "vertical" }}
                      />
                    )}
                    {b.type === "image" && (
                      <div style={{ display: "grid", gap: 8 }}>
                        <AInput value={b.url} onChange={(v) => patchBlock(i, { ...b, url: v })} placeholder="https://…/photo.jpg" />
                        <AInput value={b.alt[lang]} onChange={(v) => patchBlock(i, { ...b, alt: setL(b.alt, v) })} placeholder={`${t("cms.phAlt")} (${lang})`} />
                      </div>
                    )}
                    {b.type === "faq" && (
                      <div style={{ display: "grid", gap: 8 }}>
                        <AInput value={b.question[lang]} onChange={(v) => patchBlock(i, { ...b, question: setL(b.question, v) })} placeholder={`${t("cms.phQuestion")} (${lang})`} />
                        <textarea
                          value={b.answer[lang]}
                          onChange={(e) => patchBlock(i, { ...b, answer: setL(b.answer, e.target.value) })}
                          rows={2}
                          placeholder={`${t("cms.phAnswer")} (${lang})`}
                          style={{ width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, padding: 10, resize: "vertical" }}
                        />
                      </div>
                    )}
                    {b.type === "divider" && <div style={{ borderTop: `1px dashed ${AT.rule}` }} />}
                  </div>
                ))}
              </div>
              {editable && (
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  {(Object.keys(BLOCK_FACTORY) as Array<Block["type"]>).map((bt) => (
                    <ABtn key={bt} size="sm" kind="soft" onClick={() => setEditing({ ...editing, blocks: [...editing.blocks, BLOCK_FACTORY[bt]!()] })}>
                      <AIcon name="plus" size={12} /> {t(BLOCK_KEYS[bt])}
                    </ABtn>
                  ))}
                </div>
              )}
            </div>

            {/* SEO */}
            <ACard title="SEO">
              <div style={{ display: "grid", gap: 10 }}>
                <AField label={`${t("cms.metaTitle")} (${lang})`}>
                  <AInput
                    value={editing.seo?.title[lang] ?? ""}
                    onChange={(v) =>
                      setEditing({
                        ...editing,
                        seo: {
                          title: setL(editing.seo?.title ?? emptyL(), v),
                          description: editing.seo?.description ?? emptyL(),
                        },
                      })
                    }
                  />
                </AField>
                <AField label={`${t("cms.metaDescription")} (${lang})`} hint={t("cms.metaHint")}>
                  <AInput
                    value={editing.seo?.description[lang] ?? ""}
                    onChange={(v) =>
                      setEditing({
                        ...editing,
                        seo: {
                          title: editing.seo?.title ?? emptyL(),
                          description: setL(editing.seo?.description ?? emptyL(), v),
                        },
                      })
                    }
                  />
                </AField>
              </div>
            </ACard>

            {!isNew && editing.status === "published" && (
              <div style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>
                {t("cms.liveAt")} <span style={{ fontFamily: AT.mono }}>/p/{editing.slug}</span>
              </div>
            )}
          </div>
        </ADrawer>
      )}
    </div>
  );
}
