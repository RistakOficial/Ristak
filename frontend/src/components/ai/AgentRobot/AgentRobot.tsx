import React, { useId } from 'react'
import styles from './AgentRobot.module.css'

export interface AgentRobotProps {
  active?: boolean
  className?: string
  label?: string
  scene?: 'compact' | 'expanded'
  size?: number
}

export const AgentRobot: React.FC<AgentRobotProps> = ({
  active = true,
  className = '',
  label = 'Agente AI de Ristak',
  scene = 'compact',
  size
}) => {
  const uid = useId().replace(/:/g, '')
  const ids = {
    body: `rkb-body-${uid}`,
    hot: `rkb-hot-${uid}`,
    ao: `rkb-ao-${uid}`,
    bounce: `rkb-bounce-${uid}`,
    rim: `rkb-rim-${uid}`,
    topEdge: `rkb-top-edge-${uid}`,
    visor: `rkb-visor-${uid}`,
    visorTop: `rkb-visor-top-${uid}`,
    eyeGlow: `rkb-eye-glow-${uid}`,
    eye: `rkb-eye-${uid}`,
    hand: `rkb-hand-${uid}`,
    bulb: `rkb-bulb-${uid}`
  }
  const rootStyle: React.CSSProperties | undefined = size
    ? {
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        flex: `0 0 ${size}px`
      }
    : undefined
  const rootClassName = [
    styles.robotShell,
    active ? styles.active : '',
    scene === 'expanded' ? styles.sceneExpanded : '',
    className
  ].filter(Boolean).join(' ')

  return (
    <span className={rootClassName} style={rootStyle} role="img" aria-label={label}>
      {active ? (
        <>
          <span className={styles.agentBotOrbit} aria-hidden="true" />
          <span className={styles.agentBotSparkle} aria-hidden="true" />
        </>
      ) : null}
      <span className={styles.agentRobot} data-active={active ? 'true' : 'false'} aria-hidden="true">
        <span className={styles.rkShadow} />
        <span className={styles.rkFloat}>
          <span className={styles.rkZoom}>
            <span className={styles.rkTurn}>
              <svg
                className={styles.agentRobotSvg}
                data-active={active ? 'true' : 'false'}
                viewBox="0 0 240 320"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <defs>
                  <linearGradient id={ids.body} x1="120" y1="86" x2="120" y2="248" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stopColor="#ffffff" />
                    <stop offset="0.42" stopColor="#eef3fa" />
                    <stop offset="0.78" stopColor="#d2dceb" />
                    <stop offset="1" stopColor="#aebbd0" />
                  </linearGradient>
                  <radialGradient id={ids.hot} cx="0.5" cy="0.5" r="0.5">
                    <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
                    <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id={ids.ao} cx="0.5" cy="0.5" r="0.5">
                    <stop offset="0" stopColor="#56678a" stopOpacity="0.6" />
                    <stop offset="1" stopColor="#56678a" stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id={ids.bounce} cx="0.5" cy="0.5" r="0.5">
                    <stop offset="0" stopColor="#7fb4ee" stopOpacity="0.5" />
                    <stop offset="1" stopColor="#7fb4ee" stopOpacity="0" />
                  </radialGradient>
                  <linearGradient id={ids.rim} x1="64" y1="106" x2="186" y2="242" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stopColor="#d6fbff" stopOpacity="0" />
                    <stop offset="0.58" stopColor="#d6fbff" stopOpacity="0" />
                    <stop offset="1" stopColor="#d8fbff" stopOpacity="0.95" />
                  </linearGradient>
                  <linearGradient id={ids.topEdge} x1="120" y1="86" x2="120" y2="122" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stopColor="#ffffff" stopOpacity="0.9" />
                    <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
                  </linearGradient>
                  <radialGradient id={ids.visor} cx="0.42" cy="0.32" r="0.8">
                    <stop offset="0" stopColor="#1a3056" />
                    <stop offset="0.5" stopColor="#0c1c3c" />
                    <stop offset="1" stopColor="#050b1d" />
                  </radialGradient>
                  <linearGradient id={ids.visorTop} x1="120" y1="120" x2="120" y2="150" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stopColor="#000000" stopOpacity="0.55" />
                    <stop offset="1" stopColor="#000000" stopOpacity="0" />
                  </linearGradient>
                  <radialGradient id={ids.eyeGlow} cx="0.5" cy="0.5" r="0.5">
                    <stop offset="0" stopColor="#2bbbf0" stopOpacity="0.55" />
                    <stop offset="1" stopColor="#2bbbf0" stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id={ids.eye} cx="0.42" cy="0.3" r="0.85">
                    <stop offset="0" stopColor="#ffffff" />
                    <stop offset="0.4" stopColor="#bdf0ff" />
                    <stop offset="1" stopColor="#5bd3f4" />
                  </radialGradient>
                  <radialGradient id={ids.hand} cx="0.4" cy="0.3" r="0.8">
                    <stop offset="0" stopColor="#ffffff" />
                    <stop offset="0.7" stopColor="#dce6f3" />
                    <stop offset="1" stopColor="#b3c2d8" />
                  </radialGradient>
                  <radialGradient id={ids.bulb} cx="0.5" cy="0.4" r="0.6">
                    <stop offset="0" stopColor="#fff7cf" />
                    <stop offset="0.5" stopColor="#ffd23d" />
                    <stop offset="1" stopColor="#f59e0b" />
                  </radialGradient>
                </defs>

                <g className={styles.rkRotorRig}>
                  <path className={styles.rkAntennaStem} d="M120 88 C120 79 120 70 120 62" stroke="#9bf0ff" strokeWidth="3.2" strokeLinecap="round" />
                  <ellipse className={styles.rkRotorBlur} cx="120" cy="62" rx="36" ry="7" fill="#7fdcff" opacity="0.12" />
                  <g className={styles.rkRotor}>
                    <animateTransform
                      attributeName="transform"
                      attributeType="XML"
                      type="rotate"
                      from="0 120 62"
                      to="360 120 62"
                      dur={active ? '0.34s' : '0.86s'}
                      repeatCount="indefinite"
                    />
                    <rect className={styles.rkRotorBlade} x="88" y="59.7" width="64" height="4.6" rx="2.3" fill="#9bf0ff" opacity="0.72" />
                    <rect className={styles.rkRotorBlade} x="95" y="60.3" width="50" height="3.4" rx="1.7" fill="#5bd3f4" opacity="0.26" transform="rotate(90 120 62)" />
                  </g>
                  <circle className={styles.rkRotorHub} cx="120" cy="62" r="5.5" fill="#d6fbff" />
                </g>

                <g className={styles.rkProps}>
                  <g className={styles.rkIdea}>
                    <circle className={styles.rkIdeaDot} cx="176" cy="100" r="3.2" fill="#dbeeff" />
                    <circle className={styles.rkIdeaDot} cx="186" cy="88" r="4.2" fill="#e8f6ff" />
                    <rect x="176" y="42" width="56" height="40" rx="14" fill="#0e1f3e" stroke="#3f6ea8" strokeWidth="1.6" />
                    <circle className={styles.rkBulb} cx="200" cy="58" r="9" fill={`url(#${ids.bulb})`} />
                    <rect x="196" y="66" width="8" height="4" rx="1.5" fill="#cfa83a" />
                    <path d="M196 54 L200 48 L204 54" fill="none" stroke="#fff7cf" strokeWidth="1.4" strokeLinecap="round" />
                  </g>
                  <g className={styles.rkReader}>
                    <rect x="10" y="126" width="66" height="48" rx="12" fill="#0e1f3e" stroke="#3f6ea8" strokeWidth="1.8" />
                    <path className={styles.rkReaderLine} d="M24 141 H59" stroke="#7fe0ff" strokeWidth="3" strokeLinecap="round" />
                    <path className={styles.rkReaderLine} d="M24 153 H50" stroke="#bdf0ff" strokeWidth="3" strokeLinecap="round" />
                    <path className={styles.rkReaderLine} d="M24 164 H62" stroke="#5fc7ef" strokeWidth="3" strokeLinecap="round" />
                    <circle cx="65" cy="137" r="3.2" fill="#ffd23d" />
                  </g>
                  <g className={styles.rkAnalyzer}>
                    <circle cx="203" cy="148" r="16" fill="#0e1f3e" stroke="#7fdcff" strokeWidth="2" />
                    <path className={styles.rkAnalyzerBeam} d="M192 148 H214" stroke="#9bf0ff" strokeWidth="2.4" strokeLinecap="round" />
                    <path className={styles.rkAnalyzerBeam} d="M203 137 V159" stroke="#5bd3f4" strokeWidth="2.4" strokeLinecap="round" />
                    <path d="M214 160 L226 172" stroke="#d6fbff" strokeWidth="4" strokeLinecap="round" />
                    <ellipse cx="228" cy="175" rx="8" ry="7" fill={`url(#${ids.hand})`} />
                  </g>
                </g>

                <g className={styles.rkBody}>
                  <path d="M120,86 C168,86 196,130 196,174 C196,216 166,248 120,248 C74,248 44,216 44,174 C44,130 72,86 120,86 Z" fill={`url(#${ids.body})`} />
                  <ellipse cx="120" cy="226" rx="74" ry="46" fill={`url(#${ids.ao})`} />
                  <ellipse cx="120" cy="238" rx="60" ry="30" fill={`url(#${ids.bounce})`} />
                  <g className={styles.rkGloss}>
                    <ellipse cx="96" cy="122" rx="46" ry="40" fill={`url(#${ids.hot})`} />
                    <ellipse cx="92" cy="114" rx="11" ry="6" fill="#ffffff" opacity="0.9" transform="rotate(-26 92 114)" />
                  </g>
                  <path d="M120,86 C168,86 196,130 196,174 C196,216 166,248 120,248 C74,248 44,216 44,174 C44,130 72,86 120,86 Z" fill="none" stroke={`url(#${ids.rim})`} strokeWidth="3.5" />
                  <path d="M86,92 C100,86 140,86 154,92" fill="none" stroke={`url(#${ids.topEdge})`} strokeWidth="3" strokeLinecap="round" />

                  <rect x="54" y="118" width="132" height="76" rx="38" fill={`url(#${ids.visor})`} />
                  <rect x="54" y="118" width="132" height="76" rx="38" fill={`url(#${ids.visorTop})`} />
                  <rect x="55.4" y="119.4" width="129.2" height="73.2" rx="36.6" fill="none" stroke="#a8dcff" strokeOpacity="0.16" strokeWidth="1.5" />
                  <ellipse className={styles.rkChin} cx="120" cy="204" rx="36" ry="12" fill={`url(#${ids.eyeGlow})`} opacity="0.5" />
                  <path d="M68,142 C92,128 152,126 170,134 C152,148 96,152 72,158 Z" fill="#ffffff" opacity="0.09" />

                  <g className={styles.rkFace3d}>
                    <g className={styles.rkEyes}>
                      <g className={styles.rkEyesWrap}>
                        <g className={styles.rkEye}>
                          <ellipse cx="101" cy="151" rx="11" ry="13" fill={`url(#${ids.eye})`} />
                          <circle cx="97.5" cy="146" r="3.2" fill="#ffffff" opacity="0.95" />
                        </g>
                        <g className={styles.rkEye}>
                          <ellipse cx="139" cy="151" rx="11" ry="13" fill={`url(#${ids.eye})`} />
                          <circle cx="135.5" cy="146" r="3.2" fill="#ffffff" opacity="0.95" />
                        </g>
                      </g>
                      <g className={styles.rkHappy}>
                        <path d="M90 154 Q101 142 112 154" stroke="#bdf0ff" strokeWidth="5" strokeLinecap="round" />
                      <path d="M128 154 Q139 142 150 154" stroke="#bdf0ff" strokeWidth="5" strokeLinecap="round" />
                    </g>
                    <g className={styles.rkFocusEyes}>
                      <path d="M89 150 H113" stroke="#9bf0ff" strokeWidth="5" strokeLinecap="round" />
                      <path d="M127 150 H151" stroke="#9bf0ff" strokeWidth="5" strokeLinecap="round" />
                    </g>
                    <g className={styles.rkStarEyes}>
                      <path d="M101 139 L105 149 L116 150 L107 156 L110 167 L101 160 L92 167 L95 156 L86 150 L97 149 Z" fill="#bdf0ff" />
                      <path d="M139 139 L143 149 L154 150 L145 156 L148 167 L139 160 L130 167 L133 156 L124 150 L135 149 Z" fill="#bdf0ff" />
                    </g>
                  </g>
                    <g className={styles.rkSoundMouth}>
                      <path className={styles.rkSoundWave} d="M98 180 C101 171 105 171 108 180 C111 189 115 189 118 180 C121 171 125 171 128 180 C131 189 135 189 138 180 C141 171 145 171 148 180" fill="none" stroke="#9bf0ff" strokeWidth="3.8" strokeLinecap="round" />
                      <path className={styles.rkSoundWave} d="M104 189 C107 184 111 184 114 189 C117 194 121 194 124 189 C127 184 131 184 134 189" fill="none" stroke="#5bd3f4" strokeWidth="2.7" strokeLinecap="round" opacity="0.72" />
                    </g>
                  </g>
                </g>

                <g className={styles.rkProps}>
                  <g className={styles.rkPhone}>
                    <ellipse cx="150" cy="250" rx="15" ry="11" fill={`url(#${ids.hand})`} />
                    <rect x="134" y="190" width="42" height="64" rx="9" fill="#0b1730" stroke="#37528a" strokeWidth="2" transform="rotate(-7 155 222)" />
                    <rect className={styles.rkPhoneScr} x="139" y="196" width="32" height="48" rx="4" fill="#123a6b" transform="rotate(-7 155 222)" />
                    <rect className={styles.rkPhoneScr} x="144" y="204" width="22" height="3.4" rx="1.7" fill="#7fe0ff" transform="rotate(-7 155 222)" />
                    <rect className={styles.rkPhoneScr} x="144" y="212" width="16" height="3.4" rx="1.7" fill="#5fc7ef" transform="rotate(-7 155 222)" />
                    <path className={styles.rkPhoneSignal} d="M178 200 C192 209 198 228 188 243" fill="none" stroke="#ffd23d" strokeWidth="3" strokeLinecap="round" />
                    <path className={styles.rkPhoneSignal} d="M184 192 C205 206 214 233 198 254" fill="none" stroke="#fff7cf" strokeWidth="2.2" strokeLinecap="round" />
                  </g>
                  <g className={styles.rkKeyboard}>
                    <rect x="58" y="254" width="92" height="22" rx="8" fill="#0b1730" stroke="#37528a" strokeWidth="2" />
                    <path className={styles.rkKeyLine} d="M70 263 H88" stroke="#7fe0ff" strokeWidth="3" strokeLinecap="round" />
                    <path className={styles.rkKeyLine} d="M96 263 H116" stroke="#bdf0ff" strokeWidth="3" strokeLinecap="round" />
                    <path className={styles.rkKeyLine} d="M124 263 H137" stroke="#5fc7ef" strokeWidth="3" strokeLinecap="round" />
                    <ellipse className={styles.rkKeyboardHand} cx="82" cy="246" rx="13" ry="10" fill={`url(#${ids.hand})`} />
                  </g>
                  <g className={styles.rkJuggle}>
                    <circle className={styles.rkJuggleOrb} cx="72" cy="88" r="6" fill="#ffd23d" />
                    <circle className={styles.rkJuggleOrb} cx="120" cy="70" r="6" fill="#7fe0ff" />
                    <circle className={styles.rkJuggleOrb} cx="168" cy="88" r="6" fill="#bdf0ff" />
                  </g>
                  <g className={styles.rkFlipTrail}>
                    <path d="M54 222 C80 280 164 280 188 220" fill="none" stroke="#7fdcff" strokeOpacity="0.28" strokeWidth="4" strokeLinecap="round" strokeDasharray="6 9" />
                  </g>
                  <g className={styles.rkWave}>
                    <g className={styles.rkHandWave} transform="translate(206 150)">
                      <ellipse cx="0" cy="0" rx="15" ry="18" fill={`url(#${ids.hand})`} />
                      <ellipse cx="-12" cy="7" rx="5" ry="8" fill={`url(#${ids.hand})`} transform="rotate(30)" />
                    </g>
                  </g>
                </g>
              </svg>
            </span>
          </span>
        </span>
      </span>
    </span>
  )
}

export default AgentRobot
