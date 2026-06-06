import React from 'react'
import { Link } from 'react-router-dom'
import { Bot, CalendarDays, CreditCard, MessageCircle } from 'lucide-react'
import styles from './PhoneEcosystemNav.module.css'

type PhoneSection = 'chat' | 'calendar' | 'payments' | 'agent'

interface PhoneEcosystemNavProps {
  active: PhoneSection
}

const navItems = [
  { key: 'chat', label: 'Chats', to: '/phone/chat', Icon: MessageCircle },
  { key: 'calendar', label: 'Citas', to: '/phone/calendario', Icon: CalendarDays },
  { key: 'payments', label: 'Pagos', to: '/phone/pagos', Icon: CreditCard },
  { key: 'agent', label: 'Agente', to: '/phone/agente-ia', Icon: Bot }
] as const

export const PhoneEcosystemNav: React.FC<PhoneEcosystemNavProps> = ({ active }) => (
  <nav className={styles.dock} aria-label="Secciones de Ristak Chat">
    {navItems.map(({ key, label, to, Icon }) => (
      <Link key={key} to={to} className={active === key ? styles.active : undefined}>
        <Icon size={key === 'chat' ? 25 : 24} />
        <span>{label}</span>
      </Link>
    ))}
  </nav>
)
