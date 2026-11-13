import type { Database } from "bun:sqlite";
import { DEFAULT_FRAME_SETTINGS, type FrameSettings } from "./frame";

/**
 * Settings changed in the UI, kept in the database. Values are validated before they are saved;
 * a setting added since a value was saved takes its default.
 */
export function createSettings(db: Database) {
  const read = (key: string): unknown => {
    const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
    return row === null ? undefined : JSON.parse(row.value);
  };
  const write = (key: string, value: unknown) => {
    db.query(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run(key, JSON.stringify(value));
  };

  return {
    frame(): FrameSettings {
      const saved = read("frame") as Partial<FrameSettings> | undefined;
      if (saved === undefined) return DEFAULT_FRAME_SETTINGS;
      return {
        ...DEFAULT_FRAME_SETTINGS,
        ...saved,
        fields: { ...DEFAULT_FRAME_SETTINGS.fields, ...saved.fields },
      };
    },

    setFrame(settings: FrameSettings): FrameSettings {
      write("frame", settings);
      return settings;
    },
  };
}

export type Settings = ReturnType<typeof createSettings>;
