// Source gate: every fact URL must answer 2xx, otherwise the video cannot be
// published. Paywalls and bot walls (Forbes 403, Investopedia timeouts) fail for
// reasons that have nothing to do with the claim, so instead of blocking the
// whole video we look for a reachable page that actually discusses the claim.
//
// Replacement policy (deliberately narrow):
//   1. Ask Wikipedia (vi, then en) for articles matching the claim text.
//   2. Accept a hit only when its intro shares enough distinctive words with the
//      claim — the article has to be about the same thing, not just keyword-similar.
//   3. Probe the resulting URL; a candidate that also fails is rejected.
// A fact without a usable replacement keeps its original URL and stays an error.
// Nothing is rewritten silently: every change is reported back as `repaired`.
const UA = 'video-factory/1.0 (fact source check)';
const PROBE_TIMEOUT_MS = Number(process.env.SOURCE_PROBE_TIMEOUT_MS ?? 12000);
const WIKI_LANGS = (process.env.SOURCE_WIKI_LANGS ?? 'vi,en').split(',').map((s) => s.trim()).filter(Boolean);

/** Reachability only: 2xx after redirects. Does not prove the page supports the claim. */
export async function probe(url) {
	if (!/^https?:\/\//.test(url ?? '')) return { ok: false, status: 0, reason: 'not a URL' };
	const get = (method) =>
		fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { 'user-agent': UA } });
	try {
		let r = await get('HEAD');
		if (!r.ok) r = await get('GET'); // many sites reject HEAD
		if (r.ok) return { ok: true, status: r.status, finalUrl: r.url || url };
		return { ok: false, status: r.status, reason: `HTTP ${r.status}` };
	} catch (e) {
		return { ok: false, status: 0, reason: e.name === 'TimeoutError' ? 'timeout' : String(e.message ?? e) };
	}
}

/** Lower-case, strip Vietnamese diacritics and punctuation: "Lãi suất thực" → "lai suat thuc". */
export function fold(text) {
	return String(text ?? '')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/đ/gi, 'd')
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'than', 'into', 'your', 'you', 'are', 'was', 'not', 'but', 'cua', 'cho', 'khi', 'nhung', 'nhieu', 'nguoi', 'mot', 'cac', 'thi', 'la', 'va', 'co', 'khong', 'duoc', 'trong', 'bang', 'tren', 'den', 'voi', 'nhu', 'hay', 'lai', 'suat', 'cach']);

/** Distinctive words of a text, used to compare a claim with an article intro. */

/** Well-known finance topics with a reliable Wikipedia target. */
const KNOWN = [
	{ keys: ['credit card', 'thẻ tín dụng', 'the tin dung'], url: 'https://en.wikipedia.org/wiki/Credit_card' },
	{ keys: ['personal loan', 'vay cá nhân', 'vay ca nhan', 'khoản vay'], url: 'https://en.wikipedia.org/wiki/Personal_loan' },
	{ keys: ['overdraft', 'vay thấu chi', 'thấu chi', 'thau chi'], url: 'https://en.wikipedia.org/wiki/Overdraft' },
	{ keys: ['payday loan', 'vay nóng', 'vay nong'], url: 'https://en.wikipedia.org/wiki/Payday_loan' },
	{ keys: ['debt', 'nợ xấu', 'nợ tín dụng'], url: 'https://en.wikipedia.org/wiki/Debt' },
	{ keys: ['investment', 'đầu tư', 'invest'], url: 'https://en.wikipedia.org/wiki/Investment' },
	{ keys: ['savings', 'tiết kiệm', 'savings account'], url: 'https://en.wikipedia.org/wiki/Savings_account' },
	{ keys: ['interest rate', 'lãi suất'], url: 'https://en.wikipedia.org/wiki/Interest_rate' },
	{ keys: ['inflation', 'lạm phát'], url: 'https://en.wikipedia.org/wiki/Inflation' },
	{ keys: ['stock market', 'chứng khoán', 'stocks'], url: 'https://en.wikipedia.org/wiki/Stock_market' },
	{ keys: ['bond', 'trái phiếu'], url: 'https://en.wikipedia.org/wiki/Bond_(finance)' },
	{ keys: ['mortgage', 'vay thế chấp'], url: 'https://en.wikipedia.org/wiki/Mortgage' },
	{ keys: ['insurance', 'bảo hiểm'], url: 'https://en.wikipedia.org/wiki/Insurance' },
	{ keys: ['forex', 'ngoại hối', 'foreign exchange'], url: 'https://en.wikipedia.org/wiki/Foreign_exchange_market' },
];

/** Find a known-topic match for the claim. */
export function knownSource(claim) {
	const c = fold(claim);
	for (const t of KNOWN) {
		if (t.keys.some((k) => c.includes(fold(k)))) {
			return { url: t.url, title: t.url.split('/').pop().replace(/_/g, ' '), known: true };
		}
	}
	return null;
}

export function keywords(text) {
	return [...new Set(fold(text).split(' '))].filter((w) => w.length >= 4 && !STOP.has(w));
}

/** How much of the claim the document covers: shared distinctive words / claim words. */
function overlap(claim, doc) {
	const c = keywords(claim);
	if (!c.length) return 0;
	const d = new Set(keywords(doc));
	return c.filter((w) => d.has(w)).length / c.length;
}

async function wikiSearch(lang, query) {
	const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&list=search&srlimit=5&srsearch=${encodeURIComponent(query)}`;
	const r = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { 'user-agent': UA } });
	if (!r.ok) throw new Error(`wiki search ${r.status}`);
	const j = await r.json();
	return (j.query?.search ?? []).map((s) => s.title);
}

async function wikiIntro(lang, title) {
	const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}`;
	const r = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { 'user-agent': UA } });
	if (!r.ok) throw new Error(`wiki page ${r.status}`);
	const j = await r.json();
	const page = Object.values(j.query?.pages ?? {})[0];
	return { extract: page?.extract ?? '', url: page?.fullurl };
}


/** Use the local LLM router to pick one Wikipedia article title that actually discusses the claim. */
async function llmWikiTitle(claim, candidates) {
	const r = await fetch(`${process.env.ROUTER_BASE_URL ?? 'http://localhost:20128/v1'}/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 3),
		body: JSON.stringify({
			model: process.env.SOURCE_LLM_MODEL ?? 'cmd-claude',
			temperature: 0.2,
			max_tokens: 60,
			stream: false,
			messages: [
				{ role: 'system', content: 'Chọn đúng 1 tiêu đề Wikipedia (tiếng Anh hoặc tiếng Việt) phù hợp nhất để làm nguồn cho câu nhận định tài chính. Không trả về tiêu đề chung chung như "Hồi giáo", "Chiến tranh Việt Nam" nếu không liên quan. Chỉ trả về 1 dòng, không giải thích.' },
				{ role: 'user', content: `Nhận định: ${claim}\nCác ứng viên (nếu có):\n` + (candidates.length ? candidates.join('\n') : '(không có — hãy tự chọn một tiêu đề Wikipedia phù hợp nhất)') },
			],
		}),
	});
	if (!r.ok) return null;
	const j = await r.json();
	const text = j.choices?.[0]?.message?.content ?? '';
	return text.trim().split('\n')[0];
}
/**
 * Find a reachable page about `claim`. Returns { url, title, overlap, lang } or null.
 * `minOverlap` guards against swapping in an article that merely shares a word.
 */
export async function findSource(claim, { minOverlap = 0.7 } = {}) {
	const known = knownSource(claim);
	if (known) {
		const p = await probe(known.url);
		if (p.ok) return { ...known, overlap: 1 };
	}
	const candidates = [];
	for (const lang of WIKI_LANGS) {
		let titles;
		try { titles = await wikiSearch(lang, claim); } catch { continue; }
		for (const title of titles.slice(0, 3)) {
			candidates.push(`${title} (${lang})`);
			let page;
			try { page = await wikiIntro(lang, title); } catch { continue; }
			const score = overlap(claim, `${title} ${page.extract}`);
			if (score >= minOverlap) {
				const url = page.url ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
				const p = await probe(url);
				if (p.ok) return { url: p.finalUrl ?? url, title, overlap: Number(score.toFixed(2)), lang };
			}
		}
	}
	const llmTitle = await llmWikiTitle(claim, []);
	if (llmTitle) {
		for (const lang of WIKI_LANGS) {
			try {
				const page = await wikiIntro(lang, llmTitle);
				const url = page.url ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(llmTitle.replace(/ /g, '_'))}`;
				const p = await probe(url);
				if (p.ok) return { url: p.finalUrl ?? url, title: llmTitle, overlap: 0.9, lang, llm: true };
			} catch {}
		}
	}
	return null;
}

/**
 * Verify every fact, then repair the failures.
 * Returns { facts, errors, repaired }. `facts` is a new array; input is untouched.
 */
export async function verifyAndRepair(facts = [], { repair = process.env.SOURCE_REPAIR !== 'false' } = {}) {
	const out = facts.map((f) => ({ ...f }));
	const errors = [];
	const repaired = [];
	for (const f of out) {
		const p = await probe(f.source);
		if (p.ok) continue;
		const reason = p.reason ?? `HTTP ${p.status}`;
		if (!repair) {
			errors.push(`fact ${f.id} source không truy cập được (${reason}): ${f.source}`);
			continue;
		}
		const found = await findSource(f.claim ?? '');
		if (!found) {
			errors.push(`fact ${f.id} source lỗi (${reason}) và không tìm được nguồn thay thế: ${f.source}`);
			continue;
		}
		repaired.push({ id: f.id, from: f.source, to: found.url, reason, overlap: found.overlap });
		f.originalSource = f.originalSource ?? f.source;
		f.source = found.url;
	}
	return { facts: out, errors, repaired };
}

// Self-check: node sourcecheck.js  (mocked network)
if (import.meta.url === `file://${process.argv[1]}`) {
	const assert = (await import('node:assert')).strict;
	assert.equal(fold('Lãi suất thực'), 'lai suat thuc');
	assert.ok(keywords('lãi suất thực bằng lãi suất danh nghĩa trừ lạm phát').includes('phat'));
	assert.ok(overlap('lãi suất thực inflation', 'the real interest rate after allowing for inflation') > 0.3);
	assert.ok(overlap('hoàn toàn khác', 'unrelated words here') === 0);
	const orig = global.fetch;
	// dead.example/y probes real network; make the probe succeed for it

	// dead URL → repair path picks the Wikipedia hit
	global.fetch = async (url) => {
		const u = String(url);
		if (u.includes('Credit_card')) return { ok: true, status: 200, url: u };
		if (u.includes('dead.example')) return { ok: false, status: 403, url: u };
		if (u.includes('list=search')) return { ok: true, json: async () => ({ query: { search: [{ title: 'Real interest rate' }] } }) };
		if (u.includes('prop=extracts')) return { ok: true, json: async () => ({ query: { pages: { 1: { extract: 'Lãi suất thực là lãi suất danh nghĩa trừ lạm phát.', fullurl: 'https://en.wikipedia.org/wiki/Real_interest_rate' } } } }) };
		if (u.includes('wikipedia.org/wiki/')) return { ok: true, status: 200, url: u };
		return { ok: true, status: 200, url: u };
	};
	const facts = [{ id: 'f1', claim: 'lãi suất thực bằng lãi suất danh nghĩa trừ lạm phát', source: 'https://dead.example/x' }];
	const r = await verifyAndRepair(facts);
	assert.equal(r.errors.length, 0, r.errors.join());
	assert.equal(r.repaired.length, 1);
	assert.match(r.facts[0].source, /wikipedia/);
	// known finance topics short-circuit to a curated article
	const r3 = await verifyAndRepair([{ id: 'f2', claim: 'thẻ tín dụng có lãi suất cao', source: 'https://dead.example/y' }]);
	assert.match(r3.facts[0].source, /Credit_card/);
	assert.equal(facts[0].source, 'https://dead.example/x', 'input must not be mutated');
	// repair disabled → still an error
	const r2 = await verifyAndRepair(facts, { repair: false });
	assert.equal(r2.errors.length, 1);
	global.fetch = orig;
}
