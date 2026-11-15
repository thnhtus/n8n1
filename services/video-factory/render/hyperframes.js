// HyperFrames second-runtime adapter: builds deterministic HTML+GSAP+assets, writes *.motion.json, runs `hyperframes check` + `render`.
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Build index.html + index.motion.json, verify with `hyperframes check`, and render raw MP4. */
export async function renderHyperFrames({ tmp, id, title, scenes, lineTimings, outroHold, totalSec, safe, fps, crf, hookVisibleBySec = 0.5 }) {
	const hfDir = join(tmp, 'hf');
	const assets = join(hfDir, 'assets');
	mkdirSync(assets, { recursive: true });
	copyFileSync(join(ROOT, 'assets/gsap.min.js'), join(assets, 'gsap.min.js'));
	lineTimings.forEach((l, i) => copyFileSync(l.audioPath, join(assets, `l${i}.mp3`)));

	const sceneGroups = scenes.map((s, si) => {
		const ls = lineTimings.filter((l) => l.scene === s.id);
		const start = ls[0].start;
		const end = si === scenes.length - 1 ? totalSec : ls[ls.length - 1].end;
		return { id: s.id, index: si, start, dur: Math.max(0.1, end - start), lines: ls, visual: s.visual };
	});

	const sceneHtml = sceneGroups.map((sg) => {
		const linesHtml = sg.lines.map((l) => {
			const words = l.text.split(/\s+/).filter(Boolean).map((w) => `<span class="word">${esc(w)}</span>`).join(' ');
			return `<span id="line-${l.index}" class="line">${words}</span>`;
		}).join('\n');
		return `<section id="scene-${sg.index}" class="clip scene" data-start="${sg.start.toFixed(3)}" data-duration="${sg.dur.toFixed(3)}" data-track-index="${sg.index + 3}" data-variant="${sg.index % 4}">${linesHtml}</section>`;
	}).join('\n');

	const audioHtml = lineTimings.map((l, i) =>
		`<audio id="audio-${i}" src="assets/l${i}.mp3" data-start="${l.start.toFixed(3)}" data-duration="${l.audioDur.toFixed(3)}" data-track-index="0"></audio>`
	).join('\n');

	const marginX = Math.round((safe.width - safe.panelMaxWidthPx) / 2);
	const stageH = safe.bottomPx - safe.topPx;
	const html = `<!doctype html>
<html lang="vi">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1080, height=1920" />
<script src="assets/gsap.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1080px; height: 1920px; overflow: hidden; background: #0b0d12; color: #f6f7f9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #root { position: relative; width: 1080px; height: 1920px; }
  #bg { position: absolute; inset: 0; background: radial-gradient(circle at 50% 35%, hsl(220,38%,18%), #090b10 72%); }
  #stage { position: absolute; top: ${safe.topPx}px; left: ${marginX}px; width: ${safe.panelMaxWidthPx}px; height: ${stageH}px; display: flex; flex-direction: column; justify-content: space-between; padding: 24px 0; }
  #title { font-size: 40px; font-weight: 700; color: rgba(255,255,255,0.86); letter-spacing: -0.02em; line-height: 1.25; }
  #scene-box { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; }
  .scene { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; gap: 28px; opacity: 0; }
  .line { display: block; font-size: 60px; font-weight: 800; line-height: 1.25; text-align: center; text-shadow: 0 4px 20px rgba(0,0,0,0.65); }
  .word { display: inline-block; margin-right: 0.14em; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${totalSec.toFixed(3)}" data-width="1080" data-height="1920">
  <div id="bg"></div>
  <div id="stage">
    <h1 id="title" class="clip" data-start="0" data-duration="${totalSec.toFixed(3)}" data-track-index="2">${esc(title)}</h1>
    <div id="scene-box">${sceneHtml}</div>
  </div>
  ${audioHtml}
</div>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  // Title is on screen at frame 0 (thumbnail); the bg drifts slowly so no stretch is fully static.
  tl.set("#title", { opacity: 1 }, 0);
  tl.fromTo("#bg", { scale: 1, rotation: 0 }, { scale: 1.12, rotation: 4, duration: ${totalSec.toFixed(3)}, ease: "none" }, 0);
  const scenes = ${JSON.stringify(sceneGroups.map((sg) => ({ index: sg.index, start: sg.start, dur: sg.dur, isLast: sg.index === sceneGroups.length - 1, lines: sg.lines.map((l) => ({ index: l.index, start: l.start, end: l.end })) })))};
  for (const sc of scenes) {
    const sel = "#scene-" + sc.index;
    const v = sc.index % 4;
    if (sc.index === 0) tl.set(sel, { opacity: 1 }, 0);
    else if (v === 0) tl.fromTo(sel, { opacity: 0, y: 20, filter: "blur(6px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.26, ease: "expo.out" }, sc.start);
    else if (v === 1) tl.fromTo(sel, { opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1, duration: 0.24, ease: "power4.out" }, sc.start);
    else if (v === 2) tl.fromTo(sel, { opacity: 0, x: -18 }, { opacity: 1, x: 0, duration: 0.24, ease: "expo.out" }, sc.start);
    else tl.fromTo(sel, { opacity: 0, y: -14 }, { opacity: 1, y: 0, duration: 0.24, ease: "power4.out" }, sc.start);

    for (const ln of sc.lines) {
      const ws = document.querySelectorAll("#line-" + ln.index + " .word");
      tl.fromTo(ws, { opacity: 0.35, y: 8 }, { opacity: 1, y: 0, duration: 0.16, stagger: 0.06, ease: "expo.out" }, ln.start);
    }
    if (!sc.isLast) {
      tl.to(sel, { opacity: 0, y: -10, duration: 0.14, ease: "power3.in" }, Math.max(sc.start + 0.1, sc.start + sc.dur - 0.14));
    }
    tl.to("#bg", { filter: "hue-rotate(" + ((sc.index * 28) % 360) + "deg)", duration: 0.35, ease: "power2.out" }, sc.start);
  }
  window.__timelines["main"] = tl;
  tl.seek(0);
</script>
</body>
</html>`;

	writeFileSync(join(hfDir, 'index.html'), html);

	const assertions = [
		{ kind: 'appearsBy', selector: '#title', bySec: hookVisibleBySec },
		{ kind: 'staysInFrame', selector: '#title' },
		{ kind: 'appearsBy', selector: '#scene-0', bySec: hookVisibleBySec },
		...sceneGroups.slice(1).map((sg, idx) => ({ kind: 'before', a: `#scene-${idx}`, b: `#scene-${sg.index}` })),
		{ kind: 'keepsMoving', withinSelector: '#stage', maxStaticSec: Math.max(4, Math.ceil(outroHold) + 1) },
	];
	writeFileSync(join(hfDir, 'index.motion.json'), JSON.stringify({ version: 1, duration: Number(totalSec.toFixed(3)), assertions }, null, 2));

	const checkRes = await run('npx', ['--yes', 'hyperframes@0.9.52', 'check', hfDir, '--json', '--strict'], { maxBuffer: 10 * 1024 * 1024 }).catch((e) => {
		let msg = e.message;
		try {
			const r = JSON.parse(e.stdout);
			const items = [
				...(r.findings ?? []),
				...(r.lint?.findings ?? []),
				...(r.runtime?.findings ?? []),
				...(r.layout?.findings ?? []),
			].map((f) => `${f.severity ?? ''} ${f.code ?? f.rule ?? ''}: ${f.message ?? ''}`.trim());
			msg = items.length ? items.slice(0, 20).join('\n') : JSON.stringify(r).slice(0, 1500);
		} catch {
			msg = (e.stdout || '').slice(0, 1500) || (e.stderr || '').slice(-1500) || e.message;
		}
		throw new Error(`hyperframes check failed:\n${msg}`);
	});
	let checkReport;
	try { checkReport = JSON.parse(checkRes.stdout); } catch { checkReport = { raw: checkRes.stdout }; }

	const rawOut = join(tmp, 'raw.mp4');
	await run('npx', [
		'--yes', 'hyperframes@0.9.52', 'render', hfDir,
		'-o', rawOut, '--resolution', 'portrait', '--fps', String(fps), '--crf', String(crf), '--json', '--no-best-effort',
	], { maxBuffer: 10 * 1024 * 1024 }).catch((e) => {
		throw new Error(`hyperframes render failed: ${e.stderr || e.stdout || e.message}`);
	});

	return { rawOut, checkReport, hfDir };
}
