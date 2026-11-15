// Audio cue planner (SFX + ducked music bed) and ffmpeg filter_complex builder.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Pick cause-linked SFX events from scene boundaries, numbers, and explicit cues. */
export function planSfx(scenes, lineTimings, T, sfxDir) {
	const events = [];
	const numPool = T.sfx?.number ?? ['pop', 'tick'];
	const cutPool = T.sfx?.cut ?? ['whoosh'];
	const payoffPool = T.sfx?.payoff ?? ['riser'];
	const leadSec = (T.sfx?.leadFrames ?? 1) / (T.video?.fps ?? 30);

	let numIdx = 0;
	let cutIdx = 0;
	const seenScenes = new Set();

	for (let i = 0; i < lineTimings.length; i++) {
		const l = lineTimings[i];
		const isNewScene = !seenScenes.has(l.scene);
		seenScenes.add(l.scene);

		let name = l.sfx;
		let atSec = l.start + leadSec;

		if (!name && isNewScene && seenScenes.size > 1) {
			const isLast = seenScenes.size === scenes.length && scenes.length >= 2;
			if (isLast && existsSync(join(sfxDir, `${payoffPool[0]}.mp3`))) {
				name = payoffPool[0];
				atSec = Math.max(0, l.start - 0.5);
			} else {
				name = cutPool[cutIdx++ % cutPool.length];
			}
		} else if (!name && /\d+/.test(l.text)) {
			name = numPool[numIdx++ % numPool.length];
			atSec = l.start + 0.15;
		}

		if (!name) continue;
		const clean = String(name).replace(/[^a-z0-9_-]/gi, '');
		const file = join(sfxDir, `${clean}.mp3`);
		if (existsSync(file)) events.push({ name: clean, file, atSec: Number(atSec.toFixed(3)) });
	}
	return events;
}

/** Build ffmpeg input args + filter_complex mixing voice [0:a], optional music, and SFX, ending with loudnorm. */
export function buildAudioMix({ totalSec, speechEndSec, musicPath, musicVolume, sfxEvents, T }) {
	const inputs = [];
	const filters = [];
	const fmt = `aformat=sample_rates=${T.audio.sampleRate}:channel_layouts=stereo`;
	const mixInputs = [];

	if (musicPath) {
		inputs.push('-stream_loop', '-1', '-i', musicPath);
		const mIdx = 1;
		const vol = musicVolume ?? T.music?.bedVolume ?? 0.14;
		const fade = Math.min(T.music?.fadeOutSec ?? 1.5, Math.max(0.2, totalSec - 0.2));
		const fadeStart = Math.max(0, Math.min(speechEndSec, totalSec) - fade * 0.5);
		filters.push(
			`[0:a]${fmt},apad=whole_dur=${totalSec.toFixed(3)},atrim=0:${totalSec.toFixed(3)},asplit=2[v_mix][v_sc]`,
			`[${mIdx}:a]${fmt},atrim=0:${totalSec.toFixed(3)},asetpts=PTS-STARTPTS,volume=${vol},afade=t=out:st=${fadeStart.toFixed(3)}:d=${fade.toFixed(3)}[m_bed]`,
			`[m_bed][v_sc]sidechaincompress=${T.music?.duck ?? 'threshold=0.02:ratio=9:attack=200:release=500:level_sc=1:mix=0.9'}[m_duck]`,
		);
		mixInputs.push('[v_mix]', '[m_duck]');
	} else {
		filters.push(`[0:a]${fmt},apad=whole_dur=${totalSec.toFixed(3)},atrim=0:${totalSec.toFixed(3)}[v_mix]`);
		mixInputs.push('[v_mix]');
	}

	const sfxOffset = musicPath ? 2 : 1;
	const sfxVol = T.sfx?.volume ?? 0.6;
	sfxEvents.forEach((ev, i) => {
		inputs.push('-i', ev.file);
		const inIdx = sfxOffset + i;
		const ms = Math.max(0, Math.round(ev.atSec * 1000));
		const tag = `[sfx_${i}]`;
		filters.push(`[${inIdx}:a]${fmt},volume=${sfxVol},adelay=${ms}:all=1${tag}`);
		mixInputs.push(tag);
	});

	const norm = `loudnorm=I=${T.audio.loudnessLUFS}:TP=${T.audio.truePeakMaxDb}:LRA=11`;
	if (mixInputs.length === 1) {
		filters.push(`${mixInputs[0]}${norm}[aout]`);
	} else {
		filters.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:normalize=0:dropout_transition=0,${norm}[aout]`);
	}
	return { inputs, filterComplex: filters.join(';') };
}
