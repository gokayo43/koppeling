import { StartClient } from "@tanstack/react-start/client";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

import { initObservability } from "~/lib/observability.ts";

// Replaces the Start plugin's default client entry. It exists for this one line:
// telemetry has to be initialised before hydration so the first paint is
// instrumented too.
initObservability();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});
