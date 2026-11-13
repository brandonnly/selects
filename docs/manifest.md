# The gallery manifest

With gallery output on, Selects keeps `posts.json` at the root of the bucket, read from the
bucket's public base URL (`BUCKET_PUBLIC_URL`). It lists every post in the gallery, newest
first, for a gallery page, a map or any other site to build on. See "Gallery output" in
[PRODUCT.md](PRODUCT.md) and [ADR 0008](adr/0008-gallery-output.md).

This is version 1 of the format, fixed for version 1 of Selects. A reader checks `version` and
ignores a field it does not know; a change that would break a reader comes as a new version.
Version 1 lists one image per post, as every post is a single image; carousels would come as a
new version.

## Example

```json
{
  "version": 1,
  "posts": [
    {
      "id": "0b6f3c1e-2f43-4a57-9d55-6a1c1f4f8a10",
      "postedAt": "2026-11-13T09:00:00.000Z",
      "permalink": "https://www.instagram.com/p/EXAMPLE/",
      "caption": "20°30'00\"S 120°45'00\"W\nFixture Optics FX-3 · Fixture 85mm F1.8\n\n#film",
      "altText": "Photograph with Fixture Optics FX-3",
      "images": {
        "clean": { "url": "https://cdn.example.org/gallery/5d1c….jpg", "width": 2048, "height": 1365 },
        "framed": { "url": "https://cdn.example.org/frames/9a7e….jpg", "width": 1440, "height": 1800 }
      },
      "capture": {
        "camera": "Fixture Optics FX-3",
        "lens": "Fixture 85mm F1.8",
        "focalLength": 85,
        "exposureTime": 0.004,
        "fNumber": 1.8,
        "iso": 100,
        "takenAt": "2025-03-04T05:06:07"
      },
      "location": { "latitude": -20.5, "longitude": -120.75 }
    }
  ]
}
```

## Fields

Every field is always present. A value the select lacks is `null`, never left out.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | number | The format's version: `1`. |
| `posts` | array | One entry per post in the gallery, newest first, then by `id`. |
| `posts[]` | object | A post. |
| `posts[].id` | string | The post's ID: random, stable, and saying nothing about the photo. |
| `posts[].postedAt` | string | When it was published, in UTC, as ISO 8601. For a post its owner marked as posted by hand, when it was marked. |
| `posts[].permalink` | string or null | The post on Instagram. Null when Instagram's link could not be found. |
| `posts[].caption` | string | The caption as posted; once its location is withheld, as it reads without it, or empty if written by hand (see below). |
| `posts[].altText` | string | The alt text as posted, on the same terms. |
| `posts[].images` | object | The post's public images. |
| `posts[].images.clean` | object | The photo with no frame. |
| `posts[].images.clean.url` | string | Its public URL, on the public base URL as it is when the manifest is written. |
| `posts[].images.clean.width` | number | Its width in pixels. |
| `posts[].images.clean.height` | number | Its height in pixels. |
| `posts[].images.framed` | object or null | The framed image posted to Instagram. Null when it was not kept: a post confirmed published after its frame was deleted, or one whose location was withheld after it was posted, since the frame prints it. |
| `posts[].images.framed.url` | string | Its public URL. |
| `posts[].images.framed.width` | number | 1440. |
| `posts[].images.framed.height` | number | 1800. |
| `posts[].capture` | object | The capture data the post was published with. |
| `posts[].capture.camera` | string or null | Camera make and model. |
| `posts[].capture.lens` | string or null | Lens. |
| `posts[].capture.focalLength` | number or null | Focal length in millimetres. |
| `posts[].capture.exposureTime` | number or null | Shutter speed in seconds: `0.004` is 1/250 s. |
| `posts[].capture.fNumber` | number or null | Aperture: `1.8` is f/1.8. |
| `posts[].capture.iso` | number or null | ISO. |
| `posts[].capture.takenAt` | string or null | When it was taken, local time as the camera recorded it, with no zone: `YYYY-MM-DDTHH:MM:SS`. |
| `posts[].location` | object or null | Where it was taken. Null when its location is withheld. |
| `posts[].location.latitude` | number | Decimal degrees, north positive, to four places (about 11 m), as the frame prints them. |
| `posts[].location.longitude` | number | Decimal degrees, east positive, to four places. |

## Images

- Each image has its own random key. Keys never carry a file name, and images never change once
  written. The clean image is served with `Cache-Control: public, max-age=31536000, immutable`.
- The clean image is the photo upright with no frame, 2048 px on its long side (never enlarged
  from a smaller original), in sRGB, as a JPEG with no embedded metadata of any kind.
- The framed image is the 1440 × 1800 JPEG Instagram was given, also with no metadata. It has no
  `Cache-Control` of its own: it is cached as the bucket and any CDN in front of it decide.

## The manifest file

- `posts.json` is served as `application/json; charset=utf-8` with `Cache-Control: no-cache`:
  a reader checks with the bucket on every load and gets a new post or a removal at once.
- A site on another origin reads it only if the bucket allows it: set a CORS rule on the bucket
  allowing `GET` from the gallery's origin.
- Selects writes the whole file from its database each time; it never reads the bucket's copy.
  An entry is listed only once its images are stored, and an image is deleted only once a
  manifest without it is stored, so an entry never points at a missing image.

## Location privacy

An entry never carries coordinates that Selects withholds (see "Location privacy" in
[PRODUCT.md](PRODUCT.md) and [ADR 0004](adr/0004-location-privacy-rules.md)): not in `location`,
not in `caption` or `altText`, and not in a framed image. An entry lists what its post was sent
with. Its location is listed only while the select is still in the library, still has the same
coordinates it was posted with, and is in no privacy zone.

When a location is hidden, a privacy zone added or the select deleted after a post, its entry is
rewritten with `location` and `images.framed` null, and the framed image is deleted. Its caption
and alt text become the ones Selects built, when it was posted, from the same templates and
hashtags without the coordinates. A caption or alt text written by hand for the select cannot be
cleaned of coordinates safely, so it is listed as an empty string.

The rewrite happens on the next run of the gallery's timer, every 30 seconds, while the bucket
accepts writes. It does not happen while Selects is stopped, or while it runs in the other mode
(fake or live) from the one the post was made in. Copies a reader or cache took before then are
beyond Selects' reach.

## Removing a post

"Remove from gallery" on the Posted screen takes a post's entry out of `posts.json`, then
deletes its images. The post stays on Instagram and its select stays posted.
