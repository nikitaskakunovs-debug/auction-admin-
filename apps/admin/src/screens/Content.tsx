import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate } from "../format.js";
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

export function ContentScreen({ nav: _nav }: { nav: Nav }) {
  const { can } = useAuth();
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
      toast(publishToggle === "published" ? "Page published" : "Page saved", "ok");
      setEditing(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed", "danger");
    }
  };

  const remove = async () => {
    if (!editing || isNew) return;
    const r = await confirm({
      title: `Delete page /${editing.slug}?`,
      body: "The page disappears from the storefront immediately. This cannot be undone.",
      danger: true,
      typeToConfirm: editing.slug,
      confirmLabel: "Delete",
    });
    if (!r.ok) return;
    try {
      await api.delete(`/api/cms/pages/${editing.id}`);
      toast("Page deleted", "ok");
      setEditing(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Delete failed", "danger");
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
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>Content</h1>
        {editable && (
          <ABtn onClick={openNew}>
            <AIcon name="plus" size={15} color="#fff" /> New page
          </ABtn>
        )}
      </div>

      <APills
        options={[
          { id: "all", label: "All", count: counts.all },
          { id: "published", label: "Published", count: counts.published },
          { id: "draft", label: "Draft", count: counts.draft },
        ]}
        value={filter}
        onChange={setFilter}
      />

      <ACard pad={false}>
        {visible.length === 0 ? (
          <AEmpty text="No pages yet." />
        ) : (
          <ATable head={["Page", "Slug", "Blocks", "Footer", "Updated", "Status"]}>
            {visible.map((p) => (
              <ATr key={p.id} onClick={() => { setIsNew(false); setLang("lv"); setEditing(p); }}>
                <ATd><span style={{ fontWeight: 600 }}>{p.title.lv || p.title.en || "(untitled)"}</span></ATd>
                <ATd mono>/{p.slug}</ATd>
                <ATd right>{p.blocks.length}</ATd>
                <ATd>{p.inFooter ? "yes" : "—"}</ATd>
                <ATd>{formatDate(p.updatedAt)}</ATd>
                <ATd><ABadge tone={p.status === "published" ? "ok" : "neutral"}>{p.status}</ABadge></ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>

      {editing && (
        <ADrawer
          width={720}
          title={isNew ? "New page" : <span>Edit <span style={{ fontFamily: AT.mono, fontSize: 13 }}>/{editing.slug}</span></span>}
          onClose={() => setEditing(null)}
          footer={
            <>
              {!isNew && editable && <ABtn kind="danger" onClick={() => void remove()}>Delete</ABtn>}
              <ABtn kind="ghost" onClick={() => setEditing(null)}>Close</ABtn>
              {editable && editing.status === "published" && !isNew && (
                <ABtn kind="soft" onClick={() => void save("draft")}>Unpublish</ABtn>
              )}
              {editable && <ABtn kind="dark" onClick={() => void save(editing.status === "published" ? undefined : "published")}>
                {editing.status === "published" ? "Save" : "Save & publish"}
              </ABtn>}
              {editable && editing.status !== "published" && (
                <ABtn onClick={() => void save()}>Save draft</ABtn>
              )}
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 110px", gap: 12 }}>
              <AField label="Slug" hint="URL: /p/<slug> on the storefront.">
                <AInput value={editing.slug} onChange={(v) => setEditing({ ...editing, slug: v.toLowerCase() })} placeholder="about" />
              </AField>
              <AField label="Position">
                <AInput value={String(editing.position)} onChange={(v) => setEditing({ ...editing, position: Number(v) || 0 })} />
              </AField>
              <AField label="In footer">
                <ABtn size="sm" kind={editing.inFooter ? "dark" : "ghost"} onClick={() => setEditing({ ...editing, inFooter: !editing.inFooter })}>
                  {editing.inFooter ? "Shown" : "Hidden"}
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
                Editing the <strong>{lang.toUpperCase()}</strong> version · LV is the storefront fallback
              </span>
            </div>

            <AField label={`Page title (${lang})`}>
              <AInput value={editing.title[lang]} onChange={(v) => setEditing({ ...editing, title: setL(editing.title, v) })} />
            </AField>

            {/* Blocks */}
            <div>
              <div style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700, color: AT.ink, marginBottom: 7 }}>Blocks</div>
              <div style={{ display: "grid", gap: 10 }}>
                {editing.blocks.map((b, i) => (
                  <div key={i} style={{ border: `1px solid ${AT.rule}`, borderRadius: AT.radiusSm, padding: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                      <ABadge tone="accent">{b.type}</ABadge>
                      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
                        <ABtn size="sm" kind="soft" onClick={() => moveBlock(i, -1)} disabled={i === 0}>↑</ABtn>
                        <ABtn size="sm" kind="soft" onClick={() => moveBlock(i, 1)} disabled={i === editing.blocks.length - 1}>↓</ABtn>
                        <ABtn size="sm" kind="soft" onClick={() => setEditing({ ...editing, blocks: editing.blocks.filter((_, j) => j !== i) })}>
                          <AIcon name="close" size={12} />
                        </ABtn>
                      </span>
                    </div>
                    {b.type === "heading" && (
                      <AInput value={b.text[lang]} onChange={(v) => patchBlock(i, { ...b, text: setL(b.text, v) })} placeholder={`Heading (${lang})`} />
                    )}
                    {b.type === "text" && (
                      <textarea
                        value={b.text[lang]}
                        onChange={(e) => patchBlock(i, { ...b, text: setL(b.text, e.target.value) })}
                        rows={3}
                        placeholder={`Paragraph (${lang})`}
                        style={{ width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, padding: 10, resize: "vertical" }}
                      />
                    )}
                    {b.type === "image" && (
                      <div style={{ display: "grid", gap: 8 }}>
                        <AInput value={b.url} onChange={(v) => patchBlock(i, { ...b, url: v })} placeholder="https://…/photo.jpg" />
                        <AInput value={b.alt[lang]} onChange={(v) => patchBlock(i, { ...b, alt: setL(b.alt, v) })} placeholder={`Alt text (${lang})`} />
                      </div>
                    )}
                    {b.type === "faq" && (
                      <div style={{ display: "grid", gap: 8 }}>
                        <AInput value={b.question[lang]} onChange={(v) => patchBlock(i, { ...b, question: setL(b.question, v) })} placeholder={`Question (${lang})`} />
                        <textarea
                          value={b.answer[lang]}
                          onChange={(e) => patchBlock(i, { ...b, answer: setL(b.answer, e.target.value) })}
                          rows={2}
                          placeholder={`Answer (${lang})`}
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
                  {Object.keys(BLOCK_FACTORY).map((t) => (
                    <ABtn key={t} size="sm" kind="soft" onClick={() => setEditing({ ...editing, blocks: [...editing.blocks, BLOCK_FACTORY[t]!()] })}>
                      <AIcon name="plus" size={12} /> {t}
                    </ABtn>
                  ))}
                </div>
              )}
            </div>

            {/* SEO */}
            <ACard title="SEO">
              <div style={{ display: "grid", gap: 10 }}>
                <AField label={`Meta title (${lang})`}>
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
                <AField label={`Meta description (${lang})`} hint="~155 characters for search snippets.">
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
                Live at <span style={{ fontFamily: AT.mono }}>/p/{editing.slug}</span> on the storefront.
              </div>
            )}
          </div>
        </ADrawer>
      )}
    </div>
  );
}
