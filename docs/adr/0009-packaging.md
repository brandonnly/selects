# ADR 0009: One image on Bun's Debian image, published from a tag, installable as a PWA

## Status

Accepted, November 13, 2026.

## Context

[docs/PRODUCT.md](../PRODUCT.md) settles that Selects ships as one container image for amd64
and arm64 on each version tag, with an Unraid template, and installs as a PWA, online only. It
leaves open what the image is built on, who it runs as, how a health check and an install work
behind the optional password, and how the arm64 image is built and checked.

## Decision

- **Base image: `oven/bun` slim, at the Bun version in `package.json`, pinned by digest.** It is
  Debian, so glibc: sharp ships prebuilt glibc binaries for linux amd64 and arm64, which are its
  most used builds. Alpine (musl) has sharp builds too, but would put Bun and sharp on their
  less used libc for no gain beyond image size.
- **Nothing runs emulated.** The UI is built on the build machine's platform. The server's
  production dependencies are installed there too, with `bun install --os --cpu` choosing the
  target's sharp binaries, and the final stage only copies files. A multi-platform build needs
  no QEMU.
- **The image runs as Bun's `bun` user (1000:1000)**, with `/data` as its one volume, owned by
  that user so a new named volume is writable. The Unraid template runs it as `nobody:users`
  (99:100), the owner of files in Unraid's shares. Startup names `DATA_DIR` and the user when
  the folder cannot be written.
- **Fake mode stays the default.** The image leaves `INSTAGRAM_API` unset.
- **Bun is PID 1**, started in exec form, so `docker stop`'s SIGTERM reaches the server's own
  shutdown. The health check runs `bun -e` against `/api/health`: the image has no curl.
- **Behind the password, three things answer without a session**, all reads: `/api/health`,
  which then says only `{"status": "ok"}` or `{"status": "error"}` (the version and schema stay
  behind the password), and the web manifest and icons copied from `brand/favicon`, which
  browsers fetch without the cookie when installing. Every other path stays behind it.
- **No service worker.** Chrome, Edge and Safari install a site with a manifest and icons
  without one, and Selects is online only, so there is nothing for one to cache.
- **CI builds the image on every pull request** and runs a smoke test against it: health, UI,
  manifest and icons, a rendered frame, the password gate, and a clean stop.
- **A `v*` tag releases.** The tag must match `package.json`'s version. The smoke test runs
  natively on GitHub's amd64 and arm64 runners (free for public repositories), then one job
  builds both platforms with buildx and pushes them to the repository's GitHub Container
  Registry as the version and `latest` (`latest` skipped for a pre-release), with provenance
  and an SBOM, using only `GITHUB_TOKEN` with `packages: write`.

## Consequences

- The published arm64 image is built on amd64 from the same Dockerfile as the one tested on the
  arm64 runner, not the same bytes. They differ only in where `bun install` ran.
- Elysia's peer dependencies put TypeScript in the image's `node_modules`, unused at run time.
- A host folder mounted at `/data` must be writable by the container's user; a named volume
  needs nothing.
- Installing on iOS uses `apple-touch-icon.png`; the manifest's dark theme color is not
  expressible in the manifest, so the browser's theme color follows the device through two
  `theme-color` meta tags instead.
