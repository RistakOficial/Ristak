import React from 'react'
import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { Send, CreditCard, Activity, Calendar, UserCircle, TrendingDown, Bot, KeyRound } from 'lucide-react'
import { HighLevelIntegration } from './HighLevelIntegration'
import { Costs } from './Costs'
import { PaymentsConfiguration } from './PaymentsConfiguration'
import { MetaAdsIntegration } from './MetaAdsIntegration'
import { WebTracking } from './WebTracking'
import { CalendarsConfiguration } from './CalendarsConfiguration'
import { AccountSettings } from './AccountSettings'
import { AIAgentSettings } from './AIAgentSettings'
import { APIAccessSettings } from './APIAccessSettings'
import { useTheme } from '@/contexts/ThemeContext'
import styles from './Settings.module.css'

export const Settings: React.FC = () => {
  const { theme } = useTheme()
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Configuración</h1>
        <p className={styles.subtitle}>Gestiona las integraciones y configuración de tu cuenta</p>
      </div>

      <div className={styles.tabs}>
        <NavLink
          to="/settings/highlevel"
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          <Send size={18} />
          <span>HighLevel</span>
        </NavLink>
        <NavLink
          to="/settings/meta-ads"
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          <img
            src={theme === 'dark'
              ? 'https://img.icons8.com/ios-filled/150/FFFFFF/meta.png'
              : 'https://img.icons8.com/ios-filled/150/meta.png'
            }
            alt="Meta"
            style={{ width: '18px', height: '18px' }}
          />
          <span>Meta Ads</span>
        </NavLink>
        <NavLink
          to="/settings/calendars"
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          <Calendar size={18} />
          <span>Calendarios</span>
        </NavLink>
        <NavLink
          to="/settings/tracking"
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          <Activity size={18} />
          <span>Rastreo Web</span>
        </NavLink>
        <NavLink
          to="/settings/payments"
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          <CreditCard size={18} />
          <span>Pagos</span>
        </NavLink>
        <NavLink
          to="/settings/costs"
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          <TrendingDown size={18} />
          <span>Costos</span>
        </NavLink>
        <NavLink
          to="/settings/ai-agent"
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          <Bot size={18} />
          <span>Agente AI</span>
        </NavLink>
        <NavLink
          to="/settings/api-access"
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          <KeyRound size={18} />
          <span>Acceso API</span>
        </NavLink>
        <NavLink
          to="/settings/account"
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          <UserCircle size={18} />
          <span>Cuenta</span>
        </NavLink>
      </div>

      <div className={styles.mainContent}>
        <Routes>
          <Route index element={<Navigate to="highlevel" replace />} />
          <Route path="highlevel" element={<HighLevelIntegration />} />
          <Route path="costs" element={<Costs />} />
          <Route path="meta-ads" element={<MetaAdsIntegration />} />
          <Route path="calendars" element={<CalendarsConfiguration />} />
          <Route path="tracking" element={<WebTracking />} />
          <Route path="payments" element={<PaymentsConfiguration />} />
          <Route path="ai-agent" element={<AIAgentSettings />} />
          <Route path="api-access" element={<APIAccessSettings />} />
          <Route path="account" element={<AccountSettings />} />
        </Routes>
      </div>
    </div>
  )
}
