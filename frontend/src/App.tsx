import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { DateRangeProvider } from '@/contexts/DateRangeContext'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { NotificationProvider, useNotification } from '@/contexts/NotificationContext'
import { TimezoneProvider } from '@/contexts/TimezoneContext'
import { LabelsProvider } from '@/contexts/LabelsContext'
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
import { PhoneAgentChat } from '@/pages/PhoneAgentChat'
import { Login } from '@/pages/Login'
import { Setup } from '@/pages/Login/Setup'
import { ToastContainer } from '@/components/common/Toast'
import { Modal } from '@/components/common/Modal'
import { StorageAlert } from '@/components/common/StorageAlert'

// Componente para la ruta de setup (primera vez)
const SetupRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { needsSetup, isLoading } = useAuth()
  const location = useLocation()

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
        Cargando...
      </div>
    )
  }

  if (!needsSetup) {
    return <Navigate to="/login" state={{ from: location }} replace />
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
        Cargando...
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

const AppWithNotifications: React.FC = () => {
  const { toasts, removeToast, modal, closeModal } = useNotification()

  return (
    <>
      <BrowserRouter>
        <Routes>
          <Route path="/setup" element={<SetupRoute><Setup /></SetupRoute>} />
          <Route path="/login" element={<Login />} />
          <Route
            path="/phone/agent-chat"
            element={
              <ProtectedRoute>
                <PhoneAgentChat />
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
            <Route path="analytics" element={<Analytics />} />
            <Route path="settings/*" element={<Settings />} />
          </Route>
        </Routes>
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
