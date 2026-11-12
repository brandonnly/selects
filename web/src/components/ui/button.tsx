import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const variants = {
  /** The main action on a screen: ink in light, paper in dark. */
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  outline: "border bg-card text-card-foreground hover:bg-accent hover:text-accent-foreground",
  ghost: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
  /** Text and outline only, always with a word: see brand/tokens/README.md. */
  destructive: "border border-destructive text-destructive hover:bg-destructive/10",
} as const;

const sizes = {
  default: "h-10 px-4",
  sm: "h-9 px-3",
} as const;

export function Button({
  variant = "default",
  size = "default",
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: keyof typeof variants; size?: keyof typeof sizes }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
