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
| `docs/` | SOUL, thresholds, 20 flows, shot dictionary, facts ledger |
| `launchd/` | launchd plists for the render service and the daily backup |
| `backup.sh` | Backup of n8n SQLite database, encryption key, S3 data |

## Setup on a new machine

```bash
cd services/video-factory/render && npm ci      # node_modules is not committed
cp ../.env.example ../.env                      # then fill the S3 keys
cd .. && docker compose up -d                   # RustFS on :9000
node render/server.js                           # or load launchd/vn.videofactory.render.plist
```

Import `workflows/generate-video.json` into n8n, then create the credentials it
references: `9Router` (HTTP), `RustFS (local S3)`, and TikTok. Credentials stay
in n8n, never in this repository.

## Not committed

`.env`, `data/` (object storage), `out/` (rendered packages) and
`render/node_modules` are ignored. Copy them from the existing instance if you
move a running deployment.
