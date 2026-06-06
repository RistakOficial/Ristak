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
import { Reports } from '@/pages/Reports'
import { Campaigns } from '@/pages/Campaigns'
import { Transactions } from '@/pages/Transactions'
import { Contacts } from '@/pages/Contacts'
import { Settings } from '@/pages/Settings'
import { APIDocumentation } from '@/pages/Settings/APIDocumentation'
import { Appointments } from '@/pages/Appointments'
import { Analytics } from '@/pages/Analytics'
import { Sites } from '@/pages/Sites'
import { PhoneAgentChat } from '@/pages/PhoneAgentChat'
import { PhoneApp } from '@/pages/PhoneApp'
import { PhoneAnalytics } from '@/pages/PhoneAnalytics'
import { PhoneCalendar } from '@/pages/PhoneCalendar'
import { PhoneChat } from '@/pages/PhoneChat'
import { PhonePayments } from '@/pages/PhonePayments'
import { Login } from '@/pages/Login'
import { Setup } from '@/pages/Login/Setup'
import { ToastContainer } from '@/components/common/Toast'
import { Modal } from '@/components/common/Modal'
import { StorageAlert } from '@/components/common/StorageAlert'
import { MobileNotificationOnboarding } from '@/components/phone/MobileNotificationOnboarding'

type RedirectLocation = {
  pathname?: string
  search?: string
  hash?: string
}

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
    title: 'Ristak Chat',
    favicon: '/ristak-chat-icon.svg',
    faviconType: 'image/svg+xml',
    manifest: '/manifest.phone.webmanifest',
    appleTouchIcon: '/ristak-chat-apple-touch-icon.png',
    themeColor: '#050505'
  },
  phoneChat: {
    title: 'Ristak Chat',
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

function getRedirectPath(from?: RedirectLocation) {
  const pathname = from?.pathname

  if (!pathname?.startsWith('/') || pathname === '/login' || pathname === '/phone/login' || pathname === '/setup') {
    return '/dashboard'
  }

  return `${pathname}${from?.search || ''}${from?.hash || ''}`
}

function getLoginPath(pathname?: string) {
  return pathname?.startsWith('/phone') ? '/phone/login' : '/login'
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

// Componente para la ruta de setup (primera vez)
const SetupRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, needsSetup, isLoading } = useAuth()
  const location = useLocation()
  const redirectPath = getRedirectPath((location.state as RouteLocationState)?.from)

  if (isLoading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: 'var(--color-background-primary)',
        color: 'var(--color-text-primary)'
      }}>
        Loading...
      </div>
    )
  }

  if (!needsSetup) {
    return isAuthenticated
      ? <Navigate to={redirectPath} replace />
      : <Navigate to={getLoginPath(location.pathname)} state={{ from: location }} replace />
  }

  return <>{children}</>
}

// Componente para proteger rutas que requieren autenticación
const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading, needsSetup } = useAuth()
  const location = useLocation()

  if (isLoading) {
    // Mostrar loading mientras verificamos el token
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: 'var(--color-background-primary)',
        color: 'var(--color-text-primary)'
      }}>
        Loading...
      </div>
    )
  }

  if (needsSetup) {
    return <Navigate to="/setup" state={{ from: location }} replace />
  }

  if (!isAuthenticated) {
    return <Navigate to={getLoginPath(location.pathname)} state={{ from: location }} replace />
  }

  return <>{children}</>
}

const PhoneRouteEffects: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const isPhoneRoute = location.pathname.startsWith('/phone')

  React.useEffect(() => {
    const redirectPath = getStandalonePhoneRedirect(location.pathname)
    if (!redirectPath || redirectPath === location.pathname) return
    navigate(redirectPath, { replace: true })
  }, [location.pathname, navigate])

  React.useEffect(() => {
    applyRouteBranding(location.pathname)
  }, [location.pathname])

  React.useEffect(() => {
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
    const syncPhoneViewport = () => {
      const visualViewport = window.visualViewport
      const layoutHeight = Math.max(root.clientHeight, window.innerHeight)
      const visibleHeight = visualViewport?.height ?? window.innerHeight
      const viewportTop = visualViewport?.offsetTop ?? 0
      const keyboardInset = Math.max(0, layoutHeight - visibleHeight - viewportTop)
      const roundedInset = keyboardInset > 48 ? Math.round(keyboardInset) : 0

      root.style.setProperty('--phone-visual-viewport-height', `${Math.round(visibleHeight)}px`)
      root.style.setProperty('--phone-visual-viewport-top', `${Math.round(viewportTop)}px`)
      root.style.setProperty('--phone-keyboard-inset', `${roundedInset}px`)
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

const AppWithNotifications: React.FC = () => {
  const { toasts, removeToast, modal, closeModal } = useNotification()

  return (
    <>
      <BrowserRouter>
        <PhoneRouteEffects />
        <Routes>
          <Route path="/setup" element={<SetupRoute><Setup /></SetupRoute>} />
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
                <APIDocumentation />
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
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="reports" element={<Reports />} />
            <Route path="campaigns" element={<Campaigns />} />
            <Route path="transactions" element={<Transactions />} />
            <Route path="contacts" element={<Contacts />} />
            <Route path="appointments" element={<Appointments />} />
            <Route path="sites" element={<Sites />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="settings/*" element={<Settings />} />
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
