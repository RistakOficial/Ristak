import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { Layout } from '@/components/layout/Layout'
import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { SyncProgressBar } from '@/components/common/SyncProgressBar'
import { Loading } from '@/components/common/Loading'
import { useAuth } from '@/contexts/AuthContext'
import { InitializationProvider } from '@/contexts/InitializationContext'
import { useAppConfig, useDomainFeatureSync, useIntegrationsStatus } from '@/hooks'
import { hasLicenseFeature, hasModuleAccess } from '@/utils/accessControl'
import { isHighLevelSyncProgressPollingAllowed } from '@/utils/highLevelSyncProgress'
import { apiUrl } from '@/services/apiBaseUrl'
import { HIGHLEVEL_SYNC_STARTED_EVENT } from '@/services/highLevelService'
import styles from './AppShell.module.css'

const SIDEBAR_COLLAPSED_CONFIG_KEY = 'sidebar_collapsed'
const SITES_EDITOR_ACTIVE_EVENT = 'ristak-sites-editor-active'

export const AppShell: React.FC = () => {
  const navigate = useNavigate()
  const { logout, user } = useAuth()
  const [persistedSidebarCollapsed, savePersistedSidebarCollapsed] = useAppConfig<boolean>(
    SIDEBAR_COLLAPSED_CONFIG_KEY,
    false
  )
  const [syncProgressVisible, setSyncProgressVisible] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(persistedSidebarCollapsed)
  const [sitesEditorActive, setSitesEditorActive] = useState(false)
  const hasHighLevelSyncProgressFeature = hasLicenseFeature(user, ['highlevel_integration'])
  const hasHighLevelSyncProgressPermission = hasModuleAccess(user, 'settings_integrations', 'read')
  const canAccessHighLevelSyncProgress = hasHighLevelSyncProgressFeature && hasHighLevelSyncProgressPermission
  const { status: integrationsStatus } = useIntegrationsStatus({ enabled: canAccessHighLevelSyncProgress })
  const highLevelSyncProgressPollingAllowed = isHighLevelSyncProgressPollingAllowed({
    hasFeature: hasHighLevelSyncProgressFeature,
    hasPermission: hasHighLevelSyncProgressPermission,
    connected: Boolean(integrationsStatus?.highlevel?.connected)
  })
  const highLevelSyncProgressPollingWasAllowedRef = useRef(false)

  // Asegurar que las configuraciones sensibles al dominio estén sincronizadas
  useDomainFeatureSync()

  // El caso normal no necesita polling: la sincronización manual publica este
  // evento en la misma pestaña.
  useEffect(() => {
    const handleSyncStarted = () => setSyncProgressVisible(true)
    window.addEventListener(HIGHLEVEL_SYNC_STARTED_EVENT, handleSyncStarted)
    return () => window.removeEventListener(HIGHLEVEL_SYNC_STARTED_EVENT, handleSyncStarted)
  }, [])

  // Una pestaña distinta todavía necesita un respaldo lento, pero sólo cuando
  // la licencia, el permiso y la conexión coinciden con el contrato del backend.
  useEffect(() => {
    if (!highLevelSyncProgressPollingAllowed) return undefined

    let cancelled = false
    let pollingDisabled = false
    let activeController: AbortController | null = null
    let interval: number | null = null

    const stopPolling = () => {
      pollingDisabled = true
      if (interval !== null) {
        window.clearInterval(interval)
        interval = null
      }
    }

    const checkSyncProgress = async () => {
      if (cancelled || pollingDisabled || activeController) return
      const controller = new AbortController()
      activeController = controller

      try {
        const response = await fetch(apiUrl('/api/highlevel/sync/progress'), {
          signal: controller.signal
        })
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          stopPolling()
          return
        }
        if (!response.ok) return

        const data = await response.json()
        if (cancelled) return
        // Solo mostrar si está sincronizando Y el origen es 'manual' (no cron)
        const isRunning = data.progress?.status === 'running' || data.progress?.status === 'syncing'
        const isManualTrigger = data.progress?.triggerSource === 'manual'

        if (isRunning && isManualTrigger) {
          setSyncProgressVisible(true)
        }
      } catch (error) {
        // Silencioso: la barra simplemente no se muestra
      } finally {
        if (activeController === controller) activeController = null
      }
    }

    void checkSyncProgress()
    interval = window.setInterval(() => {
      void checkSyncProgress()
    }, 30000)

    return () => {
      cancelled = true
      activeController?.abort()
      if (interval !== null) window.clearInterval(interval)
    }
  }, [highLevelSyncProgressPollingAllowed])

  useEffect(() => {
    const wasAllowed = highLevelSyncProgressPollingWasAllowedRef.current
    highLevelSyncProgressPollingWasAllowedRef.current = highLevelSyncProgressPollingAllowed
    if (wasAllowed && !highLevelSyncProgressPollingAllowed) {
      setSyncProgressVisible(false)
    }
  }, [highLevelSyncProgressPollingAllowed])

  useLayoutEffect(() => {
    const handleSitesEditorActive = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean }>).detail
      const active = Boolean(detail?.active)
      setSitesEditorActive(active)
    }

    window.addEventListener(SITES_EDITOR_ACTIVE_EVENT, handleSitesEditorActive)
    return () => window.removeEventListener(SITES_EDITOR_ACTIVE_EVENT, handleSitesEditorActive)
  }, [])

  useEffect(() => {
    setSidebarCollapsed(Boolean(persistedSidebarCollapsed))
  }, [persistedSidebarCollapsed])

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  const handleSidebarCollapsedChange = (nextCollapsed: boolean) => {
    setSidebarCollapsed(nextCollapsed)
    void savePersistedSidebarCollapsed(nextCollapsed).catch(() => undefined)
  }

  const handleProgressBarClose = () => {
    setSyncProgressVisible(false)
  }

  return (
    <InitializationProvider>
      {syncProgressVisible && <SyncProgressBar onClose={handleProgressBarClose} />}

      <div
        className={`${styles.shell} ${syncProgressVisible ? styles.shellWithSyncBar : ''}`}
      >
        <div className={styles.mainPane}>
          <Layout
            sidebarCollapsed={sidebarCollapsed}
            sidebar={
              <Sidebar
                collapsed={sidebarCollapsed}
                onCollapsedChange={handleSidebarCollapsedChange}
                onLogout={handleLogout}
              />
            }
          >
            <div className="flex h-full min-h-0 flex-col">
              {!sitesEditorActive && <Header />}
              <div className={`${styles.contentScroller} min-h-0 flex-1 overflow-auto`}>
                <div className={styles.routeContentReady}>
                  <React.Suspense fallback={<Loading message="Abriendo módulo..." size="md" />}>
                    <Outlet />
                  </React.Suspense>
                </div>
              </div>
            </div>
          </Layout>
        </div>

      </div>
    </InitializationProvider>
  )
}
