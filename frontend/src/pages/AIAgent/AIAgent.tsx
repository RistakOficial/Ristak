import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { AIAgentSettings } from '@/pages/Settings/AIAgentSettings'
import { ConversationalAgentSettings } from '@/pages/Settings/ConversationalAgentSettings'
import { getFirstAllowedAIAgentPath, hasLicenseFeature } from '@/utils/accessControl'
import styles from '@/pages/Settings/Settings.module.css'

const AIAgentFeatureRoute: React.FC<{ featureKeys: readonly string[]; children: React.ReactNode }> = ({ featureKeys, children }) => {
  const { user } = useAuth()

  if (!hasLicenseFeature(user, featureKeys)) {
    return <Navigate to={getFirstAllowedAIAgentPath(user)} replace />
  }

  return <>{children}</>
}

// Agente AI vive como sección principal del producto. Las pantallas reutilizan
// los paneles existentes, pero ya no se montan dentro de Configuración.
export const AIAgent: React.FC = () => {
  const { user } = useAuth()

  return (
    <div className={styles.container}>
      <section className={styles.settingsPanel}>
        <div className={styles.mainContent}>
          <Routes>
            <Route index element={<Navigate to={getFirstAllowedAIAgentPath(user).replace('/ai-agent/', '')} replace />} />
            <Route
              path="general"
              element={(
                <AIAgentFeatureRoute featureKeys={['app_assistant_ai', 'ai']}>
                  <AIAgentSettings />
                </AIAgentFeatureRoute>
              )}
            />
            <Route
              path="conversational"
              element={(
                <AIAgentFeatureRoute featureKeys={['conversational_ai', 'ai']}>
                  <ConversationalAgentSettings />
                </AIAgentFeatureRoute>
              )}
            />
            <Route
              path="conversational/:agentId"
              element={(
                <AIAgentFeatureRoute featureKeys={['conversational_ai', 'ai']}>
                  <ConversationalAgentSettings />
                </AIAgentFeatureRoute>
              )}
            />
            <Route path="*" element={<Navigate to={getFirstAllowedAIAgentPath(user)} replace />} />
          </Routes>
        </div>
      </section>
    </div>
  )
}
