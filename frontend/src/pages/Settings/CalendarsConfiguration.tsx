import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Card, Button, Modal, CustomSelect, Loading } from '@/components/common'
import { Calendar, Loader2, CheckCircle, XCircle, Info, Settings } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { useAppConfig } from '@/hooks'
import { useAuth } from '@/contexts/AuthContext'
import { calendarsService, type Calendar as CalendarType } from '@/services/calendarsService'
import styles from './HighLevelIntegration.module.css'

export const CalendarsConfiguration: React.FC = () => {
  const { showToast } = useNotification()
  const { locationId, accessToken } = useAuth()

  // Estados de configuración (usa sistema híbrido)
  const [defaultCalendarId, setDefaultCalendarId] = useAppConfig<string>('default_calendar_id', '')
  const [attributionCalendarIds, setAttributionCalendarIds] = useAppConfig<string[]>('attribution_calendar_ids', [])

  // Estados locales
  const [calendars, setCalendars] = useState<CalendarType[]>([])
  const [loadingCalendars, setLoadingCalendars] = useState(true)

  // Estados del modal de configuración
  const [showConfigModal, setShowConfigModal] = useState(false)
  const [selectedCalendar, setSelectedCalendar] = useState<CalendarType | null>(null)
  const [savingConfig, setSavingConfig] = useState(false)

  // Cargar calendarios al montar
  useEffect(() => {
    if (locationId && accessToken) {
      loadCalendars()
    }
  }, [locationId, accessToken])

  const loadCalendars = async () => {
    if (!locationId || !accessToken) {
      return
    }

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
    if (!selectedCalendar || !accessToken) return

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

      await calendarsService.updateCalendar(selectedCalendar.id, updateData, accessToken)

      showToast('success', 'Configuración de calendario actualizada', `Los cambios se guardaron en ${selectedCalendar.name}`)
      handleCloseConfigModal()
      loadCalendars() // Recargar calendarios para ver cambios
    } catch (error: any) {
      showToast('error', 'Error al actualizar calendario', error.message)
    } finally {
      setSavingConfig(false)
    }
  }

  if (loadingCalendars) {
    return <Loading message="Cargando calendarios..." kpiCount={0} />
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
              Asegúrate de tener al menos un calendario configurado en HighLevel.
            </p>
          </div>
        </Card>
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

        {/* Configuración de Calendarios Individuales */}
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Configuración Avanzada de Calendarios</h3>
          <p className={styles.sectionDescription} style={{ marginBottom: '16px' }}>
            Ajusta la configuración individual de cada calendario (horarios, duraciones, límites, etc.)
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {calendars.map(calendar => (
              <div
                key={calendar.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '16px',
                  backgroundColor: 'var(--color-background-secondary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '8px'
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: '4px' }}>
                    {calendar.name}
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                    Duración: {calendar.slotDuration} {calendar.slotDurationUnit} ·
                    Intervalo: {calendar.slotInterval} {calendar.slotIntervalUnit}
                  </div>
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
            ))}
          </div>
        </div>

        {/* Calendarios para Atribución */}
        <div className={styles.section} style={{ borderTop: '1px solid var(--color-border)', paddingTop: '24px' }}>
          <h3 className={styles.sectionTitle}>Calendarios para Atribución</h3>
          <p className={styles.sectionDescription} style={{ marginBottom: '16px' }}>
            Selecciona qué calendarios quieres usar para medir resultados en Reportes, Campañas y el Viaje del Cliente
          </p>

          <div className={styles.infoBox} style={{ marginBottom: '16px', display: 'flex', gap: '12px', padding: '12px', backgroundColor: 'var(--color-background-secondary)', borderRadius: '8px' }}>
            <Info size={20} style={{ color: 'var(--color-primary)', flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
              <strong style={{ color: 'var(--color-text-primary)' }}>¿Qué significa esto?</strong>
              <br />
              Solo las citas de los calendarios seleccionados aparecerán en:
              <ul style={{ margin: '8px 0 0 0', paddingLeft: '20px' }}>
                <li>La columna "Citas" en Reportes y Campañas</li>
                <li>El timeline del Viaje del Cliente de cada contacto</li>
                <li>Las métricas de atribución de marketing</li>
              </ul>
            </div>
          </div>

          <div className={styles.sectionContent}>
            <div className={styles.formField}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <label className={styles.label} style={{ margin: 0 }}>
                  Selecciona calendarios ({attributionCalendarIds.length}/{calendars.length})
                </label>
                <Button
                  variant="ghost"
                  size="small"
                  onClick={handleSelectAllAttribution}
                >
                  {allSelected ? 'Deseleccionar todos' : 'Seleccionar todos'}
                </Button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {calendars.map(calendar => {
                  const isSelected = attributionCalendarIds.includes(calendar.id)
                  return (
                    <label
                      key={calendar.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        padding: '12px',
                        backgroundColor: isSelected ? 'var(--color-background-secondary)' : 'transparent',
                        border: `1px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                        borderRadius: '8px',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease'
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) {
                          e.currentTarget.style.backgroundColor = 'var(--color-background-secondary)'
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) {
                          e.currentTarget.style.backgroundColor = 'transparent'
                        }
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleAttributionToggle(calendar.id)}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>
                          {calendar.name}
                        </div>
                      </div>
                    </label>
                  )
                })}
              </div>

              <p className={styles.hint} style={{ marginTop: '12px' }}>
                Si no seleccionas ninguno, NO se mostrarán citas en los reportes ni en el viaje del cliente
              </p>
            </div>
          </div>
        </div>
      </Card>

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
