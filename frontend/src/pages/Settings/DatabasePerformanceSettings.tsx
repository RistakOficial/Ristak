import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpRight,
  Cpu,
  Database,
  ExternalLink,
  Gauge,
  RefreshCw
} from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  Loading,
  Modal,
  PageHeader,
  SegmentTabs,
  SelectionGrid
} from '@/components/common'
import type { SegmentTab, SelectionGridOption } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { useAccountCurrency } from '@/hooks'
import { apiUrl } from '@/services/apiBaseUrl'
import { formatCurrency } from '@/utils/format'
import pageStyles from './Settings.module.css'
import styles from './DatabasePerformanceSettings.module.css'

type PerformanceTier = 'basic' | 'pro' | 'accelerated'
type OperationStatus = 'processing' | 'completed' | 'failed'

interface PerformancePlan {
  id: string
  label: string
  tier: PerformanceTier
  memory_mb: number
  cpu: number
  connections: number
  monthly_usd: number
  monthly_account_currency: number
  current: boolean
  selectable: boolean
  disabled_reason: string | null
}

interface PerformanceOperation {
  id: string
  status: OperationStatus
  previous_plan: string
  target_plan: string
  account_currency: string
  previous_monthly_usd: number
  target_monthly_usd: number
  previous_monthly_account_currency: number
  target_monthly_account_currency: number
  exchange_rate: number
  operation_error: string | null
}

interface DatabasePerformanceStatus {
  success: boolean
  managed: boolean
  management_available: boolean
  management_message?: string
  account_currency: string
  billing_currency: 'USD'
  quote_current: boolean
  pricing?: {
    current: boolean
    source_url: string
    error?: string | null
  }
  exchange_rate?: {
    rate: number
    current: boolean
    attribution_url?: string | null
    updated_at?: string | null
    error?: string | null
  }
  postgres?: {
    status: string
    current_plan: string
    current: PerformancePlan | null
    high_availability_enabled: boolean
  }
  plans: PerformancePlan[]
  operation: PerformanceOperation | null
  downtime_notice?: string
}

const TIER_TABS: SegmentTab[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'pro', label: 'Pro' },
  { id: 'accelerated', label: 'Acelerada' }
]

const getAuthHeaders = () => {
  const token = localStorage.getItem('auth_token')
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

const formatMemory = (memoryMb: number) => {
  if (memoryMb < 1024) return `${memoryMb} MB`
  const memoryGb = memoryMb / 1024
  if (memoryGb >= 1024) return `${memoryGb / 1024} TB`
  return `${memoryGb} GB`
}

const formatCpu = (cpu: number) => `${cpu} CPU`

const planPriceDelta = (plan: PerformancePlan, current?: PerformancePlan | null) => {
  if (!current) return null
  return plan.monthly_account_currency - current.monthly_account_currency
}

export const DatabasePerformanceSettings: React.FC = () => {
  const { showToast } = useNotification()
  const [configuredCurrency] = useAccountCurrency()
  const [status, setStatus] = useState<DatabasePerformanceStatus | null>(null)
  const [activeTier, setActiveTier] = useState<PerformanceTier>('basic')
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)

  const loadStatus = useCallback(async ({ forceRefresh = false, silent = false } = {}) => {
    if (forceRefresh) setRefreshing(true)
    try {
      const response = await fetch(apiUrl('/api/license/database-performance/status'), {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ force_refresh: forceRefresh })
      })
      const data = await response.json() as DatabasePerformanceStatus & { message?: string }
      if (!response.ok || !data.success) {
        throw new Error(data.message || 'No se pudo consultar PostgreSQL en Render.')
      }

      setStatus(data)
      setLoadError('')
      setSelectedPlanId((currentSelection) => {
        const selectionStillValid = data.plans?.some((plan) => (
          plan.id === currentSelection && plan.selectable
        ))
        if (currentSelection && selectionStillValid) return currentSelection

        const currentTier = data.postgres?.current?.tier
        if (currentTier === 'basic' || currentTier === 'pro' || currentTier === 'accelerated') {
          setActiveTier(currentTier)
        }
        return null
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo consultar PostgreSQL en Render.'
      setLoadError(message)
      if (!silent) showToast('error', 'No cargó el rendimiento', message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [showToast])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const processing = status?.operation?.status === 'processing'

  useEffect(() => {
    if (!processing) return undefined
    const intervalId = window.setInterval(() => {
      void loadStatus({ silent: true })
    }, 6000)
    return () => window.clearInterval(intervalId)
  }, [loadStatus, processing])

  const currentPlan = status?.postgres?.current || null
  const selectedPlan = useMemo(
    () => status?.plans.find((plan) => plan.id === selectedPlanId) || null,
    [selectedPlanId, status?.plans]
  )
  const selectedDelta = selectedPlan ? planPriceDelta(selectedPlan, currentPlan) : null
  const displayCurrency = status?.account_currency || configuredCurrency
  const visiblePlans = useMemo(
    () => status?.plans.filter((plan) => plan.tier === activeTier) || [],
    [activeTier, status?.plans]
  )

  const planOptions = useMemo<SelectionGridOption[]>(() => visiblePlans.map((plan) => {
    const delta = planPriceDelta(plan, currentPlan)
    const deltaLabel = delta === null || plan.current
      ? null
      : `${delta >= 0 ? '+' : '−'}${formatCurrency(Math.abs(delta), displayCurrency)} ${displayCurrency} al mes`

    return {
      id: plan.id,
      title: plan.label,
      status: plan.current ? <Badge variant="primary">Actual</Badge> : undefined,
      description: (
        <>
          <strong>{formatCurrency(plan.monthly_account_currency, displayCurrency)} {displayCurrency}</strong> / mes
        </>
      ),
      details: [
        { label: 'Memoria', value: formatMemory(plan.memory_mb) },
        { label: 'Procesador', value: formatCpu(plan.cpu) },
        { label: 'Conexiones', value: plan.connections.toLocaleString('es-MX') },
        { label: 'Precio Render', value: formatCurrency(plan.monthly_usd, 'USD') }
      ],
      footer: deltaLabel,
      disabled: !plan.selectable,
      disabledReason: plan.disabled_reason
    }
  }), [currentPlan, displayCurrency, visiblePlans])

  const handleApply = async (): Promise<boolean> => {
    if (!selectedPlan) return false
    try {
      const response = await fetch(apiUrl('/api/license/database-performance/apply'), {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ target_plan: selectedPlan.id })
      })
      const data = await response.json() as DatabasePerformanceStatus & { message?: string }
      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Render no pudo iniciar el cambio.')
      }

      setStatus(data)
      setSelectedPlanId(null)
      showToast(
        'success',
        'Cambio iniciado',
        'Render está aumentando la memoria y el procesador. Ristak confirmará cuando PostgreSQL vuelva a estar disponible.'
      )
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Render no pudo iniciar el cambio.'
      showToast('error', 'No se aplicó el cambio', message)
      return false
    }
  }

  const showUnavailable = status && !status.management_available

  return (
    <div className={pageStyles.settingsContent}>
      <PageHeader
        eyebrow="Configuración · Avanzado"
        title="Memoria y rendimiento"
        subtitle="Aumenta la memoria RAM y el procesador de PostgreSQL sin salir de Ristak. El almacenamiento se administra por separado."
      />

      {loading ? (
        <Loading message="Consultando tu instancia en Render..." size="md" />
      ) : !status ? (
        <Card className={pageStyles.settingsSection}>
          <div className={styles.emptyState}>
            <AlertTriangle size={24} aria-hidden="true" />
            <div>
              <h2>No pudimos consultar tu instancia</h2>
              <p>{loadError || 'Render no respondió. Intenta de nuevo en un momento.'}</p>
              <Button
                type="button"
                variant="secondary"
                size="small"
                leftIcon={<RefreshCw size={15} />}
                onClick={() => void loadStatus()}
              >
                Reintentar
              </Button>
            </div>
          </div>
        </Card>
      ) : showUnavailable ? (
        <Card className={pageStyles.settingsSection}>
          <div className={styles.emptyState}>
            <Database size={24} aria-hidden="true" />
            <div>
              <h2>Esta base no se administra desde aquí</h2>
              <p>{status.management_message || 'Cambia la instancia directamente desde Render.'}</p>
            </div>
          </div>
        </Card>
      ) : (
        <>
          {loadError && status && (
            <div className={styles.notice} data-tone="warning" role="status">
              <AlertTriangle size={18} aria-hidden="true" />
              <div>
                <strong>No pudimos actualizar la lectura</strong>
                <span>Mostramos la última información disponible. {loadError}</span>
              </div>
            </div>
          )}

          {processing && (
            <div className={styles.notice} data-tone="info" role="status" aria-live="polite">
              <Gauge size={18} aria-hidden="true" />
              <div>
                <strong>Render está aplicando el cambio</strong>
                <span>PostgreSQL puede desconectarse unos minutos. Esta pantalla se actualizará sola cuando termine.</span>
              </div>
            </div>
          )}

          {status?.operation?.status === 'failed' && (
            <div className={styles.notice} data-tone="error" role="alert">
              <AlertTriangle size={18} aria-hidden="true" />
              <div>
                <strong>El último cambio no terminó</strong>
                <span>{status.operation.operation_error || 'Render no confirmó el nuevo tipo de instancia.'}</span>
              </div>
            </div>
          )}

          <Card className={pageStyles.settingsSection}>
            <div className={pageStyles.panelHeader}>
              <div className={pageStyles.panelHeaderLeft}>
                <div className={pageStyles.iconBox} aria-hidden="true">
                  <Cpu size={20} />
                </div>
                <div>
                  <h2 className={pageStyles.panelTitle}>Tu instancia de PostgreSQL</h2>
                  <p className={pageStyles.panelDescription}>
                    Render cobra en USD; Ristak te muestra el equivalente de referencia en {displayCurrency} con el tipo de cambio más reciente.
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="small"
                loading={refreshing}
                disabled={processing}
                leftIcon={<RefreshCw size={15} />}
                onClick={() => void loadStatus({ forceRefresh: true })}
              >
                Actualizar precios
              </Button>
            </div>

            {currentPlan && (
              <div className={styles.currentSummary}>
                <div className={styles.currentIdentity}>
                  <span>Instancia actual</span>
                  <strong>{currentPlan.label}</strong>
                  <Badge variant={status?.postgres?.status === 'available' ? 'success' : 'warning'}>
                    {status?.postgres?.status === 'available' ? 'Disponible' : 'En proceso'}
                  </Badge>
                </div>
                <dl className={styles.currentMetrics}>
                  <div><dt>Memoria</dt><dd>{formatMemory(currentPlan.memory_mb)}</dd></div>
                  <div><dt>Procesador</dt><dd>{formatCpu(currentPlan.cpu)}</dd></div>
                  <div><dt>Conexiones</dt><dd>{currentPlan.connections.toLocaleString('es-MX')}</dd></div>
                  <div>
                    <dt>Precio mensual</dt>
                    <dd>{formatCurrency(currentPlan.monthly_account_currency, displayCurrency)} {displayCurrency}</dd>
                    <small>{formatCurrency(currentPlan.monthly_usd, 'USD')}</small>
                  </div>
                </dl>
              </div>
            )}
          </Card>

          <section className={styles.catalogSection} aria-labelledby="performance-catalog-title">
            <div className={styles.catalogHeader}>
              <div>
                <h2 id="performance-catalog-title">Elige el nuevo rendimiento</h2>
                <p>Incluimos todo el catálogo flexible actual de Render. Solo se habilitan opciones que aumentan recursos sin reducir memoria ni CPU.</p>
              </div>
              <Badge variant="neutral">{status?.plans.length || 0} opciones</Badge>
            </div>

            <SegmentTabs
              tabs={TIER_TABS}
              value={activeTier}
              onChange={(id) => setActiveTier(id as PerformanceTier)}
              aria-label="Categorías de rendimiento"
            />

            {!status?.quote_current && (
              <div className={styles.notice} data-tone="warning" role="alert">
                <AlertTriangle size={18} aria-hidden="true" />
                <div>
                  <strong>La cotización no está actualizada</strong>
                  <span>No puedes aplicar cambios hasta confirmar el precio oficial y el tipo de cambio.</span>
                </div>
              </div>
            )}

            <SelectionGrid
              ariaLabel={`Planes ${activeTier}`}
              options={planOptions}
              value={selectedPlanId || currentPlan?.id || null}
              onChange={setSelectedPlanId}
            />
          </section>

          <div className={styles.applyBar}>
            <div>
              {selectedPlan ? (
                <>
                  <span>Nuevo gasto mensual estimado</span>
                  <strong>{formatCurrency(selectedPlan.monthly_account_currency, displayCurrency)} {displayCurrency}</strong>
                  {selectedDelta !== null && (
                    <small>
                      +{formatCurrency(selectedDelta, displayCurrency)} {displayCurrency} al mes respecto al plan actual
                    </small>
                  )}
                </>
              ) : (
                <>
                  <span>Sin cambios pendientes</span>
                  <small>Selecciona una opción disponible para revisar el nuevo gasto.</small>
                </>
              )}
            </div>
            <Button
              type="button"
              disabled={!selectedPlan || processing || !status?.quote_current}
              onClick={() => setConfirmOpen(true)}
              leftIcon={<ArrowUpRight size={16} />}
            >
              Aplicar cambios
            </Button>
          </div>

          <div className={styles.sourceNote}>
            <p>
              El equivalente en {displayCurrency} es informativo: tu banco puede usar otra tasa o cobrar comisiones.
              Render factura el importe en USD.
            </p>
            <div>
              {status?.pricing?.source_url && (
                <a href={status.pricing.source_url} target="_blank" rel="noreferrer">
                  Precios de Render <ExternalLink size={13} />
                </a>
              )}
              {status?.exchange_rate?.attribution_url && (
                <a href={status.exchange_rate.attribution_url} target="_blank" rel="noreferrer">
                  Tipo de cambio por Exchange Rate API <ExternalLink size={13} />
                </a>
              )}
            </div>
          </div>
        </>
      )}

      <Modal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Aplicar nuevo rendimiento"
        subtitle="Render reiniciará PostgreSQL para cambiar la instancia."
        type="confirm"
        size="md"
        confirmText="Aplicar cambios"
        cancelText="Cancelar"
        typeToConfirm="APLICAR"
        onConfirm={handleApply}
      >
        {selectedPlan && currentPlan && (
          <div className={styles.confirmSummary}>
            <div>
              <span>Actual</span>
              <strong>{currentPlan.label}</strong>
              <small>{formatMemory(currentPlan.memory_mb)} · {formatCpu(currentPlan.cpu)}</small>
            </div>
            <ArrowUpRight size={18} aria-hidden="true" />
            <div>
              <span>Nuevo</span>
              <strong>{selectedPlan.label}</strong>
              <small>{formatMemory(selectedPlan.memory_mb)} · {formatCpu(selectedPlan.cpu)}</small>
            </div>
            <div className={styles.confirmCost}>
              <span>Nuevo gasto mensual estimado</span>
              <strong>{formatCurrency(selectedPlan.monthly_account_currency, displayCurrency)} {displayCurrency}</strong>
              <small>{formatCurrency(selectedPlan.monthly_usd, 'USD')} cobrados por Render</small>
            </div>
            <p>{status?.downtime_notice || 'PostgreSQL puede quedar fuera de servicio durante unos minutos.'}</p>
          </div>
        )}
      </Modal>
    </div>
  )
}

export default DatabasePerformanceSettings
