/**
 * Phase E evidence ring buffer. Keeps the last 50 console warnings/errors and
 * failed API calls in memory — nothing leaves the browser until the user
 * presses "Send to IT" in the report modal.
 */

const MAX_LINES = 50;
const MAX_LINE_CHARS = 500;

const buffer: string[] = [];

function push(kind: string, text: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  buffer.push(`${stamp} ${kind} ${text}`.slice(0, MAX_LINE_CHARS));
  if (buffer.length > MAX_LINES) buffer.shift();
}

const fmt = (args: unknown[]): string =>
  args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");

let installed = false;

/** Call once at app boot (main.tsx). */
export function initBugCapture(): void {
  if (installed) return;
  installed = true;

  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(level.toUpperCase(), fmt(args));
      original(...args);
    };
  }
  window.addEventListener("error", (e) => push("UNCAUGHT", e.message));
  window.addEventListener("unhandledrejection", (e) => push("REJECTION", fmt([e.reason])));
}

/** Called by the API client whenever a request fails. */
export function recordApiFailure(method: string, url: string, status: number, error: string): void {
  push("API", `${method} ${url} → ${status} ${error}`);
}

/** Snapshot for the report payload. */
export function consoleTail(): string[] {
  return [...buffer];
}
