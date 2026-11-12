# ADR 0003: Publish through the Instagram API with a pasted token and a bucket URL

## Status

Accepted, November 12, 2026.

## Context

The Instagram API publishes only to professional accounts, and takes an image as a URL that
Meta fetches itself; there is no byte upload for images. It accepts JPEG only, up to 8 MB, up
to 1440 px wide, with an aspect ratio between 4:5 and 1.91:1, and has no scheduling. An app in
development mode can publish to an account that holds a role on it, with no app review. Meta's
[content publishing guide](https://developers.facebook.com/docs/instagram-platform/content-publishing)
is the reference.

## Decision

- Use the Instagram API with Instagram Login and the scopes `instagram_business_basic` and
  `instagram_business_content_publish`.
- The user creates their own Meta app, adds their account as a tester and pastes a long-lived
  token into settings. Selects refreshes it before its 60-day expiry.
- The rendered frame is uploaded to the bucket and its URL is handed to Meta: the public URL
  when a public base URL is configured, a one-hour presigned URL otherwise.
- Selects owns the schedule and publishes at the slot's time.
- Development and tests talk to a fake Instagram server. Nothing in CI can reach Instagram.

## Consequences

- The app never needs to be reachable from the internet.
- No location tag: it requires a Facebook Page and the Facebook Login flavor of the API.
- No deleting posts: that endpoint is also Facebook Login only.
- Presigned URLs are inferred to work from Meta fetching at request time. Private-bucket mode
  is documented as supported only after it passes a real publish.
