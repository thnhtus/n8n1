import dotenv from 'dotenv';
const HERE = import.meta.dirname;
dotenv.config({ path: `${HERE}/../.env`, quiet: true });
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { T, beatGrid, lintNarration, lintTiming, snapDurationToBeat } from './lint.js';
import { planSfx, buildAudioMix } from './audio.js';
import { qcVideo } from './qc.js';
import { renderHyperFrames } from './hyperframes.js';
import { genBackground } from './bgimage.js';
import { openDb, recordVideo, markPublished, ingestMetrics, learn } from './analytics.js';
import { nextTopic, doneTopic, addTopics, resetStale } from './topics.js';
import { publishTo } from './publishers.js';
import { refill } from './strategy.js';

const execFile = promisify(execFileCb);
const env = process.env;
const PORT = Number(env.PORT ?? 3030);
const BUCKET = env.S3_BUCKET ?? env.RUSTFS_BUCKET ?? 'video-factory';
const ROUTER = env.ROUTER_BASE_URL ?? 'http://localhost:20128/v1';
const DEFAULT_VOICE = env.TTS_MODEL ?? 'edge-tts/vi-VN-HoaiMyNeural';
const JOBS = resolve(HERE, env.JOBS_DIR ?? 'jobs');
const OUT = resolve(HERE, '../out');
const ROOT = resolve(HERE, '..');
const MAX_LINES = 40;
const LINE_PAUSE = 0.25; // breath between lines, seconds
// Linux ARM64 has no Chrome Headless Shell download: the container points this at apt chromium.
const BROWSER = env.BROWSER_EXECUTABLE || null;

const db = openDb();
const s3Creds = {
	accessKeyId: env.S3_ACCESS_KEY ?? env.RUSTFS_ACCESS_KEY,
	secretAccessKey: env.S3_SECRET_KEY ?? env.RUSTFS_SECRET_KEY,
};
const s3Endpoint = env.S3_ENDPOINT ?? `http://localhost:${env.RUSTFS_PORT ?? 9000}`;
const s3 = new S3Client({ region: env.S3_REGION ?? 'us-east-1', endpoint: s3Endpoint, forcePathStyle: true, credentials: s3Creds });
// In a container the internal endpoint is not reachable from the host, so presign on the public one.
const s3Public = env.S3_PUBLIC_ENDPOINT
	? new S3Client({ region: env.S3_REGION ?? 'us-east-1', endpoint: env.S3_PUBLIC_ENDPOINT, forcePathStyle: true, credentials: s3Creds })
	: s3;

const probe = async (file) => {
	const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
	return Number(stdout.trim()) || 0.5;
};

async function tts(text, voice, file) {
	const r = await fetch(`${ROUTER}/audio/speech`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model: voice, input: text }),
	});
	if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
	await writeFile(file, Buffer.from(await r.arrayBuffer()));
	return probe(file);
}

// Every fact URL must answer 2xx. Reachability only: it does not prove the page supports the claim.
async function checkSources(facts = []) {
	const bad = await Promise.all(facts.map(async (f) => {
		if (!/^https?:\/\//.test(f.source ?? '')) return null; // lintNarration already reports it
		const get = (method) => fetch(f.source, { method, redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'Mozilla/5.0 video-factory' } });
		try {
			let r = await get('HEAD');
			if (!r.ok) r = await get('GET'); // many sites reject HEAD
			return r.ok ? null : `fact ${f.id} source trả ${r.status}: ${f.source}`;
		} catch (e) {
			return `fact ${f.id} source không truy cập được (${e.name}): ${f.source}`;
		}
	}));
	return bad.filter(Boolean);
}

// Legacy body { title, sentences } → narration without flow/facts. It renders, but lint blocks publishing.
const fromLegacy = ({ title, sentences }) => ({
	title,
	flow: null,
	facts: [],
	outroHold: 3,
	scenes: sentences.map((text, i) => ({ id: `s${i}`, lines: [{ text }] })),
});

async function renderJob(n, voice = DEFAULT_VOICE) {
	const id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
	const tmp = join(JOBS, id);
	const out = join(OUT, id);
	await mkdir(tmp, { recursive: true });
	await mkdir(out, { recursive: true });
	try {
		const lint = lintNarration(n);
		lint.errors.push(...(await checkSources(n.facts)));

		// One background image per scene, generated in parallel with TTS. Prompt = scene.bg, else title + scene text.
		// Off by default: bg images are opt-in (`bgImages: true`). Stickman scenes use a plain background.
		const bgJobs = n.bgImages !== true || n.runtime === 'hyperframes' ? [] : n.scenes.map((s, i) =>
			genBackground(s.bg ?? `${n.title}. ${s.lines.map((l) => l.text).join(' ')}`, join(tmp, `bg${i}.jpg`)));

		// Voice sets the duration: TTS each line, then sum. Durations are never typed by hand.
		const scenes = [];
		let k = 0;
		for (const s of n.scenes) {
			const lines = [];
			for (const l of s.lines) {
				const name = `l${k++}.mp3`;
				const mp3Sec = await tts(l.text, voice, join(tmp, name));
				const speech = mp3Sec + LINE_PAUSE;
				// Beat-grid pad only when the bed has a BPM. Durations still come from the voice.
				const durationSec = n.music?.bpm ? snapDurationToBeat(speech, n.music.bpm, n.music.offset ?? 0) : speech;
				lines.push({ text: l.text, durationSec, mp3Sec, audioPath: join(tmp, name), audioUrl: `http://localhost:${PORT}/jobs/${id}/${name}` });
			}
			// Lottie file name -> URL served by /lottie, so the Remotion browser can fetch it.
			const actor = s.actor && { ...s.actor, lottieUrl: s.actor.lottie && (/^https?:\/\//.test(s.actor.lottie) ? s.actor.lottie : `http://localhost:${PORT}/lottie/${s.actor.lottie.split('/').map(encodeURIComponent).join('/')}`) };
			scenes.push({ id: s.id, visual: s.visual, actor, lines });
		}
		const bgOk = await Promise.all(bgJobs);
		bgOk.forEach((ok, i) => { if (ok) scenes[i].bgUrl = `http://localhost:${PORT}/jobs/${id}/bg${i}.jpg`; });
		if (bgJobs.length && bgOk.some((ok) => !ok)) lint.warnings.push(`bg image lỗi ${bgOk.filter((ok) => !ok).length}/${bgOk.length} cảnh, dùng gradient`);
		const totalSec = scenes.flatMap((s) => s.lines).reduce((a, l) => a + l.durationSec, 0) + n.outroHold;
		const timing = lintTiming(n, totalSec);
		lint.errors.push(...timing.errors);
		lint.warnings.push(...timing.warnings);

		let cursor = 0;
		let li = 0;
		const lineTimings = n.scenes.flatMap((s, si) => s.lines.map((src, j) => {
			const sl = scenes[si].lines[j];
			const start = cursor;
			cursor += sl.durationSec;
			return { index: li++, scene: s.id, text: sl.text, start, end: cursor, audioDur: sl.mp3Sec, audioPath: sl.audioPath, sfx: src.sfx };
		}));

		const beatFrames = n.music?.bpm ? beatGrid(totalSec, n.music.bpm, n.music.offset ?? 0) : [];
		const inputProps = { title: n.title, scenes, outroHold: n.outroHold, safe: T.safeZone, beatFrames };
		let raw = join(tmp, 'raw.mp4');
		let hf = null;
		if (n.runtime === 'hyperframes') {
			hf = await renderHyperFrames({ tmp, id, title: n.title, scenes: n.scenes, lineTimings, outroHold: n.outroHold, totalSec, safe: T.safeZone, fps: T.video.fps, crf: T.video.crf, hookVisibleBySec: T.hookVisibleBySec });
			raw = hf.rawOut;
		} else {
			const serveUrl = await bundled;
			const composition = await selectComposition({ serveUrl, id: 'Short', inputProps, browserExecutable: BROWSER });
			await renderMedia({ serveUrl, composition, inputProps, codec: 'h264', outputLocation: raw, hardwareAcceleration: 'if-possible', browserExecutable: BROWSER });
		}

		// Finishing pass: voice + ducked bed + SFX → loudnorm to platform target, BT.709 tv-range yuv420p, 48k AAC, faststart.
		const { sampleRate, aacBitrate } = T.audio;
		const upload = join(out, `${id}-upload.mp4`);
		const musicFile = n.music && (typeof n.music === 'string' ? n.music : n.music.file);
		const mix = buildAudioMix({
			totalSec,
			speechEndSec: totalSec - n.outroHold,
			musicPath: musicFile ? join(ROOT, 'assets/music', musicFile) : null,
			musicVolume: typeof n.music === 'object' ? n.music.volume : undefined,
			sfxEvents: planSfx(n.scenes, lineTimings, T, join(ROOT, 'assets/sfx')),
			T,
		});
		await execFile('ffmpeg', [
			'-y', '-i', raw, ...mix.inputs,
			'-filter_complex', mix.filterComplex, '-map', '0:v', '-map', '[aout]',
			'-c:v', 'libx264', '-crf', String(T.video.crf), '-preset', 'medium', '-pix_fmt', 'yuv420p',
			'-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
			'-c:a', 'aac', '-b:a', aacBitrate, '-ar', String(sampleRate),
			'-movflags', '+faststart', upload,
		]);

		// Cover = hook frame. Thumbtest = how it looks at feed size; open it and check it is readable.
		const cover = join(out, 'cover.png');
		await execFile('ffmpeg', ['-y', '-ss', '1', '-i', upload, '-frames:v', '1', cover]);
		await execFile('ffmpeg', ['-y', '-i', cover, '-vf', `scale=${T.cover.thumbTestWidthPx}:-1,scale=${T.cover.thumbTestWidthPx * 2}:-1:flags=neighbor`, join(out, 'cover-thumbtest.png')]);

		// QA frames at fixed points plus volume stats: check them before trusting the upload.
		const qa = join(out, 'qa');
		await mkdir(qa, { recursive: true });
		const dur = await probe(upload);
		for (const [i, t] of [1, dur * 0.25, dur * 0.5, dur * 0.75, dur - 1].entries()) {
			await execFile('ffmpeg', ['-y', '-ss', Math.max(0, t).toFixed(2), '-i', upload, '-frames:v', '1', '-q:v', '2', join(qa, `f${i}.jpg`)]);
		}
		const { stderr: vol } = await execFile('ffmpeg', ['-i', upload, '-af', 'volumedetect', '-f', 'null', '-']);
		await writeFile(join(qa, 'volume.txt'), vol.split('\n').filter((l) => /mean_volume|max_volume/.test(l)).join('\n') + '\n');

		await writeFile(join(out, 'caption.txt'), `${n.caption ?? n.title}\n`);
		await writeFile(join(out, 'pinned-comment.txt'), `${n.pinned ?? sourcesLine(n)}\n`);
		await writeFile(join(out, 'narration.json'), JSON.stringify(n, null, 2));
		if (hf) lint.hyperframes = hf.checkReport;
		await writeFile(join(out, 'lint.json'), JSON.stringify(lint, null, 2));

		let qc = null;
		try {
			qc = await qcVideo(upload, T, n.profile ?? T.defaultProfile);
			await writeFile(join(qa, 'qc.json'), JSON.stringify(qc, null, 2));
		} catch (e) {
			console.error(`[render ${id}] qc failed:`, e.message);
			qc = { pass: false, score: 0, error: String(e.message) };
		}

		const key = `videos/${id}.mp4`;
		await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: await readFile(upload), ContentType: 'video/mp4' }));
		const url = await getSignedUrl(s3Public, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 7 * 24 * 3600 });
		// Hand-off by default. Auto-post only when the script and the rendered video both pass AND the owner opted in.
		const publishable = lint.errors.length === 0 && (qc?.pass ?? false) && env.AUTO_PUBLISH === 'true';
		try {
			recordVideo(db, { id, title: n.title, flow: n.flow, runtime: n.runtime, profile: n.profile, durationSec: totalSec, qcScore: qc?.score ?? null, key, url });
		} catch (e) {
			console.error(`[render ${id}] analytics record failed:`, e.message);
		}
		return { id, key, url, out, durationSec: Number(totalSec.toFixed(2)), lint, qc, publishable };
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

// Pinned comment lists sources so viewers can check every claim.
const sourcesLine = (n) => {
	const urls = [...new Set((n.facts ?? []).map((f) => f.source).filter(Boolean))];
	return urls.length ? `Nguồn:\n${urls.join('\n')}` : n.title;
};

const bundled = bundle({ entryPoint: resolve(HERE, 'src/index.jsx') });
// ponytail: one render at a time (16 GB Mac). Add a real queue when renders overlap a lot.
let queue = Promise.resolve();

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use('/jobs', express.static(JOBS));
app.use('/lottie', (_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); }, express.static(join(ROOT, 'assets/lottie')));
app.get('/health', (_, res) => res.json({ ok: true }));
app.post('/lint', (req, res) => res.json(lintNarration(req.body ?? {})));
app.post('/qc', async (req, res) => {
	const f = req.body?.file;
	if (!f || typeof f !== 'string') return res.status(400).json({ error: 'file path required' });
	const file = resolve(OUT, f);
	if (!file.startsWith(OUT + '/')) return res.status(400).json({ error: 'file must live under out/' });
	try {
		res.json(await qcVideo(file, T, req.body?.profile ?? T.defaultProfile));
	} catch (e) {
		res.status(500).json({ error: String(e.message) });
	}
});
app.post('/publish', async (req, res) => {
	const { platforms = (env.VF_PLATFORMS ?? 'tiktok').split(',').map((x) => x.trim()).filter(Boolean), key, title, caption, privacy, profile } = req.body ?? {};
	if (!key) return res.status(400).json({ error: 'Missing S3 key' });
	const fetchObject = async () => {
		const s3Res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
		const chunks = [];
		for await (const chunk of s3Res.Body) chunks.push(chunk);
		return Buffer.concat(chunks);
	};
	try {
		const results = await publishTo(platforms, { key, title: title ?? 'Video Factory Short', caption, privacy, profile, fetchObject });
		for (const [p, r] of Object.entries(results)) {
			if (r.ok) markPublished(db, key.split('/').pop()?.replace('.mp4', ''), p);
		}
		res.json({ ok: true, results });
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e.message ?? e) });
	}
});
// ponytail: a crashed run's topic is retried on the next call; fine with one run at a time, add leases if runs overlap.
app.get('/topic/next', async (_, res) => {
	await resetStale();
	const t = await nextTopic();
	res.json(t ? { ok: true, topic: t } : { ok: true, topic: null });
});
app.post('/topic/done', async (req, res) => {
	const ok = await doneTopic(req.body?.topic);
	res.json({ ok });
});
app.post('/topic/add', async (req, res) => {
	const items = Array.isArray(req.body?.items) ? req.body.items : [];
	const n = await addTopics(items);
	res.json({ ok: true, added: n });
});
app.post('/analytics/ingest', async (req, res) => {
	const { videoId, platform, ...m } = req.body ?? {};
	if (!videoId || !platform) return res.status(400).json({ error: 'videoId and platform required' });
	try {
		ingestMetrics(db, videoId, platform, m);
		res.json({ ok: true });
	} catch (e) {
		res.status(400).json({ ok: false, error: String(e.message ?? e) });
	}
});
app.get('/analytics/learn', (_, res) => res.json(learn(db)));
app.get('/trends/refill', async (_, res) => {
	try { res.json(await refill()); } catch (e) { res.status(500).json({ ok: false, error: String(e.message ?? e) }); }
});

app.post('/render', (req, res) => {
	const body = req.body ?? {};
	const n = Array.isArray(body.sentences) ? fromLegacy(body) : body;
	const lines = (n.scenes ?? []).flatMap((s) => s?.lines ?? []);
	const valid =
		typeof n.title === 'string' && n.title.trim() &&
		lines.length > 0 && lines.length <= MAX_LINES &&
		lines.every((l) => typeof l?.text === 'string' && l.text.trim()) &&
		typeof n.outroHold === 'number';
	if (!valid) return res.status(400).json({ error: `need title, outroHold, scenes[].lines[].text (1-${MAX_LINES} lines)` });
	if (body.voice !== undefined && (typeof body.voice !== 'string' || !/^[\w./-]+$/.test(body.voice))) {
		return res.status(400).json({ error: 'invalid voice' });
	}
	const job = queue.then(() => renderJob(n, body.voice));
	queue = job.catch(() => {});
	job.then(
		(r) => res.json(r),
		(e) => {
			console.error(e);
			res.status(500).json({ error: e.message });
		},
	);
});

await mkdir(JOBS, { recursive: true });
// Container sets HOST=0.0.0.0 so the published port is reachable; default stays loopback for launchd.
app.listen(PORT, env.HOST ?? '127.0.0.1', () => console.log(`render service on :${PORT}`));
