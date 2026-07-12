import React, { useEffect, useMemo, useState } from 'react'
import { UserRound } from 'lucide-react'
import { Badge, Loading, Modal, TabList, type BadgeVariant } from '@/components/common'
import automationsService, {
  type AutomationEnrollment,
  type AutomationExecutionOutcome,
  type AutomationLogOutcome,
  type EnrollmentLogEntry
} from '@/services/automationsService'
import type { AutomationNode } from '@/services/automationsService'
import { useTimezone } from '@/contexts/TimezoneContext'
import { getNodeDefinition } from './nodeRegistry'
import { formatDateTime } from '@/utils/format'
import styles from './AutomationEditor.module.css'

/**
 * Historial de inscripciones y registros de ejecución de una automatización:
 * quién entró, en qué paso va cada contacto activo y qué pasos se ejecutaron.
 */

export type RecordsTab = 'enrollments' | 'executions'

interface EnrollmentRecordsModalProps {
  automationId: string
  nodes: AutomationNode[]
  open: boolean
  initialTab: RecordsTab
  onClose: () => void
}

const STATUS_LABELS: Record<string, { label: string; variant: BadgeVariant }> = {
  active: { label: 'Activo', variant: 'success' },
  waiting: { label: 'Esperando', variant: 'warning' },
  paused: { label: 'Pausado', variant: 'info' },
  completed: { label: 'Completado', variant: 'neutral' },
  exited: { label: 'Salió', variant: 'warning' },
  goal_met: { label: 'Objetivo cumplido', variant: 'success' },
  processing: { label: 'Procesando', variant: 'info' }
}

const EXECUTION_OUTCOME_LABELS: Record<AutomationExecutionOutcome, { label: string; variant: BadgeVariant }> = {
  pending: { label: 'En curso', variant: 'info' },
  success: { label: 'Exitoso', variant: 'success' },
  error: { label: 'Error', variant: 'error' },
  stopped: { label: 'Detenido', variant: 'neutral' }
}

function getLogOutcome(entry: EnrollmentLogEntry): AutomationLogOutcome {
  if (entry.outcome) return entry.outcome
  const status = String(entry.status || '').toLowerCase()
  if (status === 'error' || status === 'failed') return 'error'
  if (status === 'waiting' || status === 'retrying') return 'waiting'
  if (status === 'skipped' || status === 'omitted') return 'skipped'
  if (status === 'info' || status === 'exited' || status === 'paused') return 'info'
  return 'success'
}

function getEnrollmentExecutionOutcome(enrollment: AutomationEnrollment): AutomationExecutionOutcome {
  if (enrollment.executionOutcome) return enrollment.executionOutcome
  const hasError = (enrollment.log || []).some((entry) => getLogOutcome(entry) === 'error' && !entry.resolved && !entry.resolvedAt)
  if (hasError || enrollment.status === 'error') return 'error'
  if (['active', 'waiting', 'paused'].includes(enrollment.status)) return 'pending'
  if (['completed', 'goal_met'].includes(enrollment.status)) return 'success'
  return enrollment.status === 'exited' ? 'stopped' : 'pending'
}

export const EnrollmentRecordsModal: React.FC<EnrollmentRecordsModalProps> = ({
  automationId,
  nodes,
  open,
  initialTab,
  onClose
}) => {
  const { timezone } = useTimezone()
  const [tab, setTab] = useState<RecordsTab>(initialTab)
  const [enrollments, setEnrollments] = useState<AutomationEnrollment[] | null>(null)

  useEffect(() => {
    if (open) setTab(initialTab)
  }, [open, initialTab])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setEnrollments(null)
    void automationsService
      .getEnrollments(automationId)
      .then((data) => {
        if (!cancelled) setEnrollments(data)
      })
      .catch(() => {
        if (!cancelled) setEnrollments([])
      })
    return () => {
      cancelled = true
    }
  }, [open, automationId])

  const nodeName = (nodeId: string | null) => {
    if (!nodeId) return '—'
    const node = nodes.find((candidate) => candidate.id === nodeId)
    if (!node) return 'Paso eliminado'
    if (node.type === 'start') return 'Cuando...'
    const config = node.config || {}
    const custom = typeof config.customTitle === 'string' && config.customTitle.trim()
    return custom || getNodeDefinition(node.type)?.label || node.type
  }

  // Registros de ejecución: pasos individuales de todas las inscripciones
  const executionRows = useMemo(() => {
    if (!enrollments) return []
    return enrollments
      .flatMap((enrollment) =>
        (enrollment.log || []).map((entry) => ({
          id: entry.id || `${enrollment.id}-${entry.at || entry.nodeId}`,
          contact: enrollment.contactName,
          step: entry.label || nodeName(entry.nodeId),
          outcome: getLogOutcome(entry),
          detail: [
            entry.errorMessage || entry.detail || entry.status || 'Sin detalle registrado',
            entry.errorDetail ? `Respuesta: ${entry.errorDetail}` : ''
          ].filter(Boolean).join(' · '),
          errorCode: entry.errorCode,
          resolved: Boolean(entry.resolved || entry.resolvedAt),
          at: entry.at || enrollment.updatedAt
        }))
      )
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 300)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrollments])

  return (
    <Modal isOpen={open} onClose={onClose} title="Registros de la automatización" size="lg">
      <TabList
        tabs={[
          { value: 'enrollments', label: 'Historial de inscripciones' },
          { value: 'executions', label: 'Registros de ejecución' }
        ]}
        activeTab={tab}
        onTabChange={(next) => setTab(next as RecordsTab)}
      />

      <div className={styles.recordsBody} data-automation-interactive="true">
        {enrollments === null ? (
          <Loading variant="spinner" />
        ) : tab === 'enrollments' ? (
          enrollments.length === 0 ? (
            <p className={styles.recordsEmpty}>
              Aún no hay contactos inscritos. Cuando la automatización corra en vivo, aquí verás
              quién entró, su estado y en qué paso del flujo va.
            </p>
          ) : (
            <div className={`${styles.recordsTable} ${styles.recordsEnrollmentTable}`}>
              <div className={styles.recordsHead}>
                <span>Contacto</span>
                <span>Estado</span>
                <span>Resultado</span>
                <span>Paso actual</span>
                <span>Entró</span>
              </div>
              {enrollments.map((enrollment) => {
                const status = STATUS_LABELS[enrollment.status] || STATUS_LABELS.active
                const execution = EXECUTION_OUTCOME_LABELS[getEnrollmentExecutionOutcome(enrollment)]
                return (
                  <div key={enrollment.id} className={styles.recordsRow}>
                    <span className={styles.recordsContact}>
                      <UserRound size={13} />
                      {enrollment.contactName}
                    </span>
                    <span>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </span>
                    <span className={styles.recordsOutcomeCell}>
                      <Badge variant={execution.variant}>{execution.label}</Badge>
                      {enrollment.lastError && (
                        <small className={styles.recordsLastError}>{enrollment.lastError}</small>
                      )}
                    </span>
                    <span>{['active', 'waiting', 'paused'].includes(enrollment.status) ? nodeName(enrollment.currentNodeId) : '—'}</span>
                    <span>{formatDateTime(enrollment.enteredAt, { timezone, includeTime: true })}</span>
                  </div>
                )
              })}
            </div>
          )
        ) : executionRows.length === 0 ? (
          <p className={styles.recordsEmpty}>
            Aún no hay ejecuciones registradas. Cada paso que corra (mensajes enviados, esperas,
            condiciones evaluadas) aparecerá aquí con su contacto y resultado.
          </p>
        ) : (
          <div className={`${styles.recordsTable} ${styles.recordsExecutionTable}`}>
            <div className={styles.recordsHead}>
              <span>Contacto</span>
              <span>Paso</span>
              <span>Estado</span>
              <span>Detalle del registro</span>
              <span>Cuándo</span>
            </div>
            {executionRows.map((row) => {
              const outcome = {
                success: { label: 'Exitoso', variant: 'success' as BadgeVariant },
                error: { label: 'Error', variant: 'error' as BadgeVariant },
                waiting: { label: 'Esperando', variant: 'warning' as BadgeVariant },
                skipped: { label: 'Omitido', variant: 'neutral' as BadgeVariant },
                info: { label: 'Información', variant: 'info' as BadgeVariant }
              }[row.outcome]
              return (
              <div key={row.id} className={styles.recordsRow}>
                <span className={styles.recordsContact}>
                  <UserRound size={13} />
                  {row.contact}
                </span>
                <span>{row.step}</span>
                <span><Badge variant={outcome.variant}>{outcome.label}</Badge></span>
                <span className={row.outcome === 'error' ? styles.recordsErrorDetail : styles.recordsDetail}>
                  {row.detail}
                  {row.errorCode ? <small className={styles.recordsErrorCode}>Código: {row.errorCode}</small> : null}
                  {row.resolved ? <small className={styles.recordsResolved}>Resuelto tras reintento</small> : null}
                </span>
                <span>{formatDateTime(row.at, { timezone, includeTime: true })}</span>
              </div>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}
