import type { Database } from "bun:sqlite";
import type { Library, Select } from "./library";
import type { CaptureData } from "./photo";
import { insideZone, type Point, type Zone, type Zones } from "./zones";

/** The capture data fields that can be edited per select. Coordinates are one field. */
export const EDITABLE_FIELDS = [
  "camera",
  "lens",
  "focalLength",
  "exposureTime",
  "fNumber",
  "iso",
  "coordinates",
  "capturedAt",
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/**
 * A select's edits. A field left out is the file's own; a field set to null is cleared, and left
 * off like one the file lacks.
 */
export type CaptureEdits = {
  camera?: string | null;
  lens?: string | null;
  focalLength?: number | null;
  exposureTime?: number | null;
  fNumber?: number | null;
  iso?: number | null;
  coordinates?: Point | null;
  capturedAt?: string | null;
};

/** Why a select's coordinates are not published. */
export type Withheld =
  /** Neither the file nor an edit gives it coordinates. */
  | "no-coordinates"
  /** Its location is hidden on its own. */
  | "hidden"
  /** It was taken inside a privacy zone. */
  | "privacy-zone";

declare const published: unique symbol;

/**
 * A select's capture data as it may be published: edits applied, and no coordinates when they
 * are withheld. Only `publishCapture` makes one, so everything that publishes (the frame, the
 * caption, the manifest) can take only this and never a select's raw data.
 */
export type PublishedCapture = CaptureData & { readonly [published]: true };

export type PrivacyRules = { locationHidden: boolean; zones: readonly Zone[] };

/** The capture data with the edits applied. */
export function applyEdits(file: CaptureData, edits: CaptureEdits): CaptureData {
  const edited: CaptureData = { ...file };
  for (const field of EDITABLE_FIELDS) {
    if (!(field in edits) || edits[field] === undefined) continue;
    if (field === "coordinates") {
      edited.latitude = edits.coordinates?.latitude ?? null;
      edited.longitude = edits.coordinates?.longitude ?? null;
    } else {
      // Each other edit has the same name and type as its field.
      (edited as Record<string, unknown>)[field] = edits[field];
    }
  }
  return edited;
}

/** Why the coordinates of capture data (edits applied) may not be published, or null when they may. */
export function locationWithheld(capture: CaptureData, rules: PrivacyRules): Withheld | null {
  const { latitude, longitude } = capture;
  if (latitude === null || longitude === null) return "no-coordinates";
  if (rules.locationHidden) return "hidden";
  if (rules.zones.some((zone) => insideZone({ latitude, longitude }, zone))) return "privacy-zone";
  return null;
}

/** Capture data as it may be published: the edits applied and the privacy rules kept. */
export function publishCapture(
  file: CaptureData,
  edits: CaptureEdits,
  rules: PrivacyRules,
): PublishedCapture {
  const edited = applyEdits(file, edits);
  const withheld = locationWithheld(edited, rules);
  return (withheld === null ? edited : { ...edited, latitude: null, longitude: null }) as PublishedCapture;
}

/** True for a moment written `YYYY-MM-DDTHH:MM:SS` that exists on the calendar. */
export function isCaptureTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 19) === value;
}

/** A select's capture data in every form the UI shows. */
export type CaptureView = {
  /** As read from the file at ingest. */
  file: CaptureData;
  edits: CaptureEdits;
  locationHidden: boolean;
  /** As the frame, caption and manifest give it. */
  published: CaptureData;
  withheld: Withheld | null;
};

/**
 * Per-select edits to capture data and the per-select location switch, kept in the database. The
 * original file is never touched. `published` is the one way to a select's capture data for
 * anything that leaves the install.
 */
export function createCaptures({ db, library, zones }: { db: Database; library: Library; zones: Zones }) {
  const editsOf = (id: string): CaptureEdits => {
    const rows = db
      .query<{ field: EditableField; value: string }, [string]>(
        "SELECT field, value FROM capture_edits WHERE select_id = ?",
      )
      .all(id);
    return Object.fromEntries(rows.map((row) => [row.field, JSON.parse(row.value)]));
  };
  const isHidden = (id: string) =>
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM hidden_locations WHERE select_id = ?")
      .get(id)?.n === 1;

  function view(select: Select): CaptureView {
    const file = captureData(select);
    const edits = editsOf(select.id);
    const rules = { locationHidden: isHidden(select.id), zones: zones.list() };
    const edited = applyEdits(file, edits);
    return {
      file,
      edits,
      locationHidden: rules.locationHidden,
      published: publishCapture(file, edits, rules),
      withheld: locationWithheld(edited, rules),
    };
  }

  return {
    /**
     * A select's capture data as it may be published, or undefined when there is no such
     * select. The frame, captions, the manifest and the publisher all take capture data from here.
     */
    published(id: string): PublishedCapture | undefined {
      const select = library.get(id);
      if (select === undefined) return undefined;
      return publishCapture(captureData(select), editsOf(id), {
        locationHidden: isHidden(id),
        zones: zones.list(),
      });
    },

    view(id: string): CaptureView | undefined {
      const select = library.get(id);
      return select === undefined ? undefined : view(select);
    },

    /** Replaces a select's edits and location switch. Undefined when there is no such select. */
    save(id: string, change: { edits: CaptureEdits; locationHidden: boolean }): CaptureView | undefined {
      const select = library.get(id);
      if (select === undefined) return undefined;
      db.transaction(() => {
        db.query("DELETE FROM capture_edits WHERE select_id = ?").run(id);
        for (const field of EDITABLE_FIELDS) {
          const value = change.edits[field];
          if (value === undefined) continue;
          db.query("INSERT INTO capture_edits (select_id, field, value) VALUES (?, ?, ?)").run(
            id,
            field,
            JSON.stringify(value),
          );
        }
        if (change.locationHidden) {
          db.query("INSERT OR IGNORE INTO hidden_locations (select_id) VALUES (?)").run(id);
        } else {
          db.query("DELETE FROM hidden_locations WHERE select_id = ?").run(id);
        }
      })();
      return view(select);
    },

    /**
     * Where a select was taken as its owner sees it, edits applied: null when it has no
     * coordinates, undefined when there is no such select. Never for publishing.
     */
    location(id: string): Point | null | undefined {
      const select = library.get(id);
      if (select === undefined) return undefined;
      const { latitude, longitude } = applyEdits(captureData(select), editsOf(id));
      return latitude === null || longitude === null ? null : { latitude, longitude };
    },

    /** The select as its owner sees it in the Library: edits applied, coordinates kept. */
    withEdits(select: Select): Select {
      return { ...select, ...applyEdits(captureData(select), editsOf(select.id)) };
    },
  };
}

export type Captures = ReturnType<typeof createCaptures>;

function captureData(select: Select): CaptureData {
  return {
    camera: select.camera,
    lens: select.lens,
    focalLength: select.focalLength,
    exposureTime: select.exposureTime,
    fNumber: select.fNumber,
    iso: select.iso,
    latitude: select.latitude,
    longitude: select.longitude,
    capturedAt: select.capturedAt,
  };
}
