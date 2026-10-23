/// <reference types="vite/client" />

// Vite's own ImportMetaEnv is an index signature, which `noPropertyAccessFromIndexSignature`
// makes unreadable with dot access. Declaring the keys here types them instead.
interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_POSTHOG_KEY?: string;
  readonly VITE_POSTHOG_HOST?: string;
}
