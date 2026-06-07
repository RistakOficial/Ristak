import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Edit3,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  Webhook,
  XCircle
} from 'lucide-react'
import { Button, Card } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import {
  OutgoingWebhookDelivery,
  OutgoingWebhookDestination,
  OutgoingWebhookEventOption,
  OutgoingWebhookScopes,
  SaveOutgoingWebhookDestinationPayload,
  outgoingWebhooksService
} from '@/services/outgoingWebhooksService'
import styles from './Settings.module.css'

const DEFAULT_EVENTS = ['contacts', 'appointments', 'payments', 'payment_plans', 'refunds']

interface FormState {
  name: string
  url: string
  scopeType: 'clinic' | 'user'
  scopeId: string
  events: string[]
  secret: string
  isActive: boolean
  maxRetries: number
}

const emptyForm: FormState = {
  name: '',
  url: '',
  scopeType: 'clinic',
  scopeId: '',
  events: DEFAULT_EVENTS,
  secret: '',
  isActive: true,
  maxRetries: 3
}

const statusLabels: Record<string, string> = {
  pending: 'En espera',
  sending: 'Enviando',
  sent: 'Enviado',
  failed: 'Con error',
  retrying: 'Reintentando'
}

const categoryLabels: Record<string, string> = {
  contacts: 'Contactos',
  appointments: 'Citas',
  payments: 'Pagos',
  payment_plans: 'Plan de pagos',
  refunds: 'Reembolsos',
  test: 'Prueba'
}

function formatDate(value: string | null) {
  if (!value) return 'Sin fecha'

  try {
    return new Date(value).toLocaleString('es-MX', {
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  } catch {
    return value
  }
}

function deliveryStatusClass(status: string) {
  if (status === 'sent') return styles.webhookStatusSent
  if (status === 'failed') return styles.webhookStatusFailed
  if (status === 'retrying') return styles.webhookStatusRetrying
  return styles.webhookStatusPending
}

function getScopeLabel(destination: OutgoingWebhookDestination, scopes: OutgoingWebhookScopes | null) {
  if (destination.scopeType === 'user') {
    const user = scopes?.users.find(item => item.id === destination.scopeId)
    return user?.label || 'Usuario'
  }

  return scopes?.clinic.label || 'Clínica'
}

function destinationToPayload(destination: OutgoingWebhookDestination): SaveOutgoingWebhookDestinationPayload {
  return {
    name: destination.name,
    url: destination.url,
    scopeType: destination.scopeType,
    scopeId: destination.scopeId,
    events: destination.events,
    isActive: destination.isActive,
    maxRetries: destination.maxRetries,
    timeoutMs: destination.timeoutMs
  }
}

export const OutgoingWebhooksSettings: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [destinations, setDestinations] = useState<OutgoingWebhookDestination[]>([])
  const [deliveries, setDeliveries] = useState<OutgoingWebhookDelivery[]>([])
  const [eventOptions, setEventOptions] = useState<OutgoingWebhookEventOption[]>([])
  const [scopes, setScopes] = useState<OutgoingWebhookScopes | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const activeCount = useMemo(
    () => destinations.filter(destination => destination.isActive).length,
    [destinations]
  )

  const loadOverview = async () => {
    setIsLoading(true)
    try {
      const overview = await outgoingWebhooksService.getOverview()
      setDestinations(overview.destinations)
      setDeliveries(overview.deliveries)
      setEventOptions(overview.eventOptions)
      setScopes(overview.scopes)
      setForm(current => ({
        ...current,
        scopeId: current.scopeId || overview.scopes.clinic.id,
        events: current.events.length > 0 ? current.events : overview.eventOptions.map(event => event.id)
      }))
    } catch (error: any) {
      showToast('error', 'No se pudo cargar', error.message || 'Revisa la conexión e intenta otra vez.')
    } finally {
      setIsLoading(false)
    }
  }

  const refreshDeliveries = async () => {
    try {
      const history = await outgoingWebhooksService.listDeliveries(50)
      setDeliveries(history)
    } catch (error: any) {
      showToast('error', 'No se actualizó el historial', error.message || 'Intenta de nuevo.')
    }
  }

  useEffect(() => {
    loadOverview()
  }, [])

  const resetForm = () => {
    setEditingId(null)
    setForm({
      ...emptyForm,
      scopeId: scopes?.clinic.id || ''
    })
  }

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(current => ({
      ...current,
      [key]: value
    }))
  }

  const toggleEvent = (eventId: string) => {
    setForm(current => {
      const selected = current.events.includes(eventId)
      if (selected && current.events.length === 1) {
        showToast('info', 'Deja un evento activo', 'El destino necesita al menos un tipo de evento.')
        return current
      }

      return {
        ...current,
        events: selected
          ? current.events.filter(item => item !== eventId)
          : [...current.events, eventId]
      }
    })
  }

  const buildPayload = (): SaveOutgoingWebhookDestinationPayload => {
    const payload: SaveOutgoingWebhookDestinationPayload = {
      name: form.name.trim(),
      url: form.url.trim(),
      scopeType: form.scopeType,
      scopeId: form.scopeType === 'user' ? form.scopeId : (form.scopeId || scopes?.clinic.id),
      events: form.events,
      isActive: form.isActive,
      maxRetries: form.maxRetries,
      timeoutMs: 10000
    }

    if (form.secret.trim()) {
      payload.secret = form.secret.trim()
    }

    return payload
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setIsSaving(true)

    try {
      const payload = buildPayload()
      const destination = editingId
        ? await outgoingWebhooksService.updateDestination(editingId, payload)
        : await outgoingWebhooksService.createDestination(payload)

      setDestinations(current => {
        const exists = current.some(item => item.id === destination.id)
        return exists
          ? current.map(item => item.id === destination.id ? destination : item)
          : [destination, ...current]
      })
      resetForm()
      showToast('success', editingId ? 'Destino actualizado' : 'Destino agregado', 'Ristak ya puede enviar eventos a esa URL.')
    } catch (error: any) {
      showToast('error', 'No se pudo guardar', error.message || 'Revisa la URL y los eventos seleccionados.')
    } finally {
      setIsSaving(false)
    }
  }

  const editDestination = (destination: OutgoingWebhookDestination) => {
    setEditingId(destination.id)
    setForm({
      name: destination.name,
      url: destination.url,
      scopeType: destination.scopeType,
      scopeId: destination.scopeId,
      events: destination.events,
      secret: '',
      isActive: destination.isActive,
      maxRetries: destination.maxRetries
    })
  }

  const toggleDestination = async (destination: OutgoingWebhookDestination) => {
    setBusyId(destination.id)
    try {
      const updated = await outgoingWebhooksService.updateDestination(destination.id, {
        ...destinationToPayload(destination),
        isActive: !destination.isActive
      })
      setDestinations(current => current.map(item => item.id === updated.id ? updated : item))
      showToast('success', updated.isActive ? 'Destino encendido' : 'Destino pausado')
    } catch (error: any) {
      showToast('error', 'No se pudo cambiar el estado', error.message || 'Intenta de nuevo.')
    } finally {
      setBusyId(null)
    }
  }

  const deleteDestination = (destination: OutgoingWebhookDestination) => {
    showConfirm(
      'Eliminar destino',
      `Ristak dejará de enviar eventos a "${destination.name}". El historial anterior se conserva.`,
      async () => {
        setBusyId(destination.id)
        try {
          await outgoingWebhooksService.deleteDestination(destination.id)
          setDestinations(current => current.filter(item => item.id !== destination.id))
          if (editingId === destination.id) resetForm()
          showToast('success', 'Destino eliminado')
        } catch (error: any) {
          showToast('error', 'No se pudo eliminar', error.message || 'Intenta de nuevo.')
        } finally {
          setBusyId(null)
        }
      },
      'Eliminar',
      'Cancelar'
    )
  }

  const sendTest = async (destination: OutgoingWebhookDestination) => {
    setBusyId(destination.id)
    try {
      const delivery = await outgoingWebhooksService.sendTest(destination.id)
      await refreshDeliveries()
      showToast(
        delivery.status === 'sent' ? 'success' : 'warning',
        delivery.status === 'sent' ? 'Prueba enviada' : 'Prueba con error',
        delivery.status === 'sent' ? 'La URL respondió correctamente.' : delivery.errorMessage || 'Revisa el historial.'
      )
    } catch (error: any) {
      showToast('error', 'No se pudo probar', error.message || 'Intenta de nuevo.')
    } finally {
      setBusyId(null)
    }
  }

  const retryDelivery = async (delivery: OutgoingWebhookDelivery) => {
    setBusyId(delivery.id)
    try {
      await outgoingWebhooksService.retryDelivery(delivery.id)
      await refreshDeliveries()
      showToast('success', 'Reintento enviado')
    } catch (error: any) {
      showToast('error', 'No se pudo reintentar', error.message || 'Intenta de nuevo.')
    } finally {
      setBusyId(null)
    }
  }

  const scopeUsers = scopes?.users || []

  return (
    <div className={styles.settingsContent}>
      <Card>
        <div className={styles.panelHeader}>
          <div className={styles.panelHeaderLeft}>
            <div className={styles.iconBox}>
              <Webhook size={22} />
            </div>
            <div>
              <h2 className={styles.panelTitle}>Webhooks salientes</h2>
              <p className={styles.panelDescription}>
                Envía eventos por POST a sistemas externos cuando cambien contactos, citas, pagos, planes o reembolsos.
              </p>
            </div>
          </div>
          <div className={styles.panelHeaderActions}>
            <span className={activeCount > 0 ? styles.statusConnected : styles.statusDisconnected}>
              {activeCount > 0 ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              {activeCount > 0 ? `${activeCount} activo${activeCount === 1 ? '' : 's'}` : 'Sin destinos'}
            </span>
            <Button variant="secondary" onClick={loadOverview} disabled={isLoading}>
              <RefreshCw size={17} />
              Actualizar
            </Button>
          </div>
        </div>

        <div className={styles.webhooksLayout}>
          <form className={styles.webhookForm} onSubmit={handleSubmit}>
            <div>
              <h3 className={styles.webhookSectionTitle}>{editingId ? 'Editar destino' : 'Nuevo destino'}</h3>
              <p className={styles.webhookSectionText}>Agrega una URL y elige qué eventos recibirá.</p>
            </div>

            <div className={styles.webhookFieldGrid}>
              <label className={styles.field}>
                <span className={styles.label}>Nombre</span>
                <input
                  className={styles.input}
                  value={form.name}
                  onChange={event => updateForm('name', event.target.value)}
                  placeholder="CRM, Make, Zapier..."
                  required
                />
              </label>

              <label className={styles.field}>
                <span className={styles.label}>URL para POST</span>
                <input
                  className={styles.input}
                  value={form.url}
                  onChange={event => updateForm('url', event.target.value)}
                  placeholder="https://..."
                  inputMode="url"
                  required
                />
              </label>
            </div>

            <div className={styles.webhookScopeRow}>
              <div>
                <span className={styles.label}>Aplicar a</span>
                <div className={styles.webhookSegment}>
                  <button
                    type="button"
                    className={`${styles.webhookSegmentButton} ${form.scopeType === 'clinic' ? styles.webhookSegmentButtonActive : ''}`}
                    onClick={() => setForm(current => ({ ...current, scopeType: 'clinic', scopeId: scopes?.clinic.id || '' }))}
                  >
                    Clínica
                  </button>
                  <button
                    type="button"
                    className={`${styles.webhookSegmentButton} ${form.scopeType === 'user' ? styles.webhookSegmentButtonActive : ''}`}
                    onClick={() => setForm(current => ({ ...current, scopeType: 'user', scopeId: scopeUsers[0]?.id || '' }))}
                  >
                    Usuario
                  </button>
                </div>
              </div>

              <label className={styles.field}>
                <span className={styles.label}>{form.scopeType === 'user' ? 'Usuario' : 'Clínica'}</span>
                <select
                  className={styles.select}
                  value={form.scopeId}
                  onChange={event => updateForm('scopeId', event.target.value)}
                >
                  {form.scopeType === 'user' ? (
                    scopeUsers.map(user => (
                      <option key={user.id} value={user.id}>{user.label}</option>
                    ))
                  ) : (
                    <option value={scopes?.clinic.id || ''}>{scopes?.clinic.label || 'Clínica actual'}</option>
                  )}
                </select>
              </label>

              <label className={styles.field}>
                <span className={styles.label}>Reintentos</span>
                <select
                  className={styles.select}
                  value={form.maxRetries}
                  onChange={event => updateForm('maxRetries', Number(event.target.value))}
                >
                  <option value={0}>Sin reintentos</option>
                  <option value={1}>1 reintento</option>
                  <option value={3}>3 reintentos</option>
                  <option value={5}>5 reintentos</option>
                </select>
              </label>
            </div>

            <label className={styles.field}>
              <span className={styles.label}>Llave secreta opcional</span>
              <input
                className={styles.input}
                value={form.secret}
                onChange={event => updateForm('secret', event.target.value)}
                placeholder={editingId ? 'Déjalo vacío para conservar la actual' : 'Para que el sistema externo confirme que viene de Ristak'}
              />
            </label>

            <div className={styles.webhookEventsBlock}>
              <span className={styles.label}>Eventos a enviar</span>
              <div className={styles.webhookEventGrid}>
                {(eventOptions.length > 0 ? eventOptions : DEFAULT_EVENTS.map(id => ({ id, label: categoryLabels[id], description: '' }))).map(event => {
                  const selected = form.events.includes(event.id)
                  return (
                    <button
                      key={event.id}
                      type="button"
                      className={`${styles.webhookEventOption} ${selected ? styles.webhookEventOptionActive : ''}`}
                      onClick={() => toggleEvent(event.id)}
                    >
                      <strong>{event.label}</strong>
                      {event.description && <span>{event.description}</span>}
                    </button>
                  )
                })}
              </div>
            </div>

            <label className={styles.webhookCheckboxRow}>
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={event => updateForm('isActive', event.target.checked)}
              />
              <span>Enviar eventos a este destino</span>
            </label>

            <div className={styles.webhookFormActions}>
              {editingId && (
                <Button type="button" variant="secondary" onClick={resetForm}>
                  Cancelar
                </Button>
              )}
              <Button type="submit" loading={isSaving}>
                {editingId ? <CheckCircle2 size={17} /> : <Plus size={17} />}
                {editingId ? 'Guardar cambios' : 'Agregar URL'}
              </Button>
            </div>
          </form>

          <div className={styles.webhookDestinationList}>
            <div>
              <h3 className={styles.webhookSectionTitle}>Destinos configurados</h3>
              <p className={styles.webhookSectionText}>Cada destino recibe solo los eventos elegidos.</p>
            </div>

            {isLoading ? (
              <div className={styles.webhookEmptyState}>Cargando destinos...</div>
            ) : destinations.length === 0 ? (
              <div className={styles.webhookEmptyState}>Agrega una URL para empezar a enviar eventos.</div>
            ) : (
              destinations.map(destination => (
                <div key={destination.id} className={styles.webhookDestinationItem}>
                  <div className={styles.webhookDestinationMain}>
                    <div className={destination.isActive ? styles.webhookDotActive : styles.webhookDotPaused} />
                    <div>
                      <strong>{destination.name}</strong>
                      <span>{destination.url}</span>
                      <small>{getScopeLabel(destination, scopes)} · {destination.events.map(event => categoryLabels[event] || event).join(', ')}</small>
                    </div>
                  </div>

                  <div className={styles.webhookIconActions}>
                    <button type="button" title="Enviar prueba" onClick={() => sendTest(destination)} disabled={busyId === destination.id}>
                      <Send size={16} />
                    </button>
                    <button type="button" title="Editar" onClick={() => editDestination(destination)} disabled={busyId === destination.id}>
                      <Edit3 size={16} />
                    </button>
                    <button type="button" title={destination.isActive ? 'Pausar' : 'Activar'} onClick={() => toggleDestination(destination)} disabled={busyId === destination.id}>
                      {destination.isActive ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
                    </button>
                    <button type="button" title="Eliminar" onClick={() => deleteDestination(destination)} disabled={busyId === destination.id}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </Card>

      <Card>
        <div className={styles.webhookHistoryHeader}>
          <div>
            <h3 className={styles.webhookSectionTitle}>Historial de envíos</h3>
            <p className={styles.webhookSectionText}>Consulta respuestas, errores y reintentos de los últimos eventos.</p>
          </div>
          <Button variant="secondary" onClick={refreshDeliveries}>
            <RefreshCw size={17} />
            Actualizar historial
          </Button>
        </div>

        {deliveries.length === 0 ? (
          <div className={styles.webhookEmptyState}>Todavía no hay envíos registrados.</div>
        ) : (
          <div className={styles.webhookHistoryTableWrap}>
            <table className={styles.webhookHistoryTable}>
              <thead>
                <tr>
                  <th>Evento</th>
                  <th>Destino</th>
                  <th>Estado</th>
                  <th>Respuesta</th>
                  <th>Fecha</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {deliveries.map(delivery => (
                  <tr key={delivery.id}>
                    <td>
                      <strong>{categoryLabels[delivery.eventCategory] || delivery.eventCategory}</strong>
                      <span>{delivery.eventType}</span>
                    </td>
                    <td>{delivery.destinationName}</td>
                    <td>
                      <span className={`${styles.webhookStatusBadge} ${deliveryStatusClass(delivery.status)}`}>
                        {delivery.status === 'failed' ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
                        {statusLabels[delivery.status] || delivery.status}
                      </span>
                    </td>
                    <td>
                      <span className={styles.webhookHistoryResponse}>
                        {delivery.httpStatus ? `HTTP ${delivery.httpStatus}` : delivery.errorMessage || 'Sin respuesta'}
                      </span>
                      {delivery.attemptCount > 0 && <small>{delivery.attemptCount}/{delivery.maxRetries} intento(s)</small>}
                    </td>
                    <td>{formatDate(delivery.createdAt)}</td>
                    <td>
                      {(delivery.status === 'failed' || delivery.status === 'retrying') && (
                        <button
                          type="button"
                          className={styles.webhookRetryButton}
                          onClick={() => retryDelivery(delivery)}
                          disabled={busyId === delivery.id}
                          title="Reintentar envío"
                        >
                          <RotateCcw size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
