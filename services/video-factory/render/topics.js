// Content queue: the source of topics for the n8n workflow. Replaces the
// hardcoded Topic node so the pipeline can (a) run on schedule without touching
// the workflow, and (b) later be fed by a trend/learning agent.
//
// Format of content/queue.json:
//   { "items": [ { "topic": "...", "model": "...", "flow": "...", "beats": "...", "profile": "...", "status": "pending" } ] }
//
// Status lifecycle: pending → processing (when served) → done (when the
// workflow reports success via POST /topic/done). If a render fails the item
// stays "processing"; the operator can reset it to pending manually.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = process.env.CONTENT_QUEUE
	? resolve(HERE, '..', process.env.CONTENT_QUEUE)
	: resolve(HERE, '../content/queue.json');

const DEFAULT_ITEM = {
	model: 'gemini/gemini-3.1-flash-lite-preview',
	flow: 'H',
	beats: 'hook,problem,layer1,layer2,hardest,payoff,share',
	profile: 'tiktok',
};

export async function readQueue(file = QUEUE_FILE) {
	let raw;
	try {
		raw = await readFile(file, 'utf8');
	} catch {
		return { items: [] };
	}
	try {
		const q = JSON.parse(raw);
		return Array.isArray(q.items) ? q : { items: [] };
	} catch {
		return { items: [] };
	}
}

async function writeQueue(q, file = QUEUE_FILE) {
	await writeFile(file, JSON.stringify(q, null, 2) + '\n', { mode: 0o600 });
}

/** Append topics (from a trend agent or the operator). Skips duplicates. */
export async function addTopics(items, file = QUEUE_FILE) {
	const q = await readQueue(file);
	const seen = new Set(q.items.map((i) => i.topic));
	const added = items.filter((i) => i?.topic && !seen.has(i.topic)).map((i) => ({ ...i, status: 'pending' }));
	q.items.push(...added);
	await writeQueue(q, file);
	return added.length;
}

/**
 * Serve the next pending topic and mark it processing. Returns null when empty.
 * `rank` is an optional function (item) => number; when given, the highest-rank
 * pending topic is served first (used by the learning engine to prefer flows
 * that historically performed best). Without it, FIFO order is kept.
 */
export async function nextTopic(file = QUEUE_FILE, rank) {
	const q = await readQueue(file);
	const pending = q.items.filter((i) => i.status === 'pending' || !i.status);
	if (!pending.length) return null;
	const item = rank ? [...pending].sort((a, b) => rank(b) - rank(a))[0] : pending[0];
	item.status = 'processing';
	await writeQueue(q, file);
	return { ...DEFAULT_ITEM, ...item };
}

/** Workflow calls this after a successful QC to mark the item done. */
export async function doneTopic(topic, file = QUEUE_FILE) {
	const q = await readQueue(file);
	const item = q.items.find((i) => i.topic === topic);
	if (!item) return false;
	item.status = 'done';
	await writeQueue(q, file);
	return true;
}

/** Reset any stale processing items back to pending (e.g. after a crash). */
export async function resetStale(file = QUEUE_FILE) {
	const q = await readQueue(file);
	let changed = false;
	for (const i of q.items) {
		if (i.status === 'processing') { i.status = 'pending'; changed = true; }
	}
	if (changed) await writeQueue(q, file);
	return changed;
}

// Self-check: node render/topics.js
if (import.meta.url === `file://${process.argv[1]}`) {
	const assert = (await import('node:assert')).strict;
	const { mkdtemp } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join: j } = await import('node:path');
	const dir = await mkdtemp(j(tmpdir(), 'vf-topics-'));
	const file = j(dir, 'queue.json');
	await writeQueue({ items: [{ topic: 'T1' }, { topic: 'T2', flow: 'K', status: 'done' }] }, file);
	const n1 = await nextTopic(file);
	assert.equal(n1.topic, 'T1');
	assert.equal(n1.flow, 'H');
	const n2 = await nextTopic(file);
	assert.equal(n2, null); // T2 is done, nothing pending
	assert.equal(await doneTopic('T1', file), true);
	await writeQueue({ items: [{ topic: 'T3', status: 'processing' }] }, file);
	assert.equal(await resetStale(file), true);
	assert.equal(await addTopics([{ topic: 'T3' }, { topic: 'T4' }], file), 1);
	console.log('topics self-check OK');
}
