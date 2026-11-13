import type { GalleryPost } from "@selects/server";

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
