import React, { lazy, type ComponentType } from 'react'
import { LazyLoadErrorBoundary } from '@/components/common/LazyLoadErrorBoundary/LazyLoadErrorBoundary'

type RouteModule = Record<string, unknown>
type RouteComponent = ComponentType<any>
type LoadedRoute = { default: RouteComponent }

interface LazyRouteModule {
  Component: RouteComponent
  preload: () => Promise<LoadedRoute>
}

interface RouteModuleRegistration {
  path: string
  exact?: boolean
  preload: (destination: string) => Promise<LoadedRoute>
}

/**
 * React.lazy no expone una API de precarga. Esta envoltura comparte exactamente
 * la misma promesa entre el hover del menú y el render de la ruta, de modo que
 * la navegación aprovecha el trabajo ya iniciado y nunca descarga dos veces el
 * mismo módulo.
 */
const createLazyRoute = (
  loader: () => Promise<RouteModule>,
  exportName: string
): LazyRouteModule => {
  let pendingLoad: Promise<LoadedRoute> | undefined

  const preload = () => {
    if (!pendingLoad) {
      pendingLoad = loader()
        .then((module) => {
          const component = module[exportName] ?? module.default
          if (!component) {
            throw new Error(`El módulo de ruta no exporta "${exportName}" ni un componente default`)
          }
          return { default: component as RouteComponent }
        })
        .catch((error) => {
          // Un fallo transitorio de red durante el hover no debe envenenar la
          // ruta para el siguiente intento real de navegación.
          pendingLoad = undefined
          throw error
        })
    }

    return pendingLoad
  }

  const LazyComponent = lazy(preload)
  const GuardedRouteComponent: RouteComponent = (props) => (
    <LazyLoadErrorBoundary>
      <LazyComponent {...props} />
    </LazyLoadErrorBoundary>
  )

  return { Component: GuardedRouteComponent, preload }
}

const setup = createLazyRoute(() => import('@/pages/Login/Setup'), 'Setup')
const licenseBlocked = createLazyRoute(() => import('@/pages/Login/LicenseBlocked'), 'LicenseBlocked')
const sso = createLazyRoute(() => import('@/pages/Login/Sso'), 'Sso')
const login = createLazyRoute(() => import('@/pages/Login/Login'), 'Login')
const resetPassword = createLazyRoute(() => import('@/pages/Login/ResetPassword'), 'default')
const publicPayment = createLazyRoute(() => import('@/pages/PublicPayment/PublicPayment'), 'PublicPayment')
const publicPaymentGatewayReturn = createLazyRoute(
  () => import('@/pages/PublicPayment/PublicPayment'),
  'PublicPaymentGatewayReturn'
)
const mobileTenantSetup = createLazyRoute(
  () => import('@/components/phone/MobileTenantSetup'),
  'MobileTenantSetup'
)

const phoneChat = createLazyRoute(() => import('@/pages/PhoneChat/PhoneChat'), 'PhoneChat')
const phoneAgentChat = createLazyRoute(() => import('@/pages/PhoneAgentChat/PhoneAgentChat'), 'PhoneAgentChat')
const phonePayments = createLazyRoute(() => import('@/pages/PhonePayments/PhonePayments'), 'PhonePayments')
const phoneAnalytics = createLazyRoute(() => import('@/pages/PhoneAnalytics/PhoneAnalytics'), 'PhoneAnalytics')
const phoneSettings = createLazyRoute(() => import('@/pages/PhoneSettings/PhoneSettings'), 'PhoneSettings')
const phoneCalendar = createLazyRoute(() => import('@/pages/PhoneCalendar/PhoneCalendar'), 'PhoneCalendar')
const phoneApp = createLazyRoute(() => import('@/pages/PhoneApp/PhoneApp'), 'PhoneApp')

const apiDocumentation = createLazyRoute(
  () => import('@/pages/Settings/APIDocumentation'),
  'APIDocumentation'
)
const initialization = createLazyRoute(
  () => import('@/pages/Initialization/Initialization'),
  'Initialization'
)
const dashboard = createLazyRoute(() => import('@/pages/Dashboard/Dashboard'), 'Dashboard')
const desktopChat = createLazyRoute(() => import('@/pages/DesktopChat/DesktopChat'), 'DesktopChat')
const reports = createLazyRoute(() => import('@/pages/Reports/Reports'), 'Reports')
const campaigns = createLazyRoute(() => import('@/pages/Campaigns/Campaigns'), 'Campaigns')
const transactions = createLazyRoute(() => import('@/pages/Transactions/Transactions'), 'Transactions')
const paymentSubscriptions = createLazyRoute(
  () => import('@/pages/Transactions/PaymentSubscriptions'),
  'PaymentSubscriptions'
)
const paymentProducts = createLazyRoute(
  () => import('@/pages/Transactions/PaymentProducts'),
  'PaymentProducts'
)
const contacts = createLazyRoute(() => import('@/pages/Contacts/Contacts'), 'Contacts')
const appointments = createLazyRoute(() => import('@/pages/Appointments/Appointments'), 'Appointments')
const sites = createLazyRoute(() => import('@/pages/Sites/Sites'), 'Sites')
const automations = createLazyRoute(() => import('@/pages/Automations/Automations'), 'Automations')
const analytics = createLazyRoute(() => import('@/pages/Analytics/Analytics'), 'default')
const aiAgent = createLazyRoute(() => import('@/pages/AIAgent/AIAgent'), 'AIAgent')
const mdpProgram = createLazyRoute(() => import('@/pages/MDPProgram/MDPProgram'), 'MDPProgram')
const settings = createLazyRoute(() => import('@/pages/Settings/Settings'), 'Settings')

const preloadSettingsRoute = async (destination: string) => {
  const loadedRoute = await settings.preload()
  const settingsModule = await import('@/pages/Settings/Settings')
  await settingsModule.prefetchSettingsPage(destination)
  return loadedRoute
}

export const LazySetup = setup.Component
export const LazyLicenseBlocked = licenseBlocked.Component
export const LazySso = sso.Component
export const LazyLogin = login.Component
export const LazyResetPassword = resetPassword.Component
export const LazyPublicPayment = publicPayment.Component
export const LazyPublicPaymentGatewayReturn = publicPaymentGatewayReturn.Component
export const LazyMobileTenantSetup = mobileTenantSetup.Component
export const LazyPhoneChat = phoneChat.Component
export const LazyPhoneAgentChat = phoneAgentChat.Component
export const LazyPhonePayments = phonePayments.Component
export const LazyPhoneAnalytics = phoneAnalytics.Component
export const LazyPhoneSettings = phoneSettings.Component
export const LazyPhoneCalendar = phoneCalendar.Component
export const LazyPhoneApp = phoneApp.Component
export const LazyAPIDocumentation = apiDocumentation.Component
export const LazyInitialization = initialization.Component
export const LazyDashboard = dashboard.Component
export const LazyDesktopChat = desktopChat.Component
export const LazyReports = reports.Component
export const LazyCampaigns = campaigns.Component
export const LazyTransactions = transactions.Component
export const LazyPaymentSubscriptions = paymentSubscriptions.Component
export const LazyPaymentProducts = paymentProducts.Component
export const LazyContacts = contacts.Component
export const LazyAppointments = appointments.Component
export const LazySites = sites.Component
export const LazyAutomations = automations.Component
export const LazyAnalytics = analytics.Component
export const LazyAIAgent = aiAgent.Component
export const LazyMDPProgram = mdpProgram.Component
export const LazySettings = settings.Component

// Las rutas más específicas deben ir antes que sus prefijos generales.
const routeModuleRegistry: RouteModuleRegistration[] = [
  { path: '/pay/success', exact: true, preload: publicPaymentGatewayReturn.preload },
  { path: '/pay', preload: publicPayment.preload },
  { path: '/setup', exact: true, preload: setup.preload },
  { path: '/license-blocked', exact: true, preload: licenseBlocked.preload },
  { path: '/sso', exact: true, preload: sso.preload },
  { path: '/login', exact: true, preload: login.preload },
  { path: '/reset-password', exact: true, preload: resetPassword.preload },
  { path: '/movil/tenant', exact: true, preload: mobileTenantSetup.preload },
  { path: '/movil/login', exact: true, preload: login.preload },
  { path: '/movil/agent-chat', preload: phoneAgentChat.preload },
  { path: '/movil/agent-ai', preload: phoneAgentChat.preload },
  { path: '/movil/ai-agent', preload: phoneAgentChat.preload },
  { path: '/movil/payments', exact: true, preload: phonePayments.preload },
  { path: '/movil/analytics', exact: true, preload: phoneAnalytics.preload },
  { path: '/movil/settings', exact: true, preload: phoneSettings.preload },
  { path: '/movil/calendar', exact: true, preload: phoneCalendar.preload },
  { path: '/movil/appointments', exact: true, preload: phoneCalendar.preload },
  { path: '/movil', exact: true, preload: phoneChat.preload },
  { path: '/movil', preload: phoneApp.preload },
  { path: '/api-docs', exact: true, preload: apiDocumentation.preload },
  { path: '/transactions/payment-plans', preload: transactions.preload },
  { path: '/transactions/subscriptions', preload: paymentSubscriptions.preload },
  { path: '/transactions/products', preload: paymentProducts.preload },
  { path: '/transactions', preload: transactions.preload },
  { path: '/initialization', preload: initialization.preload },
  { path: '/dashboard', preload: dashboard.preload },
  { path: '/chat', preload: desktopChat.preload },
  { path: '/reports', preload: reports.preload },
  { path: '/campaigns', preload: campaigns.preload },
  { path: '/contacts', preload: contacts.preload },
  { path: '/appointments', preload: appointments.preload },
  { path: '/sites', preload: sites.preload },
  { path: '/automations', preload: automations.preload },
  { path: '/analytics', preload: analytics.preload },
  { path: '/ai-agent', preload: aiAgent.preload },
  { path: '/mdp-program', preload: mdpProgram.preload },
  { path: '/settings', preload: preloadSettingsRoute }
]

const matchesRegisteredPath = (pathname: string, registration: RouteModuleRegistration) => (
  registration.exact
    ? pathname === registration.path
    : pathname === registration.path || pathname.startsWith(`${registration.path}/`)
)

const toPathname = (destination: string) => {
  try {
    return new URL(destination, 'https://ristak.local').pathname
  } catch {
    return destination.split(/[?#]/, 1)[0] || '/'
  }
}

/**
 * Inicia la descarga del chunk asociado a una navegación interna. Los callers
 * deciden si ignoran el error (hover) o lo reportan; el registro no dispara
 * trabajo por sí solo durante el arranque de la aplicación.
 */
export const prefetchRouteModule = (destination: string): Promise<void> => {
  const pathname = toPathname(destination)
  const registration = routeModuleRegistry.find((candidate) => matchesRegisteredPath(pathname, candidate))

  if (!registration) return Promise.resolve()

  return registration.preload(pathname).then(() => undefined)
}
