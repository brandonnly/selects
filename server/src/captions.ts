import type { PublishedCapture } from "./capture";
import { FRAME_FIELDS, type FrameField, type FrameSettings, fieldValues } from "./frame";

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
  /** As `published` gives it: coordinates are already gone when they are withheld. */
  capture: PublishedCapture;
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
    caption: ownCaption ?? fill(templates.caption, values, CAPTION_TOKENS),
    altText: override?.altText ?? fill(templates.altText, values, ALT_TEXT_TOKENS),
    hashtagSet: ownCaption === null && templates.caption.includes("{hashtags}") ? (set?.name ?? null) : null,
  };
}

/** Instagram's limits on a caption and on alt text. */
export const CAPTION_LIMITS = { characters: 2200, hashtags: 30, mentions: 20, altTextCharacters: 1000 };

/** A warning shows from this share of a limit. */
const NEAR = 0.9;

/**
 * How a caption and alt text measure against Instagram's limits. Characters are UTF-16 code
 * units, as JavaScript counts them: Meta does not say how it counts, and this never counts
 * fewer than code points or graphemes. Every `#` or `@` followed by a letter, digit or
 * underscore counts as a hashtag or an @ tag.
 */
export type LimitCheck = {
  captionCharacters: number;
  hashtags: number;
  mentions: number;
  altTextCharacters: number;
  /** Near a limit: allowed. */
  warnings: string[];
  /** Over a limit: refused. */
  problems: string[];
};

type Counts = Omit<LimitCheck, "warnings" | "problems">;

/** Measures one caption and alt text against Instagram's limits. */
export function checkCaption({ caption, altText }: { caption: string; altText: string }): LimitCheck {
  return judge(count(caption, altText), "is");
}

/**
 * A template's syntax problems, and how a long caption from it measures against Instagram's
 * limits. This is an estimate that catches a template too long for ordinary photos: a select's
 * own capture data can still carry more, so whatever publishes a post measures the caption it
 * built with `checkCaption` before sending it.
 */
export function checkTemplates(templates: CaptionTemplates): Pick<LimitCheck, "warnings" | "problems"> {
  const problems = [
    ...(templates.caption.split("{hashtags}").length > 2 ? ["The caption can have {hashtags} once."] : []),
    ...unknownTokens(templates.caption, CAPTION_TOKENS, "caption"),
    ...unknownTokens(templates.altText, ALT_TEXT_TOKENS, "alt text"),
    ...setProblems(templates.hashtagSets),
  ];
  if (problems.length > 0) return { problems, warnings: [] };
  // The longest caption: every field at its longest, with each set in turn.
  const longest = (["dms", "decimal"] as const)
    .flatMap((coordinateFormat) =>
      (templates.hashtagSets.length === 0 ? [undefined] : templates.hashtagSets).map((set) =>
        buildCaption({ capture: LONGEST, templates, coordinateFormat, hashtagSet: set?.name }),
      ),
    )
    .map((built) => count(built.caption, built.altText))
    .reduce((most, counts) => ({
      captionCharacters: Math.max(most.captionCharacters, counts.captionCharacters),
      hashtags: Math.max(most.hashtags, counts.hashtags),
      mentions: Math.max(most.mentions, counts.mentions),
      altTextCharacters: Math.max(most.altTextCharacters, counts.altTextCharacters),
    }));
  const limits = judge(longest, "can be");
  return { problems: [...problems, ...limits.problems], warnings: limits.warnings };
}

function count(caption: string, altText: string): Counts {
  return {
    captionCharacters: caption.length,
    hashtags: caption.match(/#[\p{L}\p{N}_]/gu)?.length ?? 0,
    mentions: caption.match(/@[\p{L}\p{N}_]/gu)?.length ?? 0,
    altTextCharacters: altText.length,
  };
}

function judge(counts: Counts, verb: "is" | "can be"): LimitCheck {
  const warnings: string[] = [];
  const problems: string[] = [];
  const has = verb === "is" ? "has" : "can have up to";
  const is = verb === "is" ? "is" : "can be up to";
  const measure = (value: number, limit: number, what: (n: string) => string) => {
    const said = `${what(value.toLocaleString("en-US"))}, `;
    if (value > limit) problems.push(`${said}over Instagram's limit of ${limit.toLocaleString("en-US")}.`);
    else if (value >= limit * NEAR)
      warnings.push(`${said}near Instagram's limit of ${limit.toLocaleString("en-US")}.`);
  };
  measure(counts.captionCharacters, CAPTION_LIMITS.characters, (n) => `The caption ${is} ${n} characters`);
  measure(counts.hashtags, CAPTION_LIMITS.hashtags, (n) => `The caption ${has} ${n} hashtags`);
  measure(counts.mentions, CAPTION_LIMITS.mentions, (n) => `The caption ${has} ${n} @ tags`);
  measure(
    counts.altTextCharacters,
    CAPTION_LIMITS.altTextCharacters,
    (n) => `The alt text ${is} ${n} characters`,
  );
  return { ...counts, warnings, problems };
}

/** Every field at its longest: names as long as a frame prints them, numbers at their widest. */
const LONGEST = {
  // Two UTF-16 units to the character, as a name in emoji or rare script would be.
  camera: "\u{1d54e}".repeat(48),
  lens: "\u{1d54e}".repeat(48),
  focalLength: 1234.5,
  exposureTime: 1 / 1_000_000,
  fNumber: 22.5,
  iso: 3_280_000,
  latitude: -89.5,
  longitude: -179.5,
  capturedAt: "2024-12-31T23:59:59",
} as PublishedCapture;

function unknownTokens(template: string, tokens: ReadonlySet<string>, where: string): string[] {
  return [...template.matchAll(TOKEN)]
    .filter(([, name]) => !tokens.has(name ?? ""))
    .map(([whole]) => `${whole} in the ${where} isn't a token.`);
}

/** A hashtag Instagram links: # and then letters, digits and underscores only. */
const HASHTAG = /^#[\p{L}\p{N}_]+$/u;

function setProblems(sets: HashtagSet[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const set of sets) {
    const name = set.name.trim();
    if (name === "") problems.push("A hashtag set needs a name.");
    else if (seen.has(name)) problems.push(`There are two hashtag sets named ${name}.`);
    seen.add(name);
    for (const tag of set.tags) {
      if (!HASHTAG.test(tag)) problems.push(`${tag} in ${name || "a set"} isn't a hashtag.`);
    }
  }
  return problems;
}

type Token = FrameField | "hashtags";

/** The tokens a template can use, in the order the Captions screen offers them. Hashtags go in the caption only. */
export const TOKENS: readonly Token[] = [
  "coordinates",
  "date",
  "camera",
  "lens",
  "focalLength",
  "shutter",
  "aperture",
  "iso",
  "hashtags",
];
const CAPTION_TOKENS: ReadonlySet<string> = new Set<Token>(TOKENS);
const ALT_TEXT_TOKENS: ReadonlySet<string> = new Set<Token>(FRAME_FIELDS);
type Values = Record<Token, string | null>;

/** A run of text, or a field: a token, or brackets holding one, which is null when it is missing. */
type Part =
  | { text: string }
  /** `lead` is the separator a bracketed group opens with, before its first token. */
  | { field: string | null; bracketed: boolean; lead: string };

/** Brackets and quotes that close around a field and go with it when it is missing. */
const PAIRS: Record<string, string> = { "(": ")", "“": "”", '"': '"', "‘": "’", "'": "'" };

/**
 * Fills a template. A missing field leaves nothing behind: the separator beside it goes with
 * it, a line whose every field outside brackets is missing is left out, and text in square
 * brackets around a field is left out with it. Blank lines never stack or end the text.
 */
function fill(template: string, values: Values, tokens: ReadonlySet<string>): string {
  const lines: string[] = [];
  for (const line of template.split(/\r?\n/)) {
    const filled = fillLine(line, values, tokens);
    if (filled === undefined) continue;
    if (filled === "" && (lines.length === 0 || lines.at(-1) === "")) continue;
    lines.push(filled);
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

/** The line filled in, or undefined when it holds fields outside brackets and every one is missing. */
function fillLine(line: string, values: Values, tokens: ReadonlySet<string>): string | undefined {
  const parts = parse(line, values, tokens);
  const present = (part: Part | undefined) => part !== undefined && "field" in part && part.field !== null;
  // Brackets already take their own words with them, so a line of nothing but brackets stays.
  // A line with fields outside brackets goes when no field on it, in brackets or out, is present.
  const bare = parts.filter((part) => "field" in part && !part.bracketed);
  if (bare.length > 0 && !parts.some(present)) return undefined;

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
    // A mark that opens the line before its first field, such as a pin before coordinates, goes too.
    if (i === 1 && before !== undefined && isSeparator(before.text)) before.text = "";
  }
  const printed = parts.map((part) => ("field" in part ? (part.field ?? "") : part.text));
  // Brackets that now open the line drop the separator they began with, as in `[ · {iso}]`.
  const first = printed.findIndex((text) => text.trim() !== "");
  const opener = parts[first];
  if (first > 0 && opener !== undefined && "field" in opener && opener.bracketed) {
    // Only the separator written in the template goes, never the start of a field's own value.
    printed[first] = (printed[first] ?? "").slice(opener.lead.length);
  }
  return printed
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

function parse(line: string, values: Values, tokens: ReadonlySet<string>): Part[] {
  const parts: Part[] = [];
  let at = 0;
  for (const match of line.matchAll(/\[[^[\]]*\]|\{(\w+)\}/g)) {
    const [whole, name] = match;
    const value = name === undefined ? group(whole, values, tokens) : token(name, values, tokens);
    if (value === undefined) continue;
    if (match.index > at) parts.push({ text: line.slice(at, match.index) });
    const opening = name === undefined ? (/^\[([^{]*)/.exec(whole)?.[1] ?? "") : "";
    parts.push({ field: value, bracketed: name === undefined, lead: isSeparator(opening) ? opening : "" });
    at = match.index + whole.length;
  }
  if (at < line.length) parts.push({ text: line.slice(at) });
  return parts;
}

/** A token's value, null when the select lacks it, or undefined when it is no token. */
function token(name: string, values: Values, tokens: ReadonlySet<string>): string | null | undefined {
  if (!tokens.has(name)) return undefined;
  const value = values[name as Token];
  return value === null || value === "" ? null : value;
}

/**
 * Bracketed text with its tokens filled, null when one of them is missing, or undefined when it
 * holds no token and so prints as written.
 */
function group(bracketed: string, values: Values, tokens: ReadonlySet<string>): string | null | undefined {
  const inner = bracketed.slice(1, -1);
  let holdsToken = false;
  let missing = false;
  const filled = inner.replace(TOKEN, (whole, name: string) => {
    const value = token(name, values, tokens);
    if (value === undefined) return whole;
    holdsToken = true;
    if (value === null) missing = true;
    return value ?? "";
  });
  if (!holdsToken) return undefined;
  return missing ? null : filled;
}
