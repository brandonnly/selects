# syntax=docker/dockerfile:1

# Selects in one image: the server and the built UI, with everything it keeps in the /data
# volume. CI builds it on every pull request and publishes it on each version tag.

# Bun's official image on Debian slim, at the version in package.json's `packageManager`, pinned
# to its multi-platform index. Debian means glibc, which sharp ships prebuilt binaries for on
# both linux/amd64 and linux/arm64.
ARG BUN_IMAGE=oven/bun:1.3.12-slim@sha256:d3c7094c144dd3975d183a4dbc4ec0a764223995bff73290d983edb47043a75f

# The UI is static files, so it is built once, on the build machine's own platform.
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS web
WORKDIR /src
COPY package.json bun.lock ./
COPY server/package.json server/
COPY web/package.json web/
RUN bun install --frozen-lockfile
COPY brand/favicon brand/favicon
COPY brand/tokens brand/tokens
COPY web web
RUN bun run build

# The server's production dependencies for the target platform. They are installed on the build
# machine's platform with --os and --cpu choosing sharp's binaries, so nothing runs emulated.
# The image is glibc, so sharp's musl builds, which would never load, are removed. /volume/data
# becomes the volume's mount point, owned by the image's user so a new named volume is writable.
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS deps
ARG TARGETARCH
WORKDIR /src
COPY package.json bun.lock ./
COPY server/package.json server/
COPY web/package.json web/
RUN case "$TARGETARCH" in \
      amd64) cpu=x64 ;; \
      arm64) cpu=arm64 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && bun install --frozen-lockfile --production --filter @selects/server --os=linux --cpu="$cpu" \
    && rm -rf node_modules/.bun/@img+sharp-linuxmusl-* node_modules/.bun/@img+sharp-libvips-linuxmusl-* \
    && mkdir -p /volume/data

FROM ${BUN_IMAGE}
LABEL org.opencontainers.image.title="Selects" \
      org.opencontainers.image.description="Posts a photographer's backlog to Instagram on a schedule, each photo on a frame with its capture data." \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
# Only what the server reads at run time: its code, fonts, the login page's tokens, the root
# package.json for the version, and the built UI. No tests, references or dev dependencies.
COPY package.json ./
COPY --from=deps /src/node_modules node_modules
COPY --from=deps /src/server/node_modules server/node_modules
COPY server/package.json server/
COPY server/src server/src
COPY server/fonts server/fonts
COPY brand/tokens/selects.css brand/tokens/
COPY --from=web /src/web/dist web/dist
COPY --from=deps --chown=1000:1000 /volume/ /

# INSTAGRAM_API is left unset: Selects runs in fake mode until it is set to `live`.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
VOLUME /data
EXPOSE 3000
# The base image's user, uid and gid 1000. On Unraid the template runs it as 99:100 instead.
USER bun

# Bun has no curl to lean on; it asks the server itself. /api/health answers without the
# optional password, saying only whether the app is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Exec form with Bun as PID 1, so SIGTERM reaches the server, which finishes requests in flight
# and closes the database before it exits.
ENTRYPOINT ["bun", "server/src/main.ts"]
