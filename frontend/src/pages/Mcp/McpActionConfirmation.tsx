import React from 'react'
import { AlertTriangle, CheckCircle2, Clock3, ShieldCheck, XCircle } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { AppStartupLoader, Badge, Button, Card, Logo } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import apiClient, { type ApiRequestError } from '@/services/apiClient'
import styles from './McpActionConfirmation.module.css'

type ConfirmationStatus = 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired'

type Confirmation = {
  confirmationId: string
  toolName: string
  toolTitle: string
  toolDescription: string | null
  clientName: string
  riskLevel: 'write' | 'execute' | 'destructive'
  status: ConfirmationStatus
  arguments: Record<string, unknown>
  createdAt: string
  expiresAt: string
}

type ConfirmationResponse = {
  success: true
  confirmation: Confirmation
}

const STATUS_COPY: Record<ConfirmationStatus, { label: string; description: string }> = {
  pending: {
    label: 'Esperando tu decisión',
    description: 'Revisa los datos. Ristak no ejecutará nada hasta que apruebes.'
  },
  approved: {
    label: 'Acción aprobada',
    description: 'La inteligencia artificial ya puede ejecutar una sola vez la acción ligada a este pase.'
  },
  rejected: {
    label: 'Acción rechazada',
    description: 'El pase quedó cancelado y no puede utilizarse.'
  },
  consumed: {
    label: 'Aprobación utilizada',
    description: 'Esta aprobación ya se usó y no puede repetirse.'
  },
  expired: {
    label: 'Aprobación vencida',
    description: 'Por seguridad, la inteligencia artificial tendrá que preparar una solicitud nueva.'
  }
}

function readApprovalTicket() {
  const hash = window.location.hash.replace(/^#/, '')
  return new URLSearchParams(hash).get('ticket') || ''
}

function errorMessage(error: unknown) {
  const requestError = error as ApiRequestError
  const body = requestError?.body as { message?: unknown; error?: unknown } | undefined
  return String(body?.message || body?.error || requestError?.message || 'No pudimos abrir esta aprobación.')
}

function displayValue(value: unknown) {
  if (value === null) return 'Vacío'
  if (typeof value === 'boolean') return value ? 'Sí' : 'No'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return 'Dato no disponible'
  }
}

function statusVariant(status: ConfirmationStatus) {
  if (status === 'approved') return 'success' as const
  if (status === 'rejected' || status === 'expired') return 'error' as const
  return 'neutral' as const
}

export const McpActionConfirmation: React.FC = () => {
  const navigate = useNavigate()
  const { showConfirm, showToast } = useNotification()
  const ticket = React.useMemo(readApprovalTicket, [])
  const [confirmation, setConfirmation] = React.useState<Confirmation | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [submitting, setSubmitting] = React.useState<'approve' | 'reject' | null>(null)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    let active = true
    if (!ticket) {
      setError('El enlace no incluye un pase de aprobación válido.')
      setLoading(false)
      return () => { active = false }
    }
    apiClient.post<ConfirmationResponse>('/api/mcp/action-confirmations/context', { ticket }, {
      suppressFeatureNotAvailableToast: true
    })
      .then(response => {
        if (active) setConfirmation(response.confirmation)
      })
      .catch(cause => {
        if (active) setError(errorMessage(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [ticket])

  const submitDecision = React.useCallback(async (decision: 'approve' | 'reject') => {
    if (!ticket || submitting) return false
    setSubmitting(decision)
    setError('')
    try {
      const response = await apiClient.post<ConfirmationResponse>(
        '/api/mcp/action-confirmations/decision',
        { ticket, decision },
        { suppressFeatureNotAvailableToast: true }
      )
      setConfirmation(response.confirmation)
      showToast(
        decision === 'approve' ? 'success' : 'info',
        decision === 'approve' ? 'Acción aprobada' : 'Acción rechazada',
        decision === 'approve'
          ? 'El pase sirve una sola vez y únicamente con estos datos.'
          : 'La inteligencia artificial no podrá ejecutar esta solicitud.'
      )
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setSubmitting(null)
    }
  }, [showToast, submitting, ticket])

  const requestApproval = React.useCallback(() => {
    if (!confirmation) return
    const destructive = confirmation.riskLevel === 'destructive'
    showConfirm(
      destructive ? 'Aprobar acción delicada' : 'Aprobar esta acción',
      `Vas a permitir que ${confirmation.clientName} ejecute “${confirmation.toolTitle}” una sola vez y únicamente con los datos mostrados.`,
      () => submitDecision('approve'),
      'Aprobar acción',
      'Volver',
      undefined,
      destructive ? { typeToConfirm: 'APROBAR' } : undefined
    )
  }, [confirmation, showConfirm, submitDecision])

  if (loading) return <AppStartupLoader message="Validando aprobación segura" />

  if (!confirmation) {
    return (
      <main className={styles.page}>
        <Logo size="md" />
        <Card className={styles.card} padding="lg">
          <div className={styles.errorIcon} aria-hidden="true"><AlertTriangle size={24} /></div>
          <div className={styles.centeredCopy}>
            <Badge variant="error">Solicitud detenida</Badge>
            <h1>No se puede abrir esta aprobación</h1>
            <p>{error}</p>
          </div>
          <Button variant="secondary" fullWidth onClick={() => navigate('/dashboard', { replace: true })}>
            Volver a Ristak
          </Button>
        </Card>
      </main>
    )
  }

  const statusCopy = STATUS_COPY[confirmation.status]
  const argumentEntries = Object.entries(confirmation.arguments || {})
  const resolved = confirmation.status !== 'pending'
  const negativeStatus = confirmation.status === 'rejected' || confirmation.status === 'expired'
  const StatusIcon = confirmation.status === 'approved'
    ? CheckCircle2
    : confirmation.status === 'rejected' || confirmation.status === 'expired' ? XCircle : Clock3

  return (
    <main className={styles.page}>
      <Logo size="md" />
      <Card className={styles.card} padding="lg">
        <div className={negativeStatus ? styles.errorIcon : resolved ? styles.statusIcon : styles.headerIcon} aria-hidden="true">
          {resolved ? <StatusIcon size={25} /> : <ShieldCheck size={25} />}
        </div>
        <header className={styles.header}>
          <Badge variant={statusVariant(confirmation.status)}>{statusCopy.label}</Badge>
          <h1>{confirmation.toolTitle}</h1>
          <p>{statusCopy.description}</p>
        </header>

        <section className={styles.summary} aria-label="Resumen de la solicitud">
          <div><span>Herramienta conectada</span><strong>{confirmation.clientName}</strong></div>
          <div><span>Tipo de acción</span><strong>{confirmation.riskLevel === 'destructive' ? 'Delicada' : 'Cambio en Ristak'}</strong></div>
        </section>

        {confirmation.toolDescription && <p className={styles.description}>{confirmation.toolDescription}</p>}

        <section className={styles.details} aria-labelledby="mcp-action-details-title">
          <div className={styles.sectionHeading}>
            <h2 id="mcp-action-details-title">Resumen seguro de la acción</h2>
            <Badge variant="neutral">{argumentEntries.length}</Badge>
          </div>
          {argumentEntries.length ? (
            <dl>
              {argumentEntries.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{displayValue(value)}</dd>
                </div>
              ))}
            </dl>
          ) : <p className={styles.empty}>Esta acción no necesita datos adicionales.</p>}
        </section>

        {confirmation.riskLevel === 'destructive' && confirmation.status === 'pending' && (
          <div className={styles.warning} role="note">
            <AlertTriangle size={18} aria-hidden="true" />
            <p>Esta acción puede eliminar, cancelar o revertir información. Para aprobarla tendrás que escribir <strong>APROBAR</strong>.</p>
          </div>
        )}

        {error && <div className={styles.errorMessage} role="alert">{error}</div>}

        {confirmation.status === 'pending' ? (
          <div className={styles.actions}>
            <Button
              variant="secondary"
              fullWidth
              loading={submitting === 'reject'}
              disabled={Boolean(submitting)}
              onClick={() => void submitDecision('reject')}
            >
              Rechazar
            </Button>
            <Button
              variant={confirmation.riskLevel === 'destructive' ? 'danger' : 'primary'}
              fullWidth
              disabled={Boolean(submitting)}
              onClick={requestApproval}
              leftIcon={<ShieldCheck size={17} />}
            >
              Revisar y aprobar
            </Button>
          </div>
        ) : (
          <div className={styles.resolvedAction}>
            <Button variant="secondary" fullWidth onClick={() => navigate('/dashboard', { replace: true })}>
              Volver a Ristak
            </Button>
          </div>
        )}

        <p className={styles.footerNote}>Los valores sensibles o muy largos se ocultan en este resumen. El pase queda ligado a todos los datos, vence automáticamente y deja de servir si cualquiera cambia.</p>
      </Card>
    </main>
  )
}

export default McpActionConfirmation
