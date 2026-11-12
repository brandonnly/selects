import type { ReactNode } from "react";

/** The frame every screen shares: its title, in the page and the browser tab. */
export function Screen({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-6">
      <title>{`${title} · Selects`}</title>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </section>
  );
}
