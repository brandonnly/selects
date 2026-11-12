import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  type CaptureData,
  EXTENSIONS,
  type Format,
  hashDistance,
  inspectPhoto,
  MIME_TYPES,
  type Photo,
  writeThumbnail,
} from "./photo";

export type Source = "upload" | "inbox";

/** A select as the API shows it. */
export type Select = CaptureData & {
  id: string;
  fileName: string;
  source: Source;
  format: Format;
  bytes: number;
  width: number;
  height: number;
  alreadyPosted: boolean;
  /** Not posted and not marked as already posted: eligible to be picked. */
  inPool: boolean;
  addedAt: string;
};

export type RejectionReason = "unsupported" | "duplicate" | "reexport";

/** A file refused at ingest, kept so its reason shows in the UI. */
export type Rejection = {
  id: string;
  source: Source;
  fileName: string;
  reason: RejectionReason;
  message: string;
  /** Only a likely re-export can be added anyway. */
  canAccept: boolean;
  rejectedAt: string;
};

export type IngestOptions = {
  /** The name the file arrived with. Shown in the UI; never used for storage. */
  fileName: string;
  source: Source;
  alreadyPosted?: boolean;
  /** Adds a likely re-export instead of refusing it. Byte-identical files are always refused. */
  allowReexport?: boolean;
};

type Match = { fileName: string; selectId: string | null };

export type IngestResult =
  | { status: "added"; select: Select }
  | { status: "unsupported" }
  | { status: "duplicate"; match: Match }
  | { status: "reexport"; match: Match };

export type UploadResult =
  | { status: "added"; select: Select }
  | { status: "unsupported"; message: string }
  | { status: "duplicate"; message: string }
  | { status: "reexport"; rejection: Rejection };

export type AcceptResult = IngestResult | { status: "not-found" } | { status: "gone" };

/**
 * Perceptual hashes this many bits apart or closer, with the same capture time, are taken for
 * one picture exported twice.
 */
const REEXPORT_DISTANCE = 10;

const UNSUPPORTED = "Not a JPEG, PNG or TIFF.";

/** A file in the inbox modified more recently than this may still be copying in. */
const INBOX_SETTLE_MS = 10_000;

export type ScanResult = { added: number; rejected: number };

type SelectRow = {
  id: string;
  file_name: string;
  source: Source;
  format: Format;
  bytes: number;
  width: number;
  height: number;
  camera: string | null;
  lens: string | null;
  focal_length: number | null;
  exposure_time: number | null;
  f_number: number | null;
  iso: number | null;
  latitude: number | null;
  longitude: number | null;
  captured_at: string | null;
  already_posted: 0 | 1;
  added_at: string;
};

type RejectionRow = {
  id: string;
  source: Source;
  file_name: string;
  reason: RejectionReason;
  matched_file_name: string | null;
  matched_select_id: string | null;
  stored_path: string | null;
  already_posted: 0 | 1;
  rejected_at: string;
};

/**
 * The Library: every select and its files, and the checks a file passes to join it.
 *
 * In the data directory, originals are kept byte for byte under random IDs in `originals/`,
 * each with a thumbnail in `thumbnails/`. A likely re-export from an upload waits in `held/`
 * until it is added anyway or dismissed.
 *
 * Files dropped in `inbox/` are ingested by `scanInbox`. A refused one moves to
 * `inbox/rejected/`, and its reason is recorded for the UI.
 */
export function createLibrary({ db, dataDir }: { db: Database; dataDir: string }) {
  const dirs = {
    originals: join(dataDir, "originals"),
    thumbnails: join(dataDir, "thumbnails"),
    held: join(dataDir, "held"),
    inbox: join(dataDir, "inbox"),
    rejected: join(dataDir, "inbox", "rejected"),
  };

  const originalPath = (row: Pick<SelectRow, "id" | "format">) =>
    join(dirs.originals, `${row.id}.${EXTENSIONS[row.format]}`);
  const thumbnailPath = (id: string) => join(dirs.thumbnails, `${id}.jpg`);

  const selectRow = (id: string) =>
    db.query<SelectRow, [string]>("SELECT * FROM selects WHERE id = ?").get(id);
  const rejectionRow = (id: string) =>
    db.query<RejectionRow, [string]>("SELECT * FROM rejections WHERE id = ?").get(id);

  // One ingest at a time, so two copies of a file arriving together cannot both pass the checks.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  function findDuplicate(photo: Photo): Match | undefined {
    const found = db
      .query<{ file_name: string; select_id: string | null }, [string]>(
        "SELECT file_name, select_id FROM fingerprints WHERE sha256 = ?",
      )
      .get(photo.sha256);
    return found === null ? undefined : { fileName: found.file_name, selectId: found.select_id };
  }

  function findReexport(photo: Photo): Match | undefined {
    if (photo.capturedAt === null) return undefined;
    const candidates = db
      .query<{ phash: string; file_name: string; select_id: string | null }, [string]>(
        "SELECT phash, file_name, select_id FROM fingerprints WHERE captured_at = ? ORDER BY added_at",
      )
      .all(photo.capturedAt);
    const found = candidates.find((c) => hashDistance(c.phash, photo.phash) <= REEXPORT_DISTANCE);
    return found === undefined ? undefined : { fileName: found.file_name, selectId: found.select_id };
  }

  /** Moves the file at `path` into the Library, or leaves it where it is when it is refused. */
  async function ingestNow(path: string, options: IngestOptions): Promise<IngestResult> {
    const photo = await inspectPhoto(path);
    if (photo === undefined) return { status: "unsupported" };

    const duplicate = findDuplicate(photo);
    if (duplicate !== undefined) return { status: "duplicate", match: duplicate };
    if (!options.allowReexport) {
      const reexport = findReexport(photo);
      if (reexport !== undefined) return { status: "reexport", match: reexport };
    }

    const id = randomUUID();
    const addedAt = new Date().toISOString();
    mkdirSync(dirs.originals, { recursive: true });
    mkdirSync(dirs.thumbnails, { recursive: true });
    const original = originalPath({ id, format: photo.format });
    await writeThumbnail(path, thumbnailPath(id));
    try {
      moveFile(path, original);
      db.transaction(() => {
        db.query(
          `INSERT INTO selects (id, file_name, source, format, bytes, width, height, camera, lens,
             focal_length, exposure_time, f_number, iso, latitude, longitude, captured_at,
             already_posted, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          options.fileName,
          options.source,
          photo.format,
          photo.bytes,
          photo.width,
          photo.height,
          photo.camera,
          photo.lens,
          photo.focalLength,
          photo.exposureTime,
          photo.fNumber,
          photo.iso,
          photo.latitude,
          photo.longitude,
          photo.capturedAt,
          options.alreadyPosted ? 1 : 0,
          addedAt,
        );
        db.query(
          `INSERT INTO fingerprints (sha256, phash, captured_at, file_name, select_id, added_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(photo.sha256, photo.phash, photo.capturedAt, options.fileName, id, addedAt);
      })();
    } catch (error) {
      // Put the file back where it came from, so a failed ingest loses nothing.
      if (existsSync(original) && !existsSync(path)) moveFile(original, path);
      rmSync(original, { force: true });
      rmSync(thumbnailPath(id), { force: true });
      throw error;
    }
    const added = selectRow(id);
    if (added === null) throw new Error("The new select was not saved");
    return { status: "added", select: toSelect(added) };
  }

  const ingest = (path: string, options: IngestOptions) => serially(() => ingestNow(path, options));

  function recordRejection(
    file: { fileName: string; source: Source; storedPath: string | null; alreadyPosted: boolean },
    reason: RejectionReason,
    match?: Match,
  ): Rejection {
    const id = randomUUID();
    db.query(
      `INSERT INTO rejections (id, source, file_name, reason, matched_file_name, matched_select_id,
         stored_path, already_posted, rejected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      file.source,
      file.fileName,
      reason,
      match?.fileName ?? null,
      match?.selectId ?? null,
      file.storedPath,
      file.alreadyPosted ? 1 : 0,
      new Date().toISOString(),
    );
    const saved = rejectionRow(id);
    if (saved === null) throw new Error("The rejection was not saved");
    return toRejection(saved);
  }

  async function scanInboxNow(): Promise<ScanResult> {
    mkdirSync(dirs.rejected, { recursive: true });
    const result: ScanResult = { added: 0, rejected: 0 };
    const settled = Date.now() - INBOX_SETTLE_MS;
    for (const entry of readdirSync(dirs.inbox, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const path = join(dirs.inbox, entry.name);
      if (statSync(path).mtimeMs > settled) continue;

      const ingested = await ingest(path, { fileName: entry.name, source: "inbox" });
      if (ingested.status === "added") {
        result.added++;
        continue;
      }
      const target = freePath(dirs.rejected, entry.name);
      moveFile(path, target);
      recordRejection(
        { fileName: entry.name, source: "inbox", storedPath: target, alreadyPosted: false },
        ingested.status,
        "match" in ingested ? ingested.match : undefined,
      );
      result.rejected++;
    }
    return result;
  }

  let scanning: Promise<ScanResult> | undefined;

  return {
    ingest,

    /** The folder watched for new files. */
    inboxDir: dirs.inbox,

    /**
     * Ingests every file in the inbox, moving refused ones to `inbox/rejected/`. Hidden files,
     * folders and files modified in the last few seconds are left alone. A scan asked for while
     * one runs shares its result.
     */
    scanInbox(): Promise<ScanResult> {
      scanning ??= scanInboxNow().finally(() => {
        scanning = undefined;
      });
      return scanning;
    },

    /**
     * Adds an uploaded file. A byte-identical or unsupported file is refused outright; a likely
     * re-export is held in `held/` for review. The file at `path` is moved either way, or left
     * in place when refused.
     */
    async addUpload(
      path: string,
      options: { fileName: string; alreadyPosted: boolean },
    ): Promise<UploadResult> {
      const result = await ingest(path, { ...options, source: "upload" });
      switch (result.status) {
        case "added":
          return result;
        case "unsupported":
          return { status: "unsupported", message: UNSUPPORTED };
        case "duplicate":
          return { status: "duplicate", message: duplicateMessage(result.match) };
        case "reexport": {
          mkdirSync(dirs.held, { recursive: true });
          const held = join(dirs.held, `${randomUUID()}${extname(options.fileName).toLowerCase()}`);
          moveFile(path, held);
          const rejection = recordRejection(
            { ...options, source: "upload", storedPath: held },
            "reexport",
            result.match,
          );
          return { status: "reexport", rejection };
        }
      }
    },

    /** Every select, newest first. */
    list(): Select[] {
      return db
        .query<SelectRow, []>("SELECT * FROM selects ORDER BY added_at DESC, rowid DESC")
        .all()
        .map(toSelect);
    },

    /**
     * The IDs of selects that may be picked, oldest first: never those marked as already
     * posted. The picker builds on this.
     */
    pool(): string[] {
      return db
        .query<{ id: string }, []>("SELECT id FROM selects WHERE already_posted = 0 ORDER BY added_at, rowid")
        .all()
        .map((row) => row.id);
    },

    original(id: string): { path: string; type: string } | undefined {
      const found = selectRow(id);
      return found === null ? undefined : { path: originalPath(found), type: MIME_TYPES[found.format] };
    },

    thumbnail(id: string): string | undefined {
      return selectRow(id) === null ? undefined : thumbnailPath(id);
    },

    /** Deletes a select and its files. Its fingerprint stays, so the file stays blocked. */
    remove(id: string): boolean {
      const found = selectRow(id);
      if (found === null) return false;
      db.query("DELETE FROM selects WHERE id = ?").run(id);
      rmSync(originalPath(found), { force: true });
      rmSync(thumbnailPath(id), { force: true });
      return true;
    },

    /** Files refused at ingest, newest first. */
    rejections(): Rejection[] {
      return db
        .query<RejectionRow, []>("SELECT * FROM rejections ORDER BY rejected_at DESC, rowid DESC")
        .all()
        .map(toRejection);
    },

    /** Adds a held likely re-export anyway. */
    async acceptRejection(id: string): Promise<AcceptResult> {
      const found = rejectionRow(id);
      if (found === null || found.reason !== "reexport" || found.stored_path === null) {
        return { status: "not-found" };
      }
      const path = found.stored_path;
      if (!existsSync(path)) {
        db.query("DELETE FROM rejections WHERE id = ?").run(id);
        return { status: "gone" };
      }
      const result = await ingest(path, {
        fileName: found.file_name,
        source: found.source,
        alreadyPosted: found.already_posted === 1,
        allowReexport: true,
      });
      if (result.status === "added") db.query("DELETE FROM rejections WHERE id = ?").run(id);
      if (result.status === "duplicate") {
        // The same file was added since by another route: it can no longer be added.
        db.query(
          "UPDATE rejections SET reason = 'duplicate', matched_file_name = ?, matched_select_id = ? WHERE id = ?",
        ).run(result.match.fileName, result.match.selectId, id);
      }
      return result;
    },

    /** Clears a rejection from the UI. A held upload is deleted with it. */
    dismissRejection(id: string): boolean {
      const found = rejectionRow(id);
      if (found === null) return false;
      db.query("DELETE FROM rejections WHERE id = ?").run(id);
      if (found.source === "upload" && found.stored_path !== null) rmSync(found.stored_path, { force: true });
      return true;
    },
  };
}

export type Library = ReturnType<typeof createLibrary>;

function toSelect(row: SelectRow): Select {
  const alreadyPosted = row.already_posted === 1;
  return {
    id: row.id,
    fileName: row.file_name,
    source: row.source,
    format: row.format,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    camera: row.camera,
    lens: row.lens,
    focalLength: row.focal_length,
    exposureTime: row.exposure_time,
    fNumber: row.f_number,
    iso: row.iso,
    latitude: row.latitude,
    longitude: row.longitude,
    capturedAt: row.captured_at,
    alreadyPosted,
    inPool: !alreadyPosted,
    addedAt: row.added_at,
  };
}

function toRejection(row: RejectionRow): Rejection {
  const match = { fileName: row.matched_file_name ?? "another file", selectId: row.matched_select_id };
  const message =
    row.reason === "unsupported"
      ? UNSUPPORTED
      : row.reason === "duplicate"
        ? duplicateMessage(match)
        : reexportMessage(match);
  return {
    id: row.id,
    source: row.source,
    fileName: row.file_name,
    reason: row.reason,
    message,
    canAccept: row.reason === "reexport",
    rejectedAt: row.rejected_at,
  };
}

const matchName = (match: Match) =>
  match.selectId === null ? `${match.fileName}, since deleted` : match.fileName;

export function duplicateMessage(match: Match) {
  return `Already added as ${matchName(match)}.`;
}

function reexportMessage(match: Match) {
  return `Looks like a re-export of ${matchName(match)}: the same picture, taken at the same moment.`;
}

/** `dir/name`, or `dir/name (2)` and so on when that is taken. */
function freePath(dir: string, name: string): string {
  const extension = extname(name);
  const stem = basename(name, extension);
  let candidate = join(dir, name);
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `${stem} (${n})${extension}`);
  return candidate;
}

/** Renames, or copies and removes when the target is on another filesystem. */
function moveFile(from: string, to: string) {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(from, to);
    rmSync(from);
  }
}
