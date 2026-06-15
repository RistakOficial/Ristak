import React, { useEffect, useMemo, useState } from 'react'
import { UserRound } from 'lucide-react'
import { Badge, Loading, Modal, TabList } from '@/components/common'
import automationsService, { type AutomationEnrollment } from '@/services/automationsService'
import type { AutomationNode } from '@/services/automationsService'
import { getNodeDefinition } from './nodeRegistry'
import { formatDate } from '@/utils/format'
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

const STATUS_LABELS: Record<string, { label: string; variant: 'success' | 'neutral' | 'warning' | 'default' }> = {
  active: { label: 'Activo', variant: 'success' },
  waiting: { label: 'Esperando', variant: 'warning' },
  completed: { label: 'Completado', variant: 'neutral' },
  exited: { label: 'Salió', variant: 'warning' },
  goal_met: { label: 'Objetivo cumplido', variant: 'success' }
}

export const EnrollmentRecordsModal: React.FC<EnrollmentRecordsModalProps> = ({
  automationId,
  nodes,
  open,
  initialTab,
  onClose
}) => {
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
          contact: enrollment.contactName,
          step: entry.label || nodeName(entry.nodeId),
          status: (entry as { detail?: string }).detail || entry.status || 'ok',
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
          <Loading variant="spinner" message="Cargando registros" />
        ) : tab === 'enrollments' ? (
          enrollments.length === 0 ? (
            <p className={styles.recordsEmpty}>
              Aún no hay contactos inscritos. Cuando la automatización corra en vivo, aquí verás
              quién entró, su estado y en qué paso del flujo va.
            </p>
          ) : (
            <div className={styles.recordsTable}>
              <div className={styles.recordsHead}>
                <span>Contacto</span>
                <span>Estado</span>
                <span>Paso actual</span>
                <span>Entró</span>
              </div>
              {enrollments.map((enrollment) => {
                const status = STATUS_LABELS[enrollment.status] || STATUS_LABELS.active
                return (
                  <div key={enrollment.id} className={styles.recordsRow}>
                    <span className={styles.recordsContact}>
                      <UserRound size={13} />
                      {enrollment.contactName}
                    </span>
                    <span>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </span>
                    <span>{enrollment.status === 'active' ? nodeName(enrollment.currentNodeId) : '—'}</span>
                    <span>{formatDate(enrollment.enteredAt, { includeYear: true })}</span>
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
          <div className={styles.recordsTable}>
            <div className={styles.recordsHead}>
              <span>Contacto</span>
              <span>Paso</span>
              <span>Resultado</span>
              <span>Cuándo</span>
            </div>
            {executionRows.map((row, index) => (
              <div key={index} className={styles.recordsRow}>
                <span className={styles.recordsContact}>
                  <UserRound size={13} />
                  {row.contact}
                </span>
                <span>{row.step}</span>
                <span>{row.status}</span>
                <span>{formatDate(row.at, { includeYear: true })}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
