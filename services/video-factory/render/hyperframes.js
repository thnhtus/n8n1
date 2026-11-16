// HyperFrames second-runtime adapter: builds deterministic HTML+GSAP+assets,
// writes *.motion.json, runs `hyperframes check` + `render`.
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Build index.html + index.motion.json, verify with `hyperframes check`, and render raw MP4. */
export async function renderHyperFrames({ tmp, id, title, scenes, lineTimings, outroHold, totalSec, safe, fps, crf, hookVisibleBySec = 0.5 }) {
	const hfDir = join(tmp, 'hf');
	const assets = join(hfDir, 'assets');
	mkdirSync(assets, { recursive: true });
	copyFileSync(join(ROOT, 'assets/gsap.min.js'), join(assets, 'gsap.min.js'));
	lineTimings.forEach((l, i) => copyFileSync(l.audioPath, join(assets, `l${i}.mp3`)));

	const sceneGroups = scenes.map((s, si) => {
		const ls = lineTimings.filter((l) => l.scene === s.id);
		const start = ls[0]?.start ?? 0;
		const end = si === scenes.length - 1 ? totalSec : (ls[ls.length - 1]?.end ?? start);
		return { id: s.id, index: si, start, dur: Math.max(0.1, end - start), lines: ls, visual: s.visual, bgUrl: s.bgUrl };
	});

	const visualHtml = (v) => {
		if (!v || !v.type) return '';
		if (v.type === 'quote') return `<div class="gfx quote">“${esc(v.quote ?? v.title ?? v.label ?? '')}”${v.author || v.subtitle ? `<div class="sub">— ${esc(v.author ?? v.subtitle)}</div>` : ''}</div>`;
		if (v.type === 'bullets' || v.type === 'list') {
			const items = (Array.isArray(v.items) ? v.items : []).slice(0, 5).map((it) => `<li>${esc(it)}</li>`).join('');
			return `<div class="gfx bullets">${v.title || v.label ? `<div class="gtitle">${esc(v.title ?? v.label)}</div>` : ''}<ul>${items}</ul></div>`;
		}
		if (v.type === 'stat') return `<div class="gfx stat"><div class="big">${esc(v.prefix ?? '')}${esc(v.value ?? '')}${esc(v.suffix ?? '')}</div>${v.label ? `<div class="sub">${esc(v.label)}</div>` : ''}</div>`;
		if (v.type === 'ring') return `<div class="gfx stat"><div class="big">${esc(v.percent ?? v.value ?? '')}%</div>${v.label ? `<div class="sub">${esc(v.label)}</div>` : ''}</div>`;
		if (v.type === 'steps') {
			const items = (Array.isArray(v.items) ? v.items : []).slice(0, 5).map((it, i) => `<li><span class="n">${i + 1}</span>${esc(it)}</li>`).join('');
			return `<div class="gfx bullets"><ul class="steps">${items}</ul></div>`;
		}
		if (v.type === 'compare' && v.a && v.b) return `<div class="gfx bullets"><div class="gtitle">So sánh</div><ul><li><span class="n">A</span>${esc(v.a.label ?? 'A')}: ${esc(v.a.value)}</li><li><span class="n">B</span>${esc(v.b.label ?? 'B')}: ${esc(v.b.value)}</li></ul></div>`;
		const titleText = v.title ?? v.label;
		if (!titleText && !v.subtitle && !v.tag) return '';
		return `<div class="gfx card">${v.tag ? `<div class="tag">${esc(v.tag)}</div>` : ''}${titleText ? `<div class="gtitle">${esc(titleText)}</div>` : ''}${v.subtitle ? `<div class="sub">${esc(v.subtitle)}</div>` : ''}</div>`;
	};
	const bgSrc = (u) => (u ? String(u).replace(/^https?:\/\/localhost:9000/, 'http://127.0.0.1:9000') : '');

	const sceneHtml = sceneGroups.map((sg) => {
		const linesHtml = sg.lines.map((l) => {
			const words = l.text.split(/\s+/).filter(Boolean).map((w) => `<span class="word">${esc(w)}</span>`).join(' ');
			return `<span id="line-${l.index}" class="line">${words}</span>`;
		}).join('\n');
		const bg = bgSrc(sg.bgUrl);
		const gfx = visualHtml(sg.visual);
		return `<section id="scene-${sg.index}" class="clip scene" data-start="${sg.start.toFixed(3)}" data-duration="${sg.dur.toFixed(3)}" data-track-index="${sg.index + 3}" data-variant="${sg.index % 4}">${bg ? `<img class="bgimg" src="${esc(bg)}"/>` : ''}<div class="shade"></div><div class="gfxwrap">${gfx}</div><div class="linestack">${linesHtml}</div></section>`;
	}).join('\n');

	const audioHtml = lineTimings.map((l, i) =>
		`<audio id="audio-${i}" src="assets/l${i}.mp3" data-start="${l.start.toFixed(3)}" data-duration="${(l.audioDur ?? l.dur).toFixed(3)}" data-track-index="0"></audio>`
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
  html, body { width: 1080px; height: 1920px; overflow: hidden; background: #090b10; color: #f6f7f9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #root { position: relative; width: 1080px; height: 1920px; }
  #bg { position: absolute; inset: -8%; background: radial-gradient(circle at 50% 30%, hsl(220,38%,20%), #090b10 70%); }
  #grain { position:absolute; inset:0; background:repeating-linear-gradient(0deg,rgba(255,255,255,.02) 0 1px,transparent 1px 3px); opacity:.16; mix-blend-mode:soft-light; pointer-events:none; }
  #progress { position:absolute; left:${marginX}px; right:${marginX}px; top:${Math.max(18, safe.topPx - 26)}px; height:8px; border-radius:8px; background:rgba(255,255,255,.18); overflow:hidden; }
  #bar { height:100%; width:0%; background:linear-gradient(90deg,#ffd166,#06d6a0); box-shadow:0 0 18px rgba(255,209,102,.35); }
  #stage { position: absolute; top: ${safe.topPx}px; left: ${marginX}px; width: ${safe.panelMaxWidthPx}px; height: ${stageH}px; display: flex; flex-direction: column; justify-content: space-between; padding: 24px 0; }
  #title { font-size: 40px; font-weight: 800; color: rgba(255,255,255,0.9); letter-spacing: -0.02em; line-height: 1.25; text-shadow:0 4px 20px rgba(0,0,0,.45); }
  #scene-box { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; }
  .scene { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: flex-end; align-items:center; opacity: 0; overflow:hidden; }
  .bgimg { position:absolute; inset:-4%; width:108%; height:108%; object-fit:cover; opacity:.5; filter:saturate(1.1); }
  .shade { position:absolute; inset:0; background:linear-gradient(180deg,rgba(0,0,0,.12),rgba(0,0,0,.48) 55%,rgba(0,0,0,.7)); }
  .gfxwrap { position:absolute; top:70px; left:0; right:0; display:flex; justify-content:center; z-index:3; }
  .gfx { max-width:${safe.panelMaxWidthPx}px; padding:22px 28px; border-radius:24px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.18); backdrop-filter:blur(8px); text-align:center; }
  .gfx .big { font-size:92px; font-weight:900; color:#ffd166; line-height:1; text-shadow:0 4px 24px rgba(255,209,102,.3); }
  .gfx .gtitle { font-size:36px; font-weight:800; line-height:1.25; }
  .gfx .sub,.gfx .tag { margin-top:10px; font-size:24px; font-weight:700; color:rgba(255,255,255,.85); }
  .gfx.quote { font-size:38px; font-weight:800; line-height:1.3; background:linear-gradient(135deg,rgba(255,209,102,.18),rgba(255,255,255,.06)); border-color:rgba(255,209,102,.35); }
  .gfx.bullets ul { margin:12px 0 0; padding:0; list-style:none; text-align:left; }
  .gfx.bullets li { font-size:28px; font-weight:700; line-height:1.35; margin:10px 0; display:flex; gap:12px; align-items:flex-start; }
  .gfx.bullets .n { min-width:34px; height:34px; border-radius:17px; background:#ffd166; color:#111; display:inline-flex; align-items:center; justify-content:center; font-weight:900; }
  .linestack { position:relative; z-index:4; width:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:24px; padding-bottom:110px; min-height:45%; }
  .line { display: block; font-size: 60px; font-weight: 800; line-height: 1.25; text-align: center; text-shadow: 0 6px 28px rgba(0,0,0,0.6); max-width:${safe.panelMaxWidthPx}px; }
  .word { display: inline-block; margin-right: 0.14em; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${totalSec.toFixed(3)}" data-width="1080" data-height="1920">
  <div id="bg"></div>
  <div id="grain"></div>
  <div id="progress"><div id="bar"></div></div>
  <div id="stage">
    <h1 id="title" class="clip" data-start="0" data-duration="${totalSec.toFixed(3)}" data-track-index="2">${esc(title)}</h1>
    <div id="scene-box">${sceneHtml}</div>
  </div>
  ${audioHtml}
</div>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  tl.set("#title", { opacity: 1 }, 0);
  tl.fromTo("#title", { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: "power2.out" }, 0);
  tl.to("#bar", { width: "100%", duration: ${totalSec.toFixed(3)}, ease: "none" }, 0);
  tl.fromTo("#bg", { scale: 1.04, rotation: 0 }, { scale: 1.14, rotation: 1.2, duration: ${totalSec.toFixed(3)}, ease: "sine.inOut" }, 0);
  const scenes = ${JSON.stringify(sceneGroups.map((sg) => ({ index: sg.index, start: sg.start, dur: sg.dur, isLast: sg.index === sceneGroups.length - 1, lines: sg.lines.map((l) => ({ index: l.index, start: l.start, end: l.end })) })))};
  for (const sc of scenes) {
    const sel = "#scene-" + sc.index;
    const el = document.querySelector(sel);
    if (!el) continue;
    const v = sc.index % 4;
    if (sc.index === 0) tl.set(sel, { opacity: 1, scale: 1 }, 0);
    else if (v === 0) tl.fromTo(sel, { opacity: 0, y: 22, filter: "blur(6px)", scale: 1.03 }, { opacity: 1, y: 0, filter: "blur(0px)", scale: 1, duration: 0.28, ease: "expo.out" }, sc.start);
    else if (v === 1) tl.fromTo(sel, { opacity: 0, scale: 0.95 }, { opacity: 1, scale: 1, duration: 0.26, ease: "power4.out" }, sc.start);
    else if (v === 2) tl.fromTo(sel, { opacity: 0, x: -22 }, { opacity: 1, x: 0, duration: 0.26, ease: "expo.out" }, sc.start);
    else tl.fromTo(sel, { opacity: 0, y: -16 }, { opacity: 1, y: 0, duration: 0.26, ease: "power4.out" }, sc.start);

    const gfx = el.querySelector(".gfxwrap .gfx");
    if (gfx) tl.fromTo(gfx, { opacity: 0, y: 20, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.34, ease: "back.out(1.4)" }, sc.start + 0.04);

    for (const ln of sc.lines) {
      const lineEl = document.querySelector("#line-" + ln.index);
      if (!lineEl) continue;
      const ws = lineEl.querySelectorAll(".word");
      tl.to(lineEl, { opacity: 1, y: 0, duration: 0.16, ease: "power2.out" }, ln.start);
      if (ws.length) tl.fromTo(ws, { opacity: 0.35, y: 10 }, { opacity: 1, y: 0, duration: 0.18, stagger: Math.min(0.08, (ln.end - ln.start) / Math.max(6, ws.length)), ease: "power3.out" }, ln.start);
      tl.to(lineEl, { opacity: 0, y: -18, duration: 0.18, ease: "power2.in" }, Math.max(ln.start + 0.1, ln.end - 0.12));
    }
    if (!sc.isLast) tl.to(sel, { opacity: 0, scale: 0.988, duration: 0.22, ease: "power2.in" }, Math.max(sc.start + 0.2, sc.start + sc.dur - 0.08));
    tl.to("#bg", { filter: "hue-rotate(" + ((sc.index * 24) % 360) + "deg) saturate(1.12)", duration: 0.4, ease: "power2.out" }, sc.start);
  }
  for (const ln of ${JSON.stringify(lineTimings.map((l, i) => ({ i, start: l.start })))}) {
    const a = document.querySelector("#audio-" + ln.i);
    tl.call(() => { try { a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }, null, ln.start);
  }
  window.__timelines["main"] = tl;
  tl.seek(0);
  window.renderDone = false;
  tl.eventCallback("onComplete", () => { window.renderDone = true; });
  tl.play(0);
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
