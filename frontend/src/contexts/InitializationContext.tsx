import React, { createContext, useCallback, useContext, useMemo } from 'react'
import { useAppConfig, useIntegrationsStatus } from '@/hooks'
import { useAuth } from '@/contexts/AuthContext'
import type { IntegrationsStatus } from '@/services/integrationsService'
import { hasModuleAccess, type PermissionKey } from '@/utils/accessControl'

export type InitStepId =
  | 'meta'
  | 'openai'
  | 'google-calendar'

export interface InitStep {
  id: InitStepId
  /** Si el paso cuenta para considerar al usuario "dado de alta". */
  required: boolean
  /** Si el paso ya está conectado/completado. */
  done: boolean
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
  refresh: () => Promise<void>
}

const InitializationContext = createContext<InitializationContextValue | null>(null)

const STEP_PERMISSION_KEYS: Record<InitStepId, PermissionKey> = {
  meta: 'campaigns',
  openai: 'ai_agent',
  'google-calendar': 'settings_calendars'
}

function buildSteps(status: IntegrationsStatus | null): InitStep[] {
  return [
    { id: 'meta', required: true, done: Boolean(status?.meta?.connected) },
    { id: 'google-calendar', required: true, done: Boolean(status?.googleCalendar?.connected) },
    { id: 'openai', required: true, done: Boolean(status?.openai?.configured) },
  ]
}

export const InitializationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth()
  const [hidden, setHiddenConfig] = useAppConfig<boolean>('initialization_hidden', false)
  const { status, loading, refresh: refreshStatus } = useIntegrationsStatus()

  const refresh = useCallback(async () => {
    await refreshStatus()
  }, [refreshStatus])

  const steps = useMemo(
    () => buildSteps(status).filter(step => hasModuleAccess(user, STEP_PERMISSION_KEYS[step.id], 'read')),
    [status, user]
  )

  const requiredSteps = steps.filter(step => step.required)
  const requiredDone = requiredSteps.filter(step => step.done).length
  const requiredTotal = requiredSteps.length
  const allRequiredDone = requiredTotal === 0 || requiredDone === requiredTotal
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
