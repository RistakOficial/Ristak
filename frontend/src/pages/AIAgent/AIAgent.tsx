import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { AIAgentSettings } from '@/pages/Settings/AIAgentSettings'
import { ConversationalAgentSettings } from '@/pages/Settings/ConversationalAgentSettings'
import styles from '@/pages/Settings/Settings.module.css'

// Agente AI vive como sección principal del producto. Las pantallas reutilizan
// los paneles existentes, pero ya no se montan dentro de Configuración.
export const AIAgent: React.FC = () => {
  return (
    <div className={styles.container}>
      <section className={styles.settingsPanel}>
        <div className={styles.mainContent}>
          <Routes>
            <Route index element={<Navigate to="general" replace />} />
            <Route path="general" element={<AIAgentSettings />} />
            <Route path="conversational" element={<ConversationalAgentSettings />} />
            <Route path="*" element={<Navigate to="general" replace />} />
          </Routes>
        </div>
      </section>
    </div>
  )
}
