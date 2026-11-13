import type { Database } from "bun:sqlite";
import { type CaptionOverride, type CaptionTemplates, DEFAULT_CAPTION_TEMPLATES } from "./captions";

const KEY = "captions";
const NO_OVERRIDE: CaptionOverride = { caption: null, altText: null };

/** The caption templates, kept with the other settings, and the captions written for single selects. */
export function createCaptionStore(db: Database) {
  return {
    templates(): CaptionTemplates {
      const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(KEY);
      if (row === null) return DEFAULT_CAPTION_TEMPLATES;
      return { ...DEFAULT_CAPTION_TEMPLATES, ...(JSON.parse(row.value) as Partial<CaptionTemplates>) };
    },

    setTemplates(templates: CaptionTemplates): CaptionTemplates {
      db.query(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).run(KEY, JSON.stringify(templates));
      return templates;
    },

    /** What was written for the select. Null takes the template. */
    override(selectId: string): CaptionOverride {
      const row = db
        .query<{ caption: string | null; alt_text: string | null }, [string]>(
          "SELECT caption, alt_text FROM select_captions WHERE select_id = ?",
        )
        .get(selectId);
      return row === null ? NO_OVERRIDE : { caption: row.caption, altText: row.alt_text };
    },

    setOverride(selectId: string, override: CaptionOverride): CaptionOverride {
      if (override.caption === null && override.altText === null) {
        db.query("DELETE FROM select_captions WHERE select_id = ?").run(selectId);
      } else {
        db.query(
          `INSERT INTO select_captions (select_id, caption, alt_text) VALUES (?, ?, ?)
           ON CONFLICT (select_id) DO UPDATE SET caption = excluded.caption, alt_text = excluded.alt_text`,
        ).run(selectId, override.caption, override.altText);
      }
      return override;
    },
  };
}

export type CaptionStore = ReturnType<typeof createCaptionStore>;
