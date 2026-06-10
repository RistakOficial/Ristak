import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { HighLevelIntegration } from './HighLevelIntegration'
import { Costs } from './Costs'
import { PaymentsConfiguration } from './PaymentsConfiguration'
import { MetaAdsIntegration } from './MetaAdsIntegration'
import { WhatsAppSettings } from './WhatsAppSettings'
import { WebTracking } from './WebTracking'
import { CalendarsConfiguration } from './CalendarsConfiguration'
import { AccountSettings } from './AccountSettings'
import { AIAgentSettings } from './AIAgentSettings'
import { APIAccessSettings } from './APIAccessSettings'
import { Domains } from './Domains'
import { MobileAppSettings } from './MobileAppSettings'
import { CustomFields } from './CustomFields'
import styles from './Settings.module.css'

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
            <Route path="highlevel" element={<HighLevelIntegration />} />
            <Route path="costs/*" element={<Costs />} />
            <Route path="meta-ads/*" element={<MetaAdsIntegration />} />
            <Route path="whatsapp/*" element={<WhatsAppSettings />} />
            <Route path="calendars/*" element={<CalendarsConfiguration />} />
            <Route path="tracking/*" element={<WebTracking />} />
            <Route path="domains/*" element={<Domains />} />
            <Route path="payments/*" element={<PaymentsConfiguration />} />
            <Route path="custom-fields/*" element={<CustomFields />} />
            <Route path="ai-agent" element={<AIAgentSettings />} />
            <Route path="api-access" element={<APIAccessSettings />} />
            <Route path="mobile-app" element={<MobileAppSettings />} />
            <Route path="account" element={<AccountSettings />} />
          </Routes>
        </div>
      </section>
    </div>
  )
}
