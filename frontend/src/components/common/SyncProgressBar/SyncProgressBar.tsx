import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CalendarCheck2,
  CheckCircle2,
  Clock,
  CreditCard,
  Loader2,
  Megaphone,
  Users,
  X
} from 'lucide-react'
import { cn } from '@/utils/cn'

type SyncStatus = 'idle' | 'syncing' | 'running' | 'completed' | 'error'

interface SyncProgress {
  status: SyncStatus
  step: string
  total: number
  current: number
  message: string
  triggerSource?: 'manual' | 'cron'
  contacts: SyncModuleProgress
  appointments: SyncModuleProgress
  payments: SyncModuleProgress
  metaAds?: SyncModuleProgress & { synced?: boolean; count?: number }
}

type SyncModuleProgress = {
  saved: number
  total: number
  status: string
  message: string
}

interface SyncProgressBarProps {
  onClose?: () => void
}

type StepKey = 'contacts' | 'appointments' | 'payments' | 'metaAds'
type StepState = 'pending' | 'active' | 'completed' | 'error'

type StatusMeta = {
  label: string
  tone: 'success' | 'error' | 'running' | 'pending'
  accentColor: string
  icon: typeof CheckCircle2
  iconClass?: string
}

type StepConfig = {
  key: StepKey
  label: string
  icon: typeof Users
  description: string
}

type StepData = {
  key: StepKey
  label: string
  Icon: typeof Users
  description: string
  saved: number
  total: number
  rawTotal: number
  percent: number
  state: StepState
  statusLabel: string
}

const STEP_CONFIGS: StepConfig[] = [
  {
    key: 'contacts',
    label: 'Contactos',
    icon: Users,
    description: 'Actualizando perfiles y detalles de clientes'
  },
  {
    key: 'appointments',
    label: 'Citas',
    icon: CalendarCheck2,
    description: 'Sincronizando historial y horarios'
  },
  {
    key: 'payments',
    label: 'Pagos',
    icon: CreditCard,
    description: 'Integrando transacciones recientes'
  },
  {
    key: 'metaAds',
    label: 'Meta Ads',
    icon: Megaphone,
    description: 'Importando métricas publicitarias'
  }
]

const STEP_STYLE_MAP: Record<StepState, { container: string; progress: string; icon: string; status: string }> = {
  completed: {
    container: 'border-[#10b98133] bg-[#10b98114] text-[var(--color-text-primary)]',
    progress: 'bg-[#10b981]',
    icon: 'bg-[#10b9811f] text-[#10b981]',
    status: 'text-[#10b981]'
  },
  active: {
    container: 'border-[#64748b33] bg-[#64748b14] text-[var(--color-text-primary)]',
    progress: 'bg-[#64748b]',
    icon: 'bg-[#64748b12] text-[#64748b]',
    status: 'text-[#64748b]'
  },
  error: {
    container: 'border-[#dc262633] bg-[#dc262614] text-[var(--color-text-primary)]',
    progress: 'bg-[#dc2626]',
    icon: 'bg-[#dc262612] text-[#dc2626]',
    status: 'text-[#dc2626]'
  },
  pending: {
    container: 'border-[rgba(148,163,184,0.24)] bg-[rgba(148,163,184,0.08)] text-[var(--color-text-secondary)]',
    progress: 'bg-[rgba(148,163,184,0.35)]',
    icon: 'bg-[rgba(148,163,184,0.15)] text-[var(--color-text-tertiary)]',
    status: 'text-[var(--color-text-tertiary)]'
  }
}

export const SyncProgressBar: React.FC<SyncProgressBarProps> = ({ onClose }) => {
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [isVisible, setIsVisible] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>
    let timeoutId: ReturnType<typeof setTimeout>

    const fetchProgress = async () => {
      try {
        const response = await fetch('/api/highlevel/sync/progress')
        const data = await response.json()

        setProgress((previous) => {
          const incoming: SyncProgress | undefined = data.progress
          const status = incoming?.status?.toLowerCase() as SyncStatus | undefined
          const triggerSource = incoming?.triggerSource || 'manual'

          // Solo mostrar si es una sincronización manual (no cron)
          if ((status === 'running' || status === 'syncing') && triggerSource === 'manual') {
            setIsVisible(true)
            setLastUpdated(Date.now())
            return incoming || null
          }

          if (status === 'completed' || status === 'error') {
            setIsVisible(true)
            setLastUpdated(Date.now())

            if (previous?.status === 'running' || previous?.status === 'syncing') {
              timeoutId = setTimeout(() => {
                handleClose()
              }, 3000)
            }

            return incoming || null
          }

          if (status === 'idle') {
            handleClose()
            return null
          }

          return previous
        })
      } catch (error) {
        // Silenciar errores de polling
      }
    }

    interval = setInterval(fetchProgress, 600)
    fetchProgress()

    return () => {
      clearInterval(interval)
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [])

  const handleClose = () => {
    setIsClosing(true)
    setTimeout(() => {
      setIsVisible(false)
      setProgress(null)
      setIsClosing(false)
      onClose?.()
    }, 250)
  }

  const statusInfo = useMemo<StatusMeta>(() => {
    const normalized = progress?.status?.toLowerCase()

    if (normalized === 'completed') {
      return {
        label: 'Sincronización completada',
        tone: 'success',
        accentColor: '#10b981',
        icon: CheckCircle2
      }
    }

    if (normalized === 'error') {
      return {
        label: 'Sincronización con errores',
        tone: 'error',
        accentColor: '#dc2626',
        icon: AlertCircle
      }
    }

    if (normalized === 'running' || normalized === 'syncing') {
      return {
        label: 'Sincronizando con HighLevel',
        tone: 'running',
        accentColor: '#64748b',
        icon: Loader2,
        iconClass: 'animate-spin'
      }
    }

    return {
      label: 'Sincronización en espera',
      tone: 'pending',
      accentColor: '#64748b',
      icon: Clock
    }
  }, [progress?.status])

  const { steps, overallPercent, completedSteps } = useMemo(() => {
    if (!progress) {
      return { steps: [] as StepData[], overallPercent: 0, completedSteps: 0 }
    }

    const normalizeStepState = (moduleStatus: string | undefined, saved: number, total: number): StepState => {
      const normalized = moduleStatus?.toLowerCase() || ''
      if (['completed', 'complete', 'done', 'success', 'finished'].includes(normalized)) return 'completed'
      if (['error', 'failed', 'fail'].includes(normalized)) return 'error'
      if (['running', 'syncing', 'processing', 'in_progress', 'active'].includes(normalized)) return 'active'
      if (progress.status === 'completed') return 'completed'
      if (total > 0 && saved >= total) return 'completed'
      if (saved > 0) return 'active'
      return 'pending'
    }

    const resolvedSteps = STEP_CONFIGS
      .map<StepData | null>((config) => {
        const moduleData = progress[config.key as keyof SyncProgress] as SyncModuleProgress | undefined
        if (config.key === 'metaAds' && !moduleData) {
          return null
        }

        const saved = moduleData?.saved ?? (moduleData as any)?.count ?? 0
        const totalRaw = moduleData?.total ?? 0
        const effectiveTotal = totalRaw > 0 ? totalRaw : progress.status === 'completed' ? Math.max(saved, 1) : totalRaw
        const state = normalizeStepState(moduleData?.status, saved, effectiveTotal)
        const percent = effectiveTotal > 0
          ? Math.min(100, Math.round((saved / effectiveTotal) * 100))
          : state === 'completed'
            ? 100
            : 0

        return {
          key: config.key,
          label: config.label,
          Icon: config.icon,
          description: moduleData?.message || config.description,
          saved,
          total: effectiveTotal,
          rawTotal: totalRaw,
          percent,
          state,
          statusLabel: moduleData?.status === 'running' ? 'En progreso' : moduleData?.status === 'completed' ? 'Completado' : moduleData?.status === 'syncing' ? 'Sincronizando' : state === 'completed' ? 'Completado' : state === 'active' ? 'En progreso' : 'Pendiente'
        }
      })
      .filter(Boolean) as StepData[]

    const totals = resolvedSteps.reduce(
      (acc, step) => {
        return {
          targets: acc.targets + (step.total || 0),
          saved: acc.saved + Math.min(step.saved, step.total || step.saved),
          completed: acc.completed + (step.state === 'completed' ? 1 : 0)
        }
      },
      { targets: 0, saved: 0, completed: 0 }
    )

    const overall = progress.status === 'completed'
      ? 100
      : totals.targets > 0
        ? Math.min(100, Math.round((totals.saved / totals.targets) * 100))
        : resolvedSteps.length > 0
          ? Math.round((totals.completed / resolvedSteps.length) * 100)
          : 0

    return {
      steps: resolvedSteps,
      overallPercent: overall,
      completedSteps: totals.completed
    }
  }, [progress])

  const currentStep = useMemo(
    () => steps.find((step) => step.state === 'active') || steps.find((step) => step.state === 'pending'),
    [steps]
  )

  const formattedTime = useMemo(() => {
    if (!lastUpdated) return null

    try {
      return new Intl.DateTimeFormat('es-MX', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).format(lastUpdated)
    } catch (error) {
      return new Date(lastUpdated).toLocaleTimeString()
    }
  }, [lastUpdated])

  const formatNumber = (value?: number) =>
    typeof value === 'number' ? value.toLocaleString('es-MX') : '0'

  const containerClasses = cn(
    'fixed top-[var(--header-height)] bottom-0 right-0 z-[1200] w-full sm:w-[480px] transition-all duration-300',
    isClosing ? 'translate-x-full opacity-0' : 'translate-x-0 opacity-100'
  )

  if (!isVisible || !progress) {
    return null
  }

  const StatusIcon = statusInfo.icon

  return (
    <div className={containerClasses}>
      <div className="h-full flex flex-col">
        <div className="relative overflow-y-auto flex-1 glass border-l border-[rgba(148,163,184,0.18)] dark:shadow-[-20px_0_60px_-15px_rgba(15,23,42,0.45)] backdrop-blur-xl">
          <span
            className="absolute inset-y-0 left-0 w-1"
            style={{ background: statusInfo.accentColor }}
          />

          <div className="relative z-10 flex flex-col gap-6 p-5 sm:p-6">
            <div className="flex flex-col gap-4">
              <div className="flex items-start justify-start">
                <span
                  className="inline-flex w-max items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.32em]"
                  style={{
                    color: statusInfo.accentColor,
                    borderColor: statusInfo.accentColor,
                    background: `color-mix(in srgb, ${statusInfo.accentColor} 12%, transparent)`
                  }}
                >
                  Estado
                </span>
              </div>

              <div className="space-y-2">
                <h2 className="text-xl font-semibold text-[var(--color-text-primary)]">Integración HighLevel</h2>
                <p className="text-sm text-[var(--color-text-tertiary)]">
                  {progress.message || 'Sincronizando información en tiempo real para mantener tu panel al día.'}
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <div
                  className="inline-flex w-max items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium"
                  style={{
                    color: statusInfo.accentColor,
                    borderColor: statusInfo.accentColor,
                    background: `color-mix(in srgb, ${statusInfo.accentColor} 18%, transparent)`
                  }}
                >
                  <StatusIcon className={cn('h-4 w-4', statusInfo.iconClass)} />
                  <span>{statusInfo.label}</span>
                </div>

                {formattedTime && (
                  <div className="inline-flex w-max rounded-full border border-[rgba(148,163,184,0.18)] bg-[rgba(148,163,184,0.08)] px-3 py-1 text-xs text-[var(--color-text-tertiary)]">
                    Actualizado: {formattedTime}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-4 rounded-2xl border border-[rgba(148,163,184,0.14)] bg-[rgba(148,163,184,0.06)] p-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">Avance global</span>
                  <span className="text-3xl font-semibold text-[var(--color-text-primary)]">{overallPercent}%</span>
                </div>
                <div className="text-sm text-[var(--color-text-tertiary)]">
                  {completedSteps} de {steps.length} módulos listos
                </div>
              </div>

              <div className="relative h-2 w-full overflow-hidden rounded-full bg-[rgba(148,163,184,0.18)]">
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
                  style={{ width: `${overallPercent}%`, background: statusInfo.accentColor }}
                />
              </div>

              {currentStep && (
                <div className="flex items-center justify-between text-sm text-[var(--color-text-secondary)]">
                  <span>{currentStep.state === 'completed' ? `${currentStep.label} sincronizados` : `En curso: ${currentStep.label}`}</span>
                  <span>{currentStep.percent}%</span>
                </div>
              )}
            </div>

            <div className="grid gap-4 grid-cols-1">
              {steps.map((step) => {
                const style = STEP_STYLE_MAP[step.state]
                const StepIcon = step.Icon

                return (
                  <div
                    key={step.key}
                    className={cn(
                      'flex h-full flex-col gap-3 rounded-xl border px-4 py-4 transition-colors duration-200',
                      style.container
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className={cn('flex h-10 w-10 items-center justify-center rounded-xl', style.icon)}>
                          <StepIcon className="h-5 w-5" />
                        </div>
                        <div>
                          <div className="text-sm font-semibold text-[var(--color-text-primary)]">{step.label}</div>
                          <div className={cn('text-xs font-medium uppercase tracking-[0.18em]', style.status)}>{step.statusLabel}</div>
                        </div>
                      </div>
                      <div className="text-right">
                        {step.total > 0 ? (
                          <div className="text-sm font-semibold text-[var(--color-text-primary)]">
                            {formatNumber(step.saved)}
                            <span className="ml-1 text-xs text-[var(--color-text-tertiary)]">de {formatNumber(step.total)}</span>
                          </div>
                        ) : (
                          <div className="text-sm font-semibold text-[var(--color-text-primary)]">{formatNumber(step.saved)}</div>
                        )}
                      </div>
                    </div>

                    <div className="h-2 w-full overflow-hidden rounded-full bg-[rgba(148,163,184,0.14)]">
                      <div
                        className={cn('h-full rounded-full transition-all duration-500', style.progress)}
                        style={{ width: `${step.percent}%` }}
                      />
                    </div>

                    <div className="flex items-start justify-between text-xs text-[var(--color-text-secondary)]">
                      <span className="max-w-[75%] leading-relaxed">{step.description || 'Sin novedades en este módulo.'}</span>
                      <span className="font-semibold text-[var(--color-text-primary)]">{step.percent}%</span>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="flex items-center gap-3 rounded-2xl border border-[rgba(148,163,184,0.14)] bg-[rgba(148,163,184,0.05)] px-4 py-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[rgba(148,163,184,0.12)] text-[var(--color-text-primary)]">
                {progress.status === 'error' ? (
                  <AlertCircle className="h-5 w-5 text-[#dc2626]" />
                ) : (
                  <Loader2 className="h-5 w-5 text-[var(--color-primary)] animate-spin" />
                )}
              </div>
              <div>
                <div className="text-sm font-semibold text-[var(--color-text-primary)]">Actividad en vivo</div>
                <div className="text-xs text-[var(--color-text-secondary)]">
                  {progress.step || 'Preparando sincronización...'}
                </div>
              </div>
              <div className="ml-auto text-xs text-[var(--color-text-tertiary)] max-w-md">
                {progress.message || 'Procesando datos desde HighLevel y actualizando la base de Ristak.'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
