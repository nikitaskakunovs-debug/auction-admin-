import type { Entry } from "./types.js";

/** Filled by the Phase D translation pass — one module per screen area. */
export const CONTENT = {
  // ── Heading / list ─────────────────────────────────────────────────────────
  "cms.title": { lv: "Saturs", ru: "Контент", en: "Content" },
  "cms.newPage": { lv: "Jauna lapa", ru: "Новая страница", en: "New page" },
  "cms.published": { lv: "Publicētas", ru: "Опубликованные", en: "Published" },
  "cms.draft": { lv: "Melnraksti", ru: "Черновики", en: "Draft" },
  "cms.st.published": { lv: "publicēta", ru: "опубликована", en: "published" },
  "cms.st.draft": { lv: "melnraksts", ru: "черновик", en: "draft" },
  "cms.noPages": { lv: "Vēl nav nevienas lapas.", ru: "Пока нет страниц.", en: "No pages yet." },
  "cms.thPage": { lv: "Lapa", ru: "Страница", en: "Page" },
  "cms.thSlug": { lv: "Adrese", ru: "Адрес", en: "Slug" },
  "cms.thBlocks": { lv: "Bloki", ru: "Блоки", en: "Blocks" },
  "cms.thFooter": { lv: "Kājenē", ru: "В подвале", en: "Footer" },
  "cms.thUpdated": { lv: "Atjaunināta", ru: "Обновлена", en: "Updated" },
  "cms.untitled": { lv: "(bez nosaukuma)", ru: "(без названия)", en: "(untitled)" },
  "cms.yes": { lv: "jā", ru: "да", en: "yes" },

  // ── Editor drawer ──────────────────────────────────────────────────────────
  "cms.editPage": { lv: "Labot", ru: "Правка", en: "Edit" },
  "cms.unpublish": { lv: "Atpublicēt", ru: "Снять с публикации", en: "Unpublish" },
  "cms.savePublish": { lv: "Saglabāt un publicēt", ru: "Сохранить и опубликовать", en: "Save & publish" },
  "cms.saveDraft": { lv: "Saglabāt melnrakstu", ru: "Сохранить черновик", en: "Save draft" },
  "cms.slug": { lv: "Adrese (slug)", ru: "Адрес (slug)", en: "Slug" },
  "cms.slugHint": { lv: "URL veikalā: /p/<slug>.", ru: "URL на витрине: /p/<slug>.", en: "URL: /p/<slug> on the storefront." },
  "cms.position": { lv: "Pozīcija", ru: "Позиция", en: "Position" },
  "cms.inFooter": { lv: "Kājenē", ru: "В подвале", en: "In footer" },
  "cms.shown": { lv: "Redzama", ru: "Показана", en: "Shown" },
  "cms.hidden": { lv: "Paslēpta", ru: "Скрыта", en: "Hidden" },
  "cms.editingA": { lv: "Labojat", ru: "Редактируете версию", en: "Editing the" },
  "cms.editingB": { lv: " versiju · LV ir veikala rezerves valoda", ru: " · LV — резервный язык витрины", en: " version · LV is the storefront fallback" },
  "cms.pageTitle": { lv: "Lapas nosaukums", ru: "Название страницы", en: "Page title" },
  "cms.blocks": { lv: "Bloki", ru: "Блоки", en: "Blocks" },

  // ── Block types ────────────────────────────────────────────────────────────
  "cms.b.heading": { lv: "Virsraksts", ru: "Заголовок", en: "Heading" },
  "cms.b.text": { lv: "Teksts", ru: "Текст", en: "Text" },
  "cms.b.image": { lv: "Attēls", ru: "Изображение", en: "Image" },
  "cms.b.faq": { lv: "BUJ", ru: "Вопрос-ответ", en: "FAQ" },
  "cms.b.divider": { lv: "Atdalītājs", ru: "Разделитель", en: "Divider" },
  "cms.phAlt": { lv: "Alt teksts", ru: "Альт-текст", en: "Alt text" },
  "cms.phQuestion": { lv: "Jautājums", ru: "Вопрос", en: "Question" },
  "cms.phAnswer": { lv: "Atbilde", ru: "Ответ", en: "Answer" },

  // ── SEO ────────────────────────────────────────────────────────────────────
  "cms.metaTitle": { lv: "Meta virsraksts", ru: "Мета-заголовок", en: "Meta title" },
  "cms.metaDescription": { lv: "Meta apraksts", ru: "Мета-описание", en: "Meta description" },
  "cms.metaHint": { lv: "~155 zīmes meklētāju fragmentiem.", ru: "~155 знаков для сниппетов в поиске.", en: "~155 characters for search snippets." },

  // ── Delete / toasts / footer note ──────────────────────────────────────────
  "cms.deletePage": { lv: "Dzēst lapu", ru: "Удалить страницу", en: "Delete page" },
  "cms.deleteBody": { lv: "Lapa uzreiz pazudīs no veikala. To nevar atsaukt.", ru: "Страница сразу исчезнет с витрины. Это нельзя отменить.", en: "The page disappears from the storefront immediately. This cannot be undone." },
  "cms.pagePublished": { lv: "Lapa publicēta", ru: "Страница опубликована", en: "Page published" },
  "cms.pageSaved": { lv: "Lapa saglabāta", ru: "Страница сохранена", en: "Page saved" },
  "cms.pageDeleted": { lv: "Lapa dzēsta", ru: "Страница удалена", en: "Page deleted" },
  "cms.saveFailed": { lv: "Saglabāšana neizdevās", ru: "Не удалось сохранить", en: "Save failed" },
  "cms.deleteFailed": { lv: "Dzēšana neizdevās", ru: "Не удалось удалить", en: "Delete failed" },
  "cms.liveAt": { lv: "Veikalā pieejama:", ru: "Доступна на витрине:", en: "Live on the storefront at" },
} satisfies Record<string, Entry>;
