import { AbsoluteFill, Audio, Composition, Easing, Img, Sequence, interpolate, registerRoot, useCurrentFrame, useVideoConfig } from 'remotion';
import { SceneGraphic } from './visuals.jsx';
import { CastStage, INK } from './stickman.jsx';

const FPS = 30;
const CHUNK = 4;
const SAFE = { width: 1080, height: 1920, topPx: 212, bottomPx: 1726, panelMaxWidthPx: 774 };
const toFrames = (sec) => Math.max(1, Math.round(sec * FPS));


/**
 * Always-animating background: a bright base gradient, two aurora blobs that
 * float on sine waves, and a slow zoom. It never drops below a mid-dark
 * lightness, so `blackdetect` never flags an "empty" gap as black.
 */
const Background = ({ hue, beat }) => {
	const f = useCurrentFrame();
	const t = f / FPS;
	const drift = (v) => 50 + 30 * Math.sin(t * v * 0.6 + hue);
	const zoom = 1 + 0.04 * Math.sin(t * 0.35);
	const pulse = beat ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0)';
	return (
		<AbsoluteFill>
			<div
				style={{
					position: 'absolute', inset: 0,
					background: `radial-gradient(circle at 50% 38%, hsl(${hue},45%,26%), hsl(${(hue + 24) % 360},42%,18%) 55%, hsl(${(hue + 48) % 360},40%,13%) 100%)`,
					transform: `scale(${zoom})`,
				}}
			/>
			<div
				style={{
					position: 'absolute', width: '70%', height: '80%', left: 0, top: 0,
					borderRadius: '50%',
					background: `radial-gradient(circle, hsla(${(hue + 120) % 360},80%,55%,0.28), transparent 70%)`,
					transform: `translate(${drift(1)}px, ${drift(2)}px)`,
					filter: 'blur(40px)',
				}}
			/>
			<div
				style={{
					position: 'absolute', width: '70%', height: '80%', right: 0, bottom: 0,
					borderRadius: '50%',
					background: `radial-gradient(circle, hsla(${(hue + 240) % 360},80%,55%,0.24), transparent 70%)`,
					transform: `translate(${-drift(3)}px, ${-drift(4)}px)`,
					filter: 'blur(40px)',
				}}
			/>
			<div style={{ position: 'absolute', inset: 0, background: pulse }} />
		</AbsoluteFill>
	);
};

/** Thin progress bar filling over the total duration: guarantees motion everywhere. */
const ProgressBar = ({ frames }) => {
	const f = useCurrentFrame();
	const p = Math.min(1, f / Math.max(1, frames));
	const hue = (f * 0.4) % 360;
	return (
		<div style={{ position: 'absolute', left: 0, bottom: 60, width: '100%', height: 10, background: 'rgba(255,255,255,0.10)' }}>
			<div style={{ width: `${p * 100}%`, height: '100%', background: `hsl(${hue},80%,60%)`, borderRadius: '0 5px 5px 0' }} />
		</div>
	);
};

// Speed-floored ease (shorts-kit camEase): smoothstep blended with linear so moves never stop dead.
const camEase = (t, tail = 0.34) => {
	const x = Math.min(1, Math.max(0, t));
	return (1 - tail) * x * x * (3 - 2 * x) + tail * x;
};

/** Film grain: per-frame feTurbulence seed so the noise moves. */
const Grain = () => {
	const seed = useCurrentFrame() % 12;
	return (
		<svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.14, mixBlendMode: 'overlay', pointerEvents: 'none' }}>
			<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={seed} stitchTiles="stitch" /></filter>
			<rect width="100%" height="100%" filter="url(#grain)" />
		</svg>
	);
};

const Vignette = () => (
	<AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(0,0,0,0.45) 100%)', pointerEvents: 'none' }} />
);

/** Warm flash on scene boundaries only (not every cut): 0 → 0.5 → 0 over 8 frames. */
const FlashCut = ({ at }) => {
	const f = useCurrentFrame();
	const o = at.reduce((m, s) => Math.max(m, interpolate(f - s, [-2, 1, 6], [0, 0.5, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })), 0);
	return o > 0.01 ? <AbsoluteFill style={{ background: 'radial-gradient(circle at 50% 45%, rgba(255,214,160,1), rgba(255,170,90,0.4) 60%, transparent 100%)', opacity: o, pointerEvents: 'none' }} /> : null;
};

/**
 * Word-timed caption. TTS gives no word boundaries, so word times are
 * estimated from character length across the spoken audio (mp3Sec).
 * ponytail: estimate only; switch to edge-tts WordBoundary events when sync drifts visibly.
 * Speaking word = accent colour + pop 0.92→1 over 0.12s. Read words stay white;
 * upcoming words sit at a 0.35 floor, so the panel never reads as black.
 */
const Line = ({ text, frames, hold, variant, speechSec, ink = '#fff', accent = '#ffd166' }) => {
	const f = useCurrentFrame();
	const { fps } = useVideoConfig();
	const words = text.trim().split(/\s+/).filter(Boolean);
	const speechF = Math.max(1, Math.min(frames - hold, Math.round((speechSec ?? (frames - hold) / fps) * fps)));
	const weights = words.map((w) => w.length + 1);
	const sum = weights.reduce((a, b) => a + b, 0) || 1;
	let acc = 0;
	const starts = weights.map((w) => { const s = (acc / sum) * speechF; acc += w; return s; });
	const cur = f >= speechF ? words.length : Math.max(0, starts.findLastIndex((s) => f >= s));
	const chunkIdx = Math.floor(Math.min(cur, words.length - 1) / CHUNK);
	const chunkWords = words.slice(chunkIdx * CHUNK, chunkIdx * CHUNK + CHUNK);
	const localF = f - starts[chunkIdx * CHUNK];
	const enter = interpolate(localF, [0, 6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.exp) });

	let transform = '';
	let blur = 0;
	if (variant === 0) { blur = (1 - enter) * 5; transform = `translateY(${(1 - enter) * 16}px)`; }
	else if (variant === 1) transform = `scale(${0.94 + enter * 0.06})`;
	else if (variant === 2) transform = `translateX(${(1 - enter) * -20}px)`;
	else transform = `translateY(${(1 - enter) * -12}px) scale(${0.97 + enter * 0.03})`;

	const popF = Math.round(fps * 0.12);
	return (
		<div style={{ opacity: Math.max(0.18, enter), transform, filter: blur > 0.1 ? `blur(${blur.toFixed(1)}px)` : 'none', fontSize: 62, fontWeight: 800, textAlign: 'center', lineHeight: 1.25, textShadow: '0 4px 20px rgba(0,0,0,0.65)' }}>
			{chunkWords.map((w, k) => {
				const wi = chunkIdx * CHUNK + k;
				const speaking = wi === cur;
				const pop = speaking ? interpolate(f - starts[wi], [0, popF], [0.92, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.back(2)) }) : 1;
				return (
					<span key={wi} style={{ display: 'inline-block', marginRight: '0.16em', color: speaking ? accent : ink, opacity: wi <= cur ? 1 : 0.35, transform: `scale(${pop})` }}>{w}</span>
				);
			})}
		</div>
	);
};

export const Short = ({ title, scenes = [], outroHold = 3, safe = SAFE, beatFrames = [] }) => {
	const f = useCurrentFrame();
	const { durationInFrames } = useVideoConfig();
	const flatLines = scenes.flatMap((s, si) => (s.lines ?? []).map((l) => ({ ...l, scene: s.id, variant: si % 4, hasVisual: !!s.visual?.type || !!s.actor })));
	let cursor = 0;
	const seqs = flatLines.map((l, i) => {
		const isLast = i === flatLines.length - 1;
		const hold = isLast ? Math.round(outroHold * FPS) : 0;
		const durFrames = l.frames ?? toFrames(l.durationSec ?? l.duration ?? 2) + hold;
		const item = { ...l, start: cursor, frames: durFrames, hold };
		cursor += durFrames;
		return item;
	});

	// Scene start frames + optional graphic: shown from the scene's `visual.anchor` word (estimated like the
	// captions, since TTS has no word boundaries) and held for the whole scene.
	const sceneBoxes = scenes.map((s) => {
		const own = seqs.filter((l) => l.scene === s.id);
		if (!own.length) return null;
		const start = own[0].start;
		const end = own[own.length - 1].start + own[own.length - 1].frames;
		let anchor = start;
		if (s.visual?.anchor) {
			const needle = String(s.visual.anchor).toLowerCase();
			for (const l of own) {
				const ws = l.text.toLowerCase().split(/\s+/).filter(Boolean);
				if (!ws.some((w) => w.startsWith(needle))) continue;
				const weights = ws.map((w) => w.length + 1);
				const sum = weights.reduce((a, b) => a + b, 0) || 1;
				const speechF = Math.round((l.mp3Sec ?? l.frames / FPS) * FPS);
				const idx = ws.findIndex((w) => w.startsWith(needle));
				const before = weights.slice(0, idx).reduce((a, b) => a + b, 0);
				anchor = l.start + Math.round((before / sum) * speechF);
				break;
			}
		}
		return { scene: s, start, frames: Math.max(8, end - start), anchor };
	}).filter(Boolean);

	const titleOpacity = interpolate(f, [0, 8], [0, 0.9], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.exp) });
	const titleY = interpolate(f, [0, 8], [12, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.exp) });

	// Stickman-only scenes drop all backgrounds: plain white, black ink.
	const plain = scenes.length > 0 && scenes.every((s) => s.actor);
	const nearBeat = beatFrames.some((bf) => Math.abs(f - bf) <= 2);
	const activeSceneIdx = seqs.findIndex((s) => f >= s.start && f < s.start + s.frames);
	const sceneHue = ((activeSceneIdx >= 0 ? activeSceneIdx : 0) * 32 + f * 0.25) % 360;
	const width = safe.width ?? safe.widthPx ?? 1080;
	const height = safe.height ?? 1920;
	const marginX = Math.round((width - safe.panelMaxWidthPx) / 2);
	// Slow camera push per scene (1 → 1.06), eased with a speed floor; resets at each scene boundary.
	const sceneStarts = seqs.filter((l, i) => i === 0 || l.scene !== seqs[i - 1].scene).map((l) => l.start);
	const curScene = Math.max(0, sceneStarts.findLastIndex((s) => f >= s));
	const sceneEnd = sceneStarts[curScene + 1] ?? durationInFrames;
	const curSceneId = seqs.find((l) => l.start === sceneStarts[curScene])?.scene;
	const curBg = scenes.find((s) => s.id === curSceneId)?.bgUrl;
	const push = 1 + 0.06 * camEase((f - sceneStarts[curScene]) / Math.max(1, sceneEnd - sceneStarts[curScene]));

	return (
		<AbsoluteFill style={{ fontFamily: 'sans-serif', overflow: 'hidden' }}>
			{plain ? <AbsoluteFill style={{ background: '#ffffff' }} /> : <Background hue={sceneHue} beat={nearBeat} />}
			{curBg && <AbsoluteFill style={{ transform: `scale(${1.05 + 0.05 * camEase((f - sceneStarts[curScene]) / Math.max(1, sceneEnd - sceneStarts[curScene]))})` }}><Img src={curBg} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.55 }} /></AbsoluteFill>}
			{!plain && <Vignette />}
			{!plain && <Grain />}
			{sceneBoxes.map((b, i) => (b.scene.actor ? (
				<Sequence key={`a${i}`} from={b.start} durationInFrames={b.frames}>
					<CastStage actor={b.scene.actor} frames={b.frames} />
				</Sequence>
			) : null))}
			<FlashCut at={sceneStarts.slice(1)} />
			<ProgressBar frames={durationInFrames} />
			<div style={{ transform: `scale(${push})`, transformOrigin: '50% 50%', position: 'absolute', top: safe.topPx, bottom: height - safe.bottomPx, left: marginX, right: marginX, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'center', padding: '24px 0' }}>
				<div style={{ opacity: titleOpacity, transform: `translateY(${titleY}px)`, fontSize: 38, fontWeight: 700, color: plain ? INK : '#fff', textAlign: 'center', lineHeight: 1.25 }}>{title}</div>
				<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', position: 'relative' }}>
					{!plain && sceneBoxes.map((b, i) => (
						b.scene.visual ? (
							<Sequence key={`v${i}`} from={b.anchor} durationInFrames={Math.max(8, b.start + b.frames - b.anchor)}>
								<AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-start', paddingTop: 80 }}>
									<SceneGraphic visual={b.scene.visual} startFrame={0} />
								</AbsoluteFill>
							</Sequence>
						) : null
					))}
					{seqs.map((l, i) => (
						<Sequence key={i} from={l.start} durationInFrames={l.frames}>
							<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: l.hasVisual ? 'flex-end' : 'center', justifyContent: 'center', paddingBottom: l.hasVisual ? 120 : 0 }}>
								{l.audioUrl && <Audio src={l.audioUrl} />}
								<Line text={l.text} frames={l.frames} hold={l.hold} variant={l.variant} speechSec={l.mp3Sec} ink={plain ? INK : '#fff'} accent={plain ? '#d62828' : '#ffd166'} />
							</div>
						</Sequence>
					))}
				</div>
				<div style={{ fontSize: 22, color: plain ? 'rgba(10,10,10,0.55)' : 'rgba(255,255,255,0.55)', letterSpacing: '0.06em' }}>
					{activeSceneIdx >= 0 ? `${seqs[activeSceneIdx].scene.toUpperCase()}` : ''}
				</div>
			</div>
		</AbsoluteFill>
	);
};

const Root = () => (
	<Composition
		id="Short"
		component={Short}
		durationInFrames={300}
		fps={FPS}
		width={1080}
		height={1920}
		calculateMetadata={({ props }) => {
			const total = (props.scenes ?? []).flatMap((s) => s.lines ?? []).reduce((a, l) => a + toFrames(l.durationSec ?? l.duration ?? 2), 0) + toFrames(props.outroHold ?? 0);
			return { durationInFrames: Math.max(FPS, total) };
		}}
		defaultProps={{ title: 'Video Factory', outroHold: 3, scenes: [{ id: 'hook', lines: [{ text: 'Preview', durationSec: 2 }] }] }}
	/>
);

registerRoot(Root);
