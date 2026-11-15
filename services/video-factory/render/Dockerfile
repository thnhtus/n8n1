# Render service: Node 22 + Chromium (Remotion, HyperFrames) + FFmpeg.
# Build context is services/video-factory (see docker-compose.yml): code reads ../assets and ../docs.
# Chrome Headless Shell has no Linux ARM64 build, so both runtimes use Debian's chromium.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    ffmpeg chromium ca-certificates fonts-noto-core fonts-noto-color-emoji fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

ENV BROWSER_EXECUTABLE=/usr/bin/chromium \
    HYPERFRAMES_BROWSER_PATH=/usr/bin/chromium \
    HYPERFRAMES_NO_TELEMETRY=1

WORKDIR /app/render
COPY render/package.json render/package-lock.json ./
RUN npm ci --omit=dev
# Warm the npx cache so the first render does not download hyperframes.
RUN npx --yes hyperframes@0.9.52 --version

COPY render ./
COPY assets /app/assets
COPY docs /app/docs

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3030
EXPOSE 3030
CMD ["node", "server.js"]
