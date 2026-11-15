#!/usr/bin/env bash
# End-to-end: POST /render (narration) -> lint report + hand-off dir + valid 1080x1920 h264/aac, -13 LUFS target.
set -euo pipefail
URL=${RENDER_URL:-http://127.0.0.1:3030}
resp=$(curl -sf --noproxy '*' -m 900 -X POST "$URL/render" -H 'content-type: application/json' -d '{
  "title": "Ngủ đủ là bao nhiêu",
  "flow": "A",
  "outroHold": 3,
  "facts": [{"id": "f1", "claim": "smoke test only", "source": "https://example.com"}],
  "scenes": [
    {"id": "hook", "lines": [{"text": "Ngủ tám tiếng chưa chắc đã là ngủ đủ với cơ thể của bạn.", "fact": "f1"}]},
    {"id": "share", "lines": [{"text": "Gửi video này cho người hay thức khuya nhất mà bạn quen."}]}
  ]
}')
echo "$resp"
read -r video out < <(printf '%s' "$resp" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["url"], r["out"])')
info=$(ffprobe -v error -show_entries stream=codec_name,width,height,pix_fmt,color_space,sample_rate -of csv=p=0 "$video")
echo "$info"
grep -q 'h264,1080,1920,yuv420p,bt709' <<<"$info" || { echo "FAIL: video format"; exit 1; }
grep -q 'aac,48000' <<<"$info" || { echo "FAIL: audio format"; exit 1; }
for f in cover.png cover-thumbtest.png caption.txt pinned-comment.txt narration.json lint.json; do [ -s "$out/$f" ] || { echo "FAIL: missing $f"; exit 1; }; done
ffmpeg -hide_banner -nostats -i "$video" -af ebur128 -f null - 2>&1 | grep -E '^\s+I:' | tail -1
echo "SMOKE OK"
