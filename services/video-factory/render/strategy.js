// Trend → topic feedback. Pulls Google Trends (VN RSS), asks the local LLM to
// pick finance-flavoured video topics, and appends them to the content queue.
// This is the "Trend Intelligence" path: the daily schedule can call
// GET /trends/refill so the factory always has fresh topics without a human.
import { addTopics, readQueue } from './topics.js';
import { demandFor } from './last30days.js';

const TRENDS_RSS = 'https://trends.google.com/trending/rss?geo=VN';
const ROUTER = process.env.ROUTER_BASE_URL ?? 'http://localhost:20128/v1';
import { FLOWS } from './lint.js';

const MODEL = process.env.TREND_MODEL ?? 'gemini/gemini-3.1-flash-lite-preview';
const FINANCE_KEYWORDS = ['tiền', 'lãi', 'đầu tư', 'chứng khoán', 'ngân hàng', 'nợ', 'tiết kiệm', 'vàng', 'chứng', 'tài chính', 'bảo hiểm', 'cổ phiếu', 'lạm phát'];

/** Strip HTML tags from an RSS <title> item. */
function cleanTitle(t) {
	return String(t).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim();
}

/** Fetch today's Google Trends. Returns [{ title }] (up to 40). */
export async function fetchTrends() {
	const r = await fetch(TRENDS_RSS, { signal: AbortSignal.timeout(15000) });
	if (!r.ok) throw new Error(`trends ${r.status}`);
	const xml = await r.text();
	// RSS items: <item><title>…</title>…</item>
	const titles = [...xml.matchAll(/<item>[\s\S]*?<title>([^<]*)<\/title>/g)].map((m) => cleanTitle(m[1]));
	return titles.filter(Boolean).slice(0, 40);
}

/** Ask the LLM to turn raw trends into finance topics. Returns topic strings. */
export async function topicsFromTrends(trends, limit = 5) {
	const r = await fetch(`${ROUTER}/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			model: MODEL,
			temperature: 0.8,
			max_tokens: 1200,
			stream: false,
			messages: [
				{ role: 'system', content: 'Bạn là biên tập viên kênh tài chính cá nhân Việt Nam. Từ danh sách trend hôm nay, hãy chọn các chủ đề có thể biến thành video ngắn tài chính hấp dẫn (tiền bạc, lãi suất, đầu tư, nợ, tiết kiệm, vàng, chứng khoán). Chỉ trả về JSON mảng các chuỗi chủ đề, tối đa 5, mỗi chủ đề dưới 12 từ, không markdown.' },
				{ role: 'user', content: `Trends hôm nay: ${trends.join(', ')}` },
			],
		}),
	});
	if (!r.ok) throw new Error(`llm ${r.status}`);
	const j = await r.json();
	const text = j.choices?.[0]?.message?.content ?? '';
	const start = text.indexOf('[');
	const end = text.lastIndexOf(']');
	if (start < 0 || end < 0) throw new Error('trend → topic: LLM không trả về JSON mảng');
	const arr = JSON.parse(text.slice(start, end + 1));
	return Array.isArray(arr) ? arr.map((s) => String(s).trim()).filter(Boolean).slice(0, limit) : [];
}

/**
 * Full refill: trends → topics → queue. Returns { added, topics }.
 * `keywordFilter` drops trends with no finance keyword; turn it off to accept
 * any trend (the LLM still biases toward finance).
 */
export async function refill({ limit = 5, keywordFilter = true, demand = true } = {}) {
	const trends = await fetchTrends();
	const relevant = keywordFilter ? trends.filter((t) => FINANCE_KEYWORDS.some((k) => t.toLowerCase().includes(k))) : trends;
	const pool = relevant.length ? relevant : trends;
	const topics = await topicsFromTrends(pool, limit);
	// Demand check per topic (last30days). A failed lookup keeps the topic with demand=null
	// so the queue never stalls on a flaky source; the sort only reorders what we have.
	const scored = [];
	for (const topic of topics) {
		const d = demand ? await demandFor(topic) : { ok: false };
		scored.push({ topic, demand: d.ok ? d.score : null, demandSocial: d.ok ? d.social : null });
	}
	scored.sort((a, b) => (b.demand ?? -1) - (a.demand ?? -1));
	// Spread the queue over the flow library instead of defaulting every trend topic to H:
	// a flow with no samples cannot be learned, so new topics go to the least-used flows first.
	const q = await readQueue();
	const uses = {};
	for (const i of q.items) if (i.flow) uses[i.flow] = (uses[i.flow] ?? 0) + 1;
	const flows = Object.keys(FLOWS);
	const added = await addTopics(scored.map(({ topic, demand: score, demandSocial }) => {
		const flow = [...flows].sort((a, b) => (uses[a] ?? 0) - (uses[b] ?? 0) || flows.indexOf(a) - flows.indexOf(b))[0];
		uses[flow] = (uses[flow] ?? 0) + 1;
		return { topic, flow, beats: FLOWS[flow].beats.join(','), demand: score, demandSocial };
	}));
	return { added, topics: scored, trendsSkipped: trends.length - pool.length };
}

// Self-check: node render/strategy.js (network-free — mocks fetch)
if (import.meta.url === `file://${process.argv[1]}`) {
	const assert = (await import('node:assert')).strict;
	const origFetch = global.fetch;
	global.fetch = async (url) => {
		if (String(url).startsWith('https://trends')) {
			return { ok: true, text: async () => '<rss><channel><item><title>bitcoin</title></item><item><title>phim mới</title></item></channel></rss>' };
		}
		return {
			ok: true,
			json: async () => ({ choices: [{ message: { content: '["Vàng tăng giá","Lãi suất tiết kiệm"]' } }] }),
		};
	};
	const t = await fetchTrends();
	assert.deepEqual(t, ['bitcoin', 'phim mới']);
	// temporary queue to avoid touching the real one
	const { mkdtemp } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join: j } = await import('node:path');
	const dir = await mkdtemp(j(tmpdir(), 'vf-strategy-'));
	const file = j(dir, 'queue.json');
	await (await import('node:fs/promises')).writeFile(file, JSON.stringify({ items: [] }), 'utf8');
	const added = await addTopics((await topicsFromTrends(t)).map((x) => ({ topic: x })), file);
	assert.ok(added >= 1);
	global.fetch = origFetch;
	console.log('strategy self-check OK');
}
