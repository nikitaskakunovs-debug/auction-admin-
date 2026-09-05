import { NextResponse, type NextRequest } from "next/server";

/**
 * Партнёрский поддомен (partner.izsoli.lv) отдаёт ТОЛЬКО кабинет поставщика.
 * Любой другой адрес там уводит на вход: витрина с каталогом на этом имени не
 * нужна, а два одинаковых магазина на разных доменах ещё и вредят поиску.
 *
 * Кабинет продолжает работать и на основном домене по /piegadatajs — ссылки
 * из уже отправленных писем не ломаются.
 */
export function middleware(req: NextRequest) {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (!host.startsWith("partner.")) return NextResponse.next();
  const path = req.nextUrl.pathname;
  // Статика и служебные пути Next обязаны проходить как есть.
  if (path.startsWith("/piegadatajs") || path.startsWith("/_next") || path.startsWith("/api") || /\.[a-z0-9]+$/i.test(path)) {
    return NextResponse.next();
  }
  // Адрес собираем из заголовка Host, а не из req.url: за прокси там стоит
  // внутренний адрес контейнера, и редирект уводил бы с partner.* обратно
  // на основной домен.
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return NextResponse.redirect(`${proto}://${host}/piegadatajs`, 307);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
