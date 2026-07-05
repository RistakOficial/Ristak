import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Pause, Play, RotateCcw, Send, UserRound, XCircle } from 'lucide-react'
import { Badge, Button, CustomSelect, Loading, Modal, type BadgeVariant } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import automationsService, {
  type AutomationEnrollment,
  type AutomationEnrollmentControlAction,
  type AutomationNode
} from '@/services/automationsService'
import { formatDateTime } from '@/utils/format'
import { getNodeDefinition } from './nodeRegistry'
import styles from './AutomationEditor.module.css'

interface NodeEnrollmentsModalProps {
  automationId: string
  node: AutomationNode | null
  nodes: AutomationNode[]
  open: boolean
  onClose: () => void
  onChanged: () => void
}

const ACTIVE_STATUSES = new Set(['active', 'waiting', 'paused'])

const STATUS_LABELS: Record<string, { label: string; variant: BadgeVariant }> = {
  active: { label: 'Activo', variant: 'success' },
  waiting: { label: 'Esperando', variant: 'warning' },
  paused: { label: 'Pausado', variant: 'info' },
  completed: { label: 'Completado', variant: 'neutral' },
  exited: { label: 'Salió', variant: 'warning' },
  goal_met: { label: 'Objetivo cumplido', variant: 'success' }
}

function nodeName(node: AutomationNode | null | undefined): string {
  if (!node) return 'Paso eliminado'
  if (node.type === 'start') return 'Cuando...'
  const customTitle = typeof node.config?.customTitle === 'string' ? node.config.customTitle.trim() : ''
  return customTitle || getNodeDefinition(node.type)?.label || node.label || node.type
}

function lastLogDetail(enrollment: AutomationEnrollment): string {
  const lastEntry = [...(enrollment.log || [])].reverse().find((entry) => entry.detail || entry.status)
  return lastEntry?.detail || lastEntry?.status || 'Sin actividad registrada'
}

export const NodeEnrollmentsModal: React.FC<NodeEnrollmentsModalProps> = ({
  automationId,
  node,
  nodes,
  open,
  onClose,
  onChanged
}) => {
  const { showToast } = useNotification()
  const { timezone } = useTimezone()
  const [enrollments, setEnrollments] = useState<AutomationEnrollment[] | null>(null)
  const [busy, setBusy] = useState<{ id: string; action: AutomationEnrollmentControlAction } | null>(null)
  const [moveTargets, setMoveTargets] = useState<Record<string, string>>({})

  const targetOptions = useMemo(
    () =>
      nodes
        .filter((candidate) => candidate.type !== 'start')
        .map((candidate) => ({
          value: candidate.id,
          label: nodeName(candidate),
          disabled: candidate.id === node?.id
        })),
    [node?.id, nodes]
  )

  const loadEnrollments = useCallback(async () => {
    if (!open || !automationId) return
    setEnrollments(null)
    try {
      const data = await automationsService.getEnrollments(automationId)
      setEnrollments(data)
    } catch (error) {
      setEnrollments([])
      showToast(
        'error',
        'No se pudieron cargar los contactos',
        error instanceof Error && error.message ? error.message : 'Intenta de nuevo'
      )
    }
  }, [automationId, open, showToast])

  useEffect(() => {
    if (open) void loadEnrollments()
  }, [loadEnrollments, open])

  const visibleEnrollments = useMemo(
    () =>
      (enrollments || []).filter(
        (enrollment) =>
          enrollment.currentNodeId === node?.id &&
          ACTIVE_STATUSES.has(String(enrollment.status || '').toLowerCase())
      ),
    [enrollments, node?.id]
  )

  const runAction = async (
    enrollment: AutomationEnrollment,
    action: AutomationEnrollmentControlAction,
    targetNodeId?: string
  ) => {
    setBusy({ id: enrollment.id, action })
    try {
      await automationsService.controlEnrollment(automationId, enrollment.id, {
        action,
        targetNodeId
      })
      await loadEnrollments()
      onChanged()
      showToast('success', 'Contacto actualizado', 'La automatización quedó ajustada')
    } catch (error) {
      showToast(
        'error',
        'No se pudo actualizar',
        error instanceof Error && error.message ? error.message : 'Intenta de nuevo'
      )
    } finally {
      setBusy(null)
    }
  }

  const title = node ? `${nodeName(node)} · contactos activos` : 'Contactos activos'

  return (
    <Modal isOpen={open} onClose={onClose} title={title} size="xl">
      <div className={styles.nodeEnrollmentModal} data-automation-interactive="true">
        {enrollments === null ? (
          <Loading variant="spinner" />
        ) : visibleEnrollments.length === 0 ? (
          <p className={styles.recordsEmpty}>
            No hay contactos activos en este paso. Si alguien entra al flujo, aparecerá aquí para
            moverlo, pausarlo, reintentarlo o sacarlo.
          </p>
        ) : (
          <div className={styles.nodeEnrollmentTable}>
            <div className={styles.nodeEnrollmentHead}>
              <span>Contacto</span>
              <span>Estado</span>
              <span>Última actividad</span>
              <span>Acciones</span>
            </div>
            {visibleEnrollments.map((enrollment) => {
              const status = STATUS_LABELS[String(enrollment.status || '').toLowerCase()] || STATUS_LABELS.active
              const movingTarget = moveTargets[enrollment.id] || targetOptions.find((option) => !option.disabled)?.value || ''
              const isBusy = busy?.id === enrollment.id
              const isPaused = String(enrollment.status || '').toLowerCase() === 'paused'
              return (
                <div key={enrollment.id} className={styles.nodeEnrollmentRow}>
                  <span className={styles.recordsContact}>
                    <UserRound size={14} />
                    <span className={styles.nodeEnrollmentContactText}>
                      <strong>{enrollment.contactName}</strong>
                      <small>
                        Entró {formatDateTime(enrollment.enteredAt, { timezone, includeTime: true })}
                      </small>
                    </span>
                  </span>
                  <span>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </span>
                  <span className={styles.nodeEnrollmentDetail}>{lastLogDetail(enrollment)}</span>
                  <span className={styles.nodeEnrollmentActions}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      leftIcon={<ArrowRight size={13} />}
                      loading={isBusy && busy?.action === 'advance'}
                      disabled={isBusy}
                      onClick={() => void runAction(enrollment, 'advance')}
                    >
                      Siguiente
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      leftIcon={isPaused ? <Play size={13} /> : <Pause size={13} />}
                      loading={isBusy && (busy?.action === 'pause' || busy?.action === 'resume')}
                      disabled={isBusy}
                      onClick={() => void runAction(enrollment, isPaused ? 'resume' : 'pause')}
                    >
                      {isPaused ? 'Reanudar' : 'Pausar'}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      leftIcon={<RotateCcw size={13} />}
                      loading={isBusy && busy?.action === 'retry'}
                      disabled={isBusy}
                      onClick={() => void runAction(enrollment, 'retry')}
                    >
                      Reintentar
                    </Button>
                    <span className={styles.nodeEnrollmentMove}>
                      <CustomSelect
                        value={movingTarget}
                        options={targetOptions}
                        placeholder="Mover a..."
                        disabled={isBusy || targetOptions.length === 0}
                        onValueChange={(value) =>
                          setMoveTargets((current) => ({ ...current, [enrollment.id]: value }))
                        }
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        leftIcon={<Send size={13} />}
                        loading={isBusy && busy?.action === 'move_to_node'}
                        disabled={isBusy || !movingTarget}
                        onClick={() => void runAction(enrollment, 'move_to_node', movingTarget)}
                      >
                        Mover
                      </Button>
                    </span>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      leftIcon={<XCircle size={13} />}
                      loading={isBusy && busy?.action === 'exit'}
                      disabled={isBusy}
                      onClick={() => void runAction(enrollment, 'exit')}
                    >
                      Sacar
                    </Button>
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}
