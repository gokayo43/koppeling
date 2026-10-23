import { createFileRoute } from "@tanstack/react-router";
import { Rocket } from "lucide-react";
import type { ReactNode } from "react";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home(): ReactNode {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 p-8">
      <h1 className="flex items-center gap-3 text-3xl font-semibold tracking-tight">
        <Rocket className="size-7" aria-hidden />
        project-template
      </h1>
      <p className="text-muted-foreground">
        The scaffold is up. Health lives at <code>/api/health</code>.
      </p>
    </main>
  );
}
