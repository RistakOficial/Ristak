import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { DateRangeProvider } from '@/contexts/DateRangeContext'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { NotificationProvider, useNotification } from '@/contexts/NotificationContext'
import { TimezoneProvider } from '@/contexts/TimezoneContext'
import { LabelsProvider } from '@/contexts/LabelsContext'
import { usePhoneTheme, usePhoneWakeLock } from '@/hooks'
import { AppShell } from '@/components/layout/AppShell'
import { Dashboard } from '@/pages/Dashboard'
import { Initialization } from '@/pages/Initialization'
import { useInitialization } from '@/contexts/InitializationContext'
import { Reports } from '@/pages/Reports'
import { Campaigns } from '@/pages/Campaigns'
import { Transactions } from '@/pages/Transactions'
import { Contacts } from '@/pages/Contacts'
import { Settings } from '@/pages/Settings'
import { APIDocumentation } from '@/pages/Settings/APIDocumentation'
import { AIAgent } from '@/pages/AIAgent'
import { Appointments } from '@/pages/Appointments'
import { Analytics } from '@/pages/Analytics'
import { Sites } from '@/pages/Sites'
import { Automations } from '@/pages/Automations'
import { PhoneAgentChat } from '@/pages/PhoneAgentChat'
import { PhoneApp } from '@/pages/PhoneApp'
import { PhoneAnalytics } from '@/pages/PhoneAnalytics'
import { PhoneCalendar } from '@/pages/PhoneCalendar'
import { PhoneChat } from '@/pages/PhoneChat'
import { PhonePayments } from '@/pages/PhonePayments'
import { PhoneSettings } from '@/pages/PhoneSettings'
import { Login } from '@/pages/Login'
import { Setup } from '@/pages/Login/Setup'
import { LicenseBlocked } from '@/pages/Login/LicenseBlocked'
import { Sso } from '@/pages/Login/Sso'
import { ToastContainer } from '@/components/common/Toast'
import { Modal } from '@/components/common/Modal'
import { StorageAlert } from '@/components/common/StorageAlert'
import { AppStartupLoader } from '@/components/common/AppStartupLoader'
import { MobileNotificationOnboarding } from '@/components/phone/MobileNotificationOnboarding'
import { PhoneStartupLoader } from '@/components/phone/PhoneStartupLoader'
import {
  DESKTOP_LOGIN_PATH,
  PHONE_APP_HOME_PATH,
  PHONE_APP_LOGIN_PATH,
  SETUP_PATH,
  TABLET_VIEW_PREFERENCE_EVENT,
  getLoginPathForRoute,
  getPostAuthRedirectPath,
  isCellphoneDevice,
  isPhoneAppPath,
  isTabletDevice,
  readTabletViewPreference,
  writeTabletViewPreference,
  type RedirectLocation,
  type TabletViewPreference
} from '@/utils/phoneAccess'
import {
  getFirstAllowedAppPath,
  hasModuleAccess,
  type PermissionKey
} from '@/utils/accessControl'

type RouteLocationState = {
  from?: RedirectLocation
} | null

type AppBranding = {
  title: string
  favicon: string
  faviconType: string
  manifest: string
  appleTouchIcon: string
  themeColor: string
}

const ROUTE_BRANDING: Record<'ristak' | 'phone' | 'phoneChat', AppBranding> = {
  ristak: {
    title: 'Ristak',
    favicon: '/logo.svg',
    faviconType: 'image/svg+xml',
    manifest: '/manifest.webmanifest',
    appleTouchIcon: '/apple-touch-icon.png',
    themeColor: '#ffffff'
  },
  phone: {
    title: 'Ristak',
    favicon: '/ristak-chat-icon-192.png',
    faviconType: 'image/png',
    manifest: '/manifest.phone.webmanifest',
    appleTouchIcon: '/ristak-chat-apple-touch-icon.png',
    themeColor: '#050505'
  },
  phoneChat: {
    title: 'Ristak',
    favicon: '/ristak-chat-home-icon-192.png',
    faviconType: 'image/png',
    manifest: '/manifest.phone-chat.webmanifest',
    appleTouchIcon: '/ristak-chat-home-apple-touch-icon.png',
    themeColor: '#050505'
  }
}

function getRouteBranding(pathname: string) {
  if (pathname === '/phone/chat' || pathname.startsWith('/phone/chat/')) {
    return ROUTE_BRANDING.phoneChat
  }

  if (pathname.startsWith('/phone')) {
    return ROUTE_BRANDING.phone
  }

  return ROUTE_BRANDING.ristak
}

function setHeadLink(selector: string, attributes: Record<string, string>) {
  let link = document.head.querySelector<HTMLLinkElement>(selector)

  if (!link) {
    link = document.createElement('link')
    document.head.appendChild(link)
  }

  Object.entries(attributes).forEach(([name, value]) => {
    link?.setAttribute(name, value)
  })
}

function setHeadMeta(selector: string, attributes: Record<string, string>) {
  let meta = document.head.querySelector<HTMLMetaElement>(selector)

  if (!meta) {
    meta = document.createElement('meta')
    document.head.appendChild(meta)
  }

  Object.entries(attributes).forEach(([name, value]) => {
    meta?.setAttribute(name, value)
  })
}

function applyRouteBranding(pathname: string) {
  const branding = getRouteBranding(pathname)
  const isPhoneRoute = pathname.startsWith('/phone')

  document.title = branding.title
  document.documentElement.dataset.appBrand = isPhoneRoute ? 'ristak-chat' : 'ristak'

  setHeadLink('link[rel="icon"]', {
    rel: 'icon',
    type: branding.faviconType,
    href: branding.favicon
  })
  setHeadLink('link[rel="manifest"]', {
    rel: 'manifest',
    href: branding.manifest
  })
  setHeadLink('link[rel="apple-touch-icon"]', {
    rel: 'apple-touch-icon',
    href: branding.appleTouchIcon
  })
  setHeadMeta('meta[name="theme-color"]', {
    name: 'theme-color',
    content: branding.themeColor
  })
  setHeadMeta('meta[name="apple-mobile-web-app-title"]', {
    name: 'apple-mobile-web-app-title',
    content: branding.title
  })
}

const PhoneThemeRouteEffects: React.FC = () => {
  usePhoneTheme({ active: true })
  usePhoneWakeLock({ active: true })
  return null
}

function isStandalonePhoneShell() {
  if (typeof window === 'undefined') return false

  const standaloneMedia = window.matchMedia?.('(display-mode: standalone)').matches
  const navigatorStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  if (!standaloneMedia && !navigatorStandalone) return false

  const portableViewport = window.matchMedia?.('(max-width: 760px), (pointer: coarse)').matches
  const portableUserAgent = /Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent)
  return Boolean(portableViewport || portableUserAgent)
}

function getStandalonePhoneRedirect(pathname: string) {
  if (!isStandalonePhoneShell()) return ''

  if (pathname === '/' || pathname === '/dashboard') return '/phone/chat'
  if (pathname === '/login') return '/phone/login'
  return ''
}

const RouteStartupLoader: React.FC<{ pathname: string; message?: string }> = ({ pathname, message }) => (
  isPhoneAppPath(pathname)
    ? <PhoneStartupLoader message={message || 'Abriendo Ristak'} />
    : <AppStartupLoader message={message || 'Cargando Ristak'} />
)

// Componente para la ruta de setup (primera vez)
const SetupRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, needsSetup, isLoading } = useAuth()
  const location = useLocation()
  const redirectPath = getPostAuthRedirectPath((location.state as RouteLocationState)?.from)

  if (isLoading) {
    return <RouteStartupLoader pathname={location.pathname} />
  }

  if (!needsSetup) {
    return isAuthenticated
      ? <Navigate to={redirectPath} replace />
      : <Navigate to={getLoginPathForRoute(location.pathname)} state={{ from: location }} replace />
  }

  return <>{children}</>
}

// Componente para proteger rutas que requieren autenticación
const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading, needsSetup } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return <RouteStartupLoader pathname={location.pathname} />
  }

  if (needsSetup) {
    return <Navigate to={SETUP_PATH} state={{ from: location }} replace />
  }

  if (!isAuthenticated) {
    return <Navigate to={getLoginPathForRoute(location.pathname)} state={{ from: location }} replace />
  }

  return <>{children}</>
}

const AccessRoute: React.FC<{ moduleKey: PermissionKey; children: React.ReactNode }> = ({ moduleKey, children }) => {
  const { user } = useAuth()

  if (!hasModuleAccess(user, moduleKey, 'read')) {
    return <Navigate to={getFirstAllowedAppPath(user)} replace />
  }

  return <>{children}</>
}

// Redirección de la raíz (/): mientras el onboarding de integraciones no esté
// completo (ni oculto), se lleva al usuario a /initialization; si ya está dado
// de alta, va al dashboard. Se monta dentro del AppShell (InitializationProvider).
const HomeRedirect: React.FC = () => {
  const { loading, isInitialized } = useInitialization()
  const { user } = useAuth()

  if (loading) {
    return <AppStartupLoader compact />
  }

  if (!isInitialized && user?.role === 'admin') {
    return <Navigate to="/initialization" replace />
  }

  return <Navigate to={hasModuleAccess(user, 'dashboard', 'read') ? '/dashboard' : getFirstAllowedAppPath(user)} replace />
}

const PhoneRouteEffects: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const isPhoneRoute = isPhoneAppPath(location.pathname)

  React.useEffect(() => {
    const redirectPath = getStandalonePhoneRedirect(location.pathname)
    if (!redirectPath || redirectPath === location.pathname) return
    navigate(redirectPath, { replace: true })
  }, [location.pathname, navigate])

  React.useEffect(() => {
    applyRouteBranding(location.pathname)
  }, [location.pathname])

  React.useEffect(() => {
    if (!isPhoneRoute || !isCellphoneDevice()) return

    const orientation = window.screen?.orientation as (ScreenOrientation & {
      lock?: (orientation: string) => Promise<void>
      unlock?: () => void
    }) | undefined

    void orientation?.lock?.('portrait').catch(() => undefined)

    return () => {
      orientation?.unlock?.()
    }
  }, [isPhoneRoute])

  React.useLayoutEffect(() => {
    const body = document.body
    const root = document.documentElement
    const previousBodyPhoneApp = body.dataset.phoneApp
    const previousRootPhoneApp = root.dataset.phoneApp

    if (isPhoneRoute) {
      body.dataset.phoneApp = 'active'
      root.dataset.phoneApp = 'active'
    } else {
      delete body.dataset.phoneApp
      delete root.dataset.phoneApp
    }

    let viewportFrame = 0
    let lastVisualViewportHeight = ''
    let lastVisualViewportTop = ''
    let lastKeyboardInset = ''
    const syncPhoneViewport = () => {
      const visualViewport = window.visualViewport
      const layoutHeight = Math.max(root.clientHeight, window.innerHeight)
      const visibleHeight = visualViewport?.height ?? window.innerHeight
      const viewportTop = visualViewport?.offsetTop ?? 0
      const keyboardInset = Math.max(0, layoutHeight - visibleHeight - viewportTop)
      const roundedInset = keyboardInset > 48 ? Math.round(keyboardInset) : 0
      const nextVisualViewportHeight = `${Math.round(visibleHeight)}px`
      const nextVisualViewportTop = `${Math.round(viewportTop)}px`
      const nextKeyboardInset = `${roundedInset}px`

      if (lastVisualViewportHeight !== nextVisualViewportHeight) {
        root.style.setProperty('--phone-visual-viewport-height', nextVisualViewportHeight)
        lastVisualViewportHeight = nextVisualViewportHeight
      }
      if (lastVisualViewportTop !== nextVisualViewportTop) {
        root.style.setProperty('--phone-visual-viewport-top', nextVisualViewportTop)
        lastVisualViewportTop = nextVisualViewportTop
      }
      if (lastKeyboardInset !== nextKeyboardInset) {
        root.style.setProperty('--phone-keyboard-inset', nextKeyboardInset)
        lastKeyboardInset = nextKeyboardInset
      }
    }
    const schedulePhoneViewportSync = () => {
      if (viewportFrame) window.cancelAnimationFrame(viewportFrame)
      viewportFrame = window.requestAnimationFrame(syncPhoneViewport)
    }

    if (isPhoneRoute) {
      syncPhoneViewport()
      window.visualViewport?.addEventListener('resize', schedulePhoneViewportSync)
      window.visualViewport?.addEventListener('scroll', schedulePhoneViewportSync)
      window.addEventListener('resize', schedulePhoneViewportSync)
    } else {
      root.style.removeProperty('--phone-visual-viewport-height')
      root.style.removeProperty('--phone-visual-viewport-top')
      root.style.removeProperty('--phone-keyboard-inset')
    }

    return () => {
      if (viewportFrame) window.cancelAnimationFrame(viewportFrame)
      window.visualViewport?.removeEventListener('resize', schedulePhoneViewportSync)
      window.visualViewport?.removeEventListener('scroll', schedulePhoneViewportSync)
      window.removeEventListener('resize', schedulePhoneViewportSync)
      root.style.removeProperty('--phone-visual-viewport-height')
      root.style.removeProperty('--phone-visual-viewport-top')
      root.style.removeProperty('--phone-keyboard-inset')

      if (previousBodyPhoneApp !== undefined) {
        body.dataset.phoneApp = previousBodyPhoneApp
      } else {
        delete body.dataset.phoneApp
      }

      if (previousRootPhoneApp !== undefined) {
        root.dataset.phoneApp = previousRootPhoneApp
      } else {
        delete root.dataset.phoneApp
      }
    }
  }, [isPhoneRoute])

  return isPhoneRoute ? <PhoneThemeRouteEffects /> : null
}

function useCellphoneAccessState() {
  const [isCellphone, setIsCellphone] = React.useState(isCellphoneDevice)

  React.useEffect(() => {
    const updateAccessState = () => setIsCellphone(isCellphoneDevice())
    const pointerMedia = window.matchMedia?.('(pointer: coarse)')

    updateAccessState()
    pointerMedia?.addEventListener('change', updateAccessState)
    window.addEventListener('resize', updateAccessState)
    window.addEventListener('orientationchange', updateAccessState)
    window.visualViewport?.addEventListener('resize', updateAccessState)

    return () => {
      pointerMedia?.removeEventListener('change', updateAccessState)
      window.removeEventListener('resize', updateAccessState)
      window.removeEventListener('orientationchange', updateAccessState)
      window.visualViewport?.removeEventListener('resize', updateAccessState)
    }
  }, [])

  return isCellphone
}

const CellphoneRouteGate: React.FC = () => {
  const location = useLocation()
  const isCellphone = useCellphoneAccessState()

  if (!isCellphone || isPhoneAppPath(location.pathname) || location.pathname === SETUP_PATH) {
    return null
  }

  const redirectPath = location.pathname === DESKTOP_LOGIN_PATH ? PHONE_APP_LOGIN_PATH : PHONE_APP_HOME_PATH

  return <Navigate to={redirectPath} replace state={{ from: location }} />
}

function useTabletViewPreferenceState() {
  const [isTablet, setIsTablet] = React.useState(isTabletDevice)
  const [preference, setPreference] = React.useState<TabletViewPreference | null>(readTabletViewPreference)

  React.useEffect(() => {
    const pointerMedia = window.matchMedia?.('(pointer: coarse)')
    const updateDeviceState = () => {
      setIsTablet(isTabletDevice())
      setPreference(readTabletViewPreference())
    }
    const updatePreference = () => setPreference(readTabletViewPreference())

    updateDeviceState()
    pointerMedia?.addEventListener('change', updateDeviceState)
    window.addEventListener('resize', updateDeviceState)
    window.addEventListener('orientationchange', updateDeviceState)
    window.visualViewport?.addEventListener('resize', updateDeviceState)
    window.addEventListener('storage', updatePreference)
    window.addEventListener(TABLET_VIEW_PREFERENCE_EVENT, updatePreference)

    return () => {
      pointerMedia?.removeEventListener('change', updateDeviceState)
      window.removeEventListener('resize', updateDeviceState)
      window.removeEventListener('orientationchange', updateDeviceState)
      window.visualViewport?.removeEventListener('resize', updateDeviceState)
      window.removeEventListener('storage', updatePreference)
      window.removeEventListener(TABLET_VIEW_PREFERENCE_EVENT, updatePreference)
    }
  }, [])

  return { isTablet, preference, setPreference }
}

const TabletViewPreferenceGate: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const { isTablet, preference, setPreference } = useTabletViewPreferenceState()
  const isPhoneRoute = isPhoneAppPath(location.pathname)
  const canApplyTabletPreference = isTablet && location.pathname !== SETUP_PATH

  React.useEffect(() => {
    if (!canApplyTabletPreference || !preference) return

    if (preference === 'tablet' && !isPhoneRoute) {
      navigate(PHONE_APP_HOME_PATH, { replace: true })
      return
    }

    if (preference === 'web' && isPhoneRoute) {
      navigate('/dashboard', { replace: true })
    }
  }, [canApplyTabletPreference, isPhoneRoute, location.pathname, navigate, preference])

  const chooseTabletView = (nextPreference: TabletViewPreference) => {
    writeTabletViewPreference(nextPreference)
    setPreference(nextPreference)

    if (nextPreference === 'tablet' && !isPhoneRoute) {
      navigate(PHONE_APP_HOME_PATH, { replace: true })
      return
    }

    if (nextPreference === 'web' && isPhoneRoute) {
      navigate('/dashboard', { replace: true })
    }
  }

  if (!canApplyTabletPreference || preference) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tablet-view-choice-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: 'rgba(15, 23, 42, 0.42)',
        backdropFilter: 'blur(16px)'
      }}
    >
      <div
        style={{
          width: 'min(100%, 480px)',
          borderRadius: '18px',
          border: '1px solid rgba(148, 163, 184, 0.22)',
          background: 'var(--color-background-primary)',
          color: 'var(--color-text-primary)',
          boxShadow: '0 24px 70px rgba(15, 23, 42, 0.24)',
          padding: '24px'
        }}
      >
        <p
          style={{
            margin: '0 0 8px',
            color: 'var(--color-text-tertiary)',
            fontSize: '12px',
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase'
          }}
        >
          Tablet detectada
        </p>
        <h1 id="tablet-view-choice-title" style={{ margin: 0, fontSize: '24px', lineHeight: 1.15 }}>
          ¿Cómo quieres usar Ristak en esta tablet?
        </h1>
        <p style={{ margin: '12px 0 22px', color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
          Puedes abrir el panel completo como computadora o usar la vista de tableta para chats.
        </p>
        <div style={{ display: 'grid', gap: '10px' }}>
          <button
            type="button"
            onClick={() => chooseTabletView('web')}
            style={{
              minHeight: '48px',
              borderRadius: '12px',
              border: '1px solid rgba(148, 163, 184, 0.24)',
              background: 'transparent',
              color: 'var(--color-text-primary)',
              fontWeight: 800,
              cursor: 'pointer'
            }}
          >
            Versión para computadora
          </button>
          <button
            type="button"
            onClick={() => chooseTabletView('tablet')}
            style={{
              minHeight: '48px',
              borderRadius: '12px',
              border: '1px solid rgba(var(--color-primary-rgb), 0.35)',
              background: 'rgb(var(--color-primary-rgb))',
              color: '#fff',
              fontWeight: 800,
              cursor: 'pointer'
            }}
          >
            Versión para tableta
          </button>
        </div>
      </div>
    </div>
  )
}

const AppWithNotifications: React.FC = () => {
  const { toasts, removeToast, modal, closeModal } = useNotification()

  return (
    <>
      <BrowserRouter>
        <PhoneRouteEffects />
        <CellphoneRouteGate />
        <TabletViewPreferenceGate />
        <Routes>
          <Route path="/setup" element={<SetupRoute><Setup /></SetupRoute>} />
          <Route path="/license-blocked" element={<LicenseBlocked />} />
          <Route path="/sso" element={<Sso />} />
          <Route path="/login" element={<Login />} />
          <Route path="/phone/login" element={<Login />} />
          <Route
            path="/phone"
            element={
              <ProtectedRoute>
                <Navigate to="/phone/chat" replace />
              </ProtectedRoute>
            }
          />
          <Route
            path="/phone/agent-chat"
            element={
              <ProtectedRoute>
                <PhoneAgentChat />
              </ProtectedRoute>
            }
          />
          <Route
            path="/phone/agent-ai"
            element={
              <ProtectedRoute>
                <PhoneAgentChat />
              </ProtectedRoute>
            }
          />
          <Route
            path="/phone/ai-agent"
            element={
              <ProtectedRoute>
                <PhoneAgentChat />
              </ProtectedRoute>
            }
          />
          <Route
            path="/phone/app"
            element={
              <ProtectedRoute>
                <Navigate to="/phone/chat" replace />
              </ProtectedRoute>
            }
          />
          <Route
            path="/phone/chat"
            element={
              <ProtectedRoute>
                <PhoneChat />
              </ProtectedRoute>
            }
          />
          <Route
            path="/phone/payments"
            element={
              <ProtectedRoute>
                <PhonePayments />
              </ProtectedRoute>
            }
          />
          <Route
            path="/phone/analytics"
            element={
              <ProtectedRoute>
                <PhoneAnalytics />
              </ProtectedRoute>
            }
          />
          <Route
            path="/phone/settings"
            element={
              <ProtectedRoute>
                <PhoneSettings />
              </ProtectedRoute>
            }
          />
          <Route
            path="/phone/calendar"
            element={
              <ProtectedRoute>
                <PhoneCalendar />
              </ProtectedRoute>
            }
          />
          <Route
            path="/phone/appointments"
            element={
              <ProtectedRoute>
                <PhoneCalendar />
              </ProtectedRoute>
            }
          />
          <Route
            path="/phone/:section"
            element={
              <ProtectedRoute>
                <PhoneApp />
              </ProtectedRoute>
            }
          />
          <Route
            path="/api-docs"
            element={
              <ProtectedRoute>
                <AccessRoute moduleKey="settings_api_access">
                  <APIDocumentation />
                </AccessRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <AppShell />
              </ProtectedRoute>
            }
          >
            <Route index element={<HomeRedirect />} />
            <Route path="initialization/*" element={<AccessRoute moduleKey="settings_integrations"><Initialization /></AccessRoute>} />
            <Route path="dashboard/*" element={<AccessRoute moduleKey="dashboard"><Dashboard /></AccessRoute>} />
            <Route path="reports/*" element={<AccessRoute moduleKey="reports"><Reports /></AccessRoute>} />
            <Route path="campaigns/*" element={<AccessRoute moduleKey="campaigns"><Campaigns /></AccessRoute>} />
            <Route path="transactions/*" element={<AccessRoute moduleKey="payments"><Transactions /></AccessRoute>} />
            <Route path="contacts/*" element={<AccessRoute moduleKey="contacts"><Contacts /></AccessRoute>} />
            <Route path="appointments/*" element={<AccessRoute moduleKey="appointments"><Appointments /></AccessRoute>} />
            <Route path="sites/*" element={<AccessRoute moduleKey="sites"><Sites /></AccessRoute>} />
            <Route path="automations/*" element={<AccessRoute moduleKey="automations"><Automations /></AccessRoute>} />
            <Route path="analytics/*" element={<AccessRoute moduleKey="analytics"><Analytics /></AccessRoute>} />
            <Route path="ai-agent/*" element={<AccessRoute moduleKey="ai_agent"><AIAgent /></AccessRoute>} />
            <Route path="settings/*" element={<Settings />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Routes>
        <MobileNotificationOnboarding />
      </BrowserRouter>
      <StorageAlert />
      <ToastContainer toasts={toasts} onClose={removeToast} />
      <Modal
        isOpen={modal.isOpen}
        onClose={closeModal}
        title={modal.title}
        message={modal.message}
        type={modal.type}
        confirmText={modal.confirmText}
        cancelText={modal.cancelText}
        onConfirm={modal.onConfirm}
        onCancel={modal.onCancel}
        typeToConfirm={modal.typeToConfirm}
      />
    </>
  )
}

export const App: React.FC = () => {
  return (
    <ThemeProvider>
      <TimezoneProvider>
        <NotificationProvider>
          <LabelsProvider>
            <AuthProvider>
              <DateRangeProvider>
                <AppWithNotifications />
              </DateRangeProvider>
            </AuthProvider>
          </LabelsProvider>
        </NotificationProvider>
      </TimezoneProvider>
    </ThemeProvider>
  )
}
