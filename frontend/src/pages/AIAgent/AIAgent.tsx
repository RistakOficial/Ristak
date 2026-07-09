import React from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { PageContainer, SegmentTabs } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { AIAgentSettings } from '@/pages/Settings/AIAgentSettings'
import { ConversationalAgentSettings } from '@/pages/Settings/ConversationalAgentSettings'
import { AI_AGENT_NAV_ITEMS, getFirstAllowedAIAgentPath, hasLicenseFeature } from '@/utils/accessControl'

const AIAgentFeatureRoute: React.FC<{ featureKeys: readonly string[]; children: React.ReactNode }> = ({ featureKeys, children }) => {
  const { user } = useAuth()

  if (!hasLicenseFeature(user, featureKeys)) {
    return <Navigate to={getFirstAllowedAIAgentPath(user)} replace />
  }

  return <>{children}</>
}

// Chatbot vive como sección principal del producto. Las pantallas reutilizan
// los paneles existentes, pero ya no se montan dentro de Configuración.
export const AIAgent: React.FC = () => {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const visibleTabs = AI_AGENT_NAV_ITEMS.filter((item) => hasLicenseFeature(user, item.featureKeys))
  const activeTab = visibleTabs.find((item) => (
    item.exact ? location.pathname === item.to : location.pathname.startsWith(item.to)
  )) || visibleTabs[0]

  return (
    <PageContainer size="wide">
      {visibleTabs.length > 1 && activeTab && (
        <SegmentTabs
          aria-label="Configuración de Chatbot"
          tabs={visibleTabs.map((item) => ({ id: item.to, label: item.label }))}
          value={activeTab.to}
          onChange={(path) => navigate(path)}
        />
      )}

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
              <ConversationalAgentSettings generalConfigPath="/ai-agent/general" />
            </AIAgentFeatureRoute>
          )}
        />
        <Route
          path="conversational/:agentId"
          element={(
            <AIAgentFeatureRoute featureKeys={['conversational_ai', 'ai']}>
              <ConversationalAgentSettings generalConfigPath="/ai-agent/general" />
            </AIAgentFeatureRoute>
          )}
        />
        <Route path="*" element={<Navigate to={getFirstAllowedAIAgentPath(user)} replace />} />
      </Routes>
    </PageContainer>
  )
}
