<p><img alt="Selects" src="brand/logo/selects-icon.svg" width="96"></p>

# Selects

**Post your photo backlog to Instagram, one framed select at a time.**

Selects is a small self-hosted app for photographers with more finished photos than they ever
post. Upload your finals once. On the schedule you set, it picks one, renders it on a frame with
its shutter speed, aperture, ISO and coordinates read from the file, and publishes it to your
Instagram account.

It's early: photos can be added to the Library, but nothing is posted yet. The plan is in
[docs/PRODUCT.md](docs/PRODUCT.md).

- One container, one volume, SQLite. No other services to run.
- Meant for a home server on a LAN or tailnet, not the open internet.
- One Instagram account per install.

More:

- [Decisions](docs/adr/)
- [Glossary](GLOSSARY.md)
- [Brand kit and design tokens](brand/README.md)

## Adding photos

Selects takes JPEG, PNG and TIFF files, by either route:

- **Upload** on the Library screen: several files at once, up to 200 MB each. Tick "Mark new
  uploads as already posted" for photos that are on Instagram already; they stay in the Library
  but are never picked.
- **The inbox**: the `inbox` folder in the data directory. It is scanned when the server starts
  and every two minutes after, or at once with "Scan inbox". A file is taken once it has gone
  ten seconds unchanged. An added file moves into Selects' storage; any other file moves to
  `inbox/rejected` and its reason shows in the Library.

The original is kept byte for byte. A file identical to one added before is refused, even if
that one was deleted. A likely re-export (the same picture, taken at the same moment) is held
until you add it anyway or discard it.

## Development

You need [Bun](https://bun.sh); the version is pinned in `package.json` under `packageManager`.

```sh
bun install
bun run dev
```

`bun run dev` starts the server with reload and the Vite dev server, which proxies `/api` to it.
Open the address Vite prints. The development database lives in the git-ignored `data/`.

`bun run fixtures [dir]` writes the generated test photos (portrait, square and landscape, with
and without GPS, a re-export, and files Selects refuses) to a folder, `.tmp/fixtures` by
default. Use them to try the app; never commit a real photograph.

Every environment variable is listed in [.env.example](.env.example). Copy it to `.env` to
change a port. The password applies to the built app: under `bun run dev` it guards the API but
the dev server has no password page, so leave it unset there.

## Running the built app

```sh
bun run build
bun run start
```

`bun run build` builds the UI into `web/dist`. `bun run start` runs one process that serves the
API under `/api` and the built UI everywhere else. It needs `DATA_DIR` set: a missing `DATA_DIR`
or an invalid `PORT` stops startup and names the variable.

## Checks

These run in CI on every pull request:

```sh
bun run typecheck
bun run lint     # Biome; `bun run format` fixes what it can
bun test
bun run build
```

## License

[MIT](LICENSE). The bundled fonts keep their own licenses.
