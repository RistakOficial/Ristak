import React from 'react'

/**
 * Ilustraciones del wizard de creación de agente. Todo se pinta con los tokens
 * del sistema (var(--accent), var(--accent-soft), var(--text-mute)…), así se ven
 * nítidas en claro/oscuro y en las 4 familias de tema. Sin colores hardcodeados.
 */

const line = {
  fill: 'none',
  stroke: 'var(--accent)',
  strokeWidth: 3,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}
const soft = { fill: 'var(--accent-soft)', stroke: 'none' }
const muted = {
  fill: 'none',
  stroke: 'var(--text-mute)',
  strokeWidth: 2.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 160 116" width="160" height="116" role="presentation" aria-hidden="true">
      {children}
    </svg>
  )
}

function Sparkle({ x, y, s = 7 }: { x: number; y: number; s?: number }) {
  return <path d={`M${x} ${y - s} L${x + s * 0.32} ${y - s * 0.32} L${x + s} ${y} L${x + s * 0.32} ${y + s * 0.32} L${x} ${y + s} L${x - s * 0.32} ${y + s * 0.32} L${x - s} ${y} L${x - s * 0.32} ${y - s * 0.32} Z`} fill="var(--accent)" />
}

export function StepArt({ kind }: { kind: string }) {
  switch (kind) {
    case 'welcome':
      return (
        <Frame>
          <ellipse cx="80" cy="98" rx="52" ry="9" {...soft} />
          <rect x="44" y="26" width="72" height="52" rx="16" {...soft} />
          <rect x="44" y="26" width="72" height="52" rx="16" {...line} />
          <path d="M64 78 L72 92 L84 78" {...line} />
          <circle cx="66" cy="50" r="4.4" fill="var(--accent)" />
          <circle cx="94" cy="50" r="4.4" fill="var(--accent)" />
          <path d="M66 62 Q80 70 94 62" {...line} />
          <Sparkle x={126} y={32} s={7} />
          <Sparkle x={34} y={44} s={5} />
          <Sparkle x={120} y={70} s={5} />
        </Frame>
      )
    case 'name':
      return (
        <Frame>
          <ellipse cx="80" cy="98" rx="48" ry="8" {...soft} />
          <rect x="40" y="34" width="80" height="50" rx="12" {...soft} />
          <rect x="40" y="34" width="80" height="50" rx="12" {...line} />
          <circle cx="80" cy="28" r="6" {...line} />
          <path d="M80 34 v6" {...muted} />
          <circle cx="60" cy="58" r="9" {...muted} />
          <path d="M78 52 h28" {...muted} />
          <path d="M78 64 h22" {...muted} />
        </Frame>
      )
    case 'objective':
      return (
        <Frame>
          <ellipse cx="80" cy="98" rx="48" ry="8" {...soft} />
          <circle cx="74" cy="56" r="34" {...soft} />
          <circle cx="74" cy="56" r="34" {...line} />
          <circle cx="74" cy="56" r="20" {...muted} />
          <circle cx="74" cy="56" r="6" fill="var(--accent)" />
          <path d="M74 56 L122 22" {...line} />
          <path d="M122 22 l-12 1 l3 11 z" fill="var(--accent)" />
        </Frame>
      )
    case 'identity':
      return (
        <Frame>
          <ellipse cx="80" cy="100" rx="50" ry="8" {...soft} />
          <rect x="22" y="28" width="58" height="42" rx="12" {...soft} />
          <rect x="22" y="28" width="58" height="42" rx="12" {...line} />
          <path d="M40 70 l-6 12 l16 -10" {...line} />
          <rect x="40" y="42" width="22" height="16" rx="3" {...muted} />
          <rect x="86" y="46" width="52" height="40" rx="12" {...soft} />
          <rect x="86" y="46" width="52" height="40" rx="12" {...line} />
          <path d="M120 86 l6 12 l-16 -10" {...line} />
          <circle cx="112" cy="62" r="6" {...muted} />
          <path d="M101 76 q11 -10 22 0" {...muted} />
        </Frame>
      )
    case 'persuasion':
      return (
        <Frame>
          <ellipse cx="80" cy="100" rx="46" ry="8" {...soft} />
          <path d="M58 34 v26 a22 22 0 0 0 44 0 v-26" {...soft} />
          <path d="M58 34 v26 a22 22 0 0 0 44 0 v-26" {...line} />
          <path d="M50 34 h16 v12 h-16 z" fill="var(--accent)" />
          <path d="M94 34 h16 v12 h-16 z" fill="var(--accent)" />
          <Sparkle x={118} y={30} s={5} />
          <Sparkle x={42} y={24} s={5} />
          <circle cx="80" cy="20" r="3.4" fill="var(--text-mute)" />
          <circle cx="126" cy="58" r="3.4" fill="var(--text-mute)" />
          <circle cx="34" cy="58" r="3.4" fill="var(--text-mute)" />
        </Frame>
      )
    case 'language':
      return (
        <Frame>
          <ellipse cx="80" cy="100" rx="48" ry="8" {...soft} />
          <rect x="24" y="30" width="62" height="40" rx="12" {...soft} />
          <rect x="24" y="30" width="62" height="40" rx="12" {...line} />
          <path d="M40 70 l-5 11 l15 -9" {...line} />
          <path d="M38 46 h34 M38 56 h22" {...muted} />
          <rect x="92" y="52" width="46" height="32" rx="10" {...soft} />
          <rect x="92" y="52" width="46" height="32" rx="10" {...line} />
          <path d="M122 84 l5 10 l-13 -8" {...line} />
          <path d="M104 64 h22 M104 72 h14" {...muted} />
        </Frame>
      )
    case 'action':
      return (
        <Frame>
          <ellipse cx="80" cy="100" rx="46" ry="8" {...soft} />
          <circle cx="80" cy="54" r="34" {...soft} />
          <circle cx="80" cy="54" r="34" {...line} />
          <path d="M65 55 l11 11 l20 -22" {...line} />
          <Sparkle x={118} y={26} s={6} />
          <Sparkle x={40} y={30} s={5} />
        </Frame>
      )
    case 'data':
      return (
        <Frame>
          <ellipse cx="80" cy="100" rx="44" ry="8" {...soft} />
          <rect x="48" y="24" width="64" height="68" rx="10" {...soft} />
          <rect x="48" y="24" width="64" height="68" rx="10" {...line} />
          <rect x="66" y="18" width="28" height="14" rx="5" {...line} />
          <path d="M62 46 l5 5 l8 -9" {...muted} />
          <path d="M84 46 h18" {...muted} />
          <path d="M62 64 l5 5 l8 -9" {...muted} />
          <path d="M84 64 h18" {...muted} />
        </Frame>
      )
    case 'recap':
      return (
        <Frame>
          <ellipse cx="80" cy="100" rx="46" ry="8" {...soft} />
          <path d="M80 18 c16 10 22 28 18 46 l-36 0 c-4 -18 2 -36 18 -46 z" {...soft} />
          <path d="M80 18 c16 10 22 28 18 46 l-36 0 c-4 -18 2 -36 18 -46 z" {...line} />
          <circle cx="80" cy="46" r="8" {...muted} />
          <path d="M62 64 l-10 14 l16 -6 M98 64 l10 14 l-16 -6" {...line} />
          <path d="M72 80 q8 12 16 0" {...line} />
          <Sparkle x={120} y={30} s={6} />
          <Sparkle x={40} y={40} s={5} />
        </Frame>
      )
    default:
      return <Frame><circle cx="80" cy="58" r="30" {...soft} /></Frame>
  }
}
