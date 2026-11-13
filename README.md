<p><img alt="Selects" src="brand/logo/selects-icon.svg" width="96"></p>

# Selects

**Post your photo backlog to Instagram, one framed select at a time.**

Selects is a small self-hosted app for photographers with more finished photos than they ever
post. Upload your finals once. On the schedule you set, it picks one, renders it on a frame with
its shutter speed, aperture, ISO and coordinates read from the file, and publishes it to your
Instagram account.

It's early: photos can be added to the Library and framed, but nothing is posted yet. The plan is in
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
until you add it anyway or discard it. Dismissing a file refused from the inbox clears the notice
and leaves the file in `inbox/rejected`.

## The frame

Each post is a 1440 × 1800 JPEG: the photo on a light or dark border with one line of capture
data under it, in sRGB with no embedded metadata. The Frame screen sets the border width, the
frame color, the typeface, which fields print and how coordinates read, and previews each change
on any select with the same renderer that makes the post. Changes save as you make them.

Six typefaces are bundled, each with its license in `server/fonts`. To use another font, put
one `.ttf`, `.otf` or `.woff` file in the `fonts` folder of the data directory: it replaces the
chosen typeface on every frame until it is removed.

## Development

You need [Bun](https://bun.sh); the version is pinned in `package.json` under `packageManager`.

```sh
bun install
bun run dev
```

`bun run dev` starts the server with reload and the Vite dev server, which proxies `/api` to it.
Open the address Vite prints. The development database lives in the git-ignored `data/`.

`bun run fixtures [dir]` writes the generated test photos (portrait, square and landscape, with
and without GPS, a re-export, a Display P3 photo, and files Selects refuses) to a folder,
`.tmp/fixtures` by default. Use them to try the app; never commit a real photograph.

The frame tests compare renders against the reference images in `server/references`. After an
intended change to how a frame looks, `bun run references` writes them again; look at each one
before committing it.

Development never posts for real. Until `INSTAGRAM_API=live` is set, Selects runs in fake mode:
the fake Instagram server and a fake bucket in this repo run inside the server, the bucket in
`BUCKET_*` is not used, and nothing leaves the install. Any token pasted in Settings connects a
fake account, and "Post now" works end to end: the frame goes to the fake bucket, the fake
Instagram fetches it, and the post appears on the Posted screen labelled as a fake post. A
banner on every screen says when fake mode is on. The Dry run switch in Settings renders and
records each post without uploading or posting anything.

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

### Publishing to Instagram

Publishing needs an S3-compatible bucket and an Instagram account (see
[ADR 0003](docs/adr/0003-instagram-publishing.md)):

1. Set `INSTAGRAM_API=live`. Without it, Selects talks only to its fake Instagram server and fake
   bucket, and nothing is posted.
2. Set `BUCKET_ENDPOINT`, `BUCKET_NAME`, `BUCKET_ACCESS_KEY_ID` and `BUCKET_SECRET_ACCESS_KEY`,
   and `BUCKET_PUBLIC_URL`, the URL the bucket serves its objects from. Publishing without a
   public URL, through a presigned link, is not yet proven against Instagram. They are used only in live
   mode; without them Selects runs, and Settings names the variables still missing.
3. Paste a long-lived token from your Meta app in Settings. Selects shows the account it belongs
   to, refreshes it daily and never shows it again. Its expiry shows once a refresh works.

If Instagram is asked to publish a post and never confirms whether it did, the post shows on the
Posted screen as needing a check, and its select stays out of the pool until Instagram answers
or you say whether it was posted.

Try a post with the Dry run switch on first: the Posted screen shows the frame, caption and
everything a real post would send.

### Backups and restoring

Each night at 03:30, in the timezone set on the Queue screen, Selects copies its database to
`backups/selects-YYYY-MM-DD.db` in `DATA_DIR`, keeping the latest seven. It also makes one at
start when the last copy is from before last night. Settings shows when the last copy was made
and why the last try failed, if it did. Each copy holds the Instagram token and the notification
channels, so it is readable by its owner only; keep it that way wherever you copy it.

To restore a copy:

1. Stop Selects.
2. Copy the database aside, in case you want it back: `selects.db`, `selects.db-wal` and
   `selects.db-shm` in `DATA_DIR`.
3. Replace `selects.db` with the copy, named `selects.db`, and keep it owner-only
   (`chmod 600 selects.db`).
4. Remove `selects.db-wal` and `selects.db-shm`. They belong to the database you replaced, and
   SQLite would apply them to the copy.
5. Start Selects with `SELECTS_START_PAUSED=true`. It starts with posting paused, and a post
   that was under way when the copy was made is held on the Posted screen for you to check
   instead of being sent again. Without this, a slot that is due could post before you get to
   the pause switch.

Restoring takes the library, posts, schedule, settings, Instagram token and notification
channels back to the night of the copy. Before you resume:

- A select posted since the copy is back in the pool and could be posted again. The Posted
  screen shows only what the copy knew of, so compare your Instagram feed with the Library and
  delete from the Library any select already on Instagram (its hash is kept, so it is never
  picked again).
- The photos are not in the database: originals, thumbnails and fonts stay in `DATA_DIR` and
  are not part of a copy. A select added since the copy is no longer in the library though its
  file is still on disk; upload it again.
- If the token was replaced since the copy, paste the current one in Settings.

Then remove `SELECTS_START_PAUSED`, so a later restart does not pause again, and turn the pause
switch off on the Queue screen.

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
