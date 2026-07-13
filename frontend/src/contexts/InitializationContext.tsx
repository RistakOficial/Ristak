import React, { createContext, useCallback, useContext, useMemo } from 'react'
import { useAppConfig, useIntegrationsStatus } from '@/hooks'
import type { IntegrationsStatus } from '@/services/integrationsService'

export type InitStepId =
  | 'facebook-page'
  | 'instagram'
  | 'ad-account'
  | 'pixel'
  | 'whatsapp'
  | 'meta-app'
  | 'meta-connect'
  | 'whatsapp-api'
  | 'openai'
  | 'google-calendar'

export interface InitStep {
  id: InitStepId
  /** Si el paso cuenta para considerar al usuario "dado de alta". */
  required: boolean
  /** Si el paso ya está conectado/completado. */
  done: boolean
  /** Paso manual: el usuario lo marca a mano (no hay señal técnica). */
  manual?: boolean
}

interface InitializationContextValue {
  loading: boolean
  status: IntegrationsStatus | null
  steps: InitStep[]
  /** El usuario completó los pasos requeridos o pulsó "Ocultar". */
  isInitialized: boolean
  /** Cuántos pasos requeridos están completos / total requeridos. */
  requiredDone: number
  requiredTotal: number
  hidden: boolean
  setHidden: (value: boolean) => Promise<void>
  metaAppDone: boolean
  setMetaAppDone: (value: boolean) => Promise<void>
  refresh: () => Promise<void>
}

const InitializationContext = createContext<InitializationContextValue | null>(null)

function buildSteps(status: IntegrationsStatus | null, metaAppDone: boolean): InitStep[] {
  const meta = status?.meta
  return [
    { id: 'facebook-page', required: true, done: Boolean(meta?.pageId) },
    { id: 'instagram', required: false, done: Boolean(meta?.instagramAccountId) },
    { id: 'ad-account', required: true, done: Boolean(meta?.adAccountId) },
    { id: 'pixel', required: true, done: Boolean(meta?.pixelId) },
    { id: 'whatsapp', required: true, done: Boolean(status?.whatsapp?.connected) },
    { id: 'meta-app', required: false, done: metaAppDone, manual: true },
    { id: 'meta-connect', required: true, done: Boolean(meta?.connected) },
    { id: 'whatsapp-api', required: true, done: Boolean(status?.whatsapp?.connected && meta?.connected) },
    { id: 'openai', required: true, done: Boolean(status?.openai?.configured) },
    { id: 'google-calendar', required: false, done: Boolean(status?.googleCalendar?.connected) }
  ]
}

export const InitializationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [hidden, setHiddenConfig] = useAppConfig<boolean>('initialization_hidden', false)
  const [metaAppDone, setMetaAppDoneConfig] = useAppConfig<boolean>('init_meta_app_done', false)
  const { status, loading, refresh: refreshStatus } = useIntegrationsStatus()

  const refresh = useCallback(async () => {
    await refreshStatus()
  }, [refreshStatus])

  const steps = useMemo(() => buildSteps(status, Boolean(metaAppDone)), [status, metaAppDone])

  const requiredSteps = steps.filter(step => step.required)
  const requiredDone = requiredSteps.filter(step => step.done).length
  const requiredTotal = requiredSteps.length
  const allRequiredDone = requiredTotal > 0 && requiredDone === requiredTotal
  const isInitialized = Boolean(hidden) || allRequiredDone

  const value: InitializationContextValue = {
    loading,
    status,
    steps,
    isInitialized,
    requiredDone,
    requiredTotal,
    hidden: Boolean(hidden),
    setHidden: (v: boolean) => setHiddenConfig(v),
    metaAppDone: Boolean(metaAppDone),
    setMetaAppDone: (v: boolean) => setMetaAppDoneConfig(v),
    refresh
  }

  return (
    <InitializationContext.Provider value={value}>
      {children}
    </InitializationContext.Provider>
  )
}

export function useInitialization(): InitializationContextValue {
  const ctx = useContext(InitializationContext)
  if (!ctx) {
    throw new Error('useInitialization debe usarse dentro de InitializationProvider')
  }
  return ctx
}
