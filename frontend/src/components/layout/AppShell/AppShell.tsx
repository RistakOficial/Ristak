import React, { useEffect, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { Layout } from '@/components/layout/Layout'
import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { SyncProgressBar } from '@/components/common/SyncProgressBar'
import { useAuth } from '@/contexts/AuthContext'

export const AppShell: React.FC = () => {
  const navigate = useNavigate()
  const { logout } = useAuth()
  const [syncProgressVisible, setSyncProgressVisible] = useState(false)
  const [locationName, setLocationName] = useState<string>('Ristak')

  // Obtener nombre del location de HighLevel
  useEffect(() => {
    const fetchLocationName = async () => {
      try {
        const response = await fetch('/api/integrations/status')
        const data = await response.json()
        if (data.highlevel?.locationData?.name) {
          setLocationName(data.highlevel.locationData.name)
        }
      } catch (error) {
        // Silently handle error - keep default name
      }
    }

    fetchLocationName()
  }, [])

  // Detectar cuando el panel de progreso está activo
  useEffect(() => {
    const checkSyncProgress = async () => {
      try {
        const response = await fetch('/api/highlevel/sync/progress')
        const data = await response.json()
        // Solo mostrar cuando realmente está sincronizando
        if (data.progress?.status === 'running' || data.progress?.status === 'syncing') {
          setSyncProgressVisible(true)
        } else {
          setSyncProgressVisible(false)
        }
      } catch (error) {
        // Silently handle error
        setSyncProgressVisible(false)
      }
    }

    // Check initially and every 2 seconds
    checkSyncProgress()
    const interval = setInterval(checkSyncProgress, 2000)

    return () => clearInterval(interval)
  }, [])

  const handleLogout = () => {
    logout()
    navigate('/dashboard', { replace: true })
  }

  const handleProgressBarClose = () => {
    setSyncProgressVisible(false)
  }

  return (
    <>
      {syncProgressVisible && <SyncProgressBar onClose={handleProgressBarClose} />}

      <div className="relative transition-all duration-300 ease-in-out">
        <Layout sidebar={<Sidebar locationName={locationName} />}>
          <div className="flex flex-col min-h-full">
            <Header onLogout={handleLogout} />
            <div className="flex-1 overflow-auto">
              <Outlet />
            </div>
          </div>
        </Layout>
      </div>
    </>
  )
}
