import React from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { PageContainer } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { ConversationalAgentSettings } from '@/pages/Settings/ConversationalAgentSettings'
import { getFirstAllowedAppPath, hasLicenseFeature } from '@/utils/accessControl'

const ConversationalAgentRoute: React.FC = () => {
  const { user } = useAuth()

  if (!hasLicenseFeature(user, ['conversational_ai', 'ai'])) {
    return <Navigate to={getFirstAllowedAppPath(user)} replace />
  }

  return <ConversationalAgentSettings />
}

// La ruta histórica se conserva para no romper permisos ni enlaces guardados,
// pero su única superficie es el agente conversacional.
export const Chatbot: React.FC = () => (
  <PageContainer size="wide">
    <Routes>
      <Route index element={<Navigate to="conversational" replace />} />
      <Route path="general" element={<Navigate to="../conversational" replace />} />
      <Route path="conversational" element={<ConversationalAgentRoute />} />
      <Route path="conversational/:agentId" element={<ConversationalAgentRoute />} />
      <Route path="*" element={<Navigate to="../conversational" replace />} />
    </Routes>
  </PageContainer>
)
