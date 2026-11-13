import type { Select } from "@selects/server";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { captureFields } from "@/lib/capture";

/** A select's picture and capture data, in a dialog, with a way to delete it. */
export function SelectDetails({
  select,
  onClose,
  onDeleted,
}: {
  select: Select | undefined;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(false);

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

  const fields = select === undefined ? [] : captureFields(select);

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="select-details-title"
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-lg border bg-card p-0 text-card-foreground backdrop:bg-background/80"
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
          <div className="bg-muted">
            <img
              src={`/api/selects/${select.id}/thumbnail`}
              alt={select.fileName}
              className="mx-auto max-h-[50dvh] w-auto object-contain"
            />
          </div>
          <div className="flex flex-col gap-4 p-4">
            {select.alreadyPosted && (
              <p className="text-sm text-muted-foreground">
                Marked as already posted: never picked for a post.
              </p>
            )}
            {fields.length > 0 ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
                {fields.map(({ label, value }) => (
                  <div key={label} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="min-w-0 break-words">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">The file has no capture data.</p>
            )}
            <p className="text-xs text-muted-foreground">
              {select.width} × {select.height} · {select.format.toUpperCase()} · {formatBytes(select.bytes)}
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
          </div>
        </div>
      )}
    </dialog>
  );
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
