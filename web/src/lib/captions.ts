/** Hashtags as typed, one per word: spaces, commas and new lines separate them, and # is added where it was left off. */
export function parseTags(text: string): string[] {
  const tags = text
    .split(/[\s,]+/)
    .filter((word) => word !== "")
    .map((word) => (word.startsWith("#") ? word : `#${word}`));
  return [...new Set(tags)];
}

/** `text` with `{token}` in place of the selection, and where the cursor goes after it. */
export function insertToken(
  text: string,
  selection: { start: number; end: number },
  token: string,
): { text: string; cursor: number } {
  const inserted = `{${token}}`;
  return {
    text: text.slice(0, selection.start) + inserted + text.slice(selection.end),
    cursor: selection.start + inserted.length,
  };
}
