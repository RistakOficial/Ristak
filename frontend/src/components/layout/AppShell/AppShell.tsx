import React, { useEffect, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { Layout } from '@/components/layout/Layout'
import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { SyncProgressBar } from '@/components/common/SyncProgressBar'
import { AIAgentPanel } from '@/components/ai'
import { useAuth } from '@/contexts/AuthContext'
import { useDomainFeatureSync } from '@/hooks'
import styles from './AppShell.module.css'

const AI_AGENT_FLOATING_OPEN_KEY = 'ristak.aiAgentFloating.open'

function getInitialAIAgentOpenState() {
  try {
    return window.localStorage.getItem(AI_AGENT_FLOATING_OPEN_KEY) === 'true'
  } catch {
    return false
  }
}

export const AppShell: React.FC = () => {
  const navigate = useNavigate()
  const { logout } = useAuth()
  const [syncProgressVisible, setSyncProgressVisible] = useState(false)
  const [locationName, setLocationName] = useState<string>('Mi Negocio')
  const [locationLogo, setLocationLogo] = useState<string | null>(null)
  const [aiAgentOpen, setAIAgentOpen] = useState(getInitialAIAgentOpenState)

  // Asegurar que las configuraciones sensibles al dominio estén sincronizadas
  useDomainFeatureSync()

  // Obtener nombre y logo del location de HighLevel
  useEffect(() => {
    const fetchLocationData = async () => {
      try {
        const response = await fetch('/api/integrations/status')
        const data = await response.json()
        if (data.highlevel?.locationData) {
          const locationData = data.highlevel.locationData
          if (locationData.name) {
            setLocationName(locationData.name)
          }
          if (locationData.logoUrl) {
            setLocationLogo(locationData.logoUrl)
          }
        }
      } catch (error) {
        // Silently handle error - keep default name
      }
    }

    fetchLocationData()
  }, [])

  // Detectar cuando el panel de progreso está activo
  useEffect(() => {
    const checkSyncProgress = async () => {
      try {
        const response = await fetch('/api/highlevel/sync/progress')
        const data = await response.json()
        // Solo mostrar si está sincronizando Y el origen es 'manual' (no cron)
        const isRunning = data.progress?.status === 'running' || data.progress?.status === 'syncing'
        const isManualTrigger = data.progress?.triggerSource === 'manual'

        if (isRunning && isManualTrigger) {
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
    navigate('/login', { replace: true })
  }

  const handleProgressBarClose = () => {
    setSyncProgressVisible(false)
  }

  return (
    <>
      {syncProgressVisible && <SyncProgressBar onClose={handleProgressBarClose} />}

      <div className={`${styles.shell} ${aiAgentOpen ? styles.shellWithAIAgent : ''}`}>
        <div className={styles.mainPane}>
          <Layout
            sidebar={<Sidebar locationName={locationName} locationLogo={locationLogo} />}
          >
            <div className="flex flex-col min-h-full">
              <Header onLogout={handleLogout} />
              <div className="flex-1 overflow-auto">
                <Outlet />
              </div>
            </div>
          </Layout>
        </div>

        <div className={styles.aiAgentSlot}>
          <AIAgentPanel variant="docked" onOpenChange={setAIAgentOpen} />
        </div>
      </div>
    </>
  )
}
