import React from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { PageContainer, SegmentTabs } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { ConversationalAgentSettings } from '@/pages/Settings/ConversationalAgentSettings'
import { getFirstAllowedAppPath, hasLicenseFeature } from '@/utils/accessControl'
import { ChatbotBusinessSettings } from './ChatbotBusinessSettings'

const ChatbotFeatureRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth()

  if (!hasLicenseFeature(user, ['conversational_ai', 'ai'])) {
    return <Navigate to={getFirstAllowedAppPath(user)} replace />
  }

  return <>{children}</>
}

export const Chatbot: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const activeTab = location.pathname.startsWith('/ai-agent/general')
    ? '/ai-agent/general'
    : '/ai-agent/conversational'

  return (
    <PageContainer size="wide">
      <SegmentTabs
        aria-label="Secciones de Chatbot"
        tabs={[
          { id: '/ai-agent/conversational', label: 'Agentes' },
          { id: '/ai-agent/general', label: 'Configuración' }
        ]}
        value={activeTab}
        onChange={(path) => navigate(path)}
      />

      <Routes>
        <Route index element={<Navigate to="conversational" replace />} />
        <Route
          path="general"
          element={(
            <ChatbotFeatureRoute>
              <ChatbotBusinessSettings />
            </ChatbotFeatureRoute>
          )}
        />
        <Route
          path="conversational"
          element={(
            <ChatbotFeatureRoute>
              <ConversationalAgentSettings />
            </ChatbotFeatureRoute>
          )}
        />
        <Route
          path="conversational/:agentId"
          element={(
            <ChatbotFeatureRoute>
              <ConversationalAgentSettings />
            </ChatbotFeatureRoute>
          )}
        />
        <Route path="*" element={<Navigate to="../conversational" replace />} />
      </Routes>
    </PageContainer>
  )
}
