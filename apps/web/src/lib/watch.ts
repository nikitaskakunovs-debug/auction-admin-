/** Список отслеживаемых лотов. В API такого эндпоинта нет, поэтому храним
 *  локально; все карточки на странице слушают один источник и обновляются
 *  вместе. Когда в движке появится вотчлист — меняется только это место. */
const KEY = "izsoli_watch_v1";
type Fn = () => void;
const listeners = new Set<Fn>();

function read(): string[] {
  if (typeof localStorage === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]; }
  catch { return []; }
}

export const watchStore = {
  has(id: string) { return read().includes(id); },
  list() { return read(); },
  toggle(id: string) {
    const cur = read();
    const adding = !cur.includes(id);
    const next = adding ? [...cur, id] : cur.filter((x) => x !== id);
    localStorage.setItem(KEY, JSON.stringify(next));
    listeners.forEach((f) => f());
    // Аналитика (GTM): в вёлмes добавили — снятие никого не интересует.
    if (adding) void import("./track").then((m) => m.track("add_to_wishlist", { item_id: id }));
  },
  subscribe(fn: Fn) {
    listeners.add(fn);
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) fn(); };
    window.addEventListener("storage", onStorage);
    return () => { listeners.delete(fn); window.removeEventListener("storage", onStorage); };
  },
};
