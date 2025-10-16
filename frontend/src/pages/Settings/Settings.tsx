import React from 'react'
import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { HighLevelIntegration } from './HighLevelIntegration'
import { StripeIntegration } from './StripeIntegration'
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
          HighLevel
        </NavLink>
        <NavLink
          to="/settings/stripe"
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          Stripe
        </NavLink>
      </div>

      <div className={styles.mainContent}>
        <Routes>
          <Route index element={<Navigate to="highlevel" replace />} />
          <Route path="highlevel" element={<HighLevelIntegration />} />
          <Route path="stripe" element={<StripeIntegration />} />
        </Routes>
      </div>
    </div>
  )
}