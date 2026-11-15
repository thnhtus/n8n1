// Analytics & Learning Engine (mod 07 + 08). SQLite-backed.
//
// Two tables:
//   videos   — every rendered output (id, title, flow, runtime, profile,
//               duration, qc score, publish state, publish time, key, url).
//   metrics  — per-platform performance rows (views, retention, ctr, engagement,
//               revenue) keyed by (video_id, platform).
//
// The learning output (`learn()`) turns these into strategy signals for the
// next videos: which flow / shot-families / hooks / platforms perform best, so
// the topic pipeline can weight the next batch. It is a score, not a verdict:
// small samples get damped toward the prior.
//
// Storage root comes from FACTORY_DATA_DIR (see ../.env), default ../data. The
// DB file is data/analytics.sqlite — backed up by backup.sh alongside S3.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.FACTORY_DATA_DIR
	? resolve(HERE, '..', process.env.FACTORY_DATA_DIR)
	: resolve(HERE, '../data');
mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = join(DATA_DIR, 'analytics.sqlite');

export function openDb(path = DB_PATH) {
	const db = new DatabaseSync(path);
	db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      title TEXT,
      flow TEXT,
      runtime TEXT,
      profile TEXT,
      duration_sec REAL,
      qc_score INTEGER,
      published INTEGER NOT NULL DEFAULT 0,
      published_at TEXT,
      platform TEXT,
      key TEXT,
      url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS metrics (
      video_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      views INTEGER NOT NULL DEFAULT 0,
      retention REAL NOT NULL DEFAULT 0,   -- avg % of video watched
      ctr REAL NOT NULL DEFAULT 0,         -- click-through rate, 0..1
      engagement REAL NOT NULL DEFAULT 0,  -- likes+comments+shares / views
      revenue REAL NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (video_id, platform)
    );
  `);
	return db;
}

/** Register a rendered output. Idempotent on id. */
export function recordVideo(db, v) {
	const s = db.prepare(`
    INSERT INTO videos (id, title, flow, runtime, profile, duration_sec, qc_score, key, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, flow=excluded.flow, runtime=excluded.runtime,
      profile=excluded.profile, duration_sec=excluded.duration_sec,
      qc_score=excluded.qc_score, key=excluded.key, url=excluded.url
  `);
	s.run(v.id, v.title ?? null, v.flow ?? null, v.runtime ?? null, v.profile ?? null,
		v.durationSec ?? null, v.qcScore ?? null, v.key ?? null, v.url ?? null);
}

/** Mark a video published on a platform. */
export function markPublished(db, id, platform, at = new Date().toISOString()) {
	db.prepare('UPDATE videos SET published=1, published_at=?, platform=? WHERE id=?').run(at, platform, id);
}

/**
 * Ingest platform metrics. Damping: a video that never got impressions is
 * treated as a miss, so a zero-view flop still bends the strategy away from
 * what generated it.
 */
export function ingestMetrics(db, videoId, platform, m) {
	const v = db.prepare('SELECT id FROM videos WHERE id=?').get(videoId);
	if (!v) throw new Error(`unknown video_id: ${videoId}`);
	db.prepare(`
    INSERT INTO metrics (video_id, platform, views, retention, ctr, engagement, revenue)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id, platform) DO UPDATE SET
      views=excluded.views, retention=excluded.retention, ctr=excluded.ctr,
      engagement=excluded.engagement, revenue=excluded.revenue,
      recorded_at=datetime('now')
  `).run(videoId, platform,
		Math.max(0, Math.round(Number(m.views) || 0)),
		Number(m.retention) || 0,
		Number(m.ctr) || 0,
		Number(m.engagement) || 0,
		Number(m.revenue) || 0);
}

/**
 * Learning pass. Returns strategy signals, each with a normalized 0..1 weight.
 * All numbers are damped toward the less (0.5) by n/(n+λ).
 */
export function learn(db, lambda = 8) {
	const damping = (n) => n / (n + lambda);
	const rows = db.prepare(`
    SELECT v.flow, v.runtime, v.profile, v.qc_score,
           m.views, m.retention, m.ctr, m.engagement, m.revenue
    FROM videos v LEFT JOIN metrics m ON m.video_id = v.id
    WHERE m.video_id IS NOT NULL
  `).all();

	if (!rows.length) {
		return { samples: 0, flows: {}, notes: ['chưa có số liệu — cần ít nhất một video được đo'] };
	}

	const by = (key) => {
		const g = new Map();
		for (const r of rows) {
			const k = r[key] ?? 'unknown';
			if (!g.has(k)) g.set(k, { n: 0, views: 0, retentionW: 0, ctrW: 0, revenue: 0 });
			const e = g.get(k);
			e.n++;
			e.views += r.views;
			e.retentionW += r.retention * r.views;
			e.ctrW += r.ctr * r.views;
			e.revenue += r.revenue;
		}
		return [...g.entries()].map(([k, e]) => {
			const score = e.views ? (e.retentionW / e.views) * 0.5 + (e.ctrW / e.views) * 0.3 + Math.min(1, e.revenue / (e.views || 1) / 10) * 0.2 : 0;
			return { key: k, n: e.n, views: e.views, score, weight: damping(e.n) };
		}).sort((a, b) => b.weight * b.score - a.weight * a.score);
	};

	return {
		samples: rows.length,
		flows: by('flow'),
		runtimes: by('runtime'),
		profiles: by('profile'),
		notes: [
			'weight = n/(n+λ) — mẫu nhỏ bị kéo về 0.5, chưa là phán quyết',
			'score = 0.5·retention + 0.3·CTR + 0.2·revenue(đã chuẩn hóa)',
		],
	};
}

// Self-check: node render/analytics.js
if (import.meta.url === `file://${process.argv[1]}`) {
	const assert = (await import('node:assert')).strict;
	const db = openDb(':memory:');
	assert.throws(() => ingestMetrics(db, 'x', 'tiktok', { views: 1 }), /unknown video_id/);
	recordVideo(db, { id: 'v1', title: 'A', flow: 'A', runtime: 'remotion', profile: 'tiktok', durationSec: 50, qcScore: 90 });
	recordVideo(db, { id: 'v2', title: 'B', flow: 'H', runtime: 'hyperframes', profile: 'shorts', durationSec: 40, qcScore: 95 });
	ingestMetrics(db, 'v1', 'tiktok', { views: 1000, retention: 0.6, ctr: 0.05, engagement: 0.02 });
	ingestMetrics(db, 'v2', 'shorts', { views: 200, retention: 0.3, ctr: 0.02, engagement: 0.01 });
	markPublished(db, 'v1', 'tiktok');
	const lr = learn(db, 8);
	assert.equal(lr.samples, 2);
	assert.equal(lr.flows[0].key, 'A');
	assert.equal(db.prepare('SELECT published FROM videos WHERE id=?').get('v1').published, 1);
	console.log('analytics self-check OK');
}
