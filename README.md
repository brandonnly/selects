<p><img alt="Selects" src="brand/logo/selects-icon.svg" width="96"></p>

# Selects

**Post your photo backlog to Instagram, one framed select at a time.**

Selects is a small self-hosted app for photographers with more finished photos than they ever
post. Upload your finals once. On the schedule you set, it picks one, renders it on a frame with
its shutter speed, aperture, ISO and coordinates read from the file, and publishes it to your
Instagram account.

It's early, and it has not yet posted to the real Instagram API: everything up to that is built
and runs against a fake Instagram. The plan is in [docs/PRODUCT.md](docs/PRODUCT.md).

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

## Running Selects

Selects is published as one container image for amd64 and arm64:
`ghcr.io/brandonnly/selects`, tagged with each version and `latest`. The image appears with the
first release; before that, build it from a checkout with `docker build --tag selects .` and
use `selects` in place of the image name below. It keeps everything in one
volume at `/data` and listens on port 3000.

### Keep it off the internet

Selects has no login by default: anyone who can reach it can post to your Instagram account,
read your photos' locations and download the originals. Run it on your LAN, over a VPN or
tailnet, or behind a reverse proxy that has its own authentication. Do not forward a port to
it or put it on a public hostname.

`SELECTS_PASSWORD` puts the whole app behind one password. It is a second lock for a trusted
network, not a reason to expose Selects: there are no accounts, no rate limit on guesses and no
two-factor sign-in. With it set, the health check, the web manifest and the app's icons still
answer without it; the health check says only whether the app is up.

### With Docker

```sh
docker run --detach --name selects --restart unless-stopped \
  --publish 3000:3000 \
  --volume selects-data:/data \
  ghcr.io/brandonnly/selects:latest
```

Then open port 3000 of the server from a device on the same network. Or with Compose, keeping
`SELECTS_PASSWORD`, `INSTAGRAM_API` and the `BUCKET_*` variables in an env file. Take those
lines from [.env.example](.env.example) and leave `DATA_DIR`, `PORT` and `WEB_PORT` out: the
image sets the first two, and a `DATA_DIR` from the example would move the data off the volume.

```yaml
services:
  selects:
    image: ghcr.io/brandonnly/selects:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - selects-data:/data
    # SELECTS_PASSWORD, INSTAGRAM_API and BUCKET_*; DATA_DIR and PORT are set by the image.
    env_file: selects.env

volumes:
  selects-data:
```

The image runs as user and group 1000, not root. A named volume, as above, is ready for it. To
keep the data in a folder on the host instead, make the folder writable by that user
(`sudo chown 1000:1000 <folder>`), or run the container as the folder's owner with
`--user <uid>:<gid>` (`user:` in Compose). If Selects cannot write to its data folder it says
so and stops.

The image starts in fake mode: nothing is posted until you [go live](#go-live). The container
reports healthy once `/api/health` answers, and stops cleanly on `docker stop`: requests in
flight finish and the database is closed. To update, pull the new image and recreate the
container; the database is migrated when it starts.

Back up the volume: it holds the database, the original photos and the inbox.

### On Unraid

The template is [unraid/selects.xml](unraid/selects.xml). Save it on the server as
`/boot/config/plugins/dockerMan/templates-user/my-Selects.xml`, then pick Selects under
**Add Container** in the Docker tab. It runs Selects as `nobody:users` (99:100), the owner Unraid
gives files in its shares, so photos copied into the inbox over the network can be moved.
Before the first start, create the data folder and give it to that user:

```sh
mkdir -p /mnt/user/appdata/selects
chown 99:100 /mnt/user/appdata/selects
```

The template's warnings apply: keep it off the internet, and leave `INSTAGRAM_API` at `fake`
until you go live.

## Posting to Instagram

Selects publishes through Meta's Instagram API with Instagram Login (see
[ADR 0003](docs/adr/0003-instagram-publishing.md)). It needs three things: a Meta app of your
own, a long-lived token for your Instagram account, and an S3-compatible bucket that Instagram
fetches each frame from. Until `INSTAGRAM_API=live` is set none of them is used.

These steps follow Meta's documentation as of November 2026; Meta renames its dashboard often,
so look for the nearest match if a label differs.

### Create the Meta app

1. Your Instagram account must be a professional account (business or creator) and public.
   Switch it in the Instagram app's settings if it is not. No Facebook Page is needed.
2. At [developers.facebook.com](https://developers.facebook.com/), log in, open My Apps and
   choose **Create App**.
3. For the use case choose **Other**; for the app type, **Business**. Give it a name and your
   contact email.
4. On the app's dashboard, find **Instagram** and choose **Set up**. Use **API setup with
   Instagram login**, not the Facebook login variant.
5. Under **App roles > Roles**, add your Instagram account as an **Instagram Tester**. Accept the
   invite from that account: in Instagram's settings, under **Apps and websites**, open
   **Tester invites**.

The app stays with Standard Access, which is meant for an app used only by accounts that have a
role on it. It needs no App Review and no login flow. You can leave webhooks and business login
settings empty. Meta's app guide also mentions connecting a verified business before
publishing; its overview asks for that only when the app serves accounts without a role on it.
If Instagram refuses to publish for that reason, connect one under **App settings > Basic**.

### Generate the long-lived token

1. In the app's dashboard, open **Instagram > API setup with Instagram login**.
2. Under the step for generating access tokens, add your Instagram account if it is not listed,
   then choose **Generate token** beside it and log in to Instagram. Allow at least
   `instagram_business_basic` and `instagram_business_content_publish`.
3. Copy the token. A token from the dashboard is long-lived: it lasts 60 days.
4. In Selects, paste it under **Settings**. Selects shows the account it belongs to, refreshes it
   daily (Meta allows a refresh once a token is a day old, each adding 60 days) and never shows
   it again. Its expiry shows once a refresh works. If Selects is stopped for 60 days the token
   expires, and you generate a new one.

Treat the token like a password: it can post to your account. It is kept in the database, in
the data volume.

### Configure the bucket

Instagram takes an image only as a URL it fetches itself, so each frame is uploaded to a bucket
first. Any S3-compatible service works.

- `BUCKET_ENDPOINT`: the provider's S3 API endpoint, as an `https://` URL.
- `BUCKET_NAME`: the bucket.
- `BUCKET_ACCESS_KEY_ID` and `BUCKET_SECRET_ACCESS_KEY`: an access key limited to this bucket,
  allowed to read, write and delete objects. Keep them in the environment, never in a file in
  git.
- `BUCKET_REGION`: the bucket's region where the provider needs one. Default: `auto`.
- `BUCKET_PUBLIC_URL`: the public URL the bucket's objects are served from, without a trailing
  slash: the provider's public bucket URL or a custom domain in front of it. Set it. Instagram
  fetches each frame from it, and gallery output needs it.

Objects get random keys, never file names. A framed image is deleted once it is published,
unless gallery output keeps it. With gallery output on, `posts.json` and the clean images are
public under `BUCKET_PUBLIC_URL`. A gallery on another site reads `posts.json` only if the bucket
allows it: add a CORS rule allowing `GET` from that site's origin (see
[docs/manifest.md](docs/manifest.md)). Instagram's own fetch needs no CORS rule.

**Private buckets are unverified.** Without `BUCKET_PUBLIC_URL`, Selects hands Instagram a
one-hour presigned link to each frame instead. This is not supported yet: no real publish
through a presigned link has passed, and gallery output is unavailable without a public URL.
Use a public base URL.

### Go live

Fake mode is the default and makes no outside request. Moving to the real API is a deliberate
step:

1. Turn on **Dry run** in Settings.
2. Set `INSTAGRAM_API=live` and the `BUCKET_*` variables, and restart Selects. Settings names any
   bucket variable still missing.
3. Paste the token in Settings and check the account it shows.
4. Use **Post now** on a select. The Posted screen shows the frame, caption and everything a real
   post would send, and nothing leaves Selects.
5. Turn **Dry run** off. From now on the schedule and **Post now** publish to Instagram, and a
   post cannot be taken back from Selects: remove it in the Instagram app.

If Instagram is asked to publish a post and never confirms whether it did, the post shows on the
Posted screen as needing a check, and its select stays out of the pool until Instagram answers
or you say whether it was posted.

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

## Running from source

```sh
bun run build
bun run start
```

`bun run build` builds the UI into `web/dist`. `bun run start` runs one process that serves the
API under `/api` and the built UI everywhere else. It needs `DATA_DIR` set: a missing `DATA_DIR`
or an invalid `PORT` stops startup and names the variable. Everything under
[Running Selects](#running-selects) and [Posting to Instagram](#posting-to-instagram) applies.

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

These run in CI on every pull request, with a build of the image that is started and checked by
[.github/scripts/smoke-test-image.sh](.github/scripts/smoke-test-image.sh):

```sh
bun run typecheck
bun run lint     # Biome; `bun run format` fixes what it can
bun test
bun run build
```

## Releasing

A tag `v<version>` publishes the image. Set `version` in the root `package.json` to the same
version first: the release refuses a tag that does not match it, since `/api/health` reports
that version. The release smoke-tests the image natively on amd64 and arm64, then pushes both
to `ghcr.io/brandonnly/selects` as `<version>`, tests the pushed image on both platforms, and then
moves `latest` to it (a pre-release such as `v1.0.0-rc.1` is not tagged `latest`). The first push creates the package private: make it
public once in the package's settings on GitHub.

## License

[MIT](LICENSE). The bundled fonts keep their own licenses.
