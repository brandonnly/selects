import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The largest file an upload takes: 200 MB. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export type Received = { status: "received"; path: string } | { status: "too-large" } | { status: "empty" };

/**
 * Streams a request body into a new file in `dir`, never holding the whole file in memory.
 * Stops and removes the partial file once the body passes `maxBytes`.
 */
export async function receiveUpload(request: Request, dir: string, maxBytes: number): Promise<Received> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { status: "too-large" };
  if (request.body === null) return { status: "empty" };

  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.part`);
  const writer = Bun.file(path).writer();
  let size = 0;
  try {
    for await (const chunk of request.body) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        await writer.end();
        rmSync(path, { force: true });
        return { status: "too-large" };
      }
      writer.write(chunk);
    }
    await writer.end();
  } catch (error) {
    await Promise.resolve(writer.end()).catch(() => {});
    rmSync(path, { force: true });
    throw error;
  }
  if (size === 0) {
    rmSync(path, { force: true });
    return { status: "empty" };
  }
  return { status: "received", path };
}
