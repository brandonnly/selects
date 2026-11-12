import type { UploadResult } from "@selects/server";

export type UploadResponse =
  | UploadResult
  | { status: "too-large" | "empty"; message: string }
  | { status: "failed"; message: string };

/** The file types the picker offers. The server checks the contents, not the name. */
export const ACCEPTED_FILES = "image/jpeg,image/png,image/tiff,.jpg,.jpeg,.png,.tif,.tiff";

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
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) options.onProgress(event.loaded / event.total);
    });
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
