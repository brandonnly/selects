import type { Select } from "@selects/server";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "@/api";
import { PostNow } from "@/components/post-now";
import { SelectCaption } from "@/components/select-caption";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CaptureEditor } from "./capture-editor";

/** The frame preview's width: sharp in the dialog, quick to render. */
const PREVIEW_WIDTH = 720;

/**
 * A select in a dialog: its frame as it would post, then one section per thing to change about
 * it, and a way to delete it. A new per-select editor is one more `DetailsSection`.
 */
export function SelectDetails({
  select,
  onClose,
  onDeleted,
  onChanged,
}: {
  select: Select | undefined;
  onClose: () => void;
  onDeleted: () => void;
  /** Called when something about the select was saved. */
  onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(false);
  /** Bumped by each save, so the frame preview renders again. */
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (select !== undefined && !element.open) element.showModal();
    if (select === undefined && element.open) element.close();
    setConfirming(false);
    setError(false);
  }, [select]);

  // The select on show now, so an answer that arrives after the dialog moved on is ignored.
  const shown = useRef(select?.id);
  shown.current = select?.id;

  const remove = async () => {
    if (select === undefined) return;
    const { id } = select;
    setDeleting(true);
    // A request that throws counts as failed, so the dialog never stays on "Deleting".
    const failed = await api
      .selects({ id })
      .delete()
      .then(({ error }) => error)
      .catch(() => ({ status: 0 }))
      .finally(() => setDeleting(false));
    if (shown.current !== id) return;
    // A 404 means it was deleted elsewhere in the meantime, which is the same outcome.
    if (!failed || failed.status === 404) onDeleted();
    else setError(true);
  };

  const changed = () => {
    setVersion((n) => n + 1);
    onChanged();
  };

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="select-details-title"
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-lg border bg-card p-0 text-card-foreground backdrop:bg-background/80 md:max-w-4xl"
    >
      {select !== undefined && (
        <div className="flex max-h-[calc(100dvh-4rem)] flex-col overflow-y-auto">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <h2 id="select-details-title" className="min-w-0 truncate font-medium">
              {select.fileName}
            </h2>
            <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose} className="-mr-2">
              <X aria-hidden className="size-4" />
            </Button>
          </div>
          <div className="md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="bg-muted md:sticky md:top-0 md:self-start">
              <FramePreview selectId={select.id} version={version} alt={`${select.fileName} on its frame`} />
            </div>
            <div className="flex flex-col divide-y">
              {select.alreadyPosted && (
                <p className="px-4 py-3 text-sm text-muted-foreground">
                  Marked as already posted: never picked for a post.
                </p>
              )}
              {!select.alreadyPosted && (
                <DetailsSection title="Post">
                  <PostNow key={select.id} select={select} refresh={version} onPosted={onChanged} />
                </DetailsSection>
              )}
              <DetailsSection title="Capture data">
                <CaptureEditor key={select.id} selectId={select.id} onSaved={changed} />
              </DetailsSection>
              <div className="p-4 [&>section]:border-t-0 [&>section]:pt-0">
                <SelectCaption key={select.id} selectId={select.id} refresh={version} />
              </div>
              <DetailsSection title="File">
                <p className="text-xs text-muted-foreground">
                  {select.width} × {select.height} · {select.format.toUpperCase()} ·{" "}
                  {formatBytes(select.bytes)}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {confirming ? (
                    <>
                      <Button variant="destructive" onClick={remove} disabled={deleting}>
                        {deleting ? "Deleting…" : "Delete for good"}
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirming(false)} disabled={deleting}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button variant="destructive" onClick={() => setConfirming(true)}>
                      Delete
                    </Button>
                  )}
                </div>
                {confirming && (
                  <p className="text-xs text-muted-foreground">
                    Deletes the original and its thumbnail. The same file can't be added again.
                  </p>
                )}
                {error && <p className="text-sm text-destructive">Couldn't delete it. Try again.</p>}
              </DetailsSection>
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}

/** One part of the select details: a heading and what goes under it. */
export function DetailsSection({ title, children }: { title: string; children: ReactNode }) {
  const id = `details-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 p-4">
      <h3 id={id} className="text-sm font-medium text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * The select's frame, rendered by the server as it would post: edits applied and locations
 * withheld. A new render loads behind the one on show, so the preview never blanks.
 */
function FramePreview({ selectId, version, alt }: { selectId: string; version: number; alt: string }) {
  const url = `/api/selects/${encodeURIComponent(selectId)}/frame?width=${PREVIEW_WIDTH}&v=${version}`;
  const [shown, setShown] = useState<string | undefined>();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let live = true;
    setState("loading");
    const image = new Image();
    image.onload = () => {
      if (!live) return;
      setShown(url);
      setState("ready");
    };
    image.onerror = () => {
      if (live) setState("failed");
    };
    image.src = url;
    return () => {
      live = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [url]);

  return (
    <div aria-busy={state === "loading"} className="relative mx-auto aspect-[4/5] w-full max-w-md">
      {shown === undefined ? (
        <img
          src={`/api/selects/${encodeURIComponent(selectId)}/thumbnail`}
          alt=""
          className="size-full object-contain p-6 opacity-60"
        />
      ) : (
        <img
          src={shown}
          alt={alt}
          className={cn("size-full object-contain transition-opacity", state === "loading" && "opacity-70")}
        />
      )}
      {state === "failed" && (
        <p className="absolute inset-x-0 bottom-2 text-center text-sm text-destructive">
          Couldn't render the frame.
        </p>
      )}
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
