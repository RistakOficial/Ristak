import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { HighLevelIntegration } from './HighLevelIntegration'
import { Costs } from './Costs'
import { PaymentsConfiguration } from './PaymentsConfiguration'
import { MetaAdsIntegration } from './MetaAdsIntegration'
import { WhatsAppSettings } from './WhatsAppSettings'
import { EmailSettings } from './EmailSettings'
import { WebTracking } from './WebTracking'
import { CalendarsConfiguration } from './CalendarsConfiguration'
import { AccountSettings } from './AccountSettings'
import { UserAccessSettings } from './UserAccessSettings'
import { APIAccessSettings } from './APIAccessSettings'
import { Domains } from './Domains'
import { MobileAppSettings } from './MobileAppSettings'
import { MediaSettings } from './MediaSettings'
import { CustomFields } from './CustomFields'
import { VariableFields } from './VariableFields'
import { TriggerLinks } from './TriggerLinks'
import { TagsSettings } from './TagsSettings'
import { useAuth } from '@/contexts/AuthContext'
import { getFirstAllowedAppPath, hasModuleAccess, type PermissionKey } from '@/utils/accessControl'
import styles from './Settings.module.css'

const SettingsAccessGate: React.FC<{ moduleKey: PermissionKey; children: React.ReactNode }> = ({ moduleKey, children }) => {
  const { user } = useAuth()

  if (!hasModuleAccess(user, moduleKey, 'read')) {
    return <Navigate to={getFirstAllowedAppPath(user)} replace />
  }

  return <>{children}</>
}

// La navegación de Configuración vive en el sidebar principal (grupo
// expandible); aquí solo se monta el contenido de cada sección.
// Las rutas deben mantenerse en sincronía con settingsNav.ts.
export const Settings: React.FC = () => {
  return (
    <div className={styles.container}>
      <section className={styles.settingsPanel}>
        <div className={styles.mainContent}>
          <Routes>
            <Route index element={<Navigate to="account" replace />} />
            <Route path="highlevel" element={<SettingsAccessGate moduleKey="settings_integrations"><HighLevelIntegration /></SettingsAccessGate>} />
            <Route path="costs/*" element={<SettingsAccessGate moduleKey="settings_costs"><Costs /></SettingsAccessGate>} />
            <Route path="meta-ads/*" element={<SettingsAccessGate moduleKey="campaigns"><MetaAdsIntegration /></SettingsAccessGate>} />
            <Route path="whatsapp/*" element={<SettingsAccessGate moduleKey="settings_whatsapp"><WhatsAppSettings /></SettingsAccessGate>} />
            <Route path="email" element={<SettingsAccessGate moduleKey="settings_email"><EmailSettings /></SettingsAccessGate>} />
            <Route path="calendars/*" element={<SettingsAccessGate moduleKey="settings_calendars"><CalendarsConfiguration /></SettingsAccessGate>} />
            <Route path="tracking/*" element={<SettingsAccessGate moduleKey="settings_tracking"><WebTracking /></SettingsAccessGate>} />
            <Route path="domains/*" element={<SettingsAccessGate moduleKey="settings_domains"><Domains /></SettingsAccessGate>} />
            <Route path="payments/*" element={<SettingsAccessGate moduleKey="settings_payments"><PaymentsConfiguration /></SettingsAccessGate>} />
            <Route path="media" element={<SettingsAccessGate moduleKey="settings_media"><MediaSettings /></SettingsAccessGate>} />
            <Route path="custom-fields/*" element={<SettingsAccessGate moduleKey="settings_custom_fields"><CustomFields /></SettingsAccessGate>} />
            <Route path="variable-fields/*" element={<SettingsAccessGate moduleKey="settings_custom_fields"><VariableFields /></SettingsAccessGate>} />
            <Route path="trigger-links/*" element={<SettingsAccessGate moduleKey="settings_custom_fields"><TriggerLinks /></SettingsAccessGate>} />
            <Route path="tags" element={<SettingsAccessGate moduleKey="settings_custom_fields"><TagsSettings /></SettingsAccessGate>} />
            <Route path="ai-agent" element={<SettingsAccessGate moduleKey="ai_agent"><Navigate to="/ai-agent/general" replace /></SettingsAccessGate>} />
            <Route path="ai-agent/conversational" element={<SettingsAccessGate moduleKey="ai_agent"><Navigate to="/ai-agent/conversational" replace /></SettingsAccessGate>} />
            <Route path="ai-agent/*" element={<SettingsAccessGate moduleKey="ai_agent"><Navigate to="/ai-agent/general" replace /></SettingsAccessGate>} />
            <Route path="developers" element={<SettingsAccessGate moduleKey="settings_api_access"><APIAccessSettings /></SettingsAccessGate>} />
            <Route path="api-access" element={<SettingsAccessGate moduleKey="settings_api_access"><Navigate to="../developers" replace /></SettingsAccessGate>} />
            <Route path="mobile-app" element={<SettingsAccessGate moduleKey="settings_mobile"><MobileAppSettings /></SettingsAccessGate>} />
            <Route path="users-access" element={<SettingsAccessGate moduleKey="settings_users"><UserAccessSettings /></SettingsAccessGate>} />
            <Route path="account" element={<SettingsAccessGate moduleKey="settings_account"><AccountSettings /></SettingsAccessGate>} />
          </Routes>
        </div>
      </section>
    </div>
  )
}
