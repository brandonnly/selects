import { Elysia, t } from "elysia";
import type { Gallery } from "./gallery";

const notFound = { error: "Not found" } as const;

/** The gallery switch, each post's gallery state, and "Remove from gallery". Never a bucket link. */
export function galleryRoutes({ gallery }: { gallery: Gallery }) {
  return new Elysia()
    .get("/api/gallery", () => gallery.view())
    .put(
      "/api/gallery",
      ({ body, status }) => {
        const result = gallery.setEnabled(body.enabled);
        if (!result.ok) return status(409, { problems: [result.reason] });
        return gallery.view();
      },
      { body: t.Object({ enabled: t.Boolean() }, { additionalProperties: false }) },
    )
    .delete("/api/gallery/posts/:id", ({ params, status }) => {
      switch (gallery.remove(params.id)) {
        case "removing":
          return status(202, { state: "removing" as const });
        case "not-found":
          return status(404, notFound);
        case "other-mode":
          return status(409, {
            problems: [
              "This post was made in the other mode, and its gallery files are in that mode's bucket. Remove it while Selects runs in that mode.",
            ],
          });
      }
    });
}
