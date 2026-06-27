'use client';

import { useEffect, useState, useMemo } from 'react';
import type { EmotionVector, EmotionAxis } from '@/lib/personality';
import { EMOTION_AXES, EMOTION_LABELS_RU } from '@/lib/personality';

// ============================================================================
// 2D SVG Avatar — стилизованный портрет Лии
// ----------------------------------------------------------------------------
// Эмоции маппятся в blendshapes:
//   joy        → mouth curve up, eyes slightly squinted
//   sadness    → mouth curve down, eyes half-closed
//   irritation → brows down, mouth flat
//   curiosity  → brows up, eyes wide
//   calm       → neutral + slow breathing
// ============================================================================

export type AvatarSvgProps = {
  emotion: EmotionVector;
  speaking?: boolean;
  size?: number;
};

export function AvatarSvg({ emotion, speaking = false, size = 240 }: AvatarSvgProps) {
  // Blinking — every 4-5 seconds, brief closure
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const scheduleBlink = () => {
      const delay = 3000 + Math.random() * 2500;
      timer = setTimeout(() => {
        setBlinking(true);
        setTimeout(() => {
          setBlinking(false);
          scheduleBlink();
        }, 120);
      }, delay);
    };
    scheduleBlink();
    return () => clearTimeout(timer);
  }, []);

  // Compute blendshapes from emotion vector
  const bs = useMemo(() => emotionToBlendshapes(emotion), [emotion]);

  // Mouth path — derived from joy/sadness/irritation
  const mouthPath = useMemo(() => {
    const smile = bs.mouthSmile; // -1 (frown) to 1 (smile)
    const open = speaking ? 0.3 + Math.random() * 0.2 : 0; // open when speaking
    const y = 130;
    const w = 30;
    const curve = smile * 8;
    const openOffset = open * 6;

    if (open > 0) {
      // Open mouth — ellipse-ish
      return `M ${100 - w} ${y} Q 100 ${y + curve + openOffset} ${100 + w} ${y} Q 100 ${y + curve - openOffset + 2} ${100 - w} ${y} Z`;
    }
    // Closed mouth — curve
    return `M ${100 - w} ${y} Q 100 ${y + curve} ${100 + w} ${y}`;
  }, [bs.mouthSmile, speaking]);

  // Eye shape — open factor based on curiosity/sadness
  const eyeOpenness = useMemo(() => {
    let f = 1.0;
    f -= bs.eyesClosed * 0.7;     // sadness → half-closed
    f += bs.eyesWide * 0.3;       // curiosity → wide
    if (blinking) f = 0.05;
    return Math.max(0.05, Math.min(1.2, f));
  }, [bs.eyesClosed, bs.eyesWide, blinking]);

  const eyeHeight = 12 * eyeOpenness;

  // Brow position — irritation down, curiosity up
  const browOffset = useMemo(() => {
    return bs.browsDown * 4 - bs.browsUp * 4;
  }, [bs.browsDown, bs.browsUp]);

  return (
    <div
      className={`relative lia-breathing ${speaking ? 'lia-talking' : ''}`}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 200 200"
        width={size}
        height={size}
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Background gradient — violet to soft pink */}
          <radialGradient id="lia-bg" cx="50%" cy="40%" r="70%">
            <stop offset="0%" stopColor="#1a1530" stopOpacity="1" />
            <stop offset="100%" stopColor="#08090a" stopOpacity="0" />
          </radialGradient>

          {/* Hair gradient */}
          <linearGradient id="lia-hair" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#7c3aed" />
          </linearGradient>

          {/* Face gradient */}
          <linearGradient id="lia-face" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#fde4d3" />
            <stop offset="100%" stopColor="#fbcfb0" />
          </linearGradient>

          {/* Glow filter */}
          <filter id="lia-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Background glow */}
        <circle cx="100" cy="100" r="95" fill="url(#lia-bg)" />

        {/* Aura — emotion-colored ring */}
        <circle
          cx="100"
          cy="100"
          r="92"
          fill="none"
          stroke={getAuraColor(emotion)}
          strokeWidth="1.5"
          strokeOpacity="0.4"
          filter="url(#lia-glow)"
        />

        {/* Hair back */}
        <path
          d="M 45 90 Q 40 50 70 35 Q 100 25 130 35 Q 160 50 155 90 L 155 130 Q 155 145 145 150 L 145 80 Q 145 60 130 55 Q 100 50 70 55 Q 55 60 55 80 L 55 150 Q 45 145 45 130 Z"
          fill="url(#lia-hair)"
          opacity="0.95"
        />

        {/* Neck */}
        <path
          d="M 85 145 L 85 165 Q 85 175 95 175 L 105 175 Q 115 175 115 165 L 115 145 Z"
          fill="url(#lia-face)"
        />

        {/* Face — oval */}
        <ellipse cx="100" cy="100" rx="38" ry="48" fill="url(#lia-face)" />

        {/* Hair front — bangs */}
        <path
          d="M 62 70 Q 65 55 85 50 Q 100 48 115 50 Q 135 55 138 70 Q 138 75 130 73 Q 115 68 100 70 Q 85 68 70 73 Q 62 75 62 70 Z"
          fill="url(#lia-hair)"
        />

        {/* Eyebrows */}
        <g transform="translate(0, ${browOffset})">
          <path
            d={`M 75 ${78 + browOffset} Q 82 ${75 + browOffset} 89 ${78 + browOffset}`}
            fill="none"
            stroke="#5b3a8a"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d={`M 111 ${78 + browOffset} Q 118 ${75 + browOffset} 125 ${78 + browOffset}`}
            fill="none"
            stroke="#5b3a8a"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </g>

        {/* Eyes — left */}
        <g>
          <ellipse
            cx="82"
            cy="95"
            rx="6"
            ry={eyeHeight / 2}
            fill="#ffffff"
          />
          <ellipse
            cx="82"
            cy="95"
            rx="3"
            ry={Math.min(eyeHeight / 2 - 1, 4)}
            fill="#5b3a8a"
          />
          {/* Highlight */}
          {eyeOpenness > 0.4 && (
            <circle cx="83.5" cy="93.5" r="1" fill="#ffffff" />
          )}
        </g>

        {/* Eyes — right */}
        <g>
          <ellipse
            cx="118"
            cy="95"
            rx="6"
            ry={eyeHeight / 2}
            fill="#ffffff"
          />
          <ellipse
            cx="118"
            cy="95"
            rx="3"
            ry={Math.min(eyeHeight / 2 - 1, 4)}
            fill="#5b3a8a"
          />
          {eyeOpenness > 0.4 && (
            <circle cx="119.5" cy="93.5" r="1" fill="#ffffff" />
          )}
        </g>

        {/* Nose — simple line */}
        <path
          d="M 100 105 Q 98 115 100 118 Q 102 119 103 117"
          fill="none"
          stroke="#d4a378"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity="0.6"
        />

        {/* Mouth */}
        <path
          d={mouthPath}
          fill={speaking ? "#d97757" : "none"}
          stroke="#c26647"
          strokeWidth="2"
          strokeLinecap="round"
        />

        {/* Blush when joyful */}
        {bs.mouthSmile > 0.3 && (
          <>
            <circle cx="72" cy="118" r="6" fill="#f87171" opacity={bs.mouthSmile * 0.3} />
            <circle cx="128" cy="118" r="6" fill="#f87171" opacity={bs.mouthSmile * 0.3} />
          </>
        )}
      </svg>
    </div>
  );
}

// ============================================================================
// Blendshapes — derived from emotion vector
// ============================================================================
function emotionToBlendshapes(e: EmotionVector) {
  return {
    mouthSmile: e.joy - e.sadness - e.irritation * 0.5, // -1..1
    mouthOpen: 0, // controlled by speaking state externally
    eyesClosed: Math.max(0, e.sadness - 0.3), // 0..0.7
    eyesWide: Math.max(0, e.curiosity - 0.5), // 0..0.5
    browsDown: e.irritation, // 0..1
    browsUp: Math.max(0, e.curiosity - 0.5) + Math.max(0, e.joy - 0.6) * 0.3, // 0..0.6
  };
}

function getAuraColor(e: EmotionVector): string {
  // Pick dominant emotion
  const entries: Array<[EmotionAxis, number]> = EMOTION_AXES.map(a => [a, e[a]]);
  entries.sort((a, b) => b[1] - a[1]);
  const [dom] = entries[0];

  switch (dom) {
    case 'joy':        return '#10b981'; // emerald
    case 'curiosity':  return '#8b5cf6'; // violet
    case 'calm':       return '#06b6d4'; // cyan
    case 'irritation': return '#ef4444'; // red
    case 'sadness':    return '#3b82f6'; // blue (acceptable here, it's the avatar aura)
    default:           return '#8b5cf6';
  }
}

// ============================================================================
// Emotion bars — small visualization of the 5 axes
// ============================================================================
export function EmotionBars({ emotion }: { emotion: EmotionVector }) {
  return (
    <div className="space-y-2">
      {EMOTION_AXES.map(axis => {
        const value = emotion[axis];
        const pct = Math.round(value * 100);
        return (
          <div key={axis} className="space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground capitalize">
                {EMOTION_LABELS_RU[axis]}
              </span>
              <span className="font-mono text-text-dim">
                {pct.toString().padStart(2, '0')}
              </span>
            </div>
            <div className="h-1 bg-surface-2 rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all duration-500 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
