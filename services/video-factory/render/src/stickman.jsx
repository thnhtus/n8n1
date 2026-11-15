// Stickman cast drawn in SVG from a small 2-bone rig. No assets needed.
// scene.actor = { action, mood, cast, flip, lottieUrl }. If lottieUrl is set, a Lottie file is drawn instead.
import React, { useEffect, useState } from 'react';
import { AbsoluteFill, continueRender, delayRender, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { Lottie } from '@remotion/lottie';

export const ACTIONS = ['idle', 'walk', 'run', 'jump', 'wave', 'think', 'cheer', 'sit', 'fall', 'point', 'shrug', 'dance'];
export const MOODS = ['happy', 'neutral', 'sad'];

const TAU = Math.PI * 2;
const LEG = 80; // thigh = shin
const ARM = 64; // upper arm = forearm
const TORSO = 110;
const HEAD = 26;

// Pose at time t (seconds). Limb angles are radians from straight down; + points toward the facing side.
// [upper, bend] per limb: arms = [back, front], legs = [back, front]. lift moves the hip up, lean tilts the torso.
const POSES = {
	idle: (t) => { const s = Math.sin(t * TAU * 0.5); return { lift: 0, lean: 0.03 * s, arms: [[-0.15, 0.2], [0.15 + 0.05 * s, 0.2]], legs: [[-0.08, 0], [0.08, 0]] }; },
	walk: (t) => { const s = Math.sin(t * TAU * 1.1); return { lift: 3 * Math.abs(s), lean: 0.08, arms: [[-0.5 * s, 0.4], [0.5 * s, 0.4]], legs: [[0.5 * s, -0.5 * Math.max(0, -s)], [-0.5 * s, -0.5 * Math.max(0, s)]] }; },
	run: (t) => { const s = Math.sin(t * TAU * 2.2); return { lift: 10 * Math.abs(s), lean: 0.3, arms: [[-1.0 * s, 1.4], [1.0 * s, 1.4]], legs: [[0.9 * s, -1.1 * Math.max(0, -s) - 0.2], [-0.9 * s, -1.1 * Math.max(0, s) - 0.2]] }; },
	jump: (t) => { const p = (t * 0.9) % 1; const air = Math.max(0, Math.sin(Math.min(1, Math.max(0, (p - 0.2) / 0.6)) * Math.PI)); const crouch = p < 0.2 ? Math.sin((p / 0.2) * Math.PI) : 0; return { lift: 90 * air - 25 * crouch, lean: 0.15 * crouch, arms: [[-2.6 * air - 0.3, 0.2], [2.6 * air + 0.3, 0.2]], legs: [[-0.2 - 0.5 * crouch, 0.9 * crouch + 0.4 * air], [0.2 + 0.5 * crouch, -0.9 * crouch - 0.4 * air]] }; },
	wave: (t) => ({ lift: 0, lean: 0, arms: [[-0.15, 0.2], [2.5, 0.5 + 0.45 * Math.sin(t * TAU * 2)]], legs: [[-0.08, 0], [0.08, 0]] }),
	think: (t) => ({ lift: 0, lean: -0.05 + 0.03 * Math.sin(t * TAU * 0.4), arms: [[-0.2, 1.6], [0.5, 2.4]], legs: [[-0.08, 0], [0.12, 0]], tilt: 0.15 }),
	cheer: (t) => { const s = Math.sin(t * TAU * 2); return { lift: 12 * Math.abs(s), lean: 0, arms: [[-2.7 - 0.2 * s, -0.2], [2.7 + 0.2 * s, 0.2]], legs: [[-0.25, 0], [0.25, 0]] }; },
	sit: (t) => ({ lift: -LEG, lean: -0.1 + 0.02 * Math.sin(t * TAU * 0.5), arms: [[0.6, 0.9], [0.7, 0.9]], legs: [[1.5, -1.5], [1.4, -1.4]] }),
	fall: (t) => { const k = Math.min(1, t / 0.6); return { lift: 0, lean: 0, arms: [[-1.2 * k, 0.6], [1.6 * k, 0.4]], legs: [[-0.3 * k, 0.2], [0.4 * k, -0.4]], tip: k * k * 1.45 }; },
	point: (t) => ({ lift: 0, lean: 0.05, arms: [[-0.15, 0.2], [1.55 + 0.05 * Math.sin(t * TAU), 0]], legs: [[-0.1, 0], [0.15, 0]] }),
	shrug: (t) => { const k = 0.5 + 0.5 * Math.sin(t * TAU * 0.7); return { lift: 0, lean: 0, arms: [[-0.4 - 0.2 * k, -1.4], [0.4 + 0.2 * k, 1.4]], legs: [[-0.1, 0], [0.1, 0]], shrug: 8 * k, tilt: 0.12 * k }; },
	dance: (t) => { const s = Math.sin(t * TAU * 1.6); const c = Math.cos(t * TAU * 1.6); return { lift: 8 * Math.abs(s), lean: 0.2 * s, arms: [[-1.6 - c, 0.8], [1.6 - c, -0.8]], legs: [[-0.5 * s - 0.1, 0.3], [-0.5 * s + 0.1, -0.3]] }; },
};

const limb = (from, [a, b], len, dir) => {
	const mid = { x: from.x + dir * len * Math.sin(a), y: from.y + len * Math.cos(a) };
	return [mid, { x: mid.x + dir * len * Math.sin(a + b), y: mid.y + len * Math.cos(a + b) }];
};

/** One figure, feet on y = 0 (ground). dir = 1 faces right, -1 faces left. */
export const Figure = ({ pose, dir = 1, mood = 'neutral', color = '#f6f7f9' }) => {
	const hip = { x: 0, y: -2 * LEG - pose.lift };
	const neck = { x: hip.x + dir * TORSO * Math.sin(pose.lean), y: hip.y - TORSO * Math.cos(pose.lean) };
	const sh = { x: neck.x, y: neck.y + 6 - (pose.shrug ?? 0) };
	const head = { x: neck.x + dir * (HEAD + 4) * Math.sin(pose.lean + (pose.tilt ?? 0)), y: neck.y - (HEAD + 4) * Math.cos(pose.lean + (pose.tilt ?? 0)) };
	const bones = [
		[hip, neck],
		...pose.legs.map((l) => limb(hip, l, LEG, dir)).flatMap(([k, f]) => [[hip, k], [k, f]]),
		...pose.arms.map((l) => limb(sh, l, ARM, dir)).flatMap(([e, h]) => [[sh, e], [e, h]]),
	];
	const ln = { stroke: color, strokeLinecap: 'round', fill: 'none' };
	const mouth = { happy: 'M -9 5 Q 0 13 9 5', sad: 'M -9 10 Q 0 2 9 10', neutral: 'M -8 7 L 8 7' }[mood];
	// Pivot near the feet so "fall" tips over instead of spinning in the air.
	return (
		<g transform={`rotate(${dir * (pose.tip ?? 0) * 57.3})`}>
			{bones.map(([a, b], i) => <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={9} {...ln} />)}
			<g transform={`translate(${head.x} ${head.y}) scale(${dir} 1)`}>
				<circle r={HEAD} strokeWidth={8} {...ln} />
				<circle cx={4} cy={-4} r={3} fill={color} />
				<circle cx={14} cy={-4} r={3} fill={color} />
				<path d={mouth} transform="translate(8 0)" strokeWidth={3.5} {...ln} />
			</g>
		</g>
	);
};

const LottieActor = ({ src, size }) => {
	const [data, setData] = useState(null);
	const [handle] = useState(() => delayRender(`lottie ${src}`));
	useEffect(() => {
		fetch(src).then((r) => r.json()).then(setData)
			.catch((e) => console.warn('[lottie]', e.message))
			.finally(() => continueRender(handle));
	}, [src, handle]);
	return data ? <Lottie animationData={data} loop style={{ width: size, height: size }} /> : null;
};

export const INK = '#0a0a0a';

/**
 * Stage layer for one scene: cast of 1–6 figures on a ground line. Walk/run cross the stage.
 * groundY = y of the ground inside a 1080-wide frame. Fades in over 6 frames.
 */
export const CastStage = ({ actor, frames, groundY = 1380 }) => {
	const f = useCurrentFrame();
	const { fps, width } = useVideoConfig();
	const t = f / fps;
	const fade = interpolate(f, [0, 6], [0, 1], { extrapolateRight: 'clamp' });
	const size = 520;
	if (actor.lottieUrl) {
		return (
			<AbsoluteFill style={{ opacity: fade }}>
				<div style={{ position: 'absolute', left: (width - size) / 2, top: groundY - size }}><LottieActor src={actor.lottieUrl} size={size} /></div>
			</AbsoluteFill>
		);
	}
	const action = ACTIONS.includes(actor.action) ? actor.action : 'idle';
	const cast = Math.min(6, Math.max(1, Math.round(Number(actor.cast) || 1)));
	const mood = MOODS.includes(actor.mood) ? actor.mood : 'neutral';
	const travel = action === 'walk' || action === 'run';
	const go = actor.flip ? -1 : 1;
	const gap = Math.min(170, 760 / cast);
	const dx = travel ? go * interpolate(f, [0, frames], [-200, 200]) : 0;
	return (
		<AbsoluteFill style={{ opacity: fade }}>
			<svg width={width} height={groundY + 20} style={{ position: 'absolute', overflow: 'visible', filter: 'drop-shadow(0 6px 14px rgba(0,0,0,0.55))' }}>
				<line x1={width * 0.12} x2={width * 0.88} y1={groundY} y2={groundY} stroke="rgba(255,255,255,0.22)" strokeWidth={3} strokeLinecap="round" />
				{Array.from({ length: cast }, (_, i) => {
					const x = (i - (cast - 1) / 2) * gap;
					// Facing: travellers share a direction; standing figures face the centre of the group.
					const dir = travel || x === 0 ? go : x < 0 ? 1 : -1;
					return (
						<g key={i} transform={`translate(${width / 2 + x + dx} ${groundY}) scale(${cast > 3 ? 0.8 : 1})`}>
							<Figure pose={POSES[action](t + i * 0.17)} dir={dir} mood={mood} color={INK} />
						</g>
					);
				})}
			</svg>
		</AbsoluteFill>
	);
};
