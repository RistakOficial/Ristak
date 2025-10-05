import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { HighLevelIntegration } from './HighLevelIntegration'
import styles from './Settings.module.css'

export const Settings: React.FC = () => {
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Configuración</h1>
        <p className={styles.subtitle}>Toda la información de tu cuenta proviene de HighLevel</p>
      </div>

      <div className={styles.mainContent}>
        <Routes>
          <Route index element={<Navigate to="highlevel" replace />} />
          <Route path="highlevel" element={<HighLevelIntegration />} />
        </Routes>
      </div>
    </div>
  )
}