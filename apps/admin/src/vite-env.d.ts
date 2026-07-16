/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sentry DSN, inlined at build time. Empty in dev → monitoring off. */
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_RELEASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
