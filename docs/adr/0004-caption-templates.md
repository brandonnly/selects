# ADR 0004: Caption templates leave nothing behind a missing field

## Status

Accepted, November 13, 2026.

## Context

Captions and alt text are templates built from tokens. A select often lacks a field: no lens
on a fixed-lens camera, no coordinates when its location is hidden. A template that printed
its separators and labels anyway would post "· 35mm" or "Photograph taken on with".
[docs/PRODUCT.md](../PRODUCT.md) names the tokens and the defaults but not how a template
behaves around a missing field.

## Decision

- **Tokens** are written in braces: `{coordinates}`, `{date}`, `{camera}`, `{lens}`,
  `{focalLength}`, `{shutter}`, `{aperture}`, `{iso}`, and `{hashtags}` in the caption only.
  Each prints as it does on the frame. An unknown token is refused when the template is saved.
- **A missing field takes its separator with it.** Text between two fields with no letter or
  digit in it, such as " · " or ", ", is a separator. Brackets or quotes that close around a
  missing field go too, and so does a mark that opens the line before a missing first field.
- **A line whose fields are all missing is left out**, with any words on it. Blank lines never
  stack or end the text.
- **Words in square brackets go with a missing field inside them.** `[ on {date}]` prints
  nothing when the select has no date. Fields in brackets do not decide whether their line
  stays.
- **The default alt text** is `Photograph taken[ on {date}][ with {camera}]`. With both fields
  it reads as the brief has it; with neither it reads "Photograph taken".
- **The default caption** is `{coordinates}`, then `{camera} · {lens}`, then a blank line and
  `{hashtags}`.
- **A caption or alt text written for one select is used as written.** Tokens in it are not
  filled in and no hashtag set is added.
- **Limits.** A caption holds at most 2,200 characters, 30 hashtags and 20 @ tags, and alt
  text 1,000 characters, counted in UTF-16 code units. A warning shows from 90% of a limit.
  Saving a template measures a long caption from it as an estimate; the caption built for
  each post is measured again before it is published.

## Consequences

- Templates stay plain text that reads like the caption it makes.
- A literal `{word}` cannot be printed, and a line that mixes a field with unrelated words
  loses those words when the field is missing. Brackets are the way to keep them apart.
- The publisher must measure each built caption, since a select's own capture data can carry
  more than the estimate assumes.
