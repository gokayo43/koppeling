import { useForm } from "@tanstack/react-form";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { LogIn } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "~/components/button.tsx";
import { authClient } from "~/lib/auth-client.ts";

export const Route = createFileRoute("/login")({
  component: Login,
});

const Credentials = z.object({
  email: z.email(),
  password: z.string().min(8, "at least 8 characters"),
});

function Login(): ReactNode {
  const router = useRouter();
  const form = useForm({
    defaultValues: { email: "", password: "" },
    validators: { onSubmit: Credentials },
    onSubmit: async ({ value }) => {
      const { error } = await authClient.signIn.email(value);
      if (error) {
        toast.error(error.message ?? "Sign-in failed");
        return;
      }
      await router.navigate({ to: "/" });
    },
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-8">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <LogIn className="size-5" aria-hidden />
        Sign in
      </h1>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="email">
          {(field) => (
            <label className="flex flex-col gap-1 text-sm">
              Email
              <input
                type="email"
                autoComplete="username"
                className="h-9 rounded-md border border-neutral-300 px-3"
                value={field.state.value}
                onChange={(event) => {
                  field.handleChange(event.target.value);
                }}
              />
              <FieldError messages={field.state.meta.errors} />
            </label>
          )}
        </form.Field>

        <form.Field name="password">
          {(field) => (
            <label className="flex flex-col gap-1 text-sm">
              Password
              <input
                type="password"
                autoComplete="current-password"
                className="h-9 rounded-md border border-neutral-300 px-3"
                value={field.state.value}
                onChange={(event) => {
                  field.handleChange(event.target.value);
                }}
              />
              <FieldError messages={field.state.meta.errors} />
            </label>
          )}
        </form.Field>

        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Signing in…" : "Sign in"}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </main>
  );
}

function FieldError({
  messages,
}: {
  messages: Array<{ message?: string } | undefined>;
}): ReactNode {
  const first = messages.find((message) => message?.message !== undefined);
  if (first === undefined) return null;
  return <span className="text-xs text-red-600">{first.message}</span>;
}
