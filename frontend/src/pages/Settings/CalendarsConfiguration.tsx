import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Card, Button, Modal, CustomSelect, Loading } from '@/components/common'
import { Calendar, Loader2, CheckCircle, XCircle, Info, Settings, Plus, Copy, ExternalLink, Globe2 } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { useAppConfig, useHighLevelConnected } from '@/hooks'
import { useAuth } from '@/contexts/AuthContext'
import { calendarsService, type Calendar as CalendarType } from '@/services/calendarsService'
import styles from './HighLevelIntegration.module.css'

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

  if (loadingCalendars) {
    return <Loading message="Cargando calendarios..." page="calendar-settings" />
  }

  if (calendars.length === 0) {
    return (
      <div className={styles.integrationContainer}>
        <Card className={styles.mainCard}>
          <div className={styles.pageHeader}>
            <div className={styles.headerContent}>
              <div className={styles.headerLeft}>
              <div className={styles.logoContainer}>
                <Calendar size={32} style={{ color: 'var(--color-text-secondary)' }} />
              </div>
              <div>
                <h2 className={styles.pageTitle}>Calendarios</h2>
                <p className={styles.pageSubtitle}>
                  No hay calendarios disponibles
                </p>
              </div>
              </div>
              <div className={styles.headerRight}>
                <div className={styles.statusDisconnected}>
                  <XCircle size={16} />
                  <span>Sin calendarios</span>
                </div>
              </div>
            </div>
          </div>

          <div className={styles.section}>
            <p style={{ color: 'var(--color-text-secondary)' }}>
              Crea un calendario en Ristak para empezar a agendar. Si después conectas HighLevel, se sincronizará.
            </p>
            <Button onClick={() => setShowCreateModal(true)} style={{ marginTop: '16px' }}>
              <Plus size={16} />
              Crear calendario
            </Button>
          </div>
        </Card>
        {renderCreateCalendarModal()}
      </div>
    )
  }

  const allSelected = attributionCalendarIds.length === calendars.length

  return (
    <div className={styles.integrationContainer}>
      <Card className={styles.mainCard}>
        {/* Header */}
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerLeft}>
              <div className={styles.logoContainer}>
                <Calendar size={32} style={{ color: 'var(--color-primary)' }} />
              </div>
              <div>
                <h2 className={styles.pageTitle}>Configuración de Calendarios</h2>
                <p className={styles.pageSubtitle}>
                  Configura qué calendarios usar y cómo
                </p>
              </div>
            </div>
            <div className={styles.headerRight}>
              <Button
                variant="outline"
                size="small"
                onClick={() => setShowCreateModal(true)}
              >
                <Plus size={16} />
                Crear calendario
              </Button>
              {defaultCalendarId || attributionCalendarIds.length > 0 ? (
                <div className={styles.statusConnected}>
                  <CheckCircle size={16} />
                  <span>Configurado</span>
                </div>
              ) : (
                <div className={styles.statusDisconnected}>
                  <XCircle size={16} />
                  <span>Sin configurar</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Origen de calendarios: solo aplica cuando hay una integración de
            terceros conectada. Sin ella, Ristak es la única fuente. */}
        {highLevelConnected && (
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Origen de Calendarios</h3>
            <p className={styles.sectionDescription} style={{ marginBottom: '16px' }}>
              Define qué calendarios se muestran para operar en Ristak. La sincronización sigue combinando datos cuando HighLevel está conectado.
            </p>

            <div className={styles.sectionContent}>
              <div className={styles.formField}>
                <label className={styles.label}>Calendarios a usar</label>
                <CustomSelect
                  value={calendarSourcePreference}
                  onChange={async (value) => {
                    const nextValue = value as 'combined' | 'ristak' | 'ghl'
                    await setCalendarSourcePreference(nextValue)
                    showToast('success', 'Preferencia guardada', nextValue === 'combined' ? 'Ristak y HighLevel se mostrarán juntos' : nextValue === 'ristak' ? 'Solo se mostrarán calendarios de Ristak' : 'Solo se mostrarán calendarios de HighLevel')
                    await loadCalendars()
                  }}
                  options={[
                    { value: 'combined', label: 'Ristak + HighLevel' },
                    { value: 'ristak', label: 'Solo Ristak' },
                    { value: 'ghl', label: 'Solo HighLevel' }
                  ]}
                />
                <p className={styles.hint}>
                  Aunque filtres la vista, las citas y calendarios pendientes de Ristak se suben a HighLevel cuando la integración está activa.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Calendario Predeterminado */}
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Calendario Predeterminado</h3>
          <p className={styles.sectionDescription} style={{ marginBottom: '16px' }}>
            El calendario que se seleccionará automáticamente al abrir la página de Citas
          </p>

          <div className={styles.sectionContent}>
            <div className={styles.formField}>
              <label className={styles.label}>Selecciona un calendario</label>
              <CustomSelect
                value={defaultCalendarId}
                onChange={(value) => handleDefaultCalendarChange(value)}
                options={[
                  { value: '', label: 'Ninguno (seleccionar manualmente)' },
                  ...calendars.map(calendar => ({
                    value: calendar.id,
                    label: calendar.name
                  }))
                ]}
                placeholder="Selecciona un calendario"
              />
              <p className={styles.hint}>
                Si no seleccionas ninguno, tendrás que elegir el calendario cada vez que entres a la página de Citas
              </p>
            </div>
          </div>
        </div>

        {/* Tus calendarios: una sola lista donde marcas atribución/eventos y
            ajustas la configuración de cada calendario, sin duplicar la vista. */}
        <div className={styles.section} style={{ borderTop: '1px solid var(--color-border)', paddingTop: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap', marginBottom: '12px' }}>
            <div>
              <h3 className={styles.sectionTitle}>Tus calendarios</h3>
              <p className={styles.sectionDescription} style={{ margin: 0 }}>
                Marca los que cuentan como conversión y ajusta la configuración de cada uno.
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
              <span style={{ fontSize: '13px', color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                {attributionCalendarIds.length}/{calendars.length} marcados
              </span>
              <Button variant="ghost" size="small" onClick={handleSelectAllAttribution}>
                {allSelected ? 'Desmarcar todos' : 'Marcar todos'}
              </Button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px', padding: '14px', backgroundColor: 'var(--color-background-secondary)', borderRadius: '8px', marginBottom: '16px' }}>
            <Info size={20} style={{ color: 'var(--color-primary)', flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.6' }}>
              <strong style={{ color: 'var(--color-text-primary)' }}>¿Para qué sirve marcar un calendario?</strong>
              <br />
              Los calendarios marcados son los que cuentan como conversión. Cuando alguien agenda en uno de ellos, esa cita:
              <ul style={{ margin: '8px 0 0 0', paddingLeft: '20px' }}>
                <li>Aparece en la columna “Citas” de Reportes y Campañas</li>
                <li>Se refleja en el Viaje del Cliente del contacto</li>
                <li>Suma en las métricas de atribución de marketing</li>
                <li>
                  Dispara los{' '}
                  <strong style={{ color: 'var(--color-text-primary)' }}>
                    eventos de conversión hacia Meta (Pixel / API de Conversiones) y WhatsApp
                  </strong>
                  , si los tienes activados en Ajustes → Eventos personalizados
                </li>
              </ul>
              <div style={{ marginTop: '8px' }}>
                Si no marcas ninguno, se toman en cuenta{' '}
                <strong style={{ color: 'var(--color-text-primary)' }}>todos</strong> los calendarios.
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {calendars.map(calendar => {
              const isAttributed = attributionCalendarIds.includes(calendar.id)
              return (
                <div
                  key={calendar.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '16px',
                    flexWrap: 'wrap',
                    padding: '14px 16px',
                    backgroundColor: 'var(--color-background-secondary)',
                    border: `1px solid ${isAttributed ? 'var(--color-primary)' : 'var(--color-border)'}`,
                    borderRadius: '10px',
                    transition: 'border-color 0.2s ease'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: 1 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: calendar.eventColor || 'var(--color-primary)', flexShrink: 0 }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {calendar.name}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}>
                        {calendar.slotDuration} {calendar.slotDurationUnit} · cada {calendar.slotInterval} {calendar.slotIntervalUnit}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', minWidth: 0, maxWidth: 520 }}>
                        <Globe2 size={14} style={{ color: calendar.publicUrl ? 'var(--color-primary)' : 'var(--color-text-tertiary)', flexShrink: 0 }} />
                        <input
                          readOnly
                          value={calendar.publicUrl || calendar.publicUrlUnavailableReason || 'Conecta el dominio publico general'}
                          title={calendar.publicUrl || calendar.publicUrlUnavailableReason || 'Conecta el dominio publico general'}
                          style={{
                            minWidth: 0,
                            flex: 1,
                            height: 32,
                            border: '1px solid var(--color-border)',
                            borderRadius: '7px',
                            backgroundColor: 'var(--color-background-primary)',
                            color: calendar.publicUrl ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                            fontSize: '12px',
                            padding: '0 10px'
                          }}
                        />
                        <Button
                          variant="ghost"
                          size="small"
                          onClick={() => handleCopyPublicUrl(calendar)}
                          disabled={!calendar.publicUrl}
                        >
                          <Copy size={14} />
                          Copiar URL
                        </Button>
                        {calendar.publicUrl && (
                          <a href={calendar.publicUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', color: 'var(--color-text-secondary)' }}>
                            <ExternalLink size={15} />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexShrink: 0 }}>
                    <div className={styles.toggleContainer}>
                      <button
                        type="button"
                        className={`${styles.toggle} ${isAttributed ? styles.toggleActive : ''}`}
                        onClick={() => handleAttributionToggle(calendar.id)}
                        aria-pressed={isAttributed}
                        aria-label={`Atribución y eventos para ${calendar.name}`}
                      >
                        <span className={styles.toggleThumb} />
                      </button>
                      <span className={`${styles.toggleLabel} ${isAttributed ? styles.toggleLabelActive : ''}`}>
                        Atribución y eventos
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      size="small"
                      onClick={() => handleOpenConfigModal(calendar)}
                    >
                      <Settings size={16} />
                      Configurar
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
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
