<p><img alt="Selects" src="brand/logo/selects-icon.svg" width="96"></p>

# Selects

**Post your photo backlog to Instagram, one framed select at a time.**

Selects is a small self-hosted app for photographers with more finished photos than they ever
post. Upload your finals once. On the schedule you set, it picks one, renders it on a frame with
its shutter speed, aperture, ISO and coordinates read from the file, and publishes it to your
Instagram account.

It's early: the app is an empty shell so far. The plan is in [docs/PRODUCT.md](docs/PRODUCT.md).

- One container, one volume, SQLite. No other services to run.
- Meant for a home server on a LAN or tailnet, not the open internet.
- One Instagram account per install.

More:

- [Decisions](docs/adr/)
- [Glossary](GLOSSARY.md)
- [Brand kit and design tokens](brand/README.md)

## Development

You need [Bun](https://bun.sh); the version is pinned in `package.json` under `packageManager`.

```sh
bun install
bun run dev
```

`bun run dev` starts the server with reload and the Vite dev server, which proxies `/api` to it.
Open the address Vite prints. The development database lives in the git-ignored `data/`.

Every environment variable is listed in [.env.example](.env.example). Copy it to `.env` to
change a port. The password applies to the built app: under `bun run dev` it guards the API but
the dev server has no password page, so leave it unset there.

## Running the built app

```sh
bun run build
bun run start
```

`bun run build` builds the UI into `web/dist`. `bun run start` runs one process that serves the
API under `/api` and the built UI everywhere else. It needs `DATA_DIR` set; it stops and names
any variable that is missing or invalid.

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
