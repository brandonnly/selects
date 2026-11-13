import { FRAME_FIELDS, type FrameField, type FrameSettings, fieldValues } from "./frame";
import type { CaptureData } from "./photo";

/** A named list of hashtags. One set is chosen at random for each post. */
export type HashtagSet = { name: string; tags: string[] };

/** The caption and alt text every select gets unless it has its own. */
export type CaptionTemplates = { caption: string; altText: string; hashtagSets: HashtagSet[] };

export const DEFAULT_CAPTION_TEMPLATES: CaptionTemplates = {
  caption: "{coordinates}\n{camera} · {lens}\n\n{hashtags}",
  altText: "Photograph taken[ on {date}][ with {camera}]",
  hashtagSets: [],
};

export type CaptionInput = {
  /** The capture data as it may be published: coordinates are already null when hidden. */
  capture: CaptureData;
  templates: CaptionTemplates;
  coordinateFormat: FrameSettings["coordinateFormat"];
  /** A caption or alt text written for this select, used as written in place of the template. */
  override?: CaptionOverride;
  /** The set to use, by name, in place of a random one: for a preview. */
  hashtagSet?: string;
  /** Picks the hashtag set: a number from 0 up to but not including 1. Default: Math.random. */
  random?: () => number;
};

/** What was written for one select. Null takes the template. */
export type CaptionOverride = { caption: string | null; altText: string | null };

export type Caption = {
  caption: string;
  altText: string;
  /** The name of the hashtag set chosen, or null when there are none. */
  hashtagSet: string | null;
};

/** A select's caption and alt text, with one of the hashtag sets chosen at random. */
export function buildCaption({
  capture,
  templates,
  coordinateFormat,
  override,
  hashtagSet,
  random = Math.random,
}: CaptionInput): Caption {
  const sets = templates.hashtagSets;
  const set =
    sets.find((candidate) => candidate.name === hashtagSet) ??
    sets[Math.min(sets.length - 1, Math.floor(random() * sets.length))];
  const values: Values = {
    ...fieldValues(capture, coordinateFormat),
    hashtags: set === undefined || set.tags.length === 0 ? null : set.tags.join(" "),
  };
  const ownCaption = override?.caption ?? null;
  return {
    caption: ownCaption ?? fill(templates.caption, values),
    altText: override?.altText ?? fill(templates.altText, values),
    hashtagSet: ownCaption === null && templates.caption.includes("{hashtags}") ? (set?.name ?? null) : null,
  };
}

type Token = FrameField | "hashtags";
type Values = Record<Token, string | null>;

const TOKENS: ReadonlySet<string> = new Set<Token>([...FRAME_FIELDS, "hashtags"]);

/** A run of text, or a field: a token, or brackets holding one, which is null when it is missing. */
type Part = { text: string } | { field: string | null };

/** Brackets and quotes that close around a field and go with it when it is missing. */
const PAIRS: Record<string, string> = { "(": ")", "“": "”", '"': '"', "‘": "’", "'": "'" };

/**
 * Fills a template. A missing field leaves nothing behind: the separator beside it goes with
 * it, a line whose every field is missing is left out, and text in square brackets around a
 * field is left out with it. Blank lines never stack or end the text.
 */
function fill(template: string, values: Values): string {
  const lines: string[] = [];
  for (const line of template.split(/\r?\n/)) {
    const filled = fillLine(line, values);
    if (filled === undefined) continue;
    if (filled === "" && (lines.length === 0 || lines.at(-1) === "")) continue;
    lines.push(filled);
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

/** The line filled in, or undefined when it holds fields and every one is missing. */
function fillLine(line: string, values: Values): string | undefined {
  const parts = parse(line, values);
  const present = (part: Part | undefined) => part !== undefined && "field" in part && part.field !== null;
  if (parts.some((part) => "field" in part) && !parts.some(present)) return undefined;

  for (const [i, part] of parts.entries()) {
    if (!("field" in part) || part.field !== null) continue;
    const before = textAt(parts, i - 1);
    const after = textAt(parts, i + 1);
    const close = before === undefined ? undefined : PAIRS[before.text.at(-1) ?? ""];
    if (before !== undefined && after !== undefined && close !== undefined && after.text.startsWith(close)) {
      before.text = before.text.slice(0, -1);
      after.text = after.text.slice(close.length);
    }
    if (after !== undefined && isSeparator(after.text) && parts.slice(i + 1).some(present)) after.text = "";
    else if (before !== undefined && isSeparator(before.text) && parts.slice(0, i).some(present)) {
      before.text = "";
    }
  }
  return parts
    .map((part) => ("field" in part ? (part.field ?? "") : part.text))
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function textAt(parts: Part[], i: number): { text: string } | undefined {
  const part = parts[i];
  return part !== undefined && "text" in part ? part : undefined;
}

/** Text with no letters or digits in it, such as " · " or ", ". */
function isSeparator(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text);
}

const TOKEN = /\{(\w+)\}/g;

function parse(line: string, values: Values): Part[] {
  const parts: Part[] = [];
  let at = 0;
  for (const match of line.matchAll(/\[[^[\]]*\]|\{(\w+)\}/g)) {
    const [whole, name] = match;
    const value = name === undefined ? group(whole, values) : token(name, values);
    if (value === undefined) continue;
    if (match.index > at) parts.push({ text: line.slice(at, match.index) });
    parts.push({ field: value });
    at = match.index + whole.length;
  }
  if (at < line.length) parts.push({ text: line.slice(at) });
  return parts;
}

/** A token's value, null when the select lacks it, or undefined when it is no token. */
function token(name: string, values: Values): string | null | undefined {
  if (!TOKENS.has(name)) return undefined;
  const value = values[name as Token];
  return value === null || value === "" ? null : value;
}

/**
 * Bracketed text with its tokens filled, null when one of them is missing, or undefined when it
 * holds no token and so prints as written.
 */
function group(bracketed: string, values: Values): string | null | undefined {
  const inner = bracketed.slice(1, -1);
  let holdsToken = false;
  let missing = false;
  const filled = inner.replace(TOKEN, (whole, name: string) => {
    const value = token(name, values);
    if (value === undefined) return whole;
    holdsToken = true;
    if (value === null) missing = true;
    return value ?? "";
  });
  if (!holdsToken) return undefined;
  return missing ? null : filled;
}
