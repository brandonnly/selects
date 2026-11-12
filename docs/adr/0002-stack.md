# ADR 0002: Bun, Elysia and SQLite behind a React app, in one container

## Status

Accepted, November 12, 2026.

## Context

Selects runs on a home server next to other containers. It should need no other service, and
its UI has a reorderable queue, a live frame preview, uploads and a schedule editor.

## Decision

- **Runtime:** Bun. Its built-in SQLite driver and S3 client cover the database and the bucket
  with nothing native to compile.
- **Server:** Elysia. Its Eden client gives the UI typed calls with no code generation.
- **Database:** one SQLite file in the data volume.
- **Images:** sharp for decoding, color conversion, resizing and JPEG encoding; exifr for
  reading EXIF; opentype.js to turn frame text into outlines.
- **UI:** a Vite React app with shadcn/ui and Tailwind v4, built to static files and served by
  the same process. No server rendering.
- **Maps:** Leaflet with OpenStreetMap tiles, fetched by the browser.
- **Layout:** one repo with `server`, `web` and later `gallery`, sharing types through Bun
  workspaces. No build orchestrator.
- **Scheduling:** in-process. No cron container, queue or worker.

## Consequences

- One container and one volume. Memory use is higher than a compiled server would need, which
  is acceptable for the single language and shared types.
- The server cannot run on Node without replacing the SQLite and S3 clients.
- The public gallery is a separate static site, so the app itself is never exposed.
