import React from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AutomationsHome } from './AutomationsHome'
import { AutomationEditor } from './editor/AutomationEditor'

export const Automations: React.FC = () => {
  return (
    <Routes>
      <Route index element={<AutomationsHome />} />
      <Route path=":automationId" element={<AutomationEditor />} />
      <Route path="*" element={<Navigate to="/automations" replace />} />
    </Routes>
  )
}
