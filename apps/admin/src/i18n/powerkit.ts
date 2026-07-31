import type { Entry } from "./types.js";

/** A3 power-list kit: saved views, filter chips, bulk bar, export menu. */
export const POWERKIT = {
  // ── Saved views ────────────────────────────────────────────────────────────
  "pk.views": { lv: "Skati", ru: "Виды", en: "Views" },
  "pk.view": { lv: "Skats", ru: "Вид", en: "View" },
  "pk.segment": { lv: "Segments", ru: "Сегмент", en: "Segment" },
  "pk.saveView": { lv: "+ Saglabāt pašreizējo kā skatu", ru: "+ Сохранить текущее как вид", en: "+ Save current as view" },
  "pk.update": { lv: "Atjaunot", ru: "Обновить", en: "Update" },
  "pk.rename": { lv: "Pārsaukt", ru: "Переименовать", en: "Rename" },
  "pk.promptName": { lv: "Nosaukums:", ru: "Название:", en: "Name:" },
  "pk.promptRename": { lv: "Jauns nosaukums:", ru: "Новое название:", en: "New name:" },
  "pk.savedWord": { lv: "saglabāts", ru: "сохранён", en: "saved" },
  "pk.saveFailed": { lv: "Neizdevās saglabāt", ru: "Не удалось сохранить", en: "Couldn't save" },
  "pk.renamed": { lv: "Pārsaukts", ru: "Переименовано", en: "Renamed" },
  "pk.renameFailed": { lv: "Neizdevās pārsaukt", ru: "Не удалось переименовать", en: "Rename failed" },
  "pk.updatedToFilters": { lv: "atjaunots ar pašreizējiem filtriem", ru: "обновлён по текущим фильтрам", en: "updated to current filters" },
  "pk.updateFailed": { lv: "Neizdevās atjaunot", ru: "Не удалось обновить", en: "Update failed" },
  "pk.deleteView": { lv: "Dzēst skatu", ru: "Удалить вид", en: "Delete view" },
  "pk.deleteSegment": { lv: "Dzēst segmentu", ru: "Удалить сегмент", en: "Delete segment" },
  "pk.deleteViewBody": { lv: "Tiek dzēsts tikai saglabātais filtru komplekts — ieraksti netiek skarti.", ru: "Удаляется только сохранённый набор фильтров — записи не затрагиваются.", en: "Only the saved filter preset is removed — no records are touched." },
  "pk.deleted": { lv: "Dzēsts", ru: "Удалено", en: "Deleted" },
  "pk.deleteFailed": { lv: "Neizdevās dzēst", ru: "Не удалось удалить", en: "Delete failed" },

  // ── Filter chips / search box ──────────────────────────────────────────────
  "pk.clearAll": { lv: "Notīrīt visus", ru: "Сбросить все", en: "Clear all" },
  "pk.removeFilter": { lv: "Noņemt filtru", ru: "Убрать фильтр", en: "Remove filter" },
  "pk.searchPlaceholder": { lv: "Meklēt…", ru: "Поиск…", en: "Search…" },

  // ── Bulk bar / export menu ─────────────────────────────────────────────────
  "pk.selected": { lv: "atlasīti", ru: "выбрано", en: "selected" },
  "pk.clear": { lv: "Notīrīt", ru: "Сбросить", en: "Clear" },
  "pk.download": { lv: "Lejupielādēt", ru: "Скачать", en: "Download" },
  "pk.scopeSelected": { lv: "atlasītos", ru: "выбранных", en: "selected" },
  "pk.rows": { lv: "rindas", ru: "строк", en: "rows" },
} satisfies Record<string, Entry>;
