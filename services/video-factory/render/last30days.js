// Demand check via the `last30days` skill: it answers "what do people actually
// say about this topic in the last 30 days" across Reddit, X, YouTube, TikTok,
// HN, Polymarket and grounded web. Trend Intelligence uses it as the second
// signal next to Google Trends: Trends says *what is hot now*, this says
// *whether anyone is talking about our angle, and how much*.
//
// The skill is a Python CLI. We shell out with --emit json --json-profile agent
// and cache each answer for a week so a queue of topics costs one run each.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = process.env.LAST30DAYS_HOME ?? join(homedir(), '.claude/skills/last30days');
const CACHE_DIR = resolve(HERE, '../data/last30days');
const TTL_MS = Number(process.env.LAST30DAYS_TTL_MS ?? 7 * 24 * 3600 * 1000);
const TIMEOUT_MS = Number(process.env.LAST30DAYS_TIMEOUT_MS ?? 240000);

/** Which result sources count as audience demand (a blog link is not demand). */
const SOCIAL_SOURCES = new Set(['reddit', 'x', 'twitter', 'youtube', 'tiktok', 'instagram', 'linkedin', 'hackernews', 'bluesky', 'truthsocial', 'polymarket', 'devto', 'digg', 'xiaohongshu']);

const cachePath = (topic, days) => join(CACHE_DIR, `${createHash('sha1').update(`${topic}|${days}`).digest('hex')}.json`);

async function readCache(topic, days) {
	try {
		const c = JSON.parse(await readFile(cachePath(topic, days), 'utf8'));
		if (Date.now() - Number(c.at) < TTL_MS) return c.report;
	} catch {}
	return null;
}

/** Sum a numeric engagement field across results; missing numbers count as 0. */
function engagementOf(results) {
	let total = 0;
	for (const r of results) {
		const e = r.engagement ?? {};
		for (const v of Object.values(e)) if (typeof v === 'number' && Number.isFinite(v)) total += v;
	}
	return total;
}

/**
 * Score demand on a 0..1 scale from result counts.
 * Volume alone saturates fast (5 grounded links = "popular"), so social
 * results weigh 3× and engagement is log-compressed: 0 → 0, 10 → ~0.5, 1000 → 1.
 */
function demandScore({ social, total, engagement }) {
	const reach = 3 * social + total + Math.log10(1 + engagement) * 4;
	const raw = reach / 25; // 25 reach units ≈ a well-covered topic
	return Math.min(1, Number(raw.toFixed(3)));
}

/**
 * Research one topic. Never throws: a broken skill must not stop the factory,
 * so a failure returns { ok: false, error } and the queue keeps working.
 */
export async function demandFor(topic, { days = 30, quick = true, useCache = true } = {}) {
	const cached = useCache ? await readCache(topic, days) : null;
	if (cached) return { ok: true, cached: true, ...cached };

	const args = [join(SKILL_DIR, 'scripts/last30days.py'), topic, '--research-only', '--emit', 'json', '--json-profile', 'agent', '--days', String(days), '--auto-resolve', '--no-browser-cookies', '--save-dir', ''];
	if (quick) args.push('--quick');
	try {
		const { stdout } = await run('python3', args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
		const report = JSON.parse(stdout.slice(stdout.indexOf('{')));
		const results = Array.isArray(report.results) ? report.results : [];
		const social = results.filter((r) => SOCIAL_SOURCES.has(String(r.source))).length;
		const engagement = engagementOf(results);
		const summary = {
			generatedAt: report.generated_at ?? new Date().toISOString(),
			windowDays: report.window_days ?? days,
			total: results.length,
			social,
			engagement,
			score: demandScore({ social, total: results.length, engagement }),
			// source_status is { reddit: 'ok' | 'no-results' | 'unreachable', ... }
			sources: Object.entries(report.source_status ?? {}).filter(([, v]) => v === 'ok').map(([k]) => k),
			// Evidence anchors: the script agent can cite these, and the QC gate
			// can check that a fact source is a real URL.
			top: results.slice(0, 5).map((r) => ({ title: String(r.title ?? '').slice(0, 160), url: r.url ?? '', source: r.source ?? '' })),
		};
		await mkdir(CACHE_DIR, { recursive: true });
		await writeFile(cachePath(topic, days), JSON.stringify({ at: Date.now(), report: summary }), { mode: 0o600 });
		return { ok: true, cached: false, ...summary };
	} catch (e) {
		const msg = String(e?.stderr ?? e?.message ?? e).trim().split('\n').slice(-3).join(' | ');
		return { ok: false, error: msg.slice(0, 300) };
	}
}

// Self-check: node render/last30days.js  (real network, ~5s; skips on failure)
if (import.meta.url === `file://${process.argv[1]}`) {
	const r = await demandFor('lãi suất tiết kiệm Việt Nam');
	if (!r.ok) {
		console.error('last30days self-check SKIPPED (skill unavailable):', r.error);
		process.exit(0);
	}
	const s = demandScore({ social: 3, total: 10, engagement: 0 });
	console.assert(typeof r.score === 'number' && r.score >= 0 && r.score <= 1, 'score out of range');
	console.assert(s > 0 && s <= 1, `demandScore broken: ${s}`);
	console.assert(Array.isArray(r.top), 'top must be an array');
	console.log(`last30days self-check OK — score=${r.score} total=${r.total} social=${r.social} cached=${r.cached}`);
}
