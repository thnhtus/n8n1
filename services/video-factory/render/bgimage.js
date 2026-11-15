// Per-scene background image from 9Router (OpenAI-compatible /images/generations).
// Returns false on any failure so the animated gradient still renders.
import { writeFile } from 'node:fs/promises';

const ROUTER = process.env.ROUTER_BASE_URL ?? 'http://localhost:20128/v1';
const MODEL = process.env.BG_IMAGE_MODEL ?? 'cf/@cf/black-forest-labs/flux-1-schnell';
const STYLE = 'minimal dark atmospheric background, abstract light and texture, 9:16 vertical, out of focus backdrop, no people, no faces, no text';

export async function genBackground(prompt, file) {
	try {
		const r = await fetch(`${ROUTER}/images/generations`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: MODEL, prompt: `${prompt}. ${STYLE}`, n: 1 }),
			signal: AbortSignal.timeout(120000),
		});
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const b64 = (await r.json()).data?.[0]?.b64_json;
		if (!b64) throw new Error('no b64_json in response');
		await writeFile(file, Buffer.from(b64, 'base64'));
		return true;
	} catch (e) {
		// ponytail: no retry, no cache. Ceiling: a failed scene shows the gradient. Add retry when this fails often.
		console.warn(`[bg] ${e.message}`);
		return false;
	}
}
