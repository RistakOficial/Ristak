import React, { useEffect, useRef, useState } from 'react'
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
const AI_AGENT_WIDTH_KEY = 'ristak.aiAgentDock.width'
const AI_AGENT_MIN_WIDTH = 360
const AI_AGENT_DEFAULT_WIDTH = 560
const AI_AGENT_MAX_WIDTH = 780
const AI_AGENT_MIN_MAIN_WIDTH = 560

function getInitialAIAgentOpenState() {
  try {
    return window.localStorage.getItem(AI_AGENT_FLOATING_OPEN_KEY) === 'true'
  } catch {
    return false
  }
}

function getViewportWidth() {
  return typeof window === 'undefined' ? 1440 : window.innerWidth
}

function clampAIAgentWidth(width: number, viewportWidth = getViewportWidth()) {
  const minWidth = AI_AGENT_MIN_WIDTH
  const maxByViewport = Math.max(minWidth, viewportWidth - AI_AGENT_MIN_MAIN_WIDTH)
  const maxWidth = Math.min(AI_AGENT_MAX_WIDTH, maxByViewport)

  return Math.min(Math.max(Math.round(width), minWidth), maxWidth)
}

function getInitialAIAgentWidth() {
  try {
    const storedWidth = Number(window.localStorage.getItem(AI_AGENT_WIDTH_KEY))
    return clampAIAgentWidth(Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : AI_AGENT_DEFAULT_WIDTH)
  } catch {
    return clampAIAgentWidth(AI_AGENT_DEFAULT_WIDTH)
  }
}

function saveAIAgentWidth(width: number) {
  try {
    window.localStorage.setItem(AI_AGENT_WIDTH_KEY, String(width))
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
  const [aiAgentOpen, setAIAgentOpen] = useState(getInitialAIAgentOpenState)
  const [aiAgentWidth, setAIAgentWidth] = useState(getInitialAIAgentWidth)
  const [aiAgentResizing, setAIAgentResizing] = useState(false)
  const resizePointerIdRef = useRef<number | null>(null)

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

  useEffect(() => {
    const handleResize = () => {
      setAIAgentWidth((currentWidth) => {
        const nextWidth = clampAIAgentWidth(currentWidth)
        if (nextWidth !== currentWidth) {
          saveAIAgentWidth(nextWidth)
        }
        return nextWidth
      })
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  const handleProgressBarClose = () => {
    setSyncProgressVisible(false)
  }

  const resizeAIAgentPanel = (clientX: number) => {
    const nextWidth = clampAIAgentWidth(window.innerWidth - clientX)
    setAIAgentWidth(nextWidth)
    saveAIAgentWidth(nextWidth)
  }

  const handleResizePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    resizePointerIdRef.current = event.pointerId
    setAIAgentResizing(true)
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeAIAgentPanel(event.clientX)
  }

  const handleResizePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (resizePointerIdRef.current !== event.pointerId) return
    resizeAIAgentPanel(event.clientX)
  }

  const stopResizingAIAgentPanel = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (resizePointerIdRef.current !== event.pointerId) return
    resizePointerIdRef.current = null
    setAIAgentResizing(false)
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') {
      return
    }

    event.preventDefault()

    const step = event.shiftKey ? 80 : 32
    const nextWidth = event.key === 'Home'
      ? AI_AGENT_MIN_WIDTH
      : event.key === 'End'
        ? AI_AGENT_MAX_WIDTH
        : aiAgentWidth + (event.key === 'ArrowLeft' ? step : -step)
    const clampedWidth = clampAIAgentWidth(nextWidth)

    setAIAgentWidth(clampedWidth)
    saveAIAgentWidth(clampedWidth)
  }

  return (
    <>
      {syncProgressVisible && <SyncProgressBar onClose={handleProgressBarClose} />}

      <div
        className={`${styles.shell} ${aiAgentOpen ? styles.shellWithAIAgent : ''} ${aiAgentResizing ? styles.shellResizingAIAgent : ''}`}
        style={{ '--ai-agent-width': `${aiAgentWidth}px` } as React.CSSProperties}
      >
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
          {aiAgentOpen && (
            <button
              type="button"
              className={styles.aiAgentResizeHandle}
              onPointerDown={handleResizePointerDown}
              onPointerMove={handleResizePointerMove}
              onPointerUp={stopResizingAIAgentPanel}
              onPointerCancel={stopResizingAIAgentPanel}
              onKeyDown={handleResizeKeyDown}
              role="slider"
              aria-label="Cambiar ancho del chat"
              aria-orientation="horizontal"
              aria-valuemin={AI_AGENT_MIN_WIDTH}
              aria-valuemax={AI_AGENT_MAX_WIDTH}
              aria-valuenow={aiAgentWidth}
              title="Arrastra para cambiar el ancho del chat"
            />
          )}
          <AIAgentPanel variant="docked" onOpenChange={setAIAgentOpen} />
        </div>
      </div>
    </>
  )
}
