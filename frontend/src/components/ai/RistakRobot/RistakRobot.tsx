import React, { useId } from 'react'
import styles from './RistakRobot.module.css'

export interface RistakRobotProps {
  /** Fixed pixel size. When omitted the robot fills its parent (100%). */
  size?: number
  /** Switches the robot into a focused "thinking" expression while the agent works. */
  thinking?: boolean
  /** Extra class on the root wrapper. */
  className?: string
  /** Accessible label. */
  label?: string
}

/**
 * RistakRobot — the animated mascot for the personal AI assistant.
 *
 * A friendly, always-happy floating robot rendered as a self contained SVG with
 * CSS-driven life: it bobs, sways, blinks, its antenna glows and it keeps a warm
 * smile. No box, no border — just the character and a soft aura. When `thinking`
 * is active it looks up, purses its mouth and its antenna spins faster.
 */
export const RistakRobot: React.FC<RistakRobotProps> = ({
  size,
  thinking = false,
  className,
  label = 'asistente personal AI',
}) => {
  const uid = useId().replace(/:/g, '')
  const headGrad = `rk-head-${uid}`
  const faceGrad = `rk-face-${uid}`
  const tipGrad = `rk-tip-${uid}`
  const auraGrad = `rk-aura-${uid}`
  const glossGrad = `rk-gloss-${uid}`

  const rootClassName = [styles.robot, thinking ? styles.thinking : '', className || '']
    .filter(Boolean)
    .join(' ')

  const sizeStyle = size != null ? { width: size, height: size } : undefined

  return (
    <span className={rootClassName} style={sizeStyle} role="img" aria-label={label}>
      <svg
        className={styles.svg}
        viewBox="0 0 120 120"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={headGrad} x1="28" y1="26" x2="96" y2="100" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#7af2dd" />
            <stop offset="0.5" stopColor="#22c7b3" />
            <stop offset="1" stopColor="#0c8f86" />
          </linearGradient>
          <linearGradient id={faceGrad} x1="34" y1="40" x2="86" y2="86" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#0a2f33" />
            <stop offset="1" stopColor="#03171b" />
          </linearGradient>
          <linearGradient id={glossGrad} x1="40" y1="30" x2="60" y2="58" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.65" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <radialGradient id={tipGrad} cx="0.5" cy="0.4" r="0.7">
            <stop offset="0" stopColor="#f5fffb" />
            <stop offset="0.45" stopColor="#7ff7e3" />
            <stop offset="1" stopColor="#15c7b1" />
          </radialGradient>
          <radialGradient id={auraGrad} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#34e7cd" stopOpacity="0.55" />
            <stop offset="0.6" stopColor="#16c1ac" stopOpacity="0.18" />
            <stop offset="1" stopColor="#16c1ac" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* soft living aura — replaces the old box */}
        <circle className={styles.aura} cx="60" cy="64" r="52" fill={`url(#${auraGrad})`} />

        <g className={styles.float}>
          {/* antenna */}
          <g className={styles.antenna}>
            <rect x="57.4" y="14" width="5.2" height="20" rx="2.6" fill="#0c8f86" />
            <circle className={styles.tip} cx="60" cy="13" r="7" fill={`url(#${tipGrad})`} />
            <circle className={styles.tipRing} cx="60" cy="13" r="7" fill="none" stroke="#bafff0" strokeOpacity="0.6" strokeWidth="1.4" />
          </g>

          {/* side ear pods */}
          <rect className={styles.earLeft} x="14" y="54" width="11" height="22" rx="5.5" fill={`url(#${headGrad})`} />
          <rect className={styles.earRight} x="95" y="54" width="11" height="22" rx="5.5" fill={`url(#${headGrad})`} />
          <circle className={styles.earDotLeft} cx="19.5" cy="65" r="2.4" fill="#bafff0" />
          <circle className={styles.earDotRight} cx="100.5" cy="65" r="2.4" fill="#bafff0" />

          {/* head shell */}
          <rect x="24" y="32" width="72" height="64" rx="27" fill={`url(#${headGrad})`} />
          <rect x="24" y="32" width="72" height="64" rx="27" fill="none" stroke="#ffffff" strokeOpacity="0.28" strokeWidth="1.6" />
          {/* top gloss highlight */}
          <ellipse cx="50" cy="46" rx="20" ry="10" fill={`url(#${glossGrad})`} />

          {/* face screen */}
          <rect x="33" y="42" width="54" height="44" rx="20" fill={`url(#${faceGrad})`} />
          <rect x="33" y="42" width="54" height="44" rx="20" fill="none" stroke="#0affd9" strokeOpacity="0.18" strokeWidth="1.2" />

          {/* cheeks (personality blush) */}
          <ellipse className={styles.cheekLeft} cx="44" cy="73" rx="4.6" ry="2.8" fill="#ff8fb0" fillOpacity="0.7" />
          <ellipse className={styles.cheekRight} cx="76" cy="73" rx="4.6" ry="2.8" fill="#ff8fb0" fillOpacity="0.7" />

          {/* eyes */}
          <g className={styles.eyes}>
            <g className={styles.eyeLeft}>
              <rect x="42" y="54" width="12" height="16" rx="6" fill="#7ff7e3" />
              <circle cx="50" cy="58" r="2.4" fill="#ffffff" />
            </g>
            <g className={styles.eyeRight}>
              <rect x="66" y="54" width="12" height="16" rx="6" fill="#7ff7e3" />
              <circle cx="74" cy="58" r="2.4" fill="#ffffff" />
            </g>
          </g>

          {/* mouths — happy smile by default, focused "o" while thinking */}
          <path
            className={styles.mouthHappy}
            d="M50 75 Q60 84 70 75"
            stroke="#7ff7e3"
            strokeWidth="3.4"
            strokeLinecap="round"
            fill="none"
          />
          <circle className={styles.mouthThinking} cx="60" cy="78" r="3.4" fill="#7ff7e3" />
        </g>
      </svg>
    </span>
  )
}

export default RistakRobot
