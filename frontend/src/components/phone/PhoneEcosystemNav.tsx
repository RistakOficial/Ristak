import React from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, CalendarDays, CreditCard, MessageCircle } from 'lucide-react'
import styles from './PhoneEcosystemNav.module.css'

type PhoneSection = 'chat' | 'calendar' | 'payments' | 'analytics'

interface PhoneEcosystemNavProps {
  active: PhoneSection
  badges?: Partial<Record<PhoneSection, number>>
}

const navItems = [
  { key: 'chat', label: 'Chats', to: '/phone/chat', Icon: MessageCircle },
  { key: 'calendar', label: 'Citas', to: '/phone/calendar', Icon: CalendarDays },
  { key: 'payments', label: 'Pagos', to: '/phone/payments', Icon: CreditCard },
  { key: 'analytics', label: 'Analíticas', to: '/phone/analytics', Icon: BarChart3 }
] as const

export const PhoneEcosystemNav: React.FC<PhoneEcosystemNavProps> = ({ active, badges = {} }) => (
  <nav className={styles.dock} aria-label="Secciones de Ristak Chat">
    {navItems.map(({ key, label, to, Icon }) => {
      const badgeCount = Math.max(0, Number(badges[key] || 0))

      return (
        <Link key={key} to={to} className={active === key ? styles.active : undefined}>
          <span className={styles.iconWrap}>
            <Icon size={key === 'chat' ? 25 : 24} />
            {badgeCount > 0 && (
              <i aria-label={`${badgeCount} mensajes no leídos`}>
                {badgeCount > 99 ? '99+' : badgeCount}
              </i>
            )}
          </span>
          <span>{label}</span>
        </Link>
      )
    })}
  </nav>
)
