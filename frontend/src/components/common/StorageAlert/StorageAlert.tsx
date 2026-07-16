import React, { useEffect, useState } from 'react'
import { AlertTriangle, Database, ExternalLink, X } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useNotification } from '@/contexts/NotificationContext'
import apiClient from '@/services/apiClient'
import { hasModuleAccess } from '@/utils/accessControl'
import { Button } from '../Button'
import { Modal } from '../Modal'
import styles from './StorageAlert.module.css'

interface RenderStoragePricing {
  currency: 'USD'
  storage_rate_per_gb_month: number
  current_monthly_storage_cost: number
  target_monthly_storage_cost: number
  additional_monthly_storage_cost: number
}

interface StorageStatus {
  managed: boolean
  managementAvailable: boolean
  managementMessage?: string
  sizeGB: number
  sizePretty?: string
  usedBytes: number
  limitGB: number
  currentDiskSizeGB: number
  targetDiskSizeGB: number | null
  percentUsed: number
  warningThreshold: number
  autoscaleThreshold: number
  needsAttention: boolean
  needsDecision: boolean
  decision: 'pending' | 'approved' | 'declined' | 'unavailable'
  autoscalingEnabled: boolean
  autoscalingPausedForDecision?: boolean
  renderPricing?: RenderStoragePricing | null
}

type Decision = 'approved' | 'declined'
type DecisionStep = 'offer' | 'decline-confirmation' | null

const formatUsd = (value: number) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2
}).format(Number(value || 0))

export const StorageAlert: React.FC = () => {
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [decisionStep, setDecisionStep] = useState<DecisionStep>(null)
  const [actionError, setActionError] = useState('')
  const { isAuthenticated, isLoading, user } = useAuth()
  const { showToast } = useNotification()
  const canManageStorage = !isLoading && isAuthenticated && user?.role === 'admin' &&
    hasModuleAccess(user, 'settings_account', 'write')

  useEffect(() => {
    if (!canManageStorage) {
      setStorageStatus(null)
      setDismissed(false)
      setDecisionStep(null)
      return
    }

    let cancelled = false

    const checkStorage = async () => {
      try {
        const data = await apiClient.post<StorageStatus>('/license/database-storage/status', undefined, {
          suppressFeatureNotAvailableToast: true
        })
        if (cancelled) return
        setStorageStatus(data)
        setActionError('')

        if (data.needsDecision) {
          setDecisionStep(current => current || 'offer')
        } else {
          setDecisionStep(null)
        }
        if (!data.needsAttention) setDismissed(false)
      } catch {
        // El aviso no debe romper el resto de la app si la lectura falla.
      }
    }

    void checkStorage()
    const interval = window.setInterval(checkStorage, 60 * 60 * 1000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [canManageStorage])

  const submitDecision = async (decision: Decision) => {
    if (!storageStatus?.targetDiskSizeGB) return false
    setActionError('')

    try {
      const nextStatus = await apiClient.post<StorageStatus>('/license/database-storage/decision', {
        decision,
        current_disk_size_gb: storageStatus.currentDiskSizeGB,
        target_disk_size_gb: storageStatus.targetDiskSizeGB
      })
      setStorageStatus(nextStatus)
      setDecisionStep(null)
      setDismissed(false)
      showToast(
        decision === 'approved' ? 'success' : 'warning',
        decision === 'approved' ? 'Aumento autorizado' : 'Límite conservado',
        decision === 'approved'
          ? `Render podrá ampliar la base a ${nextStatus.targetDiskSizeGB} GB cuando llegue al ${nextStatus.autoscaleThreshold}%.`
          : `La base seguirá limitada a ${nextStatus.currentDiskSizeGB} GB y puede ser suspendida por Render si se llena.`
      )
      return true
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'No se pudo guardar tu decisión. Intenta nuevamente.')
      return false
    }
  }

  const pricing = storageStatus?.renderPricing
  const reconsideringDecline = storageStatus?.decision === 'declined' && !storageStatus.needsDecision
  const showOffer = decisionStep === 'offer' && (storageStatus?.needsDecision || reconsideringDecline) && pricing && storageStatus.targetDiskSizeGB
  const showDeclineConfirmation = decisionStep === 'decline-confirmation' && storageStatus?.needsDecision
  const showBanner = storageStatus?.needsAttention && !storageStatus.needsDecision && !dismissed &&
    (storageStatus.decision === 'declined' || !storageStatus.managementAvailable)

  return (
    <>
      <Modal
        isOpen={Boolean(showOffer)}
        onClose={() => {
          if (reconsideringDecline) setDecisionStep(null)
        }}
        title="Tu base de datos está por llenarse"
        subtitle={`${storageStatus?.percentUsed || 0}% del espacio utilizado`}
        type="confirm"
        size="md"
        confirmText={`Autorizar aumento a ${storageStatus?.targetDiskSizeGB || 0} GB`}
        cancelText={reconsideringDecline ? 'Seguir sin aumentar' : 'No aumentar'}
        onConfirm={() => submitDecision('approved')}
        onCancel={() => {
          setActionError('')
          setDecisionStep(reconsideringDecline ? null : 'decline-confirmation')
        }}
        showCloseButton={reconsideringDecline}
        closeOnBackdropClick={reconsideringDecline}
        closeOnEscape={reconsideringDecline}
      >
        {showOffer && storageStatus && pricing && (
          <div className={styles.decisionBody}>
            <p className={styles.usageLead}>
              Ristak está usando <strong>{storageStatus.sizePretty || `${storageStatus.sizeGB} GB`}</strong> de{' '}
              <strong>{storageStatus.currentDiskSizeGB} GB</strong>. Para evitar que Render suspenda la base,
              puedes autorizar el siguiente aumento antes de llegar al {storageStatus.autoscaleThreshold}%.
            </p>

            <div className={styles.costPanel}>
              <div className={styles.costHeading}>
                <Database size={18} />
                <span>Costo de almacenamiento en Render</span>
              </div>
              <div className={styles.costRow}>
                <span>Capacidad actual · {storageStatus.currentDiskSizeGB} GB</span>
                <strong>{formatUsd(pricing.current_monthly_storage_cost)}/mes</strong>
              </div>
              <div className={`${styles.costRow} ${styles.costRowTarget}`}>
                <span>Nueva capacidad · {storageStatus.targetDiskSizeGB} GB</span>
                <strong>{formatUsd(pricing.target_monthly_storage_cost)}/mes</strong>
              </div>
              <div className={styles.costDelta}>
                Aumento estimado: <strong>+{formatUsd(pricing.additional_monthly_storage_cost)}/mes</strong>
              </div>
              <p className={styles.providerNote}>
                Render cobra {formatUsd(pricing.storage_rate_per_gb_month)} por GB al mes. Este cargo va directo
                a tu factura de Render y no es un cobro de Ristak. El disco no se puede reducir después.
                {' '}<a href="https://render.com/docs/postgresql-refresh" target="_blank" rel="noreferrer">
                  Ver precio oficial <ExternalLink size={13} />
                </a>
              </p>
            </div>

            <div className={styles.riskNotice}>
              <AlertTriangle size={19} />
              <div>
                <strong>Si decides no aumentar</strong>
                <p>
                  La base conservará su límite actual. Al llenarse, Render la marcará como no saludable y la
                  suspenderá; Ristak dejará de guardar información y puede dejar de funcionar hasta que aumentes el espacio.
                </p>
              </div>
            </div>

            {actionError && <p className={styles.actionError} role="alert">{actionError}</p>}

          </div>
        )}
      </Modal>

      <Modal
        isOpen={Boolean(showDeclineConfirmation)}
        onClose={() => {
          setActionError('')
          setDecisionStep('offer')
        }}
        title="Rechazar aumento de almacenamiento"
        message={`La base permanecerá limitada a ${storageStatus?.currentDiskSizeGB || 0} GB. Si se llena, Render la suspenderá y Ristak puede dejar de funcionar. Esta decisión se puede cambiar antes de que ocurra la suspensión.`}
        type="confirm"
        confirmText="Rechazar aumento"
        cancelText="Volver"
        typeToConfirm="RECHAZAR"
        showCloseButton={false}
        closeOnBackdropClick={false}
        closeOnEscape={false}
        onConfirm={async () => {
          await submitDecision('declined')
          return false
        }}
      >
        {actionError && <p className={styles.actionError} role="alert">{actionError}</p>}
      </Modal>

      {showBanner && storageStatus && (
        <div className={styles.alert} role="alert">
          <div className={styles.content}>
            <AlertTriangle className={styles.icon} size={20} />
            <div className={styles.text}>
              <strong>Base de datos en riesgo:</strong>{' '}
              está usando {storageStatus.percentUsed}% de {storageStatus.currentDiskSizeGB} GB.
              {storageStatus.decision === 'declined'
                ? ' El aumento está rechazado y Render puede suspenderla al llenarse.'
                : ` ${storageStatus.managementMessage || 'No se pudo administrar el aumento desde el Installer.'}`}
              {storageStatus.decision === 'declined' && (
                <Button variant="ghost" size="sm" onClick={() => setDecisionStep('offer')}>
                  Cambiar decisión
                </Button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className={styles.closeButton}
              aria-label="Cerrar alerta de base de datos"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
