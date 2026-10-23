import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Rocket } from "lucide-react";
import type { ReactNode } from "react";

import { api } from "~/lib/api-client.ts";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home(): ReactNode {
  // Proves the whole chain end to end: Query drives an Eden call whose response
  // type comes from the API program's own source.
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const { data, error } = await api.health.get();
      if (error !== null) throw new Error(`api health: ${String(error.status)}`);
      return data;
    },
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 p-8">
      <h1 className="flex items-center gap-3 text-3xl font-semibold tracking-tight">
        <Rocket className="size-7" aria-hidden />
        project-template
      </h1>
      <p className="text-muted-foreground">
        API status: {health.isPending ? "checking…" : (health.data?.status ?? "unreachable")}
      </p>
    </main>
  );
}
