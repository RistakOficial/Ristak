import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Pause, Play, RefreshCw, Trash2 } from 'lucide-react'
import { Badge, Button, Card, Loading, PageContainer, PageHeader, Table, Modal, NumberInput } from '@/components/common'
import type { Column } from '@/components/common'
import { contactBulkActionsService, type ContactBulkAction, type ContactBulkActionItem } from '@/services/contactBulkActionsService'
import { useNotification } from '@/contexts/NotificationContext'
import { formatDate } from '@/utils/format'
import styles from './Contacts.module.css'

interface ContactBulkActionProgressProps {
  actionId: string
}

const statusMeta = (status = ''): { label: string; variant: 'success' | 'warning' | 'error' | 'neutral' | 'default' } => {
  switch (status) {
    case 'scheduled':
      return { label: 'Programado', variant: 'warning' }
    case 'processing':
      return { label: 'Procesando', variant: 'default' }
    case 'paused':
      return { label: 'Detenido', variant: 'warning' }
    case 'completed':
      return { label: 'Completado', variant: 'success' }
    case 'error':
      return { label: 'Con errores', variant: 'error' }
    case 'cancelled':
      return { label: 'Cancelado', variant: 'neutral' }
    default:
      return { label: status || 'Pendiente', variant: 'neutral' }
  }
}

const pad = (value: number) => String(value).padStart(2, '0')

const toDateTimeLocalValue = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`

const defaultRescheduleValue = () => toDateTimeLocalValue(new Date(Date.now() + 30 * 60 * 1000))

const actionKindLabel = (action?: ContactBulkAction | null) => {
  if (!action) return ''
  return action.actionType === 'whatsapp_template' ? 'WhatsApp con plantilla' : 'Automatización'
}

export const ContactBulkActionProgress: React.FC<ContactBulkActionProgressProps> = ({ actionId }) => {
  const navigate = useNavigate()
  const { showToast } = useNotification()
  const [action, setAction] = useState<ContactBulkAction | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [showReschedule, setShowReschedule] = useState(false)
  const [rescheduleAt, setRescheduleAt] = useState(defaultRescheduleValue)
  const [rescheduleDrip, setRescheduleDrip] = useState(false)
  const [rescheduleDripMinutes, setRescheduleDripMinutes] = useState(2)

  const loadAction = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      setAction(await contactBulkActionsService.get(actionId))
    } catch (error) {
      showToast('error', 'No se pudo cargar el progreso', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    void loadAction()
    const timer = window.setInterval(() => {
      void loadAction(true)
    }, 5000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionId])

  const progressPercent = useMemo(() => {
    if (!action?.totalCount) return 0
    return Math.round((action.processedCount / action.totalCount) * 100)
  }, [action?.processedCount, action?.totalCount])

  const runAction = async (operation: () => Promise<ContactBulkAction | { deleted: boolean }>, successMessage: string) => {
    setWorking(true)
    try {
      const result = await operation()
      if ('deleted' in result) {
        showToast('success', successMessage, 'La vista ya no mostrará este lote.')
        navigate('/contacts')
        return
      }
      setAction(result)
      showToast('success', successMessage, 'Cambio aplicado.')
    } catch (error) {
      showToast('error', 'No se pudo completar la acción', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      setWorking(false)
    }
  }

  const submitReschedule = async () => {
    await runAction(
      () => contactBulkActionsService.reschedule(actionId, {
        mode: 'scheduled',
        scheduledAt: new Date(rescheduleAt).toISOString(),
        drip: {
          enabled: rescheduleDrip,
          intervalMinutes: rescheduleDrip ? rescheduleDripMinutes : undefined
        }
      }),
      'Lote reprogramado'
    )
    setShowReschedule(false)
  }

  const itemColumns: Column<ContactBulkActionItem>[] = [
    {
      key: 'contactName',
      header: 'Contacto',
      sortable: true
    },
    {
      key: 'status',
      header: 'Estado',
      render: (value) => {
        const status = statusMeta(value)
        return <Badge variant={status.variant}>{status.label}</Badge>
      },
      sortable: true
    },
    {
      key: 'scheduledAt',
      header: 'Programado',
      render: (value) => value ? formatDate(value, { includeYear: true }) : '-',
      sortable: true
    },
    {
      key: 'processedAt',
      header: 'Procesado',
      render: (value) => value ? formatDate(value, { includeYear: true }) : '-',
      sortable: true
    },
    {
      key: 'error',
      header: 'Resultado',
      render: (value, item) => value || (item.status === 'completed' ? 'Listo' : '-'),
      sortable: false
    }
  ]

  if (loading && !action) {
    return <Loading message="Cargando progreso..." page="contacts" />
  }

  const currentStatus = statusMeta(action?.status)
  const canPause = action && ['scheduled', 'processing', 'error'].includes(action.status)
  const canResume = action?.status === 'paused'
  const canEdit = action && !['completed', 'cancelled'].includes(action.status)

  return (
    <PageContainer>
      <div className={styles.container}>
        <PageHeader
          eyebrow={actionKindLabel(action)}
          title={action?.title || 'Progreso del lote'}
          subtitle="Consulta avance, errores y contactos pendientes de esta acción."
          actions={(
            <Button type="button" variant="secondary" onClick={() => navigate('/contacts')}>
              <ArrowLeft size={16} />
              Contactos
            </Button>
          )}
        />

        {action && (
          <>
            <Card padding="md">
              <div className={styles.bulkProgressHeader}>
                <div>
                  <Badge variant={currentStatus.variant}>{currentStatus.label}</Badge>
                  <h2>{progressPercent}% completado</h2>
                  <p>
                    {action.successCount} listos, {action.errorCount} con error y {Math.max(action.totalCount - action.processedCount, 0)} pendientes.
                  </p>
                </div>
                <div className={styles.bulkProgressActions}>
                  {canPause && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => runAction(() => contactBulkActionsService.pause(actionId), 'Lote detenido')}
                      disabled={working}
                    >
                      <Pause size={16} />
                      Detener
                    </Button>
                  )}
                  {canResume && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => runAction(() => contactBulkActionsService.resume(actionId), 'Lote reanudado')}
                      disabled={working}
                    >
                      <Play size={16} />
                      Reanudar
                    </Button>
                  )}
                  {canEdit && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setShowReschedule(true)}
                      disabled={working}
                    >
                      <RefreshCw size={16} />
                      Editar horario
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => runAction(() => contactBulkActionsService.delete(actionId), 'Lote eliminado')}
                    disabled={working}
                  >
                    <Trash2 size={16} />
                    Eliminar
                  </Button>
                </div>
              </div>
              <div className={styles.bulkProgressTrack} aria-label={`Progreso ${progressPercent}%`}>
                <span style={{ width: `${progressPercent}%` }} />
              </div>
            </Card>

            <Card padding="none">
              <Table
                initialColumns={itemColumns}
                data={action.items || []}
                keyExtractor={(item) => item.id}
                searchable
                searchPlaceholder="Buscar contacto o resultado..."
                paginated
                pageSize={25}
                tableId="contact_bulk_action_items"
                emptyMessage="Este lote todavía no tiene contactos."
              />
            </Card>
          </>
        )}
      </div>

      <Modal isOpen={showReschedule} onClose={() => setShowReschedule(false)} title="Editar horario" size="md">
        <div className={styles.bulkModalBody}>
          <div className={styles.formGroup}>
            <label>Nueva fecha y hora</label>
            <input
              type="datetime-local"
              value={rescheduleAt}
              onChange={(event) => setRescheduleAt(event.target.value)}
              disabled={working}
            />
          </div>
          <label className={styles.bulkOptionToggle}>
            <input
              type="checkbox"
              checked={rescheduleDrip}
              onChange={(event) => setRescheduleDrip(event.target.checked)}
              disabled={working}
            />
            Mantener en modo goteo
          </label>
          {rescheduleDrip && (
            <div className={styles.bulkInlineField}>
              <NumberInput
                min={1}
                max={1440}
                value={rescheduleDripMinutes}
                onValueChange={setRescheduleDripMinutes}
                disabled={working}
              />
              <span>min entre contactos pendientes</span>
            </div>
          )}
          <div className={styles.formActions}>
            <Button type="button" variant="ghost" onClick={() => setShowReschedule(false)} disabled={working}>
              Cancelar
            </Button>
            <Button type="button" onClick={submitReschedule} loading={working}>
              Guardar horario
            </Button>
          </div>
        </div>
      </Modal>
    </PageContainer>
  )
}
