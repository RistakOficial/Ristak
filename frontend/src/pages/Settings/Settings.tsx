import React from 'react'
import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { Send, CreditCard, Activity, Calendar, UserCircle, TrendingDown, Bot, KeyRound, Globe2 } from 'lucide-react'
import { SiWhatsapp } from 'react-icons/si'
import { HighLevelIntegration } from './HighLevelIntegration'
import { Costs } from './Costs'
import { PaymentsConfiguration } from './PaymentsConfiguration'
import { MetaAdsIntegration } from './MetaAdsIntegration'
import { WhatsAppSettings } from './WhatsAppSettings'
import { WebTracking } from './WebTracking'
import { CalendarsConfiguration } from './CalendarsConfiguration'
import { AccountSettings } from './AccountSettings'
import { AIAgentSettings } from './AIAgentSettings'
import { APIAccessSettings } from './APIAccessSettings'
import { Domains } from './Domains'
import { useTheme } from '@/contexts/ThemeContext'
import styles from './Settings.module.css'

export const Settings: React.FC = () => {
  const { theme } = useTheme()
  const settingsNavigation = [
    {
      to: '/settings/highlevel',
      label: 'HighLevel',
      icon: <Send size={18} />
    },
    {
      to: '/settings/meta-ads',
      label: 'Meta Ads',
      icon: (
        <img
          src={theme === 'dark'
            ? 'https://img.icons8.com/ios-filled/150/FFFFFF/meta.png'
            : 'https://img.icons8.com/ios-filled/150/meta.png'
          }
          alt=""
          className={styles.settingsNavMetaIcon}
        />
      )
    },
    {
      to: '/settings/whatsapp',
      label: 'WhatsApp',
      icon: <SiWhatsapp size={18} />
    },
    {
      to: '/settings/calendars',
      label: 'Calendarios',
      icon: <Calendar size={18} />
    },
    {
      to: '/settings/tracking',
      label: 'Rastreo Web',
      icon: <Activity size={18} />
    },
    {
      to: '/settings/domains',
      label: 'Dominios',
      icon: <Globe2 size={18} />
    },
    {
      to: '/settings/payments',
      label: 'Pagos',
      icon: <CreditCard size={18} />
    },
    {
      to: '/settings/costs',
      label: 'Costos',
      icon: <TrendingDown size={18} />
    },
    {
      to: '/settings/ai-agent',
      label: 'Agente AI',
      icon: <Bot size={18} />
    },
    {
      to: '/settings/api-access',
      label: 'Acceso API',
      icon: <KeyRound size={18} />
    },
    {
      to: '/settings/account',
      label: 'Cuenta',
      icon: <UserCircle size={18} />
    }
  ]

  return (
    <div className={styles.container}>
      <div className={styles.settingsLayout}>
        <aside className={styles.settingsNavPanel} aria-label="Secciones de configuración">
          <div className={styles.settingsNavHeader}>
            <span className={styles.settingsNavEyebrow}>Configuración</span>
            <strong className={styles.settingsNavTitle}>Secciones</strong>
          </div>

          <nav className={styles.settingsNavList}>
            {settingsNavigation.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `${styles.settingsNavItem} ${isActive ? styles.settingsNavItemActive : ''}`}
              >
                <span className={styles.settingsNavIcon}>{item.icon}</span>
                <span className={styles.settingsNavLabel}>{item.label}</span>
              </NavLink>
            ))}
          </nav>
        </aside>

        <section className={styles.settingsPanel}>
          <div className={styles.header}>
            <h1 className={styles.title}>Configuración</h1>
            <p className={styles.subtitle}>Gestiona las integraciones y configuración de tu cuenta</p>
          </div>

          <div className={styles.mainContent}>
            <Routes>
              <Route index element={<Navigate to="highlevel" replace />} />
              <Route path="highlevel" element={<HighLevelIntegration />} />
              <Route path="costs" element={<Costs />} />
              <Route path="meta-ads" element={<MetaAdsIntegration />} />
              <Route path="whatsapp" element={<WhatsAppSettings />} />
              <Route path="calendars" element={<CalendarsConfiguration />} />
              <Route path="tracking" element={<WebTracking />} />
              <Route path="domains" element={<Domains />} />
              <Route path="payments" element={<PaymentsConfiguration />} />
              <Route path="ai-agent" element={<AIAgentSettings />} />
              <Route path="api-access" element={<APIAccessSettings />} />
              <Route path="account" element={<AccountSettings />} />
            </Routes>
          </div>
        </section>
      </div>
    </div>
  )
}
