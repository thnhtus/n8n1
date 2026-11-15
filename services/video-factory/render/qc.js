// Pre-release video QC: measures the final MP4 with ffprobe/ffmpeg against docs/soul/thresholds.json + platform profile.
import { execFile as ef } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(ef);
const ff = (args) => run('ffmpeg', ['-hide_banner', '-nostats', ...args], { maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stderr);
const num = (re, s) => { const m = s.match(re); return m ? Number(m[1]) : NaN; };
const spans = (s, startRe, endRe) => {
	const a = [...s.matchAll(startRe)].map((m) => Number(m[1]));
	const b = [...s.matchAll(endRe)].map((m) => Number(m[1]));
	return a.map((st, i) => [st, b[i] ?? Infinity]);
};

/** MP4 atoms at top level: true when moov precedes mdat (progressive playback / "faststart"). */
async function faststart(file) {
	const fh = await open(file, 'r');
	try {
		const buf = Buffer.alloc(8);
		let pos = 0;
		for (let i = 0; i < 64; i++) {
			const { bytesRead } = await fh.read(buf, 0, 8, pos);
			if (bytesRead < 8) return false;
			let size = buf.readUInt32BE(0);
			const type = buf.toString('latin1', 4, 8);
			if (type === 'moov') return true;
			if (type === 'mdat') return false;
			if (size === 1) { const big = Buffer.alloc(8); await fh.read(big, 0, 8, pos + 8); size = Number(big.readBigUInt64BE(0)); }
			if (size < 8) return false;
			pos += size;
		}
		return false;
	} finally { await fh.close(); }
}

/** Pure scoring: turns measurements into checks. Exported for the self-check. */
export function evaluate(m, T, profileName = T.defaultProfile) {
	const p = T.profiles?.[profileName] ?? {};
	const V = T.video, A = T.audio;
	const maxSec = Math.min(T.maxDurationSeconds, p.maxSeconds ?? Infinity);
	const checks = [];
	const add = (id, label, ok, actual, expected, severity = 'error') => checks.push({ id, label, pass: Boolean(ok), severity, actual, expected });

	add('container', 'Container MP4', /mp4/.test(m.format), m.format, 'mp4');
	add('faststart', 'moov trước mdat (phát ngay khi tải)', m.faststart, m.faststart, true);
	add('size', 'Dung lượng file', m.sizeMB <= (p.maxMB ?? Infinity), `${m.sizeMB.toFixed(1)}MB`, `<= ${p.maxMB}MB`);
	add('duration', 'Thời lượng tối đa nền tảng', m.durationSec <= maxSec, `${m.durationSec.toFixed(2)}s`, `<= ${maxSec}s`);
	add('duration_min', 'Thời lượng tối thiểu', m.durationSec >= 3, `${m.durationSec.toFixed(2)}s`, '>= 3s');
	const [lo, hi] = T.targetDurationSeconds;
	add('duration_target', 'Thời lượng mục tiêu giữ chân', m.durationSec >= lo && m.durationSec <= hi, `${m.durationSec.toFixed(1)}s`, `${lo}–${hi}s`, 'warn');

	add('v_codec', 'Video codec H.264', m.vCodec === 'h264', m.vCodec, 'h264');
	add('resolution', 'Độ phân giải dọc 9:16', m.width === T.safeZone.width && m.height === T.safeZone.height, `${m.width}x${m.height}`, `${T.safeZone.width}x${T.safeZone.height}`);
	add('fps', 'Frame rate', Math.abs(m.fps - V.fps) < 0.01, m.fps, V.fps);
	add('pix_fmt', 'Pixel format', m.pixFmt === V.pixFmt, m.pixFmt, V.pixFmt);
	add('color', 'Màu BT.709 / TV range', m.colorSpace === V.colorSpace && m.colorRange === V.colorRange, `${m.colorSpace}/${m.colorRange}`, `${V.colorSpace}/${V.colorRange}`, 'warn');
	add('v_bitrate', 'Bitrate video đủ cho 1080p', m.vKbps >= 2500, `${Math.round(m.vKbps)}kbps`, '>= 2500kbps', 'warn');

	add('a_present', 'Có audio', m.aCodec != null, m.aCodec ?? 'none', 'aac');
	add('a_codec', 'Audio codec AAC', m.aCodec === 'aac', m.aCodec, 'aac');
	add('a_rate', 'Sample rate', m.aRate === A.sampleRate, m.aRate, A.sampleRate);
	add('a_channels', 'Kênh audio', m.aChannels >= 1 && m.aChannels <= 2, m.aChannels, '1–2');
	add('loudness', 'Integrated loudness', Math.abs(m.lufs - A.loudnessLUFS) <= A.loudnessToleranceLU, `${m.lufs} LUFS`, `${A.loudnessLUFS} ±${A.loudnessToleranceLU}`);
	add('true_peak', 'True peak', m.truePeak <= A.truePeakMaxDb + 0.1, `${m.truePeak} dBTP`, `<= ${A.truePeakMaxDb}`);
	add('lra', 'Loudness range (độ đều giọng)', m.lra <= 12, `${m.lra} LU`, '<= 12 LU', 'warn');

	const blackTotal = m.black.reduce((a, [s, e]) => a + Math.min(e, m.durationSec) - s, 0);
	add('black_start', 'Khung đầu không đen (hook)', !m.black.some(([s]) => s < T.hookVisibleBySec), m.black.filter(([s]) => s < 1).map(([s, e]) => `${s}-${e}`).join(',') || 'none', `no black before ${T.hookVisibleBySec}s`);
	add('black_total', 'Không có đoạn đen giữa video', blackTotal <= 0.5, `${blackTotal.toFixed(2)}s`, '<= 0.5s');
	const freezeOk = m.freeze.filter(([s, e]) => Math.min(e, m.durationSec) - s > 4.05 && s < m.durationSec - 5);
	add('freeze', 'Không đứng hình > 4s (trừ outro)', freezeOk.length === 0, freezeOk.map(([s, e]) => `${s}-${e}`).join(',') || 'none', 'none');
	const silentMid = m.silence.filter(([s, e]) => s > 0.3 && Math.min(e, m.durationSec) - s > 1.5 && e < m.durationSec - 0.5);
	add('silence', 'Không im lặng > 1.5s giữa video', silentMid.length === 0, silentMid.map(([s, e]) => `${s}-${e}`).join(',') || 'none', 'none');
	add('silence_start', 'Có tiếng ngay đầu video', !m.silence.some(([s, e]) => s <= 0.05 && e > 1), m.silence[0] ? `${m.silence[0][0]}-${m.silence[0][1]}` : 'none', 'voice before 1s', 'warn');

	const errors = checks.filter((c) => !c.pass && c.severity === 'error');
	const warns = checks.filter((c) => !c.pass && c.severity === 'warn');
	const score = Math.max(0, Math.round(100 - errors.length * 15 - warns.length * 5));
	return { pass: errors.length === 0, score, profile: profileName, errors: errors.map((c) => `${c.label}: ${c.actual} (cần ${c.expected})`), warnings: warns.map((c) => `${c.label}: ${c.actual} (nên ${c.expected})`), checks };
}

/** Measure the file, then evaluate. ~1x realtime on a 16GB Mac (one decode pass for video filters, one for audio). */
export async function qcVideo(file, T, profileName) {
	const { stdout } = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
	const pj = JSON.parse(stdout);
	const v = pj.streams.find((s) => s.codec_type === 'video') ?? {};
	const a = pj.streams.find((s) => s.codec_type === 'audio');
	const [fn, fd] = String(v.avg_frame_rate ?? '0/1').split('/').map(Number);
	const durationSec = Number(pj.format.duration);

	const vLog = await ff(['-i', file, '-an', '-vf', 'blackdetect=d=0.1:pix_th=0.10,freezedetect=n=-60dB:d=2', '-f', 'null', '-']);
	const aLog = a ? await ff(['-i', file, '-vn', '-af', 'silencedetect=n=-45dB:d=0.8,ebur128=peak=true', '-f', 'null', '-']) : '';
	const summary = aLog.slice(aLog.lastIndexOf('Summary:'));

	const m = {
		format: pj.format.format_name,
		sizeMB: (await stat(file)).size / 1048576,
		faststart: await faststart(file),
		durationSec,
		vCodec: v.codec_name, width: v.width, height: v.height, fps: fd ? fn / fd : 0,
		pixFmt: v.pix_fmt, colorSpace: v.color_space, colorRange: v.color_range,
		vKbps: Number(v.bit_rate ?? pj.format.bit_rate) / 1000,
		aCodec: a?.codec_name ?? null, aRate: Number(a?.sample_rate), aChannels: a?.channels ?? 0,
		lufs: num(/I:\s+(-?[\d.]+) LUFS/, summary), lra: num(/LRA:\s+(-?[\d.]+) LU/, summary), truePeak: num(/Peak:\s+(-?[\d.]+) dBFS/, summary),
		black: spans(vLog, /black_start:([\d.]+)/g, /black_end:([\d.]+)/g),
		freeze: spans(vLog, /freeze_start: ([\d.]+)/g, /freeze_end: ([\d.]+)/g),
		silence: spans(aLog, /silence_start: (-?[\d.]+)/g, /silence_end: ([\d.]+)/g),
	};
	return { ...evaluate(m, T, profileName), measured: m };
}

// Self-check: node qc.js [file.mp4]
if (import.meta.url === `file://${process.argv[1]}`) {
	const assert = (await import('node:assert')).strict;
	const { readFileSync } = await import('node:fs');
	const T = JSON.parse(readFileSync(new URL('../docs/soul/thresholds.json', import.meta.url)));
	const good = { format: 'mov,mp4,m4a,3gp,3g2,mj2', sizeMB: 12, faststart: true, durationSec: 60, vCodec: 'h264', width: 1080, height: 1920, fps: 30, pixFmt: 'yuv420p', colorSpace: 'bt709', colorRange: 'tv', vKbps: 4000, aCodec: 'aac', aRate: 48000, aChannels: 2, lufs: -13.1, lra: 5, truePeak: -1.2, black: [], freeze: [[56, 60]], silence: [[58.5, 60]] };
	const g = evaluate(good, T);
	assert.ok(g.pass, g.errors.join('\n'));
	assert.equal(g.score, 100);
	const b = evaluate({ ...good, faststart: false, lufs: -20, black: [[0, 0.8]], freeze: [[10, 16]], silence: [[20, 23]], aCodec: null }, T);
	assert.ok(!b.pass);
	for (const id of ['faststart', 'loudness', 'black_start', 'freeze', 'silence', 'a_present']) assert.ok(!b.checks.find((c) => c.id === id).pass, id);
	console.log('qc self-check OK');
	if (process.argv[2]) console.log(JSON.stringify(await qcVideo(process.argv[2], T), (k, v) => (k === 'measured' ? undefined : v), 2));
}
