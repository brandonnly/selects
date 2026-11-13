import type { GalleryPost, GalleryView } from "@selects/server";

/** A post's gallery state in words, and whether "Remove from gallery" applies to it now. */
export function describeGallery(
  post: Pick<GalleryPost, "state" | "error"> & Partial<Pick<GalleryPost, "mode">>,
  mode: GalleryPost["mode"],
): { label: string; detail: string | null; removable: boolean } {
  const otherMode = post.mode !== undefined && post.mode !== mode;
  const elsewhere = otherMode
    ? `Its gallery files are in the ${post.mode} mode bucket: remove it while Selects runs in ${post.mode} mode.`
    : null;
  const retried = post.error === null ? null : `${post.error} Selects tries again.`;
  switch (post.state) {
    case "listed":
      return { label: "In the gallery", detail: elsewhere, removable: !otherMode };
    case "writing":
      return { label: "Writing to the gallery…", detail: elsewhere ?? retried, removable: !otherMode };
    case "removing":
      return { label: "Removing from the gallery…", detail: elsewhere ?? retried, removable: false };
    case "removed":
      return { label: "Removed from the gallery", detail: null, removable: false };
  }
}

/**
 * The gallery switch as Settings shows it. A saved "on" shows as on even while gallery output is
 * unavailable, and can be turned off then: it never comes back on by surprise when a public
 * base URL returns. It cannot be turned on while unavailable.
 */
export function gallerySwitch(view: Pick<GalleryView, "enabled" | "availability">): {
  checked: boolean;
  disabled: boolean;
} {
  return { checked: view.enabled, disabled: !view.enabled && !view.availability.available };
}

/**
 * How soon the Posted screen checks again: soon while a write or removal is under way, since it
 * finishes in seconds; later while one is retried after a failure; not at all once all settled.
 */
export function galleryPolling(posts: Pick<GalleryPost, "state" | "error">[]): "soon" | "later" | undefined {
  const busy = posts.filter((post) => post.state === "writing" || post.state === "removing");
  if (busy.some((post) => post.error === null)) return "soon";
  return busy.length > 0 ? "later" : undefined;
}
