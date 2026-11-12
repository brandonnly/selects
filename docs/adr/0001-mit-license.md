# ADR 0001: License Selects under MIT

## Status

Accepted, November 12, 2026.

## Context

Selects is a small self-hosted utility. Nothing in it needs protecting from closed forks, and a
permissive license is what people expect from a tool they run at home.

## Decision

- Selects is MIT licensed.
- Dependencies and copied code must be under a license compatible with MIT distribution: MIT,
  BSD, ISC, Apache-2.0 or similar. Copyleft code (GPL, AGPL) stays out.
- Bundled fonts must be under the SIL Open Font License 1.1, and each ships with its license
  file beside it. The six chosen are IBM Plex Mono, JetBrains Mono, Space Mono, Courier Prime,
  Inter and EB Garamond.

## Consequences

- sharp links libvips, which is LGPL. It is used as a prebuilt dependency and never modified or
  vendored.
- Commercial typefaces can only be used through the font override in the data folder.
