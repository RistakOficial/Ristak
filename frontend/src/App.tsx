import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { DateRangeProvider } from '@/contexts/DateRangeContext'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { NotificationProvider, useNotification } from '@/contexts/NotificationContext'
import { TimezoneProvider } from '@/contexts/TimezoneContext'
import { LabelsProvider } from '@/contexts/LabelsContext'
import { usePhoneTheme } from '@/hooks'
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

const PhoneThemeRouteEffects: React.FC = () => {
  usePhoneTheme({ active: true })
  return null
}

function getRedirectPath(from?: RedirectLocation) {
  const pathname = from?.pathname

  if (!pathname?.startsWith('/') || pathname === '/login' || pathname === '/setup') {
    return '/dashboard'
  }

  return `${pathname}${from?.search || ''}${from?.hash || ''}`
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
      : <Navigate to="/login" state={{ from: location }} replace />
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
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <>{children}</>
}

const PhoneRouteEffects: React.FC = () => {
  const location = useLocation()
  const isPhoneRoute = location.pathname.startsWith('/phone')

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

    return () => {
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
