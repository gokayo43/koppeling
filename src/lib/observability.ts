import * as Sentry from "@sentry/tanstackstart-react";
import posthog from "posthog-js";

/**
 * Both integrations are opt-in by environment: with the keys unset nothing is
 * initialised and nothing is sent, so a local checkout and a CI run reach no
 * third party. Called from the client entry.
 */
export function initObservability(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (dsn !== undefined) {
    Sentry.init({ dsn, tracesSampleRate: 0.1 });
  }

  const posthogKey = import.meta.env.VITE_POSTHOG_KEY;
  if (posthogKey !== undefined) {
    posthog.init(posthogKey, {
      api_host: import.meta.env.VITE_POSTHOG_HOST ?? "https://eu.i.posthog.com",
      capture_pageview: "history_change",
    });
  }
}
