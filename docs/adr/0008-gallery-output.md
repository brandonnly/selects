# ADR 0008: Gallery output is rebuilt from the database, and never holds up a post

## Status

Accepted, November 13, 2026.

## Context

[docs/PRODUCT.md](../PRODUCT.md) settles what gallery output is: a switch, a clean 2048 px image
and a `posts.json` entry per post, the framed image deleted when it is off, and "Remove from
gallery". It leaves open how the manifest is kept right while writes fail or Selects stops part
way, what happens to entries when location privacy changes after a post, what turning the
switch off does, and how fake mode tries it. Gallery output is public and read by other sites,
so a coordinate or file name in it is published for good.

## Decision

- **The database is the source of truth.** Each post in the gallery has a row with its object
  keys. Each post stores, in the same update that stores its caption, what it was sent with:
  the capture data `published(id)` gave, and its caption and alt text built again, with the
  same templates and hashtag set, with the coordinates left out. `posts.json` is rebuilt whole
  from those rows and written over the bucket's copy; it is never read back. Each URL in it is
  built on the public base URL when it is written, so a changed `BUCKET_PUBLIC_URL` moves every
  entry. Writes run one at a time, and are idempotent: a post is taken in once, and removed once.
- **Order of writes.** The clean image's key is recorded before its upload; an entry is listed
  once its image is stored; an image is deleted only once a manifest without it is stored, and
  goes through the cleanup record of [ADR 0006](0006-publishing-safety.md). A stop at any point
  leaves no entry pointing at a missing image and no image nothing knows about. The manifest is
  written once after each start, and whenever what it should hold changes. A manifest write
  given up on that lands late is never deleted, as a frame's would be: the manifest is written
  again at once, in case it landed over a newer one.
- **Gallery output never touches the post.** The update that records a post published also
  records whether gallery output was on. Such a post is taken in after that, and its frame is
  left for the gallery: a stop or a failure in between is taken up at the next start, or on the
  next run. Its writes run on a timer of their own (every 30 seconds) and are retried apart
  from the post: after 1, 5 and 15 minutes, then hourly for as long as they fail. A manifest
  that should hold something new (a privacy change, a removal) waits behind no such wait: it is
  tried on the next run. The Posted screen shows each post's gallery state and why a write is
  being retried.
- **Privacy wins after the fact.** An entry's coordinates are listed only while the select is
  still in the library, `published(id)` still gives it the same coordinates it was sent with,
  and no privacy zone holds them. Otherwise the entry is rewritten with no `location`, no framed
  image (it prints them; it is deleted through the cleanup record, never rendered again), and
  the caption and alt text stored for that case. Text cut from a caption could leave
  coordinates in a form no rule foresaw, so none is cut: a caption or alt text written by hand
  for the select is listed as empty. Other capture data stays as it was posted. This reaches
  the manifest on the next run of the gallery's timer while the bucket answers; not while
  Selects is stopped, or running in the other mode.
- **The switch.** Off by default, and available only with a public base URL, which the URLs in
  the manifest are built on; a presigned link is never listed. Turning it off stops new posts
  writing to the gallery. Posts already there stay until removed, and their entries keep
  following privacy changes.
- **Remove from gallery** marks the post at once and finishes in the background: the entry
  leaves the manifest, then its images are deleted. The post and its select are untouched.
- **Modes.** A row records its post's mode. Only a run in that mode writes or deletes its
  objects or lists it, and a removal asked for in the other mode is refused. In fake mode the
  fake bucket has a public base URL when `BUCKET_PUBLIC_URL` is set; its value is not used.
- **Caching.** Clean images are under random keys that never change: `public,
  max-age=31536000, immutable`. `posts.json` is `no-cache`, so readers see a removal or a
  privacy change at once. Since Bun's S3 client cannot set `Cache-Control`, these objects are
  uploaded through a presigned PUT that lasts five minutes, so a clock a little behind the
  bucket's does not fail every write, signed for the host only, with the headers sent beside
  it. The link is never logged or stored. The framed image is the one the publisher uploaded,
  which has no `Cache-Control` of its own.
- **Fake mode's bucket is in memory.** A fake-mode restart starts with it empty. At that start,
  fake-mode posts in the gallery are marked to be written again (the clean image is written
  again; the framed image, lost, is not rendered again and is listed as null), and those being
  removed are taken as removed, so the manifest never lists a missing file.
- **The format is version 1**, documented field by field in [docs/manifest.md](../manifest.md)
  and checked against what Selects writes.

## Consequences

- A copy of the manifest taken before a privacy change is beyond Selects' reach; the rewrite
  only stops further readers seeing the location.
- A post confirmed published after its frame was deleted (an unconfirmed post) is listed with no
  framed image.
- The framed image keeps the headers the publisher uploads it with, which set no caching.
- Withholding a location after the fact empties a hand-written caption in the manifest, even
  where it held no coordinates.
- Without a public base URL the manifest is not written at all, privacy changes included, until
  one is set again.
- In fake mode a restart loses the gallery's files; they are written again, less the framed
  images.
- Unverified until a live run: that the bucket in use accepts unsigned `Content-Type` and
  `Cache-Control` headers on a presigned PUT, as S3 documents.
