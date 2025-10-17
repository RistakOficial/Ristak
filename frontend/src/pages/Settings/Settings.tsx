import React from 'react'
import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { Send, CreditCard, Facebook, Activity } from 'lucide-react'
import { HighLevelIntegration } from './HighLevelIntegration'
import { PaymentsConfiguration } from './PaymentsConfiguration'
import { MetaAdsIntegration } from './MetaAdsIntegration'
import { WebTracking } from './WebTracking'
import styles from './Settings.module.css'

export const Settings: React.FC = () => {
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
          <Facebook size={18} />
          <span>Meta Ads</span>
        </NavLink>
        <NavLink
          to="/settings/payments"
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          <CreditCard size={18} />
          <span>Configuración de Pagos</span>
        </NavLink>
        <NavLink
          to="/settings/tracking"
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          <Activity size={18} />
          <span>Web Tracking</span>
        </NavLink>
      </div>

      <div className={styles.mainContent}>
        <Routes>
          <Route index element={<Navigate to="highlevel" replace />} />
          <Route path="highlevel" element={<HighLevelIntegration />} />
          <Route path="payments" element={<PaymentsConfiguration />} />
          <Route path="meta-ads" element={<MetaAdsIntegration />} />
          <Route path="tracking" element={<WebTracking />} />
        </Routes>
      </div>
    </div>
  )
}