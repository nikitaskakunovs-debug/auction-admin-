import { CATEGORIES } from "@auction/domain/categories";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { formatDate } from "../format.js";
import { useT } from "../i18n.js";
import { useAuth } from "../auth.js";
import { AT } from "../theme.js";
import {
  ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AInput, ASelect, ATable, ATd, ATr, useConfirm, useToast,
} from "../ui.js";

interface Ad {
  id: string;
  advertiser: string;
  title: string;
  body: string;
  ctaLabel: string;
  href: string;
  imageUrl: string | null;
  theme: string;
  categoryCode: string | null;
  everyN: number;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  impressions: number;
  createdAt: string;
}

interface Form {
  advertiser: string; title: string; body: string; ctaLabel: string; href: string;
  imageUrl: string; theme: string; categoryCode: string; everyN: string;
  active: boolean; startsAt: string; endsAt: string;
}

const empty: Form = {
  advertiser: "", title: "", body: "", ctaLabel: "", href: "", imageUrl: "",
  theme: "green", categoryCode: "", everyN: "12", active: false, startsAt: "", endsAt: "",
};

const THEMES = ["green", "blue", "pink", "yellow"];

const dayInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/**
 * Реклама в ленте лотов.
 *
 * Место продаётся рекламодателю: человек листает каталог и встречает карточку
 * среди лотов. Плотность задаётся для каждой категории отдельно — полем «через
 * сколько карточек», а не одной настройкой на весь сайт.
 */
export function AdsScreen() {
  const { t } = useT();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [ads, setAds] = useState<Ad[]>([]);
  const [editing, setEditing] = useState<Ad | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Form>(empty);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const load = useCallback(() => {
    void api.get<{ ads: Ad[] }>("/api/ads").then((r) => setAds(r.ads)).catch(() => toast(t("ads.loadFailed"), "danger"));
  }, [t, toast]);

  useEffect(load, [load]);

  const openNew = () => { setForm(empty); setEditing(null); setCreating(true); };
  const openEdit = (a: Ad) => {
    setForm({
      advertiser: a.advertiser, title: a.title, body: a.body, ctaLabel: a.ctaLabel, href: a.href,
      imageUrl: a.imageUrl ?? "", theme: a.theme, categoryCode: a.categoryCode ?? "",
      everyN: String(a.everyN), active: a.active,
      startsAt: dayInput(a.startsAt), endsAt: dayInput(a.endsAt),
    });
    setEditing(a);
    setCreating(false);
  };
  const close = () => { setCreating(false); setEditing(null); };

  const save = async () => {
    const n = Number(form.everyN);
    if (!form.title.trim() || !form.href.trim()) { toast(t("ads.needTitleHref"), "warn"); return; }
    if (!Number.isFinite(n) || n < 3 || n > 200) { toast(t("ads.badEveryN"), "warn"); return; }
    setBusy(true);
    const body = {
      advertiser: form.advertiser, title: form.title, body: form.body, ctaLabel: form.ctaLabel,
      href: form.href, imageUrl: form.imageUrl || null, theme: form.theme,
      categoryCode: form.categoryCode || null, everyN: n, active: form.active,
      startsAt: form.startsAt ? new Date(`${form.startsAt}T00:00:00Z`).toISOString() : null,
      endsAt: form.endsAt ? new Date(`${form.endsAt}T23:59:59Z`).toISOString() : null,
    };
    try {
      if (editing) await api.patch(`/api/ads/${editing.id}`, body);
      else await api.post("/api/ads", body);
      toast(t("c.saved"), "ok");
      close();
      load();
    } catch { toast(t("ads.saveFailed"), "danger"); }
    finally { setBusy(false); }
  };

  const remove = async (a: Ad) => {
    if (!(await confirm({ title: t("ads.deleteQ"), body: a.title, danger: true }))) return;
    try { await api.delete(`/api/ads/${a.id}`); toast(t("c.deleted"), "ok"); close(); load(); }
    catch { toast(t("ads.deleteFailed"), "danger"); }
  };

  const catLabel = (code: string | null) =>
    code ? CATEGORIES.find((c) => c.code === code)?.label ?? code : t("ads.allCats");

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink, flex: 1 }}>{t("ads.title")}</h1>
        {can("content.edit") && <ABtn onClick={openNew}>{t("ads.new")}</ABtn>}
      </div>

      <p style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft, margin: 0, maxWidth: "70ch" }}>
        {t("ads.intro")}
      </p>

      <ACard>
        {ads.length === 0 ? (
          <AEmpty text={t("ads.empty")} />
        ) : (
          <ATable head={[t("ads.th.title"), t("ads.th.advertiser"), t("ads.th.category"), t("ads.th.every"), t("ads.th.shown"), t("ads.th.period"), t("c.status")]}>
            {ads.map((a) => (
              <ATr key={a.id} onClick={() => openEdit(a)}>
                <ATd><strong style={{ fontWeight: 600 }}>{a.title}</strong></ATd>
                <ATd>{a.advertiser || <span style={{ color: AT.inkSoft }}>—</span>}</ATd>
                <ATd>{catLabel(a.categoryCode)}</ATd>
                <ATd mono right>{a.everyN}</ATd>
                <ATd mono right>{a.impressions}</ATd>
                <ATd>
                  {a.startsAt || a.endsAt
                    ? `${a.startsAt ? formatDate(a.startsAt).slice(0, 10) : "…"} — ${a.endsAt ? formatDate(a.endsAt).slice(0, 10) : "…"}`
                    : <span style={{ color: AT.inkSoft }}>{t("ads.always")}</span>}
                </ATd>
                <ATd>{a.active ? <ABadge tone="ok">{t("ads.on")}</ABadge> : <ABadge tone="neutral">{t("ads.off")}</ABadge>}</ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>

      {(creating || editing) && (
        <ADrawer
          title={editing ? t("ads.edit") : t("ads.new")}
          onClose={close}
          footer={
            <>
              {editing && can("content.edit") && <ABtn kind="danger" onClick={() => void remove(editing)}>{t("c.delete")}</ABtn>}
              <ABtn kind="ghost" onClick={close}>{t("c.close")}</ABtn>
              {can("content.edit") && <ABtn disabled={busy} onClick={() => void save()}>{t("c.save")}</ABtn>}
            </>
          }
        >
          <div style={{ display: "grid", gap: 12 }}>
            <AField label={t("ads.f.title")}><AInput value={form.title} onChange={(v) => set({ title: v })} /></AField>
            <AField label={t("ads.f.body")}><AInput value={form.body} onChange={(v) => set({ body: v })} /></AField>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12 }}>
              <AField label={t("ads.f.cta")}><AInput value={form.ctaLabel} onChange={(v) => set({ ctaLabel: v })} /></AField>
              <AField label={t("ads.f.advertiser")}><AInput value={form.advertiser} onChange={(v) => set({ advertiser: v })} /></AField>
            </div>
            <AField label={t("ads.f.href")} hint={t("ads.f.hrefHint")}>
              <AInput value={form.href} onChange={(v) => set({ href: v })} placeholder="https://" />
            </AField>
            <AField label={t("ads.f.image")} hint={t("ads.f.imageHint")}>
              <AInput value={form.imageUrl} onChange={(v) => set({ imageUrl: v })} placeholder="https://" />
            </AField>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12 }}>
              <AField label={t("ads.f.category")} hint={t("ads.f.categoryHint")}>
                <ASelect
                  value={form.categoryCode}
                  onChange={(v) => set({ categoryCode: v })}
                  options={[{ value: "", label: t("ads.allCats") }, ...CATEGORIES.map((c) => ({ value: c.code, label: c.label }))]}
                />
              </AField>
              <AField label={t("ads.f.every")} hint={t("ads.f.everyHint")}>
                <AInput value={form.everyN} onChange={(v) => set({ everyN: v })} />
              </AField>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12 }}>
              <AField label={t("ads.f.theme")}>
                <ASelect value={form.theme} onChange={(v) => set({ theme: v })}
                         options={THEMES.map((x) => ({ value: x, label: x }))} />
              </AField>
              <AField label={t("c.status")}>
                <ASelect value={form.active ? "on" : "off"} onChange={(v) => set({ active: v === "on" })}
                         options={[{ value: "off", label: t("ads.off") }, { value: "on", label: t("ads.on") }]} />
              </AField>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12 }}>
              <AField label={t("ads.f.from")}>
                <input type="date" value={form.startsAt} onChange={(e) => set({ startsAt: e.target.value })}
                       style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${AT.rule}`, fontFamily: AT.body }} />
              </AField>
              <AField label={t("ads.f.to")}>
                <input type="date" value={form.endsAt} onChange={(e) => set({ endsAt: e.target.value })}
                       style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${AT.rule}`, fontFamily: AT.body }} />
              </AField>
            </div>
            {editing && (
              <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, margin: 0 }}>
                {t("ads.shownTimes")}: <strong>{editing.impressions}</strong>
              </p>
            )}
          </div>
        </ADrawer>
      )}
    </div>
  );
}
