// Pure-SVG graphics inspired by shorts-kit (charts, odometer, progress, compare bars).
// Zero external dependencies; driven by Remotion frame interpolation.
import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';

const camEase = (t, tail = 0.3) => {
	const x = Math.min(1, Math.max(0, t));
	return (1 - tail) * x * x * (3 - 2 * x) + tail * x;
};

/** Big stat counter: counts up 0 → value, formatted with prefix/suffix. */
export const StatGraphic = ({ value = 100, label = '', prefix = '', suffix = '', startFrame = 0, durFrames = 24 }) => {
	const f = useCurrentFrame();
	const t = (f - startFrame) / Math.max(1, durFrames);
	const progress = camEase(t);
	const current = Math.round(progress * value);
	const scale = interpolate(f - startFrame, [0, 6, durFrames], [0.85, 1.05, 1], {
		extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.back(1.5)),
	});
	const opacity = interpolate(f - startFrame, [0, 4], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
	return (
		<div style={{ opacity, transform: `scale(${scale})`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '16px 28px', background: 'rgba(255,255,255,0.08)', borderRadius: 24, border: '1px solid rgba(255,255,255,0.18)', backdropFilter: 'blur(10px)' }}>
			<div style={{ fontSize: 96, fontWeight: 900, color: '#ffd166', letterSpacing: '-0.03em', lineHeight: 1, textShadow: '0 4px 24px rgba(255,209,102,0.35)' }}>
				{prefix}{current.toLocaleString('vi-VN')}{suffix}
			</div>
			{label && <div style={{ fontSize: 28, fontWeight: 600, color: 'rgba(255,255,255,0.85)', letterSpacing: '0.02em', textAlign: 'center' }}>{label}</div>}
		</div>
	);
};

/** Progress / doughnut ring (0 → percent). */
export const RingGraphic = ({ percent = 75, label = '', startFrame = 0, durFrames = 28, size = 260, stroke = 22 }) => {
	const f = useCurrentFrame();
	const t = (f - startFrame) / Math.max(1, durFrames);
	const p = Math.min(100, Math.max(0, camEase(t) * percent));
	const r = (size - stroke) / 2;
	const c = 2 * Math.PI * r;
	const offset = c * (1 - p / 100);
	const opacity = interpolate(f - startFrame, [0, 4], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
	return (
		<div style={{ opacity, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
			<div style={{ position: 'relative', width: size, height: size }}>
				<svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
					<circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.14)" strokeWidth={stroke} fill="none" />
					<circle cx={size / 2} cy={size / 2} r={r} stroke="#06d6a0" strokeWidth={stroke} strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round" fill="none" />
				</svg>
				<div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 56, fontWeight: 900, color: '#fff' }}>
					{Math.round(p)}%
				</div>
			</div>
			{label && <div style={{ fontSize: 26, fontWeight: 600, color: 'rgba(255,255,255,0.85)', textAlign: 'center' }}>{label}</div>}
		</div>
	);
};

/** Compare two horizontal bars (e.g. A vs B, Chi tiêu vs Tiết kiệm). */
export const CompareGraphic = ({ a = { label: 'A', value: 80, color: '#ef476f' }, b = { label: 'B', value: 20, color: '#06d6a0' }, startFrame = 0, durFrames = 26 }) => {
	const f = useCurrentFrame();
	const t = (f - startFrame) / Math.max(1, durFrames);
	const progress = camEase(t);
	const max = Math.max(a.value, b.value, 1);
	const opacity = interpolate(f - startFrame, [0, 4], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
	const renderBar = (item) => {
		const w = Math.min(100, (item.value / max) * 100 * progress);
		return (
			<div key={item.label} style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
				<div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 24, fontWeight: 700, color: 'rgba(255,255,255,0.9)' }}>
					<span>{item.label}</span>
					<span style={{ color: item.color }}>{Math.round(item.value * progress).toLocaleString('vi-VN')}</span>
				</div>
				<div style={{ width: '100%', height: 26, background: 'rgba(255,255,255,0.12)', borderRadius: 13, overflow: 'hidden' }}>
					<div style={{ width: `${w}%`, height: '100%', background: item.color, borderRadius: 13, boxShadow: `0 0 16px ${item.color}88` }} />
				</div>
			</div>
		);
	};
	return (
		<div style={{ opacity, width: 620, padding: 24, background: 'rgba(255,255,255,0.06)', borderRadius: 20, border: '1px solid rgba(255,255,255,0.14)', display: 'flex', flexDirection: 'column', gap: 16 }}>
			{renderBar(a)}
			{renderBar(b)}
		</div>
	);
};

/** Step-by-step checklist / rule stages (e.g. 20-20-20 or 3 steps). */
export const StepsGraphic = ({ items = ['Bước 1', 'Bước 2', 'Bước 3'], activeIndex = 0, startFrame = 0 }) => {
	const f = useCurrentFrame();
	const opacity = interpolate(f - startFrame, [0, 4], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
	return (
		<div style={{ opacity, display: 'flex', flexDirection: 'column', gap: 14, width: 620 }}>
			{items.map((it, idx) => {
				const active = idx === activeIndex;
				const past = idx < activeIndex;
				const bg = active ? 'rgba(255,209,102,0.20)' : past ? 'rgba(6,214,160,0.14)' : 'rgba(255,255,255,0.05)';
				const border = active ? '#ffd166' : past ? '#06d6a0' : 'rgba(255,255,255,0.12)';
				const mark = past ? '✓' : String(idx + 1);
				return (
					<div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '14px 20px', background: bg, border: `1.5px solid ${border}`, borderRadius: 16, transform: active ? 'scale(1.03)' : 'scale(1)' }}>
						<div style={{ width: 44, height: 44, borderRadius: 22, background: border, color: '#090b10', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 22 }}>
							{mark}
						</div>
						<div style={{ fontSize: 26, fontWeight: active ? 800 : 600, color: active ? '#ffd166' : past ? '#06d6a0' : 'rgba(255,255,255,0.7)' }}>
							{it}
						</div>
					</div>
				);
			})}
		</div>
	);
};

/** Big bold text-as-image callout (single idea, strong wordmark). */
export const TextCardGraphic = ({ title = '', subtitle = '', tag = '', startFrame = 0 }) => {
	const f = useCurrentFrame();
	const scale = interpolate(f - startFrame, [0, 6], [0.92, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.back(1.4)) });
	const opacity = interpolate(f - startFrame, [0, 4], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
	return (
		<div style={{ opacity, transform: `scale(${scale})`, width: 620, padding: '28px 32px', background: 'rgba(255,255,255,0.08)', borderRadius: 24, border: '1px solid rgba(255,255,255,0.2)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
			{tag && <div style={{ padding: '6px 16px', borderRadius: 12, background: 'rgba(255,209,102,0.22)', color: '#ffd166', fontSize: 20, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{tag}</div>}
			<div style={{ fontSize: 44, fontWeight: 900, color: '#fff', lineHeight: 1.25 }}>{title}</div>
			{subtitle && <div style={{ fontSize: 26, fontWeight: 600, color: 'rgba(255,255,255,0.75)' }}>{subtitle}</div>}
		</div>
	);
};

/** Master graphic router matching `visual: { type, ... }`. */
export const SceneGraphic = ({ visual, startFrame = 0 }) => {
	if (!visual || !visual.type) return null;
	switch (visual.type) {
		case 'stat':
			return <StatGraphic value={visual.value} label={visual.label} prefix={visual.prefix} suffix={visual.suffix} startFrame={startFrame} durFrames={visual.durFrames} />;
		case 'ring':
			return <RingGraphic percent={visual.percent ?? visual.value} label={visual.label} startFrame={startFrame} />;
		case 'compare':
			return <CompareGraphic a={visual.a} b={visual.b} startFrame={startFrame} />;
		case 'steps':
			return <StepsGraphic items={visual.items} activeIndex={visual.activeIndex ?? 0} startFrame={startFrame} />;
		case 'card':
		case 'text-as-image':
			return <TextCardGraphic title={visual.title ?? visual.label} subtitle={visual.subtitle} tag={visual.tag} startFrame={startFrame} />;
		default:
			return null;
	}
};
