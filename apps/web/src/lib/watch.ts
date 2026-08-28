"use client";

import { publicApi } from "./api";

/**
 * Вэлмес — отслеживаемые лоты.
 *
 * Читается всегда из localStorage: сердечко обязано закраситься в тот же кадр,
 * без ожидания сети. Для вошедшего человека этот же список живёт в базе и
 * подтягивается при входе — сердечко, поставленное с телефона, находится потом
 * и в ноутбуке. Гость копит список локально; при первом входе список переезжает
 * в базу, ничего там не затирая, и дальше источником правды становится сервер.
 */
const KEY = "izsoli_watch_v1";
/** Чей локальный список уже перенесён в базу: слияние делается один раз. */
const MERGED = "izsoli_watch_merged_v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Fn = () => void;
const listeners = new Set<Fn>();

function read(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && UUID.test(x)) : [];
  } catch {
    return [];
  }
}

function write(ids: string[]): void {
  localStorage.setItem(KEY, JSON.stringify(ids));
  listeners.forEach((f) => f());
}

/** Забрать список из базы, влив туда локальный при первом входе. */
async function pull(owner: string): Promise<void> {
  const local = read();
  const merged = localStorage.getItem(MERGED);
  try {
    const r =
      merged !== owner && local.length > 0
        ? await publicApi.post<{ ids: string[] }>("/api/public/me/watchlist", { ids: local })
        : await publicApi.get<{ ids: string[] }>("/api/public/me/watchlist");
    localStorage.setItem(MERGED, owner);
    write(r.ids);
  } catch {
    // Сеть отвалилась — остаёмся на локальном списке. Следующий вход
    // (или следующая правка) синхронизирует снова.
  }
}

/** Вход и выход: список принадлежит аккаунту, а не браузеру. */
let owner: string | null = null;
function onSession(): void {
  const next = publicApi.bidderId;
  if (next === owner) return;
  owner = next;
  if (next === null) {
    // Чужой список не должен достаться следующему, кто сядет за этот браузер.
    localStorage.removeItem(KEY);
    localStorage.removeItem(MERGED);
    listeners.forEach((f) => f());
    return;
  }
  void pull(next);
}

if (typeof window !== "undefined") {
  publicApi.listeners.add(onSession);
  onSession();
}

export const watchStore = {
  has(id: string) {
    return read().includes(id);
  },
  list() {
    return read();
  },
  toggle(id: string) {
    const cur = read();
    const adding = !cur.includes(id);
    // Экран меняется сразу, сервер догоняет: сердечко не должно мигать
    // в такт задержкам сети.
    write(adding ? [...cur, id] : cur.filter((x) => x !== id));
    if (publicApi.hasSession) {
      const p = adding
        ? publicApi.post(`/api/public/me/watchlist/${id}`)
        : publicApi.request("DELETE", `/api/public/me/watchlist/${id}`);
      void p.catch(() => {});
    }
    // Аналитика (GTM): в вэлмес добавили — снятие никого не интересует.
    if (adding) void import("./track").then((m) => m.track("add_to_wishlist", { item_id: id }));
  },
  subscribe(fn: Fn) {
    listeners.add(fn);
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) fn();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  },
};
