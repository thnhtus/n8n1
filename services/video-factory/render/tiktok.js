// TikTok Content Posting API: OAuth token storage + Direct Post via FILE_UPLOAD (no public URL needed).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const API = 'https://open.tiktokapis.com/v2';
export const TOKEN_FILE = fileURLToPath(new URL('../data/tiktok-token.json', import.meta.url));
const cfg = () => {
	const { TIKTOK_CLIENT_KEY: key, TIKTOK_CLIENT_SECRET: secret, TIKTOK_REDIRECT_URI: redirect } = process.env;
	if (!key || !secret || !redirect) throw new Error('Set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI in .env');
	return { key, secret, redirect };
};

export function authUrl(state) {
	const { key, redirect } = cfg();
	const q = new URLSearchParams({ client_key: key, scope: 'user.info.basic,video.publish', response_type: 'code', redirect_uri: redirect, state });
	return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
}

async function tokenRequest(params) {
	const { key, secret } = cfg();
	const r = await fetch(`${API}/oauth/token/`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_key: key, client_secret: secret, ...params }),
	});
	const t = await r.json();
	if (!t.access_token) throw new Error(`TikTok token: ${t.error ?? r.status} ${t.error_description ?? ''}`);
	t.expires_at = Date.now() + (t.expires_in - 300) * 1000;
	await writeFile(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
	return t;
}

export const exchangeCode = (code) => tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: cfg().redirect });

async function accessToken() {
	let t;
	try {
		t = JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
	} catch {
		throw new Error('No TikTok token. Run: node render/tiktok-auth.js');
	}
	// Access token lives 24h, refresh token 365 days.
	if (Date.now() > t.expires_at) t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
	return t.access_token;
}

async function call(path, body, token) {
	const r = await fetch(`${API}${path}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
		body: JSON.stringify(body ?? {}),
	});
	const j = await r.json();
	if (j.error?.code && j.error.code !== 'ok') throw new Error(`TikTok ${path}: ${j.error.code} ${j.error.message}`);
	return j.data;
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Upload one mp4 buffer as a Direct Post. Unaudited apps can only post SELF_ONLY. */
export async function publish({ video, title, privacy = process.env.TIKTOK_PRIVACY ?? 'SELF_ONLY' }) {
	const token = await accessToken();
	const creator = await call('/post/publish/creator_info/query/', {}, token);
	const options = creator.privacy_level_options ?? [];
	const privacy_level = options.includes(privacy) ? privacy : options.includes('SELF_ONLY') ? 'SELF_ONLY' : options[0];
	const size = video.length;
	// ponytail: single chunk, fine up to 64 MB (a 60 s short is ~10 MB). Chunk the PUT for longer videos.
	if (size > 64 * 1024 * 1024) throw new Error('Video over 64 MB: chunked upload not implemented');
	const init = await call(
		'/post/publish/video/init/',
		{
			post_info: { title: title.slice(0, 2200), privacy_level, video_cover_timestamp_ms: 1000 },
			source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 },
		},
		token,
	);
	const put = await fetch(init.upload_url, {
		method: 'PUT',
		headers: { 'content-type': 'video/mp4', 'content-range': `bytes 0-${size - 1}/${size}` },
		body: video,
	});
	if (!put.ok) throw new Error(`TikTok upload ${put.status}: ${(await put.text()).slice(0, 200)}`);
	let status;
	for (let i = 0; i < 20; i++) {
		await sleep(3000);
		status = await call('/post/publish/status/fetch/', { publish_id: init.publish_id }, token);
		if (['PUBLISH_COMPLETE', 'FAILED'].includes(status.status)) break;
	}
	if (status.status === 'FAILED') throw new Error(`TikTok publish failed: ${status.fail_reason}`);
	return { publishId: init.publish_id, status: status.status, privacy: privacy_level, creator: creator.creator_username };
}
