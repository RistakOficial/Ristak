import React, { useEffect, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { Bot, ChevronLeft } from 'lucide-react'
import { Layout } from '@/components/layout/Layout'
import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { SyncProgressBar } from '@/components/common/SyncProgressBar'
import { TestModeBanner } from '@/components/common/TestModeBanner'
import { AIAgentPanel } from '@/components/ai'
import { useAuth } from '@/contexts/AuthContext'
import { useDomainFeatureSync } from '@/hooks'
import { aiAgentService, type AIAgentConfigStatus } from '@/services/aiAgentService'
import styles from './AppShell.module.css'

const AI_AGENT_PANEL_VISIBLE_KEY = 'ristak.aiAgentPanel.visible'

function getStoredAIAgentPanelVisible() {
  try {
    return window.localStorage.getItem(AI_AGENT_PANEL_VISIBLE_KEY) !== 'false'
  } catch {
    return true
  }
}

function saveAIAgentPanelVisible(visible: boolean) {
  try {
    window.localStorage.setItem(AI_AGENT_PANEL_VISIBLE_KEY, String(visible))
  } catch {
    // localStorage can fail in private or restricted browser contexts.
  }
}

export const AppShell: React.FC = () => {
  const navigate = useNavigate()
  const { logout } = useAuth()
  const [syncProgressVisible, setSyncProgressVisible] = useState(false)
  const [locationName, setLocationName] = useState<string>('Mi Negocio')
  const [locationLogo, setLocationLogo] = useState<string | null>(null)
  const [aiAgentConfigured, setAiAgentConfigured] = useState(false)
  const [aiAgentPanelVisible, setAiAgentPanelVisible] = useState(getStoredAIAgentPanelVisible)

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

  useEffect(() => {
    let mounted = true

    const loadAIAgentStatus = async () => {
      try {
        const status = await aiAgentService.getConfig()
        if (mounted) {
          setAiAgentConfigured(Boolean(status.configured))
        }
      } catch {
        if (mounted) {
          setAiAgentConfigured(false)
        }
      }
    }

    const handleConfigChange = (event: Event) => {
      const customEvent = event as CustomEvent<AIAgentConfigStatus>
      setAiAgentConfigured(Boolean(customEvent.detail?.configured))
    }

    loadAIAgentStatus()
    window.addEventListener('ai-agent-config-changed', handleConfigChange)

    return () => {
      mounted = false
      window.removeEventListener('ai-agent-config-changed', handleConfigChange)
    }
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

  const setAIAgentPanelVisibility = (visible: boolean) => {
    setAiAgentPanelVisible(visible)
    saveAIAgentPanelVisible(visible)
  }

  const showAIAgentPanelToggle = aiAgentConfigured && !aiAgentPanelVisible

  return (
    <>
      {syncProgressVisible && <SyncProgressBar onClose={handleProgressBarClose} />}

      <div className="relative transition-all duration-300 ease-in-out">
        <Layout
          sidebar={<Sidebar locationName={locationName} locationLogo={locationLogo} />}
          rightSidebar={aiAgentConfigured && aiAgentPanelVisible ? (
            <AIAgentPanel onCollapse={() => setAIAgentPanelVisibility(false)} />
          ) : undefined}
        >
          <div className="flex flex-col min-h-full">
            <TestModeBanner />
            <Header onLogout={handleLogout} />
            <div className="flex-1 overflow-auto">
              <Outlet />
            </div>
          </div>
        </Layout>

        {showAIAgentPanelToggle && (
          <button
            type="button"
            className={styles.aiAgentToggle}
            onClick={() => setAIAgentPanelVisibility(true)}
            aria-label="Mostrar agente AI"
            title="Mostrar agente AI"
          >
            <ChevronLeft size={18} />
            <Bot size={18} />
          </button>
        )}
      </div>
    </>
  )
}
