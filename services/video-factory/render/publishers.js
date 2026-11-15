// Multi-platform publish adapters. Each adapter takes ({ key, title, caption,
// profile, privacy, fetchObject, renderUrl }) and returns a result object.
// "fetchObject" is a function (key) -> Buffer (from local S3) so adapters
// never read storage themselves; the caller provides the primitive.
//
// Supported:
//   tiktok  — Direct Post FILE_UPLOAD via the sidecar tiktok.js (needs
//             TIKTOK_CLIENT_KEY/SECRET/REDIRECT_URI and a valid token).
//   youtube — Upload via the YouTube Data API v3, resumable upload. Needs
//             YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN.
//   meta    — Reels upload via the Graph API (Facebook/Instagram). Needs
//             META_ACCESS_TOKEN and META_PAGE_ID (or META_IG_USER_ID for IG).
//
// No adapter throws on "not configured": they return { ok:false, skipped:true }
// with the missing env names, so a single "publish to all" call is safe even
// when only one platform is wired. This keeps the system pluggable: adding a
// platform means adding a function to ADAPTERS and a credential, no rewrites.
import { publish as publishTikTok } from './tiktok.js';

const present = (keys) => keys.filter((k) => !process.env[k]);

async function tiktok({ key, title, privacy, fetchObject }) {
	const missing = present(['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI']);
	if (missing.length) return { ok: false, skipped: true, reason: `missing ${missing.join(', ')}` };
	try {
		const video = await fetchObject(key);
		return { ok: true, result: await publishTikTok({ video, title, privacy }) };
	} catch (e) {
		return { ok: false, error: String(e.message ?? e) };
	}
}

async function refreshYouTubeAccessToken() {
	const { YOUTUBE_CLIENT_ID: client_id, YOUTUBE_CLIENT_SECRET: client_secret, YOUTUBE_REFRESH_TOKEN: refresh_token } = process.env;
	const r = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }),
	});
	const j = await r.json();
	if (!j.access_token) throw new Error(`YouTube token: ${j.error ?? r.status} ${j.error_description ?? ''}`);
	return j.access_token;
}

async function youtube({ key, title, caption, privacy = process.env.YOUTUBE_PRIVACY ?? 'private', fetchObject }) {
	const missing = present(['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN']);
	if (missing.length) return { ok: false, skipped: true, reason: `missing ${missing.join(', ')}` };
	try {
		const video = await fetchObject(key);
		const token = await refreshYouTubeAccessToken();
		// Resumable upload: init
		const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'content-type': 'application/json; charset=UTF-8',
				'x-upload-content-type': 'video/mp4',
				'x-upload-content-length': String(video.length),
			},
			body: JSON.stringify({
				snippet: { title, description: caption ?? title, categoryId: '27' }, // 27 = Education
				status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
			}),
		});
		if (!init.ok) throw new Error(`YouTube init ${init.status}: ${(await init.text()).slice(0, 200)}`);
		const location = init.headers.get('location');
		if (!location) throw new Error('YouTube init: missing resumable upload URL');
		const put = await fetch(location, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(video.length) }, body: video });
		if (!put.ok) throw new Error(`YouTube upload ${put.status}: ${(await put.text()).slice(0, 200)}`);
		const j = await put.json();
		return { ok: true, result: { videoId: j.id, privacy } };
	} catch (e) {
		return { ok: false, error: String(e.message ?? e) };
	}
}

async function meta({ key, title, caption, privacy = process.env.META_PRIVACY ?? 'SELF', fetchObject }) {
	const pageId = process.env.META_PAGE_ID;
	const token = process.env.META_ACCESS_TOKEN;
	if (!token || !pageId) return { ok: false, skipped: true, reason: `missing ${[!token && 'META_ACCESS_TOKEN', !pageId && 'META_PAGE_ID'].filter(Boolean).join(', ')}` };
	try {
		// Simple upload via resumable session is overkill for a short; we use the
		// hosted-file URL path — the caller must supply a publicly reachable URL
		// (R2 public / tunnel). For local RustFS we bail with a clear reason.
		const publicBase = process.env.PUBLIC_VIDEO_BASE; // e.g. https://pub.example.com/video-factory
		if (!publicBase) return { ok: false, skipped: true, reason: 'META needs PUBLIC_VIDEO_BASE (public URL to the bucket) — local RustFS is not internet-reachable' };
		const fileUrl = `${publicBase.replace(/\/$/, '')}/${key}`;
		const init = await fetch(`https://graph.facebook.com/v21.0/${pageId}/video_reels`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ upload_phase: 'start', access_token: token }),
		});
		const i = await init.json();
		if (i.error) throw new Error(`Meta start: ${i.error.message}`);
		const up = await fetch(i.upload_url ?? `https://graph.facebook.com/v21.0/${i.video_id}`, {
			method: 'POST',
			headers: { Authorization: `OAuth ${token}`, file_url: fileUrl },
		});
		const u = await up.json().catch(() => ({}));
		if (u.error) throw new Error(`Meta upload: ${u.error.message}`);
		const fin = await fetch(`https://graph.facebook.com/v21.0/${pageId}/video_reels`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ upload_phase: 'finish', video_id: i.video_id, video_state: 'PUBLISHED', description: caption ?? title, access_token: token }),
		});
		const f = await fin.json();
		if (f.error) throw new Error(`Meta finish: ${f.error.message}`);
		return { ok: true, result: { videoId: i.video_id, privacy } };
	} catch (e) {
		return { ok: false, error: String(e.message ?? e) };
	}
}

export const ADAPTERS = { tiktok, youtube, meta };

/** Publish to a list of platforms. Unknown platforms are reported, not thrown. */
export async function publishTo(platforms, ctx) {
	const out = {};
	for (const p of platforms) {
		const fn = ADAPTERS[p];
		out[p] = fn ? await fn(ctx) : { ok: false, error: `unknown platform: ${p}` };
	}
	return out;
}

// Self-check: node render/publishers.js (no network, just shape/skips)
if (import.meta.url === `file://${process.argv[1]}`) {
	const assert = (await import('node:assert')).strict;
	const noop = async () => Buffer.from('');
	const r = await publishTo(['tiktok', 'youtube', 'meta', 'nope'], { key: 'k', title: 't', fetchObject: noop });
	assert.equal(r.tiktok.skipped, true);
	assert.equal(r.youtube.skipped, true);
	assert.equal(r.meta.skipped, true);
	assert.ok(r.nope.error);
	console.log('publishers self-check OK');
}
