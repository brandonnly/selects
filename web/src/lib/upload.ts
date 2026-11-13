import type { UploadResult } from "@selects/server";

export type UploadResponse =
  | UploadResult
  | { status: "too-large" | "empty"; message: string }
  | { status: "failed"; message: string };

/** The file types the picker offers. The server checks the contents, not the name. */
export const ACCEPTED_FILES = "image/jpeg,image/png,image/tiff,.jpg,.jpeg,.png,.tif,.tiff";

/** How long an upload may go without sending anything before it is given up. */
const STALL_MS = 60_000;
/** How long the server may take to read a file once it has all of it. */
const READING_MS = 240_000;

/**
 * Sends one file to `POST /api/uploads`, reporting progress from 0 to 1. Uses XMLHttpRequest
 * because fetch cannot report upload progress.
 */
export function uploadFile(
  file: File,
  options: { alreadyPosted: boolean; onProgress: (fraction: number) => void },
): Promise<UploadResponse> {
  const query = new URLSearchParams({ name: file.name });
  if (options.alreadyPosted) query.set("alreadyPosted", "true");

  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/uploads?${query}`);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.responseType = "json";
    // A connection that stays open and moves nothing would otherwise hold its place for good.
    let stalled: ReturnType<typeof setTimeout>;
    const watch = (ms: number) => {
      clearTimeout(stalled);
      stalled = setTimeout(() => request.abort(), ms);
    };
    watch(STALL_MS);
    request.upload.addEventListener("progress", (event) => {
      watch(STALL_MS);
      if (event.lengthComputable) options.onProgress(event.loaded / event.total);
    });
    // Sent in full: the server is now reading the photo, which takes longer for a large file.
    request.upload.addEventListener("load", () => watch(READING_MS));
    request.addEventListener("loadend", () => clearTimeout(stalled));
    request.addEventListener("abort", () =>
      resolve({ status: "failed", message: "Upload failed: the connection stalled." }),
    );
    request.addEventListener("load", () => {
      const body = request.response as UploadResponse | null;
      if (body !== null && typeof body === "object" && "status" in body) resolve(body);
      else if (request.status === 413)
        resolve({ status: "too-large", message: "Larger than the upload limit." });
      else resolve({ status: "failed", message: `Upload failed (${request.status}).` });
    });
    request.addEventListener("error", () =>
      resolve({ status: "failed", message: "Upload failed: no connection." }),
    );
    request.send(file);
  });
}

/** Runs `task` over `items`, at most `limit` at a time. */
export async function eachLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
