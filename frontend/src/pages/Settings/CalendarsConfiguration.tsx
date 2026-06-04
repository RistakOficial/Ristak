import React, { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Card, Button, Modal, CustomSelect, Loading } from '@/components/common'
import {
  Calendar,
  Loader2,
  CheckCircle,
  XCircle,
  Info,
  Settings,
  Plus,
  Copy,
  ExternalLink,
  Globe2,
  KeyRound,
  TestTube2,
  Trash2,
  ShieldCheck,
  Star,
  BookOpen,
  PlayCircle,
  FileKey2,
  ListChecks,
  SlidersHorizontal
} from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { useAppConfig, useHighLevelConnected } from '@/hooks'
import { useAuth } from '@/contexts/AuthContext'
import { calendarsService, type Calendar as CalendarType, type GoogleCalendarIntegrationStatus } from '@/services/calendarsService'
import styles from './HighLevelIntegration.module.css'
import pageStyles from './CalendarsConfiguration.module.css'

type CalendarSettingsTab = 'calendars' | 'google'

const GOOGLE_HELP_LINKS = {
  calendarApi: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
  serviceAccounts: 'https://docs.cloud.google.com/iam/docs/service-accounts-create',
  serviceAccountKeys: 'https://docs.cloud.google.com/iam/docs/keys-create-delete',
  shareCalendar: 'https://support.google.com/calendar/answer/37082',
  videoSearch: 'https://www.youtube.com/results?search_query=Google+Cloud+service+account+JSON+key+Google+Calendar+API'
}

export const CalendarsConfiguration: React.FC = () => {
  const { showToast } = useNotification()
  const { locationId, accessToken } = useAuth()

  // Estados de configuración (usa sistema híbrido)
  const [defaultCalendarId, setDefaultCalendarId] = useAppConfig<string>('default_calendar_id', '')
  const [attributionCalendarIds, setAttributionCalendarIds] = useAppConfig<string[]>('attribution_calendar_ids', [])
  const [calendarSourcePreference, setCalendarSourcePreference] = useAppConfig<'combined' | 'ristak' | 'ghl'>('calendar_source_preference', 'combined')

  // El origen de calendarios solo tiene sentido con una integración de terceros
  // (HighLevel). Sin ella, Ristak es la única fuente posible.
  const { connected: highLevelConnected, loading: highLevelLoading } = useHighLevelConnected()

  // Estados locales
  const [calendars, setCalendars] = useState<CalendarType[]>([])
  const [loadingCalendars, setLoadingCalendars] = useState(true)
  const [activeTab, setActiveTab] = useState<CalendarSettingsTab>('calendars')
  const [googleIntegration, setGoogleIntegration] = useState<GoogleCalendarIntegrationStatus | null>(null)
  const [loadingGoogleIntegration, setLoadingGoogleIntegration] = useState(true)
  const [savingGoogleIntegration, setSavingGoogleIntegration] = useState(false)
  const [testingGoogleIntegration, setTestingGoogleIntegration] = useState(false)
  const [disconnectingGoogleIntegration, setDisconnectingGoogleIntegration] = useState(false)
  const [googleCalendarId, setGoogleCalendarId] = useState('')
  const [serviceAccountJson, setServiceAccountJson] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [creatingCalendar, setCreatingCalendar] = useState(false)
  const [newCalendar, setNewCalendar] = useState<Partial<CalendarType>>({
    name: '',
    calendarType: 'event',
    eventTitle: 'Cita',
    eventColor: '#3b82f6',
    isActive: true,
    slotDuration: 60,
    slotDurationUnit: 'mins',
    slotInterval: 60,
    slotIntervalUnit: 'mins',
    appoinmentPerSlot: 1,
    appoinmentPerDay: 0,
    allowBookingAfter: 0,
    allowBookingAfterUnit: 'hours',
    allowBookingFor: 30,
    allowBookingForUnit: 'days'
  })

  // Estados del modal de configuración
  const [showConfigModal, setShowConfigModal] = useState(false)
  const [selectedCalendar, setSelectedCalendar] = useState<CalendarType | null>(null)
  const [savingConfig, setSavingConfig] = useState(false)

  // Cargar calendarios al montar
  useEffect(() => {
    loadCalendars()
  }, [locationId, accessToken, calendarSourcePreference])

  useEffect(() => {
    loadGoogleIntegration()
  }, [])

  // Sin integración conectada el selector de origen queda oculto. Si había quedado
  // en "Solo HighLevel", se volvería a Ristak para no esconder sus calendarios
  // (de lo contrario no habría forma de recuperarlos sin el selector).
  useEffect(() => {
    if (!highLevelLoading && !highLevelConnected && calendarSourcePreference === 'ghl') {
      setCalendarSourcePreference('ristak').catch(() => {})
    }
  }, [highLevelLoading, highLevelConnected, calendarSourcePreference, setCalendarSourcePreference])

  // Con un único calendario, ese es el predeterminado: no tiene sentido pedir
  // selección manual cuando solo existe la opción de Ristak.
  useEffect(() => {
    if (!loadingCalendars && calendars.length === 1 && !defaultCalendarId) {
      setDefaultCalendarId(calendars[0].id).catch(() => {})
    }
  }, [loadingCalendars, calendars, defaultCalendarId, setDefaultCalendarId])

  const loadCalendars = async () => {
    try {
      setLoadingCalendars(true)
      const data = await calendarsService.getCalendars(locationId, accessToken)
      setCalendars(data)
    } catch (error: any) {
      showToast('error', 'Error al cargar calendarios', error.message)
    } finally {
      setLoadingCalendars(false)
    }
  }

  const loadGoogleIntegration = async () => {
    try {
      setLoadingGoogleIntegration(true)
      const data = await calendarsService.getGoogleIntegration()
      setGoogleIntegration(data)
      setGoogleCalendarId(data.calendarId || '')
    } catch (error: any) {
      showToast('error', 'Error al cargar Google Calendar', error.message || 'No se pudo leer la integración')
    } finally {
      setLoadingGoogleIntegration(false)
    }
  }

  const parsedServiceAccountEmail = useMemo(() => {
    if (!serviceAccountJson.trim()) return ''
    try {
      const parsed = JSON.parse(serviceAccountJson)
      return typeof parsed?.client_email === 'string' ? parsed.client_email : ''
    } catch {
      return ''
    }
  }, [serviceAccountJson])

  const serviceAccountEmailForSharing = parsedServiceAccountEmail || googleIntegration?.serviceAccountEmail || ''

  const handleCopyServiceAccountEmail = async () => {
    if (!serviceAccountEmailForSharing) {
      showToast('warning', 'Email no disponible', 'Guarda o pega primero el JSON del Service Account')
      return
    }

    try {
      await navigator.clipboard.writeText(serviceAccountEmailForSharing)
      showToast('success', 'Email copiado', serviceAccountEmailForSharing)
    } catch {
      showToast('error', 'No se pudo copiar', 'Copia el email manualmente')
    }
  }

  const handleSaveGoogleIntegration = async () => {
    if (!googleCalendarId.trim()) {
      showToast('error', 'Calendar ID requerido', 'Pega el ID del calendario de Google que quieres conectar')
      return
    }

    if (!serviceAccountJson.trim() && !googleIntegration?.connected) {
      showToast('error', 'Credenciales requeridas', 'Pega el JSON del Service Account para conectar por primera vez')
      return
    }

    setSavingGoogleIntegration(true)
    try {
      const data = await calendarsService.saveGoogleIntegration({
        calendarId: googleCalendarId.trim(),
        serviceAccountJson: serviceAccountJson.trim()
      })
      setGoogleIntegration(data)
      setGoogleCalendarId(data.calendarId || googleCalendarId.trim())
      setServiceAccountJson('')
      showToast('success', 'Google Calendar guardado', 'Ahora prueba la conexión para validar permisos reales')
    } catch (error: any) {
      showToast('error', 'No se pudo guardar Google Calendar', error.message || 'Revisa el JSON y Calendar ID')
    } finally {
      setSavingGoogleIntegration(false)
    }
  }

  const handleTestGoogleIntegration = async () => {
    setTestingGoogleIntegration(true)
    try {
      const data = await calendarsService.testGoogleIntegration()
      setGoogleIntegration(data)
      setGoogleCalendarId(data.calendarId || googleCalendarId)
      showToast('success', 'Google Calendar probado', data.lastTestMessage || 'Permisos validados correctamente')
    } catch (error: any) {
      await loadGoogleIntegration()
      showToast('error', 'La prueba falló', error.message || 'Revisa permisos del calendario')
    } finally {
      setTestingGoogleIntegration(false)
    }
  }

  const handleDisconnectGoogleIntegration = async () => {
    if (!window.confirm('¿Desconectar Google Calendar de esta instalación? Las citas locales se conservan.')) return

    setDisconnectingGoogleIntegration(true)
    try {
      const data = await calendarsService.deleteGoogleIntegration()
      setGoogleIntegration(data)
      setGoogleCalendarId('')
      setServiceAccountJson('')
      showToast('success', 'Google Calendar desconectado', 'La integración quedó removida de esta instalación')
    } catch (error: any) {
      showToast('error', 'No se pudo desconectar', error.message || 'Intenta nuevamente')
    } finally {
      setDisconnectingGoogleIntegration(false)
    }
  }

  // Guardado automático: Calendario predeterminado
  const handleDefaultCalendarChange = async (calendarId: string) => {
    try {
      await setDefaultCalendarId(calendarId)
      showToast('success', 'Calendario predeterminado guardado', calendarId ? 'Se seleccionará automáticamente al abrir Citas' : 'Deberás seleccionar manualmente')
    } catch (error: any) {
      showToast('error', 'Error al guardar', error.message)
    }
  }

  // Guardado automático: Toggle individual de atribución
  const handleAttributionToggle = async (calendarId: string) => {
    const newSelection = attributionCalendarIds.includes(calendarId)
      ? attributionCalendarIds.filter(id => id !== calendarId)
      : [...attributionCalendarIds, calendarId]

    try {
      await setAttributionCalendarIds(newSelection)
      showToast('success', 'Calendarios de atribución actualizados', `${newSelection.length} calendario${newSelection.length !== 1 ? 's' : ''} seleccionado${newSelection.length !== 1 ? 's' : ''}`)
    } catch (error: any) {
      showToast('error', 'Error al guardar', error.message)
    }
  }

  // Guardado automático: Seleccionar/Deseleccionar todos
  const handleSelectAllAttribution = async () => {
    const newSelection = attributionCalendarIds.length === calendars.length
      ? []  // Deseleccionar todos
      : calendars.map(cal => cal.id)  // Seleccionar todos

    try {
      await setAttributionCalendarIds(newSelection)
      const action = newSelection.length === 0 ? 'Todos deseleccionados' : 'Todos seleccionados'
      showToast('success', 'Calendarios de atribución actualizados', action)
    } catch (error: any) {
      showToast('error', 'Error al guardar', error.message)
    }
  }

  const handleOpenConfigModal = (calendar: CalendarType) => {
    setSelectedCalendar(calendar)
    setShowConfigModal(true)
  }

  const handleCloseConfigModal = () => {
    setShowConfigModal(false)
    setSelectedCalendar(null)
  }

  const handleSaveCalendarConfig = async () => {
    if (!selectedCalendar) return

    setSavingConfig(true)
    try {
      // Construir payload con todos los campos editables
      const updateData: any = {
        slotDuration: selectedCalendar.slotDuration,
        slotDurationUnit: selectedCalendar.slotDurationUnit,
        slotInterval: selectedCalendar.slotInterval,
        slotIntervalUnit: selectedCalendar.slotIntervalUnit,
        preBuffer: selectedCalendar.preBuffer || 0,
        preBufferUnit: selectedCalendar.preBufferUnit || 'mins',
        slotBuffer: selectedCalendar.slotBuffer || 0,
        slotBufferUnit: selectedCalendar.slotBufferUnit || 'mins',
        allowBookingAfter: selectedCalendar.allowBookingAfter || 0,
        allowBookingAfterUnit: selectedCalendar.allowBookingAfterUnit || 'hours',
        allowBookingFor: selectedCalendar.allowBookingFor || 30,
        allowBookingForUnit: selectedCalendar.allowBookingForUnit || 'days',
        appoinmentPerSlot: selectedCalendar.appoinmentPerSlot,
        appoinmentPerDay: selectedCalendar.appoinmentPerDay
      }

      // Agregar lookBusyConfig si está configurado
      if (selectedCalendar.lookBusyConfig) {
        updateData.lookBusyConfig = {
          enabled: selectedCalendar.lookBusyConfig.enabled,
          LookBusyPercentage: selectedCalendar.lookBusyConfig.LookBusyPercentage
        }
      }

      // Agregar availabilityType si está configurado
      if (selectedCalendar.availabilityType !== undefined) {
        updateData.availabilityType = selectedCalendar.availabilityType
      }

      await calendarsService.updateCalendar(selectedCalendar.id, updateData, accessToken || undefined)

      showToast('success', 'Configuración de calendario actualizada', accessToken ? `Los cambios se guardaron en ${selectedCalendar.name}` : `Los cambios quedaron guardados en Ristak y pendientes de sync`)
      handleCloseConfigModal()
      loadCalendars() // Recargar calendarios para ver cambios
    } catch (error: any) {
      showToast('error', 'Error al actualizar calendario', error.message)
    } finally {
      setSavingConfig(false)
    }
  }

  const handleCreateCalendar = async () => {
    if (!newCalendar.name?.trim()) {
      showToast('error', 'Nombre requerido', 'Escribe un nombre para el calendario')
      return
    }

    setCreatingCalendar(true)
    try {
      const created = await calendarsService.createCalendar({
        ...newCalendar,
        name: newCalendar.name.trim(),
        eventTitle: newCalendar.eventTitle || newCalendar.name.trim()
      }, accessToken || undefined)

      showToast(
        'success',
        'Calendario creado',
        accessToken
          ? 'Se guardó en Ristak y se intentó sincronizar con HighLevel'
          : 'Se guardó en Ristak y se sincronizará cuando conectes HighLevel'
      )

      if (created?.id && !defaultCalendarId) {
        await setDefaultCalendarId(created.id)
      }

      setShowCreateModal(false)
      setNewCalendar({
        name: '',
        calendarType: 'event',
        eventTitle: 'Cita',
        eventColor: '#3b82f6',
        isActive: true,
        slotDuration: 60,
        slotDurationUnit: 'mins',
        slotInterval: 60,
        slotIntervalUnit: 'mins',
        appoinmentPerSlot: 1,
        appoinmentPerDay: 0,
        allowBookingAfter: 0,
        allowBookingAfterUnit: 'hours',
        allowBookingFor: 30,
        allowBookingForUnit: 'days'
      })
      await loadCalendars()
    } catch (error: any) {
      showToast('error', 'Error al crear calendario', error.message || 'Intenta nuevamente')
    } finally {
      setCreatingCalendar(false)
    }
  }

  const handleCopyPublicUrl = async (calendar: CalendarType) => {
    if (!calendar.publicUrl) {
      showToast('warning', 'URL no disponible', calendar.publicUrlUnavailableReason || 'Conecta y verifica el dominio publico general primero')
      return
    }

    try {
      await navigator.clipboard.writeText(calendar.publicUrl)
      showToast('success', 'URL copiada', calendar.publicUrl)
    } catch {
      showToast('error', 'No se pudo copiar', 'Copia la URL manualmente')
    }
  }

  const renderCreateCalendarModal = () => showCreateModal ? createPortal(
    <Modal
      isOpen={showCreateModal}
      onClose={() => setShowCreateModal(false)}
      title="Crear calendario"
      size="md"
    >
      <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
        <div className={styles.formField}>
          <label className={styles.label}>Nombre</label>
          <input
            className={styles.input}
            value={newCalendar.name || ''}
            onChange={(e) => setNewCalendar({ ...newCalendar, name: e.target.value, eventTitle: newCalendar.eventTitle || e.target.value })}
            placeholder="Ej. Consultas de ventas"
          />
        </div>

        <div className={styles.formField}>
          <label className={styles.label}>Título de evento</label>
          <input
            className={styles.input}
            value={newCalendar.eventTitle || ''}
            onChange={(e) => setNewCalendar({ ...newCalendar, eventTitle: e.target.value })}
            placeholder="Ej. Cita"
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div className={styles.formField}>
            <label className={styles.label}>Duración</label>
            <input
              type="number"
              className={styles.input}
              value={newCalendar.slotDuration || 60}
              min="1"
              onChange={(e) => setNewCalendar({ ...newCalendar, slotDuration: parseInt(e.target.value, 10) || 60 })}
            />
          </div>
          <div className={styles.formField}>
            <label className={styles.label}>Intervalo</label>
            <input
              type="number"
              className={styles.input}
              value={newCalendar.slotInterval || 60}
              min="1"
              onChange={(e) => setNewCalendar({ ...newCalendar, slotInterval: parseInt(e.target.value, 10) || 60 })}
            />
          </div>
        </div>

        <div className={styles.formField}>
          <label className={styles.label}>Color</label>
          <input
            type="color"
            value={newCalendar.eventColor || '#3b82f6'}
            onChange={(e) => setNewCalendar({ ...newCalendar, eventColor: e.target.value })}
            style={{ width: 56, height: 38, padding: 0, border: '1px solid var(--color-border)', borderRadius: 6, background: 'transparent' }}
          />
        </div>

        <div style={{ display: 'flex', gap: '12px', paddingTop: '8px', borderTop: '1px solid var(--color-border)' }}>
          <Button onClick={handleCreateCalendar} disabled={creatingCalendar}>
            {creatingCalendar ? (
              <>
                <Loader2 size={18} className={styles.spinIcon} />
                Creando...
              </>
            ) : (
              'Crear calendario'
            )}
          </Button>
          <Button variant="ghost" onClick={() => setShowCreateModal(false)} disabled={creatingCalendar}>
            Cancelar
          </Button>
        </div>
      </div>
    </Modal>,
    document.body
  ) : null

  const handleCalendarSourcePreferenceChange = async (value: string) => {
    const nextValue = value as 'combined' | 'ristak' | 'ghl'
    await setCalendarSourcePreference(nextValue)
    showToast(
      'success',
      'Origen guardado',
      nextValue === 'combined'
        ? 'Ristak y HighLevel se mostrarán juntos'
        : nextValue === 'ristak'
          ? 'Solo se mostrarán calendarios de Ristak'
          : 'Solo se mostrarán calendarios de HighLevel'
    )
    await loadCalendars()
  }

  const renderCalendarSourceSelect = () => highLevelConnected ? (
    <div className={pageStyles.sourceControl}>
      <SlidersHorizontal size={16} />
      <span>Origen</span>
      <CustomSelect
        className={pageStyles.sourceSelect}
        value={calendarSourcePreference}
        onChange={handleCalendarSourcePreferenceChange}
        options={[
          { value: 'combined', label: 'Ristak + HighLevel' },
          { value: 'ristak', label: 'Solo Ristak' },
          { value: 'ghl', label: 'Solo HighLevel' }
        ]}
      />
    </div>
  ) : null

  const renderCalendarSourceBadge = (calendar: CalendarType) => (
    <span className={pageStyles.metaPill}>
      {calendar.source === 'ghl' ? 'HighLevel' : 'Ristak'}
    </span>
  )

  const renderCalendarRow = (calendar: CalendarType) => {
    const isAttributed = attributionCalendarIds.includes(calendar.id)
    const isDefault = defaultCalendarId === calendar.id

    return (
      <article
        key={calendar.id}
        className={`${pageStyles.calendarRow} ${isDefault ? pageStyles.calendarRowDefault : ''}`}
      >
        <div className={pageStyles.calendarIdentity}>
          <span
            className={pageStyles.calendarColor}
            style={{ backgroundColor: calendar.eventColor || 'var(--color-primary)' }}
          />
          <div className={pageStyles.calendarMain}>
            <div className={pageStyles.calendarTitleLine}>
              <h3>{calendar.name}</h3>
              {isDefault && (
                <span className={pageStyles.defaultPill}>
                  <Star size={13} />
                  Predeterminado
                </span>
              )}
              {renderCalendarSourceBadge(calendar)}
            </div>

            <div className={pageStyles.calendarMeta}>
              <span>{calendar.slotDuration} {calendar.slotDurationUnit}</span>
              <span>Cada {calendar.slotInterval} {calendar.slotIntervalUnit}</span>
              <span>{calendar.isActive ? 'Activo' : 'Inactivo'}</span>
            </div>

            <div className={pageStyles.publicUrlLine}>
              <Globe2 size={15} />
              <span title={calendar.publicUrl || calendar.publicUrlUnavailableReason || ''}>
                {calendar.publicUrl || calendar.publicUrlUnavailableReason || 'URL publica pendiente'}
              </span>
              <button
                type="button"
                className={pageStyles.iconAction}
                onClick={() => handleCopyPublicUrl(calendar)}
                disabled={!calendar.publicUrl}
                title="Copiar URL"
              >
                <Copy size={14} />
              </button>
              {calendar.publicUrl && (
                <a
                  className={pageStyles.iconActionLink}
                  href={calendar.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Abrir URL publica"
                >
                  <ExternalLink size={14} />
                </a>
              )}
            </div>
          </div>
        </div>

        <div className={pageStyles.calendarActions}>
          {!isDefault && (
            <Button
              variant="outline"
              size="small"
              onClick={() => handleDefaultCalendarChange(calendar.id)}
            >
              <Star size={15} />
              Usar como predeterminado
            </Button>
          )}
          <div className={styles.toggleContainer}>
            <button
              type="button"
              className={`${styles.toggle} ${isAttributed ? styles.toggleActive : ''}`}
              onClick={() => handleAttributionToggle(calendar.id)}
              aria-pressed={isAttributed}
              aria-label={`Conversión para ${calendar.name}`}
              title="Cuenta como conversión"
            >
              <span className={styles.toggleThumb} />
            </button>
            <span className={`${styles.toggleLabel} ${isAttributed ? styles.toggleLabelActive : ''}`}>
              Conversión
            </span>
          </div>
          <Button
            variant="ghost"
            size="small"
            onClick={() => handleOpenConfigModal(calendar)}
          >
            <Settings size={15} />
            Configurar
          </Button>
        </div>
      </article>
    )
  }

  const renderCalendarsTab = () => (
    <div className={pageStyles.tabPanel}>
      <div className={pageStyles.panelToolbar}>
        <div>
          <h2>Tus calendarios</h2>
          <p>{calendars.length} calendario{calendars.length !== 1 ? 's' : ''} conectado{calendars.length !== 1 ? 's' : ''}</p>
        </div>
        <div className={pageStyles.toolbarActions}>
          {renderCalendarSourceSelect()}
          <Button variant="outline" size="small" onClick={() => setShowCreateModal(true)}>
            <Plus size={16} />
            Crear calendario
          </Button>
        </div>
      </div>

      <div className={pageStyles.attributionBar}>
        <div>
          <strong>{attributionCalendarIds.length}/{calendars.length}</strong>
          <span>marcados como conversión</span>
        </div>
        <Button variant="ghost" size="small" onClick={handleSelectAllAttribution} disabled={calendars.length === 0}>
          {allSelected ? 'Desmarcar todos' : 'Marcar todos'}
        </Button>
      </div>

      <details className={pageStyles.compactHelp}>
        <summary>¿Qué significa “conversión”?</summary>
        <p>Los calendarios marcados alimentan citas en reportes, campañas, viaje del cliente y eventos de Meta/WhatsApp. Si no marcas ninguno, Ristak toma todos.</p>
      </details>

      {calendars.length > 0 ? (
        <div className={pageStyles.calendarList}>
          {calendars.map(renderCalendarRow)}
        </div>
      ) : (
        <div className={pageStyles.emptyState}>
          <Calendar size={34} />
          <h3>No hay calendarios todavía</h3>
          <p>Crea el primero para empezar a agendar desde Ristak.</p>
          <Button onClick={() => setShowCreateModal(true)}>
            <Plus size={16} />
            Crear calendario
          </Button>
        </div>
      )}
    </div>
  )

  const renderGoogleCalendarTab = () => {
    const isConnected = Boolean(googleIntegration?.connected)
    const testOk = googleIntegration?.lastTestStatus === 'success'
    const testFailed = googleIntegration?.lastTestStatus === 'error'

    return (
      <div className={pageStyles.googleLayout}>
        <section className={pageStyles.connectionPanel}>
          <div className={pageStyles.connectionHeader}>
            <div>
              <h2>Google Calendar</h2>
              <p>Conexión por Service Account, sin pedir OAuth al cliente.</p>
            </div>
            {loadingGoogleIntegration ? (
              <span className={pageStyles.statusPill}>
                <Loader2 size={15} className={styles.spinIcon} />
                Cargando
              </span>
            ) : testOk ? (
              <span className={`${pageStyles.statusPill} ${pageStyles.statusOk}`}>
                <CheckCircle size={15} />
                Probado
              </span>
            ) : isConnected ? (
              <span className={`${pageStyles.statusPill} ${pageStyles.statusWarn}`}>
                <Info size={15} />
                Guardado
              </span>
            ) : (
              <span className={`${pageStyles.statusPill} ${pageStyles.statusOff}`}>
                <XCircle size={15} />
                Sin conectar
              </span>
            )}
          </div>

          <div className={pageStyles.formGrid}>
            <label className={pageStyles.field}>
              <span>Calendar ID</span>
              <input
                value={googleCalendarId}
                onChange={(event) => setGoogleCalendarId(event.target.value)}
                placeholder="cliente@empresa.com o nombre@group.calendar.google.com"
                autoComplete="off"
              />
            </label>

            <label className={pageStyles.field}>
              <span>JSON del Service Account</span>
              <textarea
                value={serviceAccountJson}
                onChange={(event) => setServiceAccountJson(event.target.value)}
                placeholder='{"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\\n...","client_email":"..."}'
                spellCheck={false}
              />
              <small>Se cifra en backend. Si ya está conectado, puedes dejarlo vacío para conservar la llave actual.</small>
            </label>
          </div>

          <div className={pageStyles.serviceEmailBox}>
            <FileKey2 size={18} />
            <div>
              <span>Email técnico para compartir el calendario</span>
              <strong>{serviceAccountEmailForSharing || 'Pega o guarda el JSON para ver el email'}</strong>
            </div>
            <Button
              variant="outline"
              size="small"
              onClick={handleCopyServiceAccountEmail}
              disabled={!serviceAccountEmailForSharing}
            >
              <Copy size={14} />
              Copiar
            </Button>
          </div>

          <div className={pageStyles.formActions}>
            <Button onClick={handleSaveGoogleIntegration} disabled={savingGoogleIntegration || testingGoogleIntegration}>
              {savingGoogleIntegration ? (
                <>
                  <Loader2 size={16} className={styles.spinIcon} />
                  Guardando...
                </>
              ) : (
                <>
                  <KeyRound size={16} />
                  Guardar conexión
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={handleTestGoogleIntegration}
              disabled={!isConnected || savingGoogleIntegration || testingGoogleIntegration}
            >
              {testingGoogleIntegration ? (
                <>
                  <Loader2 size={16} className={styles.spinIcon} />
                  Probando...
                </>
              ) : (
                <>
                  <TestTube2 size={16} />
                  Probar conexión
                </>
              )}
            </Button>
            {isConnected && (
              <Button variant="ghost" onClick={handleDisconnectGoogleIntegration} disabled={disconnectingGoogleIntegration}>
                {disconnectingGoogleIntegration ? (
                  <>
                    <Loader2 size={16} className={styles.spinIcon} />
                    Desconectando...
                  </>
                ) : (
                  <>
                    <Trash2 size={16} />
                    Desconectar
                  </>
                )}
              </Button>
            )}
          </div>

          {(testOk || testFailed) && (
            <div className={`${pageStyles.testResult} ${testOk ? pageStyles.testOk : pageStyles.testError}`}>
              {testOk ? 'Última prueba correcta' : 'Última prueba fallida'}: {googleIntegration?.lastTestMessage}
            </div>
          )}

          {isConnected && (
            <div className={pageStyles.integrationFacts}>
              <span><strong>Proyecto</strong>{googleIntegration?.projectId || 'Sin dato'}</span>
              <span><strong>Calendario</strong>{googleIntegration?.calendarSummary || googleIntegration?.calendarId}</span>
              <span><strong>Zona</strong>{googleIntegration?.calendarTimeZone || 'Sin validar'}</span>
            </div>
          )}
        </section>

        <aside className={pageStyles.guidePanel}>
          <div className={pageStyles.guideHeader}>
            <BookOpen size={20} />
            <div>
              <h2>Guía para principiantes</h2>
              <p>El flujo completo para que no se pierdan en Google Cloud.</p>
            </div>
          </div>

          <ol className={pageStyles.setupSteps}>
            <li><strong>Abre Google Cloud Console.</strong> Entra con la cuenta del cliente y elige o crea un proyecto.</li>
            <li><strong>Activa Google Calendar API.</strong> Abre la librería de APIs y habilita Google Calendar API.</li>
            <li><strong>Crea un Service Account.</strong> Ve a IAM, Service Accounts y crea uno llamado “Ristak Calendar”.</li>
            <li><strong>Genera la llave JSON.</strong> En Keys, usa Add key, Create new key, JSON. Ese archivo se pega aquí.</li>
            <li><strong>Comparte el calendario.</strong> En Google Calendar, abre Settings and sharing y agrega el email técnico.</li>
            <li><strong>Da permiso de edición.</strong> Necesita poder hacer cambios en eventos; libre/ocupado no alcanza.</li>
            <li><strong>Copia el Calendar ID.</strong> En Integrate calendar, copia el Calendar ID y pégalo en Ristak.</li>
            <li><strong>Guarda y prueba.</strong> Ristak valida lectura, creación, actualización y cancelación con un evento temporal.</li>
          </ol>

          <div className={pageStyles.supportLinks}>
            <a href={GOOGLE_HELP_LINKS.calendarApi} target="_blank" rel="noreferrer">
              <ListChecks size={16} />
              Activar Calendar API
            </a>
            <a href={GOOGLE_HELP_LINKS.serviceAccounts} target="_blank" rel="noreferrer">
              <ShieldCheck size={16} />
              Crear Service Account
            </a>
            <a href={GOOGLE_HELP_LINKS.serviceAccountKeys} target="_blank" rel="noreferrer">
              <FileKey2 size={16} />
              Crear llave JSON
            </a>
            <a href={GOOGLE_HELP_LINKS.shareCalendar} target="_blank" rel="noreferrer">
              <Calendar size={16} />
              Compartir calendario
            </a>
            <a href={GOOGLE_HELP_LINKS.videoSearch} target="_blank" rel="noreferrer">
              <PlayCircle size={16} />
              Videos paso a paso
            </a>
          </div>
        </aside>
      </div>
    )
  }

  if (loadingCalendars) {
    return <Loading message="Cargando calendarios..." page="calendar-settings" />
  }

  const allSelected = calendars.length > 0 && attributionCalendarIds.length === calendars.length

  return (
    <div className={styles.integrationContainer}>
      <Card className={`${styles.mainCard} ${pageStyles.mainCard}`}>
        <div className={pageStyles.header}>
          <div>
            <div className={pageStyles.eyebrow}>
              <Calendar size={17} />
              Configuración
            </div>
            <h2>Configuración de calendario</h2>
            <p>Administra calendarios, predeterminado, conversiones y Google Calendar sin llenar la pantalla de ruido.</p>
          </div>
          <Button variant="outline" size="small" onClick={() => setShowCreateModal(true)}>
            <Plus size={16} />
            Crear calendario
          </Button>
        </div>

        <div className={pageStyles.tabs} role="tablist" aria-label="Configuración de calendarios">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'calendars'}
            className={activeTab === 'calendars' ? pageStyles.tabActive : ''}
            onClick={() => setActiveTab('calendars')}
          >
            <Calendar size={16} />
            Tus calendarios
            <span>{calendars.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'google'}
            className={activeTab === 'google' ? pageStyles.tabActive : ''}
            onClick={() => setActiveTab('google')}
          >
            <Globe2 size={16} />
            Google Calendar
            <span>{googleIntegration?.connected ? 'Conectado' : 'Setup'}</span>
          </button>
        </div>

        {activeTab === 'calendars' ? renderCalendarsTab() : renderGoogleCalendarTab()}
      </Card>

      {renderCreateCalendarModal()}

      {/* Modal de Configuración del Calendario */}
      {showConfigModal && selectedCalendar && createPortal(
        <Modal
          isOpen={showConfigModal}
          onClose={handleCloseConfigModal}
          title={`Configurar: ${selectedCalendar.name}`}
          size="lg"
        >
          <div style={{ padding: '24px' }}>
            <div className={styles.calendarConfigGrid}>
            {/* COLUMNA IZQUIERDA */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Duración de cita */}
              <div>
                <label className={styles.label}>¿Cuánto dura cada cita?</label>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '8px' }}>
                  <input
                    type="number"
                    className={styles.input}
                    value={selectedCalendar.slotDuration}
                    onChange={(e) => setSelectedCalendar({...selectedCalendar, slotDuration: parseInt(e.target.value) || 0})}
                    min="1"
                  />
                  <CustomSelect
                    value={selectedCalendar.slotDurationUnit}
                    onChange={(value) => setSelectedCalendar({...selectedCalendar, slotDurationUnit: value})}
                    options={[
                      { value: 'mins', label: 'Minutos' },
                      { value: 'hours', label: 'Horas' }
                    ]}
                  />
                </div>
                <p className={styles.hint}>Ej: 30 minutos, 1 hora, etc.</p>
              </div>

              {/* Intervalo entre slots */}
              <div>
                <label className={styles.label}>¿Cada cuánto mostrar horarios disponibles?</label>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '8px' }}>
                  <input
                    type="number"
                    className={styles.input}
                    value={selectedCalendar.slotInterval}
                    onChange={(e) => setSelectedCalendar({...selectedCalendar, slotInterval: parseInt(e.target.value) || 0})}
                    min="1"
                  />
                  <CustomSelect
                    value={selectedCalendar.slotIntervalUnit}
                    onChange={(value) => setSelectedCalendar({...selectedCalendar, slotIntervalUnit: value})}
                    options={[
                      { value: 'mins', label: 'Minutos' },
                      { value: 'hours', label: 'Horas' }
                    ]}
                  />
                </div>
                <p className={styles.hint}>Si pones 30 min, los horarios serán: 9:00, 9:30, 10:00...</p>
              </div>

              {/* Pre-Buffer */}
              <div>
                <label className={styles.label}>Tiempo libre antes de cada cita</label>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '8px' }}>
                  <input
                    type="number"
                    className={styles.input}
                    value={selectedCalendar.preBuffer || 0}
                    onChange={(e) => setSelectedCalendar({...selectedCalendar, preBuffer: parseInt(e.target.value) || 0})}
                    min="0"
                  />
                  <CustomSelect
                    value={selectedCalendar.preBufferUnit || 'mins'}
                    onChange={(value) => setSelectedCalendar({...selectedCalendar, preBufferUnit: value})}
                    options={[
                      { value: 'mins', label: 'Minutos' },
                      { value: 'hours', label: 'Horas' }
                    ]}
                  />
                </div>
                <p className={styles.hint}>Para prepararte antes de atender (revisar expediente, tomar café, etc.)</p>
              </div>

              {/* Slot Buffer */}
              <div>
                <label className={styles.label}>Tiempo libre después de cada cita</label>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '8px' }}>
                  <input
                    type="number"
                    className={styles.input}
                    value={selectedCalendar.slotBuffer || 0}
                    onChange={(e) => setSelectedCalendar({...selectedCalendar, slotBuffer: parseInt(e.target.value) || 0})}
                    min="0"
                  />
                  <CustomSelect
                    value={selectedCalendar.slotBufferUnit || 'mins'}
                    onChange={(value) => setSelectedCalendar({...selectedCalendar, slotBufferUnit: value})}
                    options={[
                      { value: 'mins', label: 'Minutos' },
                      { value: 'hours', label: 'Horas' }
                    ]}
                  />
                </div>
                <p className={styles.hint}>Para cerrar la cita sin apuros (hacer notas, responder dudas, etc.)</p>
              </div>

              {/* Citas por slot */}
              <div>
                <label className={styles.label}>¿Cuántas personas por horario?</label>
                <input
                  type="number"
                  className={styles.input}
                  value={selectedCalendar.appoinmentPerSlot}
                  onChange={(e) => setSelectedCalendar({...selectedCalendar, appoinmentPerSlot: parseInt(e.target.value) || 1})}
                  min="1"
                />
                <p className={styles.hint}>Para citas grupales (ej: 5 personas a las 10:00am)</p>
              </div>

              {/* Citas por día */}
              <div>
                <label className={styles.label}>Límite de citas por día</label>
                <input
                  type="number"
                  className={styles.input}
                  value={selectedCalendar.appoinmentPerDay}
                  onChange={(e) => setSelectedCalendar({...selectedCalendar, appoinmentPerDay: parseInt(e.target.value) || 0})}
                  min="0"
                />
                <p className={styles.hint}>0 = sin límite. Ej: 10 citas máximo por día</p>
              </div>
            </div>

            {/* COLUMNA DERECHA */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Aviso mínimo para agendar */}
              <div>
                <label className={styles.label}>¿Con cuánta anticipación pueden agendar?</label>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '8px' }}>
                  <input
                    type="number"
                    className={styles.input}
                    value={selectedCalendar.allowBookingAfter || 0}
                    onChange={(e) => setSelectedCalendar({...selectedCalendar, allowBookingAfter: parseInt(e.target.value) || 0})}
                    min="0"
                  />
                  <CustomSelect
                    value={selectedCalendar.allowBookingAfterUnit || 'hours'}
                    onChange={(value) => setSelectedCalendar({...selectedCalendar, allowBookingAfterUnit: value})}
                    options={[
                      { value: 'hours', label: 'Horas' },
                      { value: 'days', label: 'Días' },
                      { value: 'weeks', label: 'Semanas' },
                      { value: 'months', label: 'Meses' }
                    ]}
                  />
                </div>
                <p className={styles.hint}>
                  Mínimo de tiempo antes de la cita. Ej: 2 horas = no pueden agendar a última hora
                </p>
              </div>

              {/* Límite adelante */}
              <div>
                <label className={styles.label}>¿Hasta cuándo pueden agendar?</label>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '8px' }}>
                  <input
                    type="number"
                    className={styles.input}
                    value={selectedCalendar.allowBookingFor || 30}
                    onChange={(e) => setSelectedCalendar({...selectedCalendar, allowBookingFor: parseInt(e.target.value) || 1})}
                    min="1"
                  />
                  <CustomSelect
                    value={selectedCalendar.allowBookingForUnit || 'days'}
                    onChange={(value) => setSelectedCalendar({...selectedCalendar, allowBookingForUnit: value})}
                    options={[
                      { value: 'days', label: 'Días' },
                      { value: 'weeks', label: 'Semanas' },
                      { value: 'months', label: 'Meses' }
                    ]}
                  />
                </div>
                <p className={styles.hint}>
                  Máximo de tiempo hacia adelante. Ej: 30 días = solo pueden agendar hasta 1 mes adelante
                </p>
              </div>

              {/* Look Busy - Parecer Ocupado */}
              <div style={{ marginTop: '8px', padding: '16px', backgroundColor: 'var(--color-background-secondary)', borderRadius: '8px', border: '1px solid var(--color-border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                  <input
                    type="checkbox"
                    id="lookBusyEnabled"
                    checked={selectedCalendar.lookBusyConfig?.enabled || false}
                    onChange={(e) => setSelectedCalendar({
                      ...selectedCalendar,
                      lookBusyConfig: {
                        enabled: e.target.checked,
                        LookBusyPercentage: selectedCalendar.lookBusyConfig?.LookBusyPercentage || 0
                      }
                    })}
                  />
                  <label htmlFor="lookBusyEnabled" style={{ fontWeight: 500, cursor: 'pointer', fontSize: '14px' }}>
                    Parecer ocupado
                  </label>
                </div>

                {selectedCalendar.lookBusyConfig?.enabled && (
                  <div>
                    <label className={styles.label} style={{ fontSize: '13px' }}>¿Qué porcentaje de horarios ocultar?</label>
                    <input
                      type="number"
                      className={styles.input}
                      value={selectedCalendar.lookBusyConfig?.LookBusyPercentage || 0}
                      onChange={(e) => setSelectedCalendar({
                        ...selectedCalendar,
                        lookBusyConfig: {
                          enabled: true,
                          LookBusyPercentage: parseInt(e.target.value) || 0
                        }
                      })}
                      min="0"
                      max="100"
                      placeholder="Ej: 30"
                    />
                    <p className={styles.hint} style={{ marginTop: '6px', fontSize: '12px' }}>
                      Oculta horarios disponibles para dar sensación de alta demanda. Ej: 30% = oculta 3 de cada 10 horarios
                    </p>
                  </div>
                )}
              </div>

              {/* Tipo de Disponibilidad */}
              <div>
                <label className={styles.label}>¿Cómo calcular los horarios disponibles?</label>
                <CustomSelect
                  value={selectedCalendar.availabilityType !== undefined ? String(selectedCalendar.availabilityType) : ''}
                  onChange={(value) => setSelectedCalendar({
                    ...selectedCalendar,
                    availabilityType: value === '' ? undefined : parseInt(value)
                  })}
                  options={[
                    { value: '', label: 'Ambos (horarios abiertos + personalizado)' },
                    { value: '0', label: 'Solo horarios abiertos del calendario' },
                    { value: '1', label: 'Solo disponibilidad personalizada' }
                  ]}
                />
                <p className={styles.hint} style={{ marginTop: '6px' }}>
                  Define si usar horarios fijos, personalizados, o combinar ambos
                </p>
              </div>
            </div>
          </div>

            {/* Botones */}
            <div style={{ display: 'flex', gap: '12px', marginTop: '24px', paddingTop: '24px', borderTop: '1px solid var(--color-border)' }}>
            <Button
              onClick={handleSaveCalendarConfig}
              disabled={savingConfig}
            >
              {savingConfig ? (
                <>
                  <Loader2 size={18} className={styles.spinIcon} />
                  Guardando...
                </>
              ) : (
                'Guardar Cambios'
              )}
            </Button>
            <Button
              variant="ghost"
              onClick={handleCloseConfigModal}
              disabled={savingConfig}
            >
              Cancelar
            </Button>
          </div>
          </div>
        </Modal>,
        document.body
      )}
    </div>
  )
}
