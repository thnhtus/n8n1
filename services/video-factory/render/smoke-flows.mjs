// Smoke every flow (A–T) on both runtimes → out/smoke-flows/{results.json,report.html}. Usage: node render/smoke-flows.mjs [A,B,...]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FLOWS = JSON.parse(readFileSync(join(ROOT, 'docs/flows/flows.json'), 'utf8'));
const URL = process.env.RENDER_URL ?? 'http://127.0.0.1:3030';
const DIR = join(ROOT, 'out/smoke-flows');
const RES = join(DIR, 'results.json');
mkdirSync(DIR, { recursive: true });
const only = process.argv[2]?.split(',');
const results = existsSync(RES) ? JSON.parse(readFileSync(RES, 'utf8')) : {};
const SHOTS = ['wide', 'medium', 'close'];
const MOTIONS = ['kinetic', 'push', 'pan'];

const narration = (key, runtime) => ({
	title: `Smoke flow ${key}`,
	flow: key,
	runtime,
	outroHold: 3,
	facts: [{ id: 'f1', claim: 'smoke test only', source: 'https://example.com' }],
	scenes: FLOWS[key].beats.map((id, i) => ({
		id,
		visual: { shotSize: SHOTS[i % 3], motion: MOTIONS[i % 3] },
		lines: [{ text: `Ở phần ${i + 1} này cơ thể tiếp tục hồi phục sau một ngày làm việc dài.`, fact: 'f1' }],
	})),
});

const probe = (f) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt,color_space,sample_rate', '-of', 'csv=p=0', f], { encoding: 'utf8' });
const lufs = (f) => {
	const r = execFileSync('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
	return r;
};

for (const key of Object.keys(FLOWS)) {
	if (only && !only.includes(key)) continue;
	for (const runtime of ['remotion', 'hyperframes']) {
		const k = `${key}-${runtime}`;
		const t0 = Date.now();
		const row = { flow: key, name: FLOWS[key].name, runtime, beats: FLOWS[key].beats.length, checks: {} };
		try {
			const r = await fetch(`${URL}/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(narration(key, runtime)), signal: AbortSignal.timeout(900_000) });
			const j = await r.json();
			if (!r.ok) throw new Error(j.error ?? r.status);
			const upload = join(j.out, `${j.id}-upload.mp4`);
			const info = probe(upload);
			let I = null;
			try {
				const s = execFileSync('sh', ['-c', `ffmpeg -hide_banner -nostats -i "${upload}" -af ebur128 -f null - 2>&1 | grep -E '^\\s+I:' | tail -1`], { encoding: 'utf8' });
				I = Number(s.match(/(-?[\d.]+) LUFS/)?.[1]);
			} catch {}
			row.id = j.id;
			row.durationSec = j.durationSec;
			row.lufs = I;
			row.lintErrors = j.lint.errors;
			row.lintWarnings = j.lint.warnings;
			row.checks = {
				video: /h264,1080,1920,yuv420p,bt709/.test(info),
				audio: /aac,48000/.test(info),
				loudness: I !== null && Math.abs(I - -13) <= 1,
				handoff: ['cover.png', 'caption.txt', 'pinned-comment.txt', 'narration.json', 'lint.json'].every((f) => existsSync(join(j.out, f))),
				lint: j.lint.errors.length === 0,
				hfCheck: runtime !== 'hyperframes' || (j.lint.hyperframes?.ok ?? j.lint.hyperframes?.errorCount === 0 ?? true),
			};
			copyFileSync(join(j.out, 'cover.png'), join(DIR, `${k}.png`));
			copyFileSync(join(j.out, 'qa/f2.jpg'), join(DIR, `${k}-mid.jpg`));
			row.cover = `${k}.png`;
			row.mid = `${k}-mid.jpg`;
		} catch (e) {
			row.error = String(e.message ?? e).slice(0, 500);
		}
		row.pass = !row.error && Object.values(row.checks).every(Boolean);
		row.sec = Math.round((Date.now() - t0) / 1000);
		results[k] = row;
		writeFileSync(RES, JSON.stringify(results, null, 2));
		console.log(`${row.pass ? 'PASS' : 'FAIL'} ${k} ${row.sec}s ${row.error ?? ''}`);
	}
}

const rows = Object.values(results).sort((a, b) => (a.flow + a.runtime).localeCompare(b.flow + b.runtime));
const pass = rows.filter((r) => r.pass).length;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
writeFileSync(join(DIR, 'report.html'), `<!doctype html><html lang="vi"><meta charset="utf-8"><title>Smoke flows</title>
<style>body{font:14px system-ui;margin:24px;background:#111;color:#eee}table{border-collapse:collapse}td,th{border:1px solid #333;padding:6px;vertical-align:top}img{height:160px}.p{color:#4c4}.f{color:#f55}</style>
<h1 id="summary">${pass}/${rows.length} PASS</h1><table><tr><th>flow</th><th>runtime</th><th>result</th><th>dur</th><th>LUFS</th><th>checks</th><th>lint errors</th><th>cover</th><th>mid</th></tr>
${rows.map((r) => `<tr data-pass="${r.pass}"><td>${r.flow} ${esc(r.name)} (${r.beats})</td><td>${r.runtime}</td><td class="${r.pass ? 'p' : 'f'}">${r.pass ? 'PASS' : 'FAIL'}${r.error ? `<br>${esc(r.error)}` : ''}</td><td>${r.durationSec ?? ''}s</td><td>${r.lufs ?? ''}</td><td>${Object.entries(r.checks).map(([k, v]) => `${v ? '✔' : '✖'} ${k}`).join('<br>')}</td><td>${esc((r.lintErrors ?? []).join('; '))}</td><td>${r.cover ? `<img src="${r.cover}" alt="cover ${r.flow} ${r.runtime}">` : ''}</td><td>${r.mid ? `<img src="${r.mid}" alt="mid ${r.flow} ${r.runtime}">` : ''}</td></tr>`).join('\n')}
</table></html>`);
console.log(`${pass}/${rows.length} PASS → ${join(DIR, 'report.html')}`);
