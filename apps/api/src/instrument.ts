import * as Sentry from "@sentry/node";

/**
 * Sentry error monitoring for the API. Imported as the VERY FIRST thing in
 * index.ts so the SDK can auto-instrument the runtime before other modules
 * load. A pure no-op unless SENTRY_DSN is set — so dev and the whole test
 * suite never touch Sentry. Errors only (tracesSampleRate 0 = no perf
 * sampling overhead).
 */
const dsn = process.env.SENTRY_DSN;

/**
 * Вебхук почты аутентифицируется секретом в самом адресе, а адрес Sentry
 * прикладывает к событию. Вырезаем: секрет не должен уезжать к чужому
 * сервису из-за случайной ошибки на этом маршруте.
 */
const HOOK_PATH = /(\/api\/public\/email\/hook\/)[^/?#]+/g;
export function scrubSecrets(url: string): string {
  return url.replace(HOOK_PATH, "$1[redacted]");
}

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production",
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: 0,
    beforeSend(event) {
      if (event.request?.url) event.request.url = scrubSecrets(event.request.url);
      for (const crumb of event.breadcrumbs ?? []) {
        if (typeof crumb.data?.url === "string") crumb.data.url = scrubSecrets(crumb.data.url);
      }
      return event;
    },
  });
}

export const sentryEnabled = Boolean(dsn);
