import type { GalleryView } from "@selects/server";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api";
import { problemsIn } from "@/lib/autosave";

/** The gallery output switch, with why it is unavailable when it is. */
export function GallerySettings() {
  const [gallery, setGallery] = useState<GalleryView | undefined>();
  const [loadError, setLoadError] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | { problems: string[] }>("idle");

  const load = useCallback(async () => {
    try {
      const { data, error } = await api.gallery.get();
      if (data) setGallery(data);
      setLoadError(error !== null);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (enabled: boolean) => {
    setState("saving");
    try {
      const { data, error } = await api.gallery.put({ enabled });
      if (error) {
        setState({ problems: problemsIn(error.value) });
        return;
      }
      setGallery(data);
      setState("idle");
    } catch {
      setState({ problems: [] });
    }
  };

  return (
    <section aria-labelledby="gallery" className="flex flex-col gap-3">
      <h2 id="gallery" className="text-sm font-medium text-muted-foreground">
        Gallery
      </h2>
      {loadError && <p className="text-sm text-destructive">Can't reach the server.</p>}
      {gallery !== undefined && (
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-sm text-card-foreground">
          <label className="flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              checked={gallery.enabled && gallery.availability.available}
              disabled={state === "saving" || !gallery.availability.available}
              onChange={(event) => change(event.currentTarget.checked)}
              className="size-4 accent-primary"
            />
            Gallery output
          </label>
          <p className="text-muted-foreground">
            Each new post also writes a clean 2048 px image, with no metadata, and an entry in{" "}
            <code>posts.json</code> to the bucket, for a public gallery to read. Off, the framed image is
            deleted from the bucket once posted.
          </p>
          {gallery.availability.available ? (
            <>
              <p className="text-muted-foreground">
                Turning it off stops new posts; posts already in the gallery stay until removed on the Posted
                screen.
              </p>
              <p className="break-all text-xs text-muted-foreground">
                Manifest: <span data-testid="manifest-url">{gallery.availability.manifestUrl}</span>
              </p>
            </>
          ) : (
            <p data-testid="gallery-unavailable">Unavailable: {gallery.availability.reason}</p>
          )}
          {gallery.manifestError !== null && (
            <p className="text-destructive">
              The manifest could not be written: {gallery.manifestError} Selects tries again.
            </p>
          )}
          {typeof state === "object" && (
            <p className="text-destructive">
              {state.problems.length > 0 ? state.problems.join(" ") : "Couldn't save. Try again."}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
