# Selects product brief

Selects posts a photographer's backlog to Instagram. You upload finished photos once; on the
schedule you set, it picks one, renders it on a frame with its capture data, and publishes it.
"Selects" is the working term for the frames that made the cut.

## Who it is for

One photographer with one Instagram account, running one install on a home server. An install is
single-tenant: there are no users, roles or second accounts. Everything personal to an install
(account, bucket, schedule, privacy zones) is configuration, never code.

## How a post happens

1. A photo arrives by web upload or through the inbox folder.
2. Selects reads its EXIF, hashes it, rejects duplicates and stores the original untouched.
3. A day before each slot, Selects picks the next select and shows it as next up.
4. At the slot's time it renders the frame, uploads it to the bucket, publishes it through the
   Instagram API and records the post.
5. With gallery output on, it also writes a clean image and a manifest entry to the bucket.

## Decisions

### Ingest

- Two routes: web upload, and an inbox folder scanned every few minutes.
- JPEG, PNG and TIFF are accepted. Everything else is rejected.
- Uploads take several files at once with per-file progress, up to 200 MB each by default.
- The inbox is emptied as it is processed: an ingested file moves into the app's storage, and a
  duplicate or unsupported file moves to a `rejected` subfolder with its reason shown in the UI.
- A thumbnail is generated at ingest.
- An upload can be marked as already posted, in bulk. Those selects are hashed and never picked.

### Duplicates

- Checked at ingest, never at post time.
- A SHA-256 match is an exact duplicate and is rejected.
- A perceptual-hash match with the same capture time is a likely re-export: it warns and can be
  overridden.
- Hashes are kept after a file is deleted, so a posted select stays blocked.

### Originals and metadata

- Originals stay on the install's volume and are never modified or uploaded.
- A field missing from the file is left off the frame.
- Every field (camera, lens, focal length, shutter, aperture, ISO, coordinates, date) can be
  edited per select. Edits live in the database.

### Picking

- The queue is an ordered list, reordered by dragging, and always drains first. Queued selects
  ignore the pick rules. There is no pinning a select to a date.
- With an empty queue, a select is picked from the pool under the pick rules.
- Pick rules are a fixed list, each with a switch and a number:
  - spacing by capture day: not the same day as any of the last N posts (on, N = 5);
  - spacing by place: not within X km of the last N posts (off);
  - order: random, oldest first or newest first (random).
- A rule that would leave nothing to pick is relaxed.
- A select is never posted twice.

### Schedule

- The schedule is a list of slots. Each has days of the week, a time and an optional random
  spread in minutes. A new install has no slots and posts nothing.
- One timezone per install.
- Posting is automatic. Next up is chosen a day ahead and can be swapped or skipped.
- A slot missed while the app was down posts late only within a grace period (two hours by
  default). Otherwise it is skipped; missed slots never stack.
- A failed publish retries three times over about fifteen minutes, then notifies, returns the
  select to the pool and leaves the schedule running. Slots pass that select over for a week, or
  until its owner tries it again, so the queue and pool behind it keep posting
  ([ADR 0007](adr/0007-scheduling.md)).
- A pause switch stops all posting. Any select can be posted immediately.
- Dry run renders and logs each post without publishing.

### Frame

- Output is a 1440 × 1800 JPEG (4:5) in sRGB, the largest size and tallest ratio Instagram
  keeps, encoded at high quality and under the 8 MB limit. Wide-gamut originals are converted.
- A landscape photo is padded onto the same canvas, sitting slightly above centre, with the
  metadata in the larger bottom margin.
- One frame design with settings: border width, light or dark frame, and a switch per field.
- Coordinates are the location. They print as degrees, minutes and seconds by default, with
  decimal degrees as a setting. There are no place names and no geocoding.
- Six bundled typefaces, IBM Plex Mono by default, plus a font file dropped into the data
  folder as an override. See [ADR 0001](adr/0001-mit-license.md).
- Text is converted to outlines before compositing, so a frame renders the same everywhere.
- The Frame screen previews with the same renderer that produces the post, at reduced size,
  debounced while a setting changes.
- Published images carry no embedded metadata.

### Captions and alt text

- Captions and alt text are templates built from tokens: coordinates, date, camera, lens, focal
  length, shutter, aperture and ISO.
- Named hashtag sets rotate at random.
- The default caption is coordinates, then gear, then one hashtag set. The default alt text is
  "Photograph taken on {date} with {camera}".
- A caption or alt text written for one select replaces the template for it.

### Location privacy

- A privacy zone is a point and a radius, set by typing coordinates, by using a select's own
  location, or on a map.
- A select inside any zone, or with no GPS data, has no coordinates on its frame, in its caption
  or in the manifest.
- Any other select can have its location hidden individually.

### Instagram

- Publishing uses the Instagram API with Instagram Login. See
  [ADR 0003](adr/0003-instagram-publishing.md).
- The account is connected by pasting a long-lived token into settings. Selects refreshes it,
  never shows it again and never logs it.
- Posts are single images. A post is modelled as a list of selects so carousels can follow.
- Removing a post from Instagram is done in the Instagram app.

### Storage

- Any S3-compatible bucket: endpoint, bucket, keys and an optional public base URL.
- With a public base URL, everything works. Without one, the frame is published through a
  one-hour presigned link and gallery output is unavailable.
- Object keys are random IDs, never original file names.

### Gallery output

- A switch, off by default. On, each post also writes a clean 2048 px image and an entry in
  `posts.json`: image URLs, caption, capture data, coordinates, date and the Instagram
  permalink.
- Off, the framed image is deleted from the bucket once published.
- "Remove from gallery" deletes a post's public files and manifest entry. The select stays
  marked as posted.
- The manifest format is fixed in version 1 so a gallery or map can be built against it.

### Notifications

- Two channels: an ntfy topic and a generic webhook.
- Four events, each switchable: posted, failed, token about to expire, pool running low (below
  a threshold you set).

### Interface

- Six screens, designed for a phone first: Library, Queue, Posted, Frame, Captions, Settings.
- The Library has a map view of where selects were taken.
- Light and dark follow the device.
- Installable as a PWA, online only.
- No login by default. An optional single password is set by environment variable.

### Configuration and operations

- Bucket credentials and the optional password come from environment variables. The Instagram
  token is stored in the database. Everything else is set in the UI.
- The database is copied nightly into the data volume, keeping seven copies.
- The server makes outside requests only to Instagram, the bucket and the notification
  channels. Map tiles are fetched by the browser.
- A container image is published for amd64 and arm64 on each version tag, with an Unraid
  template in the repo.

## Versions

- **Version 1** runs on a home server and posts framed selects on schedule, writing gallery
  output as it goes.
- **Version 2** adds a static public gallery page that reads the manifest.

## Later, if asked for

Place names from geocoding, carousels and stories, more frame designs, a "Connect Instagram"
login flow, AI-written alt text, and sharing into the app from a phone's share sheet.
