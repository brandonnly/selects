# ADR 0004: Coordinates are withheld by the file's location as well as the edited one

## Status

Accepted, November 13, 2026.

## Context

A select's capture data can be edited, coordinates included, and a privacy zone withholds the
coordinates of a select taken inside it. [docs/PRODUCT.md](../PRODUCT.md) does not say which
location a zone is checked against once the coordinates have been edited, or what a zone made
from a select is centred on. A published coordinate cannot be taken back, so the rules lean
towards withholding.

## Decision

- **One function gives capture data for publishing.** `published(id)` applies the edits and
  removes the coordinates when they are withheld. It returns a branded type that the frame
  takes, and that captions, the manifest and the publisher take after it. Nothing that leaves
  the install reads a select's raw data.
- **A zone withholds a select when either location is inside it:** the one in the file or the
  edited one. Editing the coordinates of a photo taken inside a zone never publishes it.
- **A zone made from a select is centred on the file's location**, or on the edited one when
  the file has none.
- **A select with no coordinates after edits has none to publish.** Coordinates added by an
  edit are published like any others.
- **A re-export added anyway inherits a hidden location** from the select it was matched to.
- **A zone's radius is typed in metres as digits only**, so "1,000" is refused and never read
  as one metre. Typing a zone's coordinates never zooms the map to them.
- **Maps load OpenStreetMap tiles from the browser** ([ADR 0002](0002-stack.md)), so
  OpenStreetMap sees the area on screen. The zone form says so.

## Consequences

- To publish an edited location for a photo taken inside a zone, the zone has to go or shrink.
- The Library and its map show the owner every location, withheld or not; they are behind the
  password when one is set and are never a source for anything published.
- The publisher must take capture data when it renders and again before it uploads, since a
  zone can be added between the two.
