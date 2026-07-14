import React, { useEffect, useMemo } from 'react'
import { Link, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import {
  BellRing,
  BadgeDollarSign,
  Bot,
  CalendarDays,
  CheckCheck,
  Code2,
  CreditCard,
  Database,
  FileCode2,
  Globe2,
  Mail,
  MonitorSmartphone,
  MousePointerClick,
  Settings2,
  Tags,
  User,
  UserX,
  Users
} from 'lucide-react'
import { HighLevelIcon, MetaIcon, WhatsAppIcon } from '@/components/common/Icon/CustomIcons'
import { Loading } from '@/components/common/Loading'
import { LazyLoadErrorBoundary } from '@/components/common/LazyLoadErrorBoundary/LazyLoadErrorBoundary'
import { useAuth } from '@/contexts/AuthContext'
import { getFirstAllowedAppPath, hasLicenseFeature, hasModuleAccess, normalizeRole, type PermissionKey } from '@/utils/accessControl'
import { cn } from '@/utils/cn'
import {
  getFirstAllowedSettingsPath,
  getVisibleSettingsNavigation,
  settingsGroupOrder,
  type SettingsNavGroup,
  type SettingsNavItem
} from './settingsNav'
import styles from './Settings.module.css'

type SettingsPageModule = Record<string, unknown>
type SettingsPageComponent = React.ComponentType<any>
type LoadedSettingsPage = { default: SettingsPageComponent }

const createLazySettingsPage = (loader: () => Promise<SettingsPageModule>, exportName: string) => {
  let pendingLoad: Promise<LoadedSettingsPage> | undefined

  const preload = () => {
    if (!pendingLoad) {
      pendingLoad = loader()
        .then((module) => {
          const component = module[exportName] ?? module.default
          if (!component) {
            throw new Error(`El panel de Configuración no exporta "${exportName}" ni un componente default`)
          }
          return { default: component as SettingsPageComponent }
        })
        .catch((error) => {
          pendingLoad = undefined
          throw error
        })
    }

    return pendingLoad
  }

  return { Component: React.lazy(preload), preload }
}

const highLevelIntegrationPage = createLazySettingsPage(() => import('./HighLevelIntegration'), 'HighLevelIntegration')
const costsPage = createLazySettingsPage(() => import('./Costs'), 'Costs')
const paymentsConfigurationPage = createLazySettingsPage(() => import('./PaymentsConfiguration'), 'PaymentsConfiguration')
const metaAdsIntegrationPage = createLazySettingsPage(() => import('./MetaAdsIntegration'), 'MetaAdsIntegration')
const whatsAppSettingsPage = createLazySettingsPage(() => import('./WhatsAppSettings'), 'WhatsAppSettings')
const emailSettingsPage = createLazySettingsPage(() => import('./EmailSettings'), 'EmailSettings')
const webTrackingPage = createLazySettingsPage(() => import('./WebTracking'), 'WebTracking')
const calendarsConfigurationPage = createLazySettingsPage(() => import('./CalendarsConfiguration'), 'CalendarsConfiguration')
const accountSettingsPage = createLazySettingsPage(() => import('./AccountSettings'), 'AccountSettings')
const userAccessSettingsPage = createLazySettingsPage(() => import('./UserAccessSettings'), 'UserAccessSettings')
const apiAccessSettingsPage = createLazySettingsPage(() => import('./APIAccessSettings'), 'APIAccessSettings')
const domainsPage = createLazySettingsPage(() => import('./Domains'), 'Domains')
const mobileAppSettingsPage = createLazySettingsPage(() => import('./MobileAppSettings'), 'MobileAppSettings')
const notificationSettingsPage = createLazySettingsPage(() => import('./NotificationSettings'), 'NotificationSettings')
const privacySettingsPage = createLazySettingsPage(() => import('./PrivacySettings'), 'PrivacySettings')
const hiddenContactsSettingsPage = createLazySettingsPage(() => import('./HiddenContactsSettings'), 'HiddenContactsSettings')
const mediaSettingsPage = createLazySettingsPage(() => import('./MediaSettings'), 'MediaSettings')
const customFieldsPage = createLazySettingsPage(() => import('./CustomFields'), 'CustomFields')
const variableFieldsPage = createLazySettingsPage(() => import('./VariableFields'), 'VariableFields')
const triggerLinksPage = createLazySettingsPage(() => import('./TriggerLinks'), 'TriggerLinks')
const tagsSettingsPage = createLazySettingsPage(() => import('./TagsSettings'), 'TagsSettings')
const aiAgentSettingsPage = createLazySettingsPage(() => import('./AIAgentSettings'), 'AIAgentSettings')

const HighLevelIntegration = highLevelIntegrationPage.Component
const Costs = costsPage.Component
const PaymentsConfiguration = paymentsConfigurationPage.Component
const MetaAdsIntegration = metaAdsIntegrationPage.Component
const WhatsAppSettings = whatsAppSettingsPage.Component
const EmailSettings = emailSettingsPage.Component
const WebTracking = webTrackingPage.Component
const CalendarsConfiguration = calendarsConfigurationPage.Component
const AccountSettings = accountSettingsPage.Component
const UserAccessSettings = userAccessSettingsPage.Component
const APIAccessSettings = apiAccessSettingsPage.Component
const Domains = domainsPage.Component
const MobileAppSettings = mobileAppSettingsPage.Component
const NotificationSettings = notificationSettingsPage.Component
const PrivacySettings = privacySettingsPage.Component
const HiddenContactsSettings = hiddenContactsSettingsPage.Component
const MediaSettings = mediaSettingsPage.Component
const CustomFields = customFieldsPage.Component
const VariableFields = variableFieldsPage.Component
const TriggerLinks = triggerLinksPage.Component
const TagsSettings = tagsSettingsPage.Component
const AIAgentSettings = aiAgentSettingsPage.Component

const settingsPageRegistry = [
  { path: '/settings/highlevel', preload: highLevelIntegrationPage.preload },
  { path: '/settings/costs', preload: costsPage.preload },
  { path: '/settings/payments', preload: paymentsConfigurationPage.preload },
  { path: '/settings/meta-ads', preload: metaAdsIntegrationPage.preload },
  { path: '/settings/whatsapp', preload: whatsAppSettingsPage.preload },
  { path: '/settings/email', preload: emailSettingsPage.preload },
  { path: '/settings/tracking', preload: webTrackingPage.preload },
  { path: '/settings/calendars', preload: calendarsConfigurationPage.preload },
  { path: '/settings/account', preload: accountSettingsPage.preload },
  { path: '/settings/users-access', preload: userAccessSettingsPage.preload },
  { path: '/settings/developers', preload: apiAccessSettingsPage.preload },
  { path: '/settings/domains', preload: domainsPage.preload },
  { path: '/settings/mobile-app', preload: mobileAppSettingsPage.preload },
  { path: '/settings/notifications', preload: notificationSettingsPage.preload },
  { path: '/settings/privacy', preload: privacySettingsPage.preload },
  { path: '/settings/hidden-contacts', preload: hiddenContactsSettingsPage.preload },
  { path: '/settings/media', preload: mediaSettingsPage.preload },
  { path: '/settings/custom-fields', preload: customFieldsPage.preload },
  { path: '/settings/variable-fields', preload: variableFieldsPage.preload },
  { path: '/settings/trigger-links', preload: triggerLinksPage.preload },
  { path: '/settings/tags', preload: tagsSettingsPage.preload },
  { path: '/settings/artificial-intelligence', preload: aiAgentSettingsPage.preload }
]

export const prefetchSettingsPage = (destination: string): Promise<void> => {
  const registration = settingsPageRegistry.find(({ path }) => (
    destination === path || destination.startsWith(`${path}/`)
  ))

  if (!registration) return Promise.resolve()
  return registration.preload().then(() => undefined)
}

const settingsPrefetchIntentProps = (destination: string) => ({
  onPointerEnter: () => void prefetchSettingsPage(destination).catch(() => undefined),
  onFocus: () => void prefetchSettingsPage(destination).catch(() => undefined),
  onTouchStart: () => void prefetchSettingsPage(destination).catch(() => undefined)
})

const SettingsAccessGate: React.FC<{ moduleKey: PermissionKey; featureKeys?: readonly string[]; adminOnly?: boolean; children: React.ReactNode }> = ({ moduleKey, featureKeys, adminOnly = false, children }) => {
  const { user } = useAuth()

  if (
    !hasModuleAccess(user, moduleKey, 'read') ||
    (featureKeys && !hasLicenseFeature(user, featureKeys)) ||
    (adminOnly && normalizeRole(user?.role) !== 'admin')
  ) {
    return <Navigate to={getFirstAllowedAppPath(user)} replace />
  }

  return <>{children}</>
}

type SettingsIcon = React.ComponentType<{ size?: number; className?: string }>

const settingsIcons: Record<string, SettingsIcon> = {
  '/settings/account': User,
  '/settings/users-access': Users,
  '/settings/notifications': BellRing,
  '/settings/mobile-app': MonitorSmartphone,
  '/settings/privacy': CheckCheck,
  '/settings/hidden-contacts': UserX,
  '/settings/calendars': CalendarDays,
  '/settings/payments': CreditCard,
  '/settings/highlevel': HighLevelIcon,
  '/settings/meta-ads': MetaIcon,
  '/settings/whatsapp': WhatsAppIcon,
  '/settings/email': Mail,
  '/settings/artificial-intelligence': Bot,
  '/settings/tracking': FileCode2,
  '/settings/domains': Globe2,
  '/settings/costs': BadgeDollarSign,
  '/settings/media': Database,
  '/settings/custom-fields': Settings2,
  '/settings/variable-fields': Code2,
  '/settings/trigger-links': MousePointerClick,
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

  useEffect(() => {
    void prefetchSettingsPage(firstAllowedSettingsPath).catch(() => undefined)
  }, [firstAllowedSettingsPath])

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
                        {...settingsPrefetchIntentProps(item.to)}
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
            <LazyLoadErrorBoundary resetKey={location.pathname}>
              <React.Suspense fallback={<Loading message="Abriendo configuración..." size="md" />}>
                <Routes>
                <Route index element={<Navigate to={firstAllowedSettingsPath} replace />} />
                <Route path="highlevel" element={<SettingsAccessGate moduleKey="settings_integrations" featureKeys={['highlevel_integration']}><HighLevelIntegration /></SettingsAccessGate>} />
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
                <Route path="trigger-links/*" element={<SettingsAccessGate moduleKey="settings_custom_fields" featureKeys={['trigger_links']}><TriggerLinks /></SettingsAccessGate>} />
                <Route path="tags" element={<SettingsAccessGate moduleKey="settings_custom_fields"><TagsSettings /></SettingsAccessGate>} />
                <Route path="artificial-intelligence" element={<SettingsAccessGate moduleKey="ai_agent"><AIAgentSettings /></SettingsAccessGate>} />
                <Route path="ai-agent" element={<SettingsAccessGate moduleKey="ai_agent"><Navigate to="/settings/artificial-intelligence" replace /></SettingsAccessGate>} />
                <Route path="ai-agent/conversational" element={<SettingsAccessGate moduleKey="ai_agent"><Navigate to="/ai-agent/conversational" replace /></SettingsAccessGate>} />
                <Route path="ai-agent/*" element={<SettingsAccessGate moduleKey="ai_agent"><Navigate to="/settings/artificial-intelligence" replace /></SettingsAccessGate>} />
                <Route path="developers" element={<SettingsAccessGate moduleKey="settings_api_access"><APIAccessSettings /></SettingsAccessGate>} />
                <Route path="api-access" element={<SettingsAccessGate moduleKey="settings_api_access"><Navigate to="../developers" replace /></SettingsAccessGate>} />
                <Route path="notifications" element={<SettingsAccessGate moduleKey="settings_account"><NotificationSettings /></SettingsAccessGate>} />
                <Route path="mobile-app" element={<SettingsAccessGate moduleKey="settings_mobile"><MobileAppSettings /></SettingsAccessGate>} />
                <Route path="privacy" element={<SettingsAccessGate moduleKey="settings_account"><PrivacySettings /></SettingsAccessGate>} />
                <Route path="hidden-contacts" element={<SettingsAccessGate moduleKey="contacts" adminOnly><HiddenContactsSettings /></SettingsAccessGate>} />
                <Route path="users-access" element={<SettingsAccessGate moduleKey="settings_users"><UserAccessSettings /></SettingsAccessGate>} />
                <Route path="account" element={<SettingsAccessGate moduleKey="settings_account"><AccountSettings /></SettingsAccessGate>} />
                </Routes>
              </React.Suspense>
            </LazyLoadErrorBoundary>
          </div>
        </section>
      </div>
    </div>
  )
}
