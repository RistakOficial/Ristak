import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  PHONE_NAV_ACTIVE_INDEX_KEY,
  PHONE_NAV_ITEMS,
  clampPhoneNavIndex,
  getPhoneSectionIndex,
  readStoredPhoneNavIndex,
  storePhoneNavIntent,
  type PhoneSection
} from './phoneNavigation'
import styles from './PhoneEcosystemNav.module.css'

interface PhoneEcosystemNavProps {
  active: PhoneSection
  badges?: Partial<Record<PhoneSection, number>>
}

export const PhoneEcosystemNav: React.FC<PhoneEcosystemNavProps> = ({ active, badges = {} }) => {
  const activeIndex = getPhoneSectionIndex(active)
  const [indicatorIndex, setIndicatorIndex] = useState(() => readStoredPhoneNavIndex(activeIndex))

  useEffect(() => {
    if (typeof window === 'undefined') {
      setIndicatorIndex(activeIndex)
      return undefined
    }

    const frame = window.requestAnimationFrame(() => {
      setIndicatorIndex(activeIndex)
      window.sessionStorage.setItem(PHONE_NAV_ACTIVE_INDEX_KEY, String(activeIndex))
    })

    return () => window.cancelAnimationFrame(frame)
  }, [activeIndex])

  return (
    <nav
      className={styles.dock}
      aria-label="Secciones de Ristak Chat"
      onContextMenu={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
    >
      <span
        className={styles.activeIndicator}
        style={{ transform: `translate3d(${indicatorIndex * 100}%, 0, 0)` }}
        aria-hidden="true"
      />
      {PHONE_NAV_ITEMS.map(({ key, label, to, Icon }, itemIndex) => {
        const badgeCount = Math.max(0, Number(badges[key] || 0))

        return (
          <Link
            key={key}
            to={to}
            className={active === key ? styles.active : undefined}
            draggable={false}
            aria-label={label}
            aria-current={active === key ? 'page' : undefined}
            onClick={() => storePhoneNavIntent(activeIndex, clampPhoneNavIndex(itemIndex))}
          >
            <span className={styles.iconWrap}>
              <Icon size={key === 'chat' ? 25 : 24} aria-hidden="true" focusable="false" />
              {badgeCount > 0 && (
                <i aria-label={`${badgeCount} mensajes no leídos`}>
                  {badgeCount > 99 ? '99+' : badgeCount}
                </i>
              )}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
