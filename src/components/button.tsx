import { useRender } from "@base-ui/react/use-render";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/cn.ts";

type Variant = "solid" | "ghost";

const VARIANTS = {
  solid: "bg-neutral-900 text-white hover:bg-neutral-700",
  ghost: "text-neutral-900 hover:bg-neutral-100",
} satisfies Record<Variant, string>;

interface ButtonProps extends ComponentProps<"button"> {
  variant?: Variant;
  /** Renders the styling onto a caller-supplied element instead of a <button>. */
  render?: useRender.RenderProp;
}

export function Button({ variant = "solid", className, render, ...props }: ButtonProps): ReactNode {
  return useRender({
    defaultTagName: "button",
    render,
    props: {
      ...props,
      className: cn(
        "inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium",
        "transition-colors focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        className,
      ),
    },
  });
}
