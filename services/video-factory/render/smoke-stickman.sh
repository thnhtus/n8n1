#!/usr/bin/env bash
# Stickman cast: render a clip with a 3-figure cast and a Lottie wave.
set -euo pipefail
URL=${RENDER_URL:-http://127.0.0.1:3030}
resp=$(curl -sf --noproxy '*' -m 900 -X POST "$URL/render" -H 'content-type: application/json' -d '{
  "title": "Stickman cast",
  "flow": "A",
  "outroHold": 3,
  "facts": [{"id": "f1", "claim": "smoke test only", "source": "https://example.com"}],
  "scenes": [
    {"id": "hook", "actor": {"action": "walk", "mood": "happy", "cast": 3}, "lines": [{"text": "Ba người bạn đi dọc bờ biển, mỗi người mang một trái tim khác nhau.", "fact": "f1"}]},
    {"id": "share", "actor": {"lottie": "stickman-wave.json"}, "lines": [{"text": "Gửi video này cho người đang đứng im giữa dòng đời."}]}
  ]
}')
echo "$resp"
read -r video out < <(printf '%s' "$resp" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["url"], r["out"])')
info=$(ffprobe -v error -show_entries stream=codec_name,width,height,pix_fmt,color_space,sample_rate -of csv=p=0 "$video")
echo "$info"
grep -q 'h264,1080,1920,yuv420p,bt709' <<<"$info" || { echo "FAIL: video format"; exit 1; }
for f in cover.png caption.txt narration.json lint.json; do [ -s "$out/$f" ] || { echo "FAIL: missing $f"; exit 1; }; done
python3 -c "import json; n=json.load(open('$out/narration.json')); assert n['scenes'][0]['actor']['action']=='walk'; assert n['scenes'][1]['actor']['lottie']=='stickman-wave.json'; l=json.load(open('$out/lint.json')); assert not l['errors'], l['errors']"
echo "STICKMAN SMOKE OK"
