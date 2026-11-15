# Video Factory (embedded)

Short vertical video pipeline (1080×1920) driven by n8n. The full plan is in
[PLAN.md](PLAN.md).

```text
n8n workflow → 9Router LLM (script) → render service :3030 (TTS + Remotion)
            → S3/RustFS bucket → presigned URL back to n8n
```

## Layout

| Path | What it is |
| --- | --- |
| `render/` | Express render service + Remotion compositions. Own `package.json`, not part of the pnpm workspace |
| `workflows/` | n8n workflow JSON to import (`generate-video.json`, `publish-template.json`) |
| `render/analytics.js` | Analytics + Learning Engine (SQLite `data/analytics.sqlite`) — ghi nhận video, nạp metric, `GET /analytics/learn` |
| `render/strategy.js` | Trend Intelligence: `GET /trends/refill` (Google Trends VN → LLM → topic mới vào queue) |
| `render/topics.js` | Content queue (`content/queue.json`): `GET /topic/next`, `POST /topic/done`, `POST /topic/add` |
| `render/publishers.js` | Multi-platform publish (`POST /publish`, platform: tiktok/youtube/meta) |
| `docs/` | SOUL, thresholds, 20 flows, shot dictionary, facts ledger |
| `launchd/` | launchd plists for the render service and the daily backup |
| `backup.sh` | Backup of n8n SQLite database, encryption key, S3 data |

## Setup on a new machine

Entire stack (n8n + render + RustFS), one command:

```bash
# 1. Stop the host n8n and render jobs so ports 5678/3030 are free
launchctl unload ~/Library/LaunchAgents/vn.n8n.dev.plist
launchctl unload ~/Library/LaunchAgents/vn.videofactory.render.plist

# 2. Start everything. RustFS keeps its data in ${FACTORY_DATA_DIR}/s3.
cd services/video-factory
docker compose up -d --build
open http://localhost:5678
```

n8n in Docker reuses `${N8N_HOME:-~/.n8n}` (same workflows and credentials as the
host n8n) via a bind mount, so nothing is imported twice. Do not run the host
n8n and the container at the same time: one SQLite file, one writer.

Just the render + RustFS services (n8n stays on the host, launchd):

```bash
cd services/video-factory && docker compose up -d --build rustfs render
```

Credentials must still exist in n8n (`9Router` HTTP, `RustFS (local S3)`, TikTok).
They are not in the repository. Expose and keep them in your own `~/.n8n`.

## Not committed

`.env`, `data/` (object storage), `out/` (rendered packages) and
`render/node_modules` are ignored. Copy them from the existing instance if you
move a running deployment.
