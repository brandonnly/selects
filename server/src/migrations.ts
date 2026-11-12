import type { Migration } from "./db";

/**
 * Every schema change, oldest first. Append only: a shipped migration is never edited,
 * removed or reordered, because its position is the schema version it produces.
 */
export const migrations: readonly Migration[] = [];
