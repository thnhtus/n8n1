// SOUL + composition + visual linter and beat-grid math. Pure functions except reading config/assets.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const T = JSON.parse(readFileSync(new URL('../docs/soul/thresholds.json', import.meta.url)));
export const FLOWS = JSON.parse(readFileSync(new URL('../docs/flows/flows.json', import.meta.url)));

/** Graphics the Remotion renderer can draw with no external asset (render/src/visuals.jsx). */
export const VISUAL_TYPES = ["stat", "ring", "compare", "steps", "card", "text-as-image"];
/** Procedural stickman actions & moods (render/src/stickman.jsx). */
export const ACTOR_ACTIONS = ["idle", "walk", "run", "jump", "wave", "think", "cheer", "sit", "fall", "point", "shrug", "dance"];
export const ACTOR_MOODS = ["happy", "neutral", "sad"];

const words = (s) => s.split(/\s+/).filter(Boolean).length;
export const lines = (n) => n.scenes.flatMap((s) => s.lines.map((l) => ({ ...l, scene: s.id })));

/** Compute beat frame indices from index without cumulative drift. */
export function beatGrid(totalSec, bpm, offsetSec = 0, fps = T.video.fps) {
	if (!(bpm > 0)) return [];
	const framesPerBeat = (fps * 60) / bpm;
	const maxFrame = Math.ceil(totalSec * fps);
	const out = [];
	for (let idx = 0; ; idx++) {
		const f = Math.round(offsetSec * fps + idx * framesPerBeat);
		if (f > maxFrame) break;
		if (f >= 0) out.push(f);
	}
	return out;
}

/** Pad duration forward to the next beat boundary >= sec (never clips speech). */
export function snapDurationToBeat(sec, bpm, offsetSec = 0, fps = T.video.fps) {
	if (!(bpm > 0)) return sec;
	const beatSec = 60 / bpm;
	const idx = Math.ceil((sec - offsetSec) / beatSec - 1e-6);
	const snapped = offsetSec + Math.max(0, idx) * beatSec;
	const f = Math.ceil(snapped * fps);
	return Math.max(sec, f / fps);
}

/** Variation + slideshow-risk check when scenes include optional `visual` metadata. */
export function lintVisuals(n) {
	const errors = [];
	const warnings = [];
	const scenes = n.scenes ?? [];
	for (const s of scenes) if (!s.visual && !s.actor) errors.push(`[${s.id}] thiếu scene.visual (nguy cơ slideshow)`);
	const withVis = scenes.filter((s) => s.visual || s.actor);
	if (!withVis.length) return { errors, warnings, slideshowRisk: null };

	// Code-rendered graphics and stickman casts animate by themselves.
	const shots = withVis.map((s) => s.visual?.shotSize ?? s.visual?.type ?? s.actor?.action ?? 'medium');
	const motions = withVis.map((s) => s.visual?.motion ?? (VISUAL_TYPES.includes(s.visual?.type) ? 'graphic' : s.actor ? 'kinetic' : 'static'));
	const counts = {};
	for (const s of shots) counts[s] = (counts[s] ?? 0) + 1;
	const maxShare = Math.max(...Object.values(counts)) / shots.length;
	if (maxShare > T.variation.maxShotShare) warnings.push(`một cỡ cảnh chiếm ${(maxShare * 100).toFixed(0)}% > ${T.variation.maxShotShare * 100}%`);

	let run = 1;
	for (let i = 1; i < shots.length; i++) {
		run = shots[i] === shots[i - 1] ? run + 1 : 1;
		if (run > T.variation.maxSameShotRun) {
			errors.push(`${run} cảnh liên tiếp cùng cỡ "${shots[i]}"`);
			break;
		}
	}

	const staticShare = motions.filter((m) => m === 'static').length / motions.length;
	if (staticShare > T.variation.maxStaticShare) errors.push(`tỷ lệ cảnh tĩnh ${(staticShare * 100).toFixed(0)}% > ${T.variation.maxStaticShare * 100}%`);

	for (const s of withVis) {
		const v = s.visual;
		if (!v) continue;
		const t = v.type;
		if (t && !VISUAL_TYPES.includes(t)) errors.push(`[${s.id}] visual.type "${t}" không hỗ trợ (chỉ code-render được: ${VISUAL_TYPES.join(", ")})`);
		if (t === "stat" && !Number.isFinite(Number(v.value))) errors.push(`[${s.id}] visual stat thiếu value số`);
		if (t === "ring" && !Number.isFinite(Number(v.percent ?? v.value))) errors.push(`[${s.id}] visual ring thiếu percent (0-100)`);
		if (t === "compare" && (!v.a || !v.b || !Number.isFinite(Number(v.a.value)) || !Number.isFinite(Number(v.b.value)))) errors.push(`[${s.id}] visual compare cần a.label/a.value và b.label/b.value`);
		if (t === "steps" && (!Array.isArray(v.items) || !v.items.length)) errors.push(`[${s.id}] visual steps cần items[] không rỗng`);
		if ((t === "card" || t === "text-as-image") && !(v.title ?? v.label)) errors.push(`[${s.id}] visual ${t} cần title hoặc label`);
	}

	const avgWordsPerScene = scenes.reduce((a, s) => a + s.lines.reduce((x, l) => x + words(l.text), 0), 0) / scenes.length;
	const dims = {
		visualStagnation: Number((staticShare * 5).toFixed(1)),
		shotVariety: Number(((1 - Object.keys(counts).length / Math.min(4, scenes.length)) * 5).toFixed(1)),
		cutRhythm: scenes.length < 3 ? 4 : 1,
		motionPresence: Number((staticShare * 5).toFixed(1)),
		textOverload: avgWordsPerScene > 30 ? 4 : 1,
		hookEnergy: motions[0] === 'static' ? 4 : 1,
	};
	const avg = Object.values(dims).reduce((a, b) => a + b, 0) / 6;
	if (avg >= T.variation.slideshowRiskFail) errors.push(`slideshow risk ${avg.toFixed(1)}/5 >= ${T.variation.slideshowRiskFail}`);
	else if (avg >= 3) warnings.push(`slideshow risk ${avg.toFixed(1)}/5 (nên thêm chuyển động/đổi cỡ cảnh)`);
	return { errors, warnings, slideshowRisk: { avg: Number(avg.toFixed(2)), dims } };
}

/** Pre-render composition, runtime, profile, and asset/licence checks. */
export function lintComposition(n, opts = {}) {
	const errors = [];
	const warnings = [];
	const root = opts.rootDir ?? resolve(import.meta.dirname, '..');
	const assetsDir = opts.assetsDir ?? join(root, 'assets');
	const sourcesFile = opts.sourcesFile ?? join(root, 'docs/facts/sources.json');

	const runtime = n.runtime ?? 'remotion';
	if (!['remotion', 'hyperframes'].includes(runtime)) errors.push(`runtime "${runtime}" không hợp lệ (remotion|hyperframes)`);

	const profileName = n.profile ?? T.defaultProfile;
	if (!T.profiles?.[profileName]) errors.push(`profile "${profileName}" không tồn tại`);

	const safeAsset = (sub, rel) => {
		if (!rel || typeof rel !== 'string' || rel.includes('..') || rel.startsWith('/')) return null;
		const full = resolve(assetsDir, sub, rel);
		return full.startsWith(resolve(assetsDir, sub) + '/') ? full : null;
	};

	if (n.music) {
		const m = typeof n.music === 'string' ? { file: n.music } : n.music;
		const full = safeAsset('music', m.file);
		if (!full) errors.push(`music path không hợp lệ: "${m.file}"`);
		else if (!existsSync(full)) errors.push(`thiếu file music: assets/music/${m.file}`);

		let sources = [];
		if (existsSync(sourcesFile)) {
			try { sources = JSON.parse(readFileSync(sourcesFile, 'utf8')); } catch {}
		}
		const list = Array.isArray(sources) ? sources : sources.sources ?? [];
		const entry = list.find((s) => s.kind === 'music' && (s.file === m.file || s.src === m.file));
		if (!entry || !entry.license || /unknown/i.test(entry.license)) {
			errors.push(`music "${m.file}" chưa có bản quyền hợp lệ trong docs/facts/sources.json`);
		}
		if (m.inSec !== undefined && m.outSec !== undefined && m.outSec <= m.inSec) {
			errors.push(`music outSec (${m.outSec}) phải > inSec (${m.inSec})`);
		}
	}

	for (const s of n.scenes ?? []) {
		if (s.visual?.src) {
			const full = safeAsset('', s.visual.src);
			if (!full) errors.push(`[${s.id}] visual.src không hợp lệ: ${s.visual.src}`);
			else if (!existsSync(full)) errors.push(`[${s.id}] thiếu asset: assets/${s.visual.src}`);
		}
		if (s.actor) {
			const a = s.actor;
			if (a.action !== undefined && !ACTOR_ACTIONS.includes(a.action)) errors.push(`[${s.id}] actor.action "${a.action}" không hợp lệ`);
			if (a.mood !== undefined && !ACTOR_MOODS.includes(a.mood)) errors.push(`[${s.id}] actor.mood "${a.mood}" không hợp lệ`);
			if (a.cast !== undefined && !(Number(a.cast) >= 1 && Number(a.cast) <= 6)) errors.push(`[${s.id}] actor.cast phải trong [1, 6]`);
			if (a.lottie && !/^https?:\/\//.test(a.lottie)) {
				const full = safeAsset('lottie', a.lottie);
				if (!full) errors.push(`[${s.id}] actor.lottie không hợp lệ: ${a.lottie}`);
				else if (!existsSync(full)) errors.push(`[${s.id}] thiếu file lottie: assets/lottie/${a.lottie}`);
			}
		}
		if (s.inSec !== undefined && s.outSec !== undefined && s.outSec <= s.inSec) {
			errors.push(`[${s.id}] outSec (${s.outSec}) phải > inSec (${s.inSec})`);
		}
	}

	return { errors, warnings };
}

/** Script-level checks (before TTS). Returns { errors, warnings, slideshowRisk }. */
export function lintNarration(n, opts = {}) {
	const errors = [];
	const warnings = [];
	const flow = FLOWS[n.flow];
	if (!flow) errors.push(`flow "${n.flow}" không tồn tại (A–T)`);
	if (!n.scenes?.length) errors.push('không có scene');
	if (errors.length) return { errors, warnings, slideshowRisk: null };

	const ids = n.scenes.map((s) => s.id);
	if (ids.join() !== flow.beats.join()) warnings.push(`beats ${ids.join()} lệch flow ${n.flow}: ${flow.beats.join()}`);

	const facts = new Map((n.facts ?? []).map((f) => [f.id, f]));
	for (const f of facts.values()) if (!/^https?:\/\//.test(f.source ?? '')) errors.push(`fact ${f.id} thiếu source URL`);

	const all = lines(n);
	const counts = all.map((l) => words(l.text));
	for (const [i, l] of all.entries()) {
		const t = l.text.toLowerCase();
		if (counts[i] > T.maxWordsPerSentence) errors.push(`[${l.scene}] câu ${counts[i]} từ > ${T.maxWordsPerSentence}`);
		for (const p of T.bannedPhrasesVi) if (t.includes(p)) errors.push(`[${l.scene}] cụm cấm "${p}"`);
		for (const p of T.bannedPunctuationInSpeech) if (l.text.includes(p)) errors.push(`[${l.scene}] dấu cấm "${p}" trong lời đọc`);
		if (l.fact && !facts.has(l.fact)) errors.push(`[${l.scene}] fact "${l.fact}" không có trong facts[]`);
	}
	const share = (max) => counts.filter((c) => c <= max).length / counts.length;
	if (share(T.veryShortSentenceWords) > T.veryShortSentenceMaxShare) warnings.push('quá nhiều câu ≤4 từ');
	if (share(T.shortSentenceWords) > T.shortSentenceMaxShare) warnings.push('quá nhiều câu ≤7 từ');
	const [lo, hi] = T.outroHoldSeconds;
	if (!(n.outroHold >= lo && n.outroHold <= hi)) errors.push(`outroHold ${n.outroHold} ngoài [${lo},${hi}]`);
	if (!all.some((l) => l.fact)) errors.push('không câu nào trỏ tới fact (Facts first)');

	const vis = lintVisuals(n);
	const comp = lintComposition(n, opts);
	errors.push(...vis.errors, ...comp.errors);
	warnings.push(...vis.warnings, ...comp.warnings);
	return { errors, warnings, slideshowRisk: vis.slideshowRisk };
}

/** Timing checks (after TTS): platform profile ceiling + total length + fact density. */
export function lintTiming(n, totalSec) {
	const errors = [];
	const warnings = [];
	const profile = T.profiles?.[n.profile ?? T.defaultProfile];
	const maxSec = Math.min(T.maxDurationSeconds, profile?.maxSeconds ?? T.maxDurationSeconds);
	if (totalSec > maxSec) errors.push(`dài ${totalSec.toFixed(1)}s > ${maxSec}s (${n.profile ?? T.defaultProfile})`);
	const [lo, hi] = T.targetDurationSeconds;
	if (totalSec < lo || totalSec > hi) warnings.push(`dài ${totalSec.toFixed(1)}s ngoài mục tiêu [${lo},${hi}]`);
	const factCount = new Set(lines(n).map((l) => l.fact).filter(Boolean)).size;
	if (factCount && totalSec / factCount > T.factEverySeconds * 2) warnings.push(`mật độ fact thấp: ${factCount} fact / ${totalSec.toFixed(0)}s`);
	return { errors, warnings };
}

// Self-check: node lint.js
if (import.meta.url === `file://${process.argv[1]}`) {
	const assert = (await import('node:assert')).strict;
	const good = {
		flow: 'K',
		outroHold: 3,
		facts: [{ id: 'f1', claim: 'x', source: 'https://example.com' }],
		scenes: FLOWS.K.beats.map((id, i) => ({
			id,
			visual: { shotSize: ['wide', 'medium', 'close'][i % 3], motion: 'kinetic' },
			lines: [{ text: 'Người trưởng thành cần ngủ từ bảy đến chín tiếng mỗi đêm theo khuyến nghị.', fact: 'f1' }],
		})),
	};
	assert.deepEqual(lintNarration(good).errors, []);
	const bad = {
		...good,
		runtime: 'unknown',
		outroHold: 0,
		music: { file: '../evil.mp3' },
		scenes: [{ id: 'hook', visual: { shotSize: 'wide', motion: 'static' }, actor: { action: 'fly', lottie: '../x.json' }, lines: [{ text: 'Bạn có biết điều này: ngủ ít rất hại', fact: 'f9' }] }],
	};
	const e = lintNarration(bad).errors.join('\n');
	for (const k of ['cụm cấm', 'dấu cấm', 'f9', 'outroHold', 'runtime', 'music path', 'cảnh tĩnh', 'actor.action', 'actor.lottie']) assert.ok(e.includes(k), k);
	assert.equal(lintTiming({ ...good, profile: 'shorts' }, 70).errors.length, 1);
	assert.deepEqual(beatGrid(2, 120, 0, 30), [0, 15, 30, 45, 60]);
	assert.ok(snapDurationToBeat(1.1, 120, 0, 30) >= 1.5);
	console.log('lint self-check OK');
}
