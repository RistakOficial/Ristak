import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { Layout } from '@/components/layout/Layout'
import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { SyncProgressBar } from '@/components/common/SyncProgressBar'
import { AIAgentPanel } from '@/components/ai'
import { useAuth } from '@/contexts/AuthContext'
import { useAppConfig, useDomainFeatureSync } from '@/hooks'
import { requestAIAgentClose } from '@/utils/aiAgentEvents'
import styles from './AppShell.module.css'

const AI_AGENT_FLOATING_OPEN_KEY = 'ristak.aiAgentFloating.open'
const AI_AGENT_WIDTH_CONFIG_KEY = 'ai_agent_dock_width'
const AI_AGENT_LEGACY_WIDTH_KEY = 'ristak.aiAgentDock.width'
const AI_AGENT_MIN_WIDTH = 360
const AI_AGENT_DEFAULT_WIDTH = 640
const AI_AGENT_MAX_WIDTH = 1600
const AI_AGENT_MIN_MAIN_WIDTH = 320
const SITES_EDITOR_ACTIVE_EVENT = 'ristak-sites-editor-active'

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
    const cachedWidth = JSON.parse(window.localStorage.getItem(`rstk_config_${AI_AGENT_WIDTH_CONFIG_KEY}`) || 'null')
    const legacyWidth = Number(window.localStorage.getItem(AI_AGENT_LEGACY_WIDTH_KEY))
    const storedWidth = Number(cachedWidth || legacyWidth)
    return clampAIAgentWidth(Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : AI_AGENT_DEFAULT_WIDTH)
  } catch {
    return clampAIAgentWidth(AI_AGENT_DEFAULT_WIDTH)
  }
}

export const AppShell: React.FC = () => {
  const navigate = useNavigate()
  const { logout } = useAuth()
  const [persistedAIAgentWidth, savePersistedAIAgentWidth] = useAppConfig<number>(
    AI_AGENT_WIDTH_CONFIG_KEY,
    getInitialAIAgentWidth()
  )
  const [syncProgressVisible, setSyncProgressVisible] = useState(false)
  const [aiAgentOpen, setAIAgentOpen] = useState(getInitialAIAgentOpenState)
  const [aiAgentWidth, setAIAgentWidth] = useState(getInitialAIAgentWidth)
  const [aiAgentResizing, setAIAgentResizing] = useState(false)
  const [sitesEditorActive, setSitesEditorActive] = useState(false)
  const [sitesEditorFocusMode, setSitesEditorFocusMode] = useState(false)
  const resizePointerIdRef = useRef<number | null>(null)
  const aiAgentWidthRef = useRef(aiAgentWidth)
  const lastSavedAIAgentWidthRef = useRef(aiAgentWidth)

  // Asegurar que las configuraciones sensibles al dominio estén sincronizadas
  useDomainFeatureSync()

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
    if (syncProgressVisible && aiAgentOpen) {
      setAIAgentOpen(false)
      requestAIAgentClose()
    }
  }, [aiAgentOpen, syncProgressVisible])

  useLayoutEffect(() => {
    const handleSitesEditorActive = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean; focusMode?: boolean }>).detail
      const active = Boolean(detail?.active)
      setSitesEditorActive(active)
      setSitesEditorFocusMode(active && Boolean(detail?.focusMode))
    }

    window.addEventListener(SITES_EDITOR_ACTIVE_EVENT, handleSitesEditorActive)
    return () => window.removeEventListener(SITES_EDITOR_ACTIVE_EVENT, handleSitesEditorActive)
  }, [])

  useEffect(() => {
    if (sitesEditorActive && aiAgentOpen) {
      setAIAgentOpen(false)
      requestAIAgentClose()
    }
  }, [aiAgentOpen, sitesEditorActive])

  useEffect(() => {
    const handleResize = () => {
      setAIAgentWidth((currentWidth) => {
        const nextWidth = clampAIAgentWidth(currentWidth)
        aiAgentWidthRef.current = nextWidth
        if (nextWidth !== currentWidth) {
          lastSavedAIAgentWidthRef.current = nextWidth
          void savePersistedAIAgentWidth(nextWidth).catch(() => undefined)
        }
        return nextWidth
      })
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [savePersistedAIAgentWidth])

  useEffect(() => {
    if (aiAgentResizing) return

    const nextWidth = clampAIAgentWidth(Number(persistedAIAgentWidth) || AI_AGENT_DEFAULT_WIDTH)
    aiAgentWidthRef.current = nextWidth
    lastSavedAIAgentWidthRef.current = nextWidth
    setAIAgentWidth(nextWidth)
  }, [aiAgentResizing, persistedAIAgentWidth])

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  const handleProgressBarClose = () => {
    setSyncProgressVisible(false)
  }

  const resizeAIAgentPanel = (clientX: number) => {
    const nextWidth = clampAIAgentWidth(window.innerWidth - clientX)
    aiAgentWidthRef.current = nextWidth
    setAIAgentWidth(nextWidth)
  }

  const saveAIAgentWidth = (width: number) => {
    const nextWidth = clampAIAgentWidth(width)
    if (nextWidth === lastSavedAIAgentWidthRef.current) return

    lastSavedAIAgentWidthRef.current = nextWidth
    void savePersistedAIAgentWidth(nextWidth).catch(() => undefined)
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
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    saveAIAgentWidth(aiAgentWidthRef.current)
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

    aiAgentWidthRef.current = clampedWidth
    setAIAgentWidth(clampedWidth)
    saveAIAgentWidth(clampedWidth)
  }

  const shellStyle = {
    '--ai-agent-width': `${aiAgentWidth}px`
  } as React.CSSProperties

  return (
    <>
      {syncProgressVisible && <SyncProgressBar onClose={handleProgressBarClose} />}

      <div
        className={`${styles.shell} ${aiAgentOpen ? styles.shellWithAIAgent : ''} ${aiAgentResizing ? styles.shellResizingAIAgent : ''} ${sitesEditorFocusMode ? styles.shellSitesEditorFocus : ''}`}
        style={shellStyle}
      >
        <div className={styles.mainPane}>
          <Layout
            sidebar={<Sidebar onLogout={handleLogout} />}
          >
            <div className="flex flex-col min-h-full">
              {!sitesEditorActive && <Header />}
              <div className="flex-1 overflow-auto">
                <Outlet />
              </div>
            </div>
          </Layout>
        </div>

        {!sitesEditorActive && (
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
        )}
      </div>
    </>
  )
}
