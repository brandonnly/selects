import type { Rejection, Select } from "@selects/server";
import { FolderInput, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api";
import { SelectDetails } from "@/components/select-details";
import { Button } from "@/components/ui/button";
import { ACCEPTED_FILES, eachLimited, type UploadResponse, uploadFile } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { Screen } from "./screen";

type UploadItem = {
  key: number;
  name: string;
  progress: number;
  state: "waiting" | "uploading" | "reading" | "done";
  result?: UploadResponse;
};

/** Uploads run this many at a time. */
const PARALLEL_UPLOADS = 2;

let nextUploadKey = 0;

export function LibraryScreen() {
  const [selects, setSelects] = useState<Select[] | undefined>();
  const [rejections, setRejections] = useState<Rejection[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [alreadyPosted, setAlreadyPosted] = useState(false);
  const [scan, setScan] = useState<{ state: "idle" | "scanning" } | { state: "done"; message: string }>({
    state: "idle",
  });
  const [open, setOpen] = useState<Select | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const [library, rejected] = await Promise.all([api.selects.get(), api.rejections.get()]);
    if (library.data) setSelects(library.data);
    if (rejected.data) setRejections(rejected.data);
    setLoadError(library.error !== null || rejected.error !== null);
  }, []);

  useEffect(() => {
    void refresh();
    // The inbox fills on its own; catch up whenever the app comes back into view.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const update = (key: number, change: Partial<UploadItem>) =>
    setUploads((items) => items.map((item) => (item.key === key ? { ...item, ...change } : item)));

  const startUploads = async (files: File[]) => {
    const batch = files.map((file) => ({ file, key: nextUploadKey++ }));
    setUploads((items) => [
      ...items,
      ...batch.map(({ file, key }) => ({ key, name: file.name, progress: 0, state: "waiting" as const })),
    ]);
    const markPosted = alreadyPosted;
    await eachLimited(batch, PARALLEL_UPLOADS, async ({ file, key }) => {
      update(key, { state: "uploading" });
      const result = await uploadFile(file, {
        alreadyPosted: markPosted,
        onProgress: (progress) => update(key, { progress, state: progress >= 1 ? "reading" : "uploading" }),
      });
      update(key, { state: "done", progress: 1, result });
      if (result.status === "added" || result.status === "reexport") void refresh();
    });
  };

  const scanInbox = async () => {
    setScan({ state: "scanning" });
    const { data } = await api.inbox.scan.post();
    if (data) {
      const parts = [`${data.added} added`, `${data.rejected} rejected`];
      setScan({ state: "done", message: `Inbox scanned: ${parts.join(", ")}.` });
    } else {
      setScan({ state: "done", message: "Couldn't scan the inbox." });
    }
    await refresh();
  };

  const finished = uploads.filter((item) => item.state === "done");

  return (
    <Screen title="Library">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => fileInput.current?.click()}>
            <Upload aria-hidden className="size-4" />
            Upload photos
          </Button>
          <Button variant="outline" onClick={scanInbox} disabled={scan.state === "scanning"}>
            <FolderInput aria-hidden className="size-4" />
            {scan.state === "scanning" ? "Scanning…" : "Scan inbox"}
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPTED_FILES}
          className="hidden"
          data-testid="upload-input"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length > 0) void startUploads(files);
          }}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={alreadyPosted}
            onChange={(event) => setAlreadyPosted(event.currentTarget.checked)}
          />
          Mark new uploads as already posted
        </label>
        {scan.state === "done" && (
          <p role="status" className="text-sm text-muted-foreground">
            {scan.message}
          </p>
        )}
      </div>

      {uploads.length > 0 && (
        <section aria-labelledby="uploads" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 id="uploads" className="text-sm font-medium text-muted-foreground">
              Uploads
            </h2>
            {finished.length === uploads.length && (
              <Button variant="ghost" size="sm" onClick={() => setUploads([])}>
                Clear
              </Button>
            )}
          </div>
          <ul className="flex flex-col divide-y rounded-lg border bg-card">
            {uploads.map((item) => (
              <UploadRow key={item.key} item={item} />
            ))}
          </ul>
        </section>
      )}

      {rejections.length > 0 && (
        <section aria-labelledby="rejected" className="flex flex-col gap-2">
          <h2 id="rejected" className="text-sm font-medium text-muted-foreground">
            Not added
          </h2>
          <ul className="flex flex-col divide-y rounded-lg border bg-card">
            {rejections.map((rejection) => (
              <RejectionRow key={rejection.id} rejection={rejection} onChange={refresh} />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="selects" className="flex flex-col gap-2">
        <h2 id="selects" className="text-sm font-medium text-muted-foreground">
          {selects === undefined
            ? "Selects"
            : `${selects.length} ${selects.length === 1 ? "select" : "selects"}`}
        </h2>
        {loadError && <p className="text-sm text-destructive">Can't reach the server.</p>}
        {selects?.length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No selects yet. Upload photos, or drop them in the <code>inbox</code> folder of the data folder.
          </p>
        )}
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {selects?.map((select) => (
            <li key={select.id}>
              <button
                type="button"
                onClick={() => setOpen(select)}
                className="group relative block aspect-square w-full overflow-hidden rounded-md bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <img
                  src={`/api/selects/${select.id}/thumbnail`}
                  alt={select.fileName}
                  loading="lazy"
                  className="size-full object-cover transition-opacity group-hover:opacity-90"
                />
                {select.alreadyPosted && (
                  <span className="absolute bottom-1.5 left-1.5 rounded-sm bg-background/90 px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                    Already posted
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <SelectDetails
        select={open}
        onClose={() => setOpen(undefined)}
        onDeleted={() => {
          setOpen(undefined);
          void refresh();
        }}
      />
    </Screen>
  );
}

function UploadRow({ item }: { item: UploadItem }) {
  const { text, tone } = uploadStatus(item);
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium">{item.name}</span>
        {item.state !== "done" && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {Math.round(item.progress * 100)}%
          </span>
        )}
      </div>
      {item.state !== "done" && (
        <div
          role="progressbar"
          aria-label={`Uploading ${item.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(item.progress * 100)}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full bg-primary transition-[width]"
            style={{ width: `${item.progress * 100}%` }}
          />
        </div>
      )}
      <p
        className={cn(
          "text-xs",
          tone === "error" ? "text-destructive" : tone === "ok" ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {text}
      </p>
    </li>
  );
}

function uploadStatus(item: UploadItem): { text: string; tone: "muted" | "ok" | "error" } {
  switch (item.state) {
    case "waiting":
      return { text: "Waiting", tone: "muted" };
    case "uploading":
      return { text: "Uploading", tone: "muted" };
    case "reading":
      return { text: "Reading the file", tone: "muted" };
    case "done":
      break;
  }
  const result = item.result;
  if (result === undefined) return { text: "", tone: "muted" };
  switch (result.status) {
    case "added":
      return { text: result.select.alreadyPosted ? "Added, marked as already posted" : "Added", tone: "ok" };
    case "reexport":
      return { text: `Held for review. ${result.rejection.message}`, tone: "muted" };
    default:
      return { text: `Not added. ${result.message}`, tone: "error" };
  }
}

function RejectionRow({ rejection, onChange }: { rejection: Rejection; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const act = async (action: () => Promise<{ error: { status: unknown } | null }>) => {
    setBusy(true);
    setError(undefined);
    const { error: failed } = await action();
    // A 409 or 410 changes or removes this row on refresh, which says why by itself.
    if (failed && failed.status !== 409 && failed.status !== 410) setError("That didn't work. Try again.");
    await onChange();
    setBusy(false);
  };

  return (
    <li className="flex flex-col gap-2 px-3 py-2.5 text-sm">
      <div className="flex flex-col gap-0.5">
        <span className="min-w-0 truncate font-medium">{rejection.fileName}</span>
        <span className="text-muted-foreground">
          {rejection.source === "inbox" ? "From the inbox. " : "Uploaded. "}
          {rejection.message}
        </span>
        {rejection.source === "inbox" && (
          <span className="text-xs text-muted-foreground">
            The file is in the inbox's <code>rejected</code> folder.
          </span>
        )}
        {error && <span className="text-destructive">{error}</span>}
      </div>
      <div className="flex gap-2">
        {rejection.canAccept && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => act(() => api.rejections({ id: rejection.id }).accept.post())}
          >
            Add anyway
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => act(() => api.rejections({ id: rejection.id }).delete())}
        >
          {rejection.source === "upload" ? "Discard" : "Dismiss"}
        </Button>
      </div>
    </li>
  );
}
