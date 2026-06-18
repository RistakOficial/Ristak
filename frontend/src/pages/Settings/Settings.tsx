import React, { useMemo } from 'react'
import { Link, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import {
  BadgeDollarSign,
  CalendarDays,
  Code2,
  CreditCard,
  Database,
  FileCode2,
  Globe2,
  Mail,
  MonitorSmartphone,
  Settings2,
  Tags,
  User,
  Users
} from 'lucide-react'
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
import { HighLevelIcon, MetaIcon, WhatsAppIcon } from '@/components/common/Icon/CustomIcons'
import { useAuth } from '@/contexts/AuthContext'
import { getFirstAllowedAppPath, hasModuleAccess, type PermissionKey } from '@/utils/accessControl'
import { cn } from '@/utils/cn'
import {
  getFirstAllowedSettingsPath,
  getVisibleSettingsNavigation,
  settingsGroupOrder,
  type SettingsNavGroup,
  type SettingsNavItem
} from './settingsNav'
import styles from './Settings.module.css'

const SettingsAccessGate: React.FC<{ moduleKey: PermissionKey; children: React.ReactNode }> = ({ moduleKey, children }) => {
  const { user } = useAuth()

  if (!hasModuleAccess(user, moduleKey, 'read')) {
    return <Navigate to={getFirstAllowedAppPath(user)} replace />
  }

  return <>{children}</>
}

type SettingsIcon = React.ComponentType<{ size?: number; className?: string }>

const settingsIcons: Record<string, SettingsIcon> = {
  '/settings/account': User,
  '/settings/users-access': Users,
  '/settings/mobile-app': MonitorSmartphone,
  '/settings/calendars': CalendarDays,
  '/settings/payments': CreditCard,
  '/settings/highlevel': HighLevelIcon,
  '/settings/meta-ads': MetaIcon,
  '/settings/whatsapp': WhatsAppIcon,
  '/settings/email': Mail,
  '/settings/tracking': FileCode2,
  '/settings/domains': Globe2,
  '/settings/costs': BadgeDollarSign,
  '/settings/media': Database,
  '/settings/custom-fields': Settings2,
  '/settings/variable-fields': Code2,
  '/settings/trigger-links': Globe2,
  '/settings/tags': Tags,
  '/settings/developers': Code2
}

const isSettingsNavItemActive = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`)

// Las rutas deben mantenerse en sincronía con settingsNav.ts.
export const Settings: React.FC = () => {
  const { user } = useAuth()
  const location = useLocation()
  const visibleSettingsNavigation = useMemo(() => getVisibleSettingsNavigation(user), [user])
  const firstAllowedSettingsPath = useMemo(() => getFirstAllowedSettingsPath(user), [user])
  const groupedSettingsNavigation = useMemo<Array<{ group: SettingsNavGroup; items: SettingsNavItem[] }>>(
    () => settingsGroupOrder
      .map((group) => ({
        group,
        items: visibleSettingsNavigation.filter((item) => item.group === group)
      }))
      .filter((entry) => entry.items.length > 0),
    [visibleSettingsNavigation]
  )

  return (
    <div className={styles.container}>
      <div className={styles.settingsLayout}>
        <aside className={styles.settingsNavPanel} aria-label="Secciones de configuración">
          <div className={styles.settingsNavIntro}>
            <h1>Configuración</h1>
            <p>Cuenta, integraciones y ajustes del espacio de trabajo.</p>
          </div>

          <div className={styles.settingsNavGroups}>
            {groupedSettingsNavigation.map(({ group, items }) => (
              <div className={styles.settingsNavGroup} key={group}>
                <h2 className={styles.settingsNavGroupTitle}>{group}</h2>
                <div className={styles.settingsNavList}>
                  {items.map((item) => {
                    const Icon = settingsIcons[item.to] || Settings2
                    const isActive = isSettingsNavItemActive(location.pathname, item.to)
                    return (
                      <Link
                        key={item.to}
                        to={item.to}
                        className={cn(styles.settingsNavItem, isActive && styles.settingsNavItemActive)}
                        aria-current={isActive ? 'page' : undefined}
                      >
                        <span className={styles.settingsNavIcon} aria-hidden="true">
                          <Icon size={16} />
                        </span>
                        <span className={styles.settingsNavLabel}>{item.label}</span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </aside>

        <section className={styles.settingsPanel}>
          <div className={styles.mainContent}>
            <Routes>
              <Route index element={<Navigate to={firstAllowedSettingsPath} replace />} />
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
    </div>
  )
}
