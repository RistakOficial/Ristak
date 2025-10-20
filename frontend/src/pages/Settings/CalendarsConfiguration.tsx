import React, { useState, useEffect } from 'react'
import { Card, Button } from '@/components/common'
import { Calendar, Loader2, CheckCircle, XCircle, Info } from 'lucide-react'
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
  const [saving, setSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)

  // Estados temporales para edición (antes de guardar)
  const [tempDefaultCalendar, setTempDefaultCalendar] = useState<string>('')
  const [tempAttributionCalendars, setTempAttributionCalendars] = useState<string[]>([])

  // Cargar calendarios al montar
  useEffect(() => {
    if (locationId && accessToken) {
      loadCalendars()
    }
  }, [locationId, accessToken])

  // Sincronizar estados temporales con los valores guardados
  useEffect(() => {
    setTempDefaultCalendar(defaultCalendarId)
    setTempAttributionCalendars(attributionCalendarIds)
    setHasChanges(false)
  }, [defaultCalendarId, attributionCalendarIds])

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

  const handleDefaultCalendarChange = (calendarId: string) => {
    setTempDefaultCalendar(calendarId)
    setHasChanges(true)
  }

  const handleAttributionToggle = (calendarId: string) => {
    const newSelection = tempAttributionCalendars.includes(calendarId)
      ? tempAttributionCalendars.filter(id => id !== calendarId)
      : [...tempAttributionCalendars, calendarId]

    setTempAttributionCalendars(newSelection)
    setHasChanges(true)
  }

  const handleSelectAllAttribution = () => {
    if (tempAttributionCalendars.length === calendars.length) {
      // Si todos están seleccionados, deseleccionar todos
      setTempAttributionCalendars([])
    } else {
      // Seleccionar todos
      setTempAttributionCalendars(calendars.map(cal => cal.id))
    }
    setHasChanges(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // Guardar ambas configuraciones
      await setDefaultCalendarId(tempDefaultCalendar)
      await setAttributionCalendarIds(tempAttributionCalendars)

      showToast('success', 'Configuración de calendarios guardada exitosamente')
      setHasChanges(false)
    } catch (error: any) {
      showToast('error', 'Error al guardar configuración', error.message)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    setTempDefaultCalendar(defaultCalendarId)
    setTempAttributionCalendars(attributionCalendarIds)
    setHasChanges(false)
  }

  if (loadingCalendars) {
    return (
      <div className={styles.integrationContainer}>
        <Card className={styles.mainCard}>
          <div style={{ padding: '48px', textAlign: 'center' }}>
            <Loader2 size={32} className={styles.spinIcon} />
            <p style={{ marginTop: '16px', color: 'var(--color-text-secondary)' }}>
              Cargando calendarios...
            </p>
          </div>
        </Card>
      </div>
    )
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
                <p className={styles.pageSubtitle}>
                  No hay calendarios disponibles
                </p>
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

  const allSelected = tempAttributionCalendars.length === calendars.length

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
              <select
                value={tempDefaultCalendar}
                onChange={(e) => handleDefaultCalendarChange(e.target.value)}
                className={styles.input}
              >
                <option value="">Ninguno (seleccionar manualmente)</option>
                {calendars.map(calendar => (
                  <option key={calendar.id} value={calendar.id}>
                    {calendar.name}
                  </option>
                ))}
              </select>
              <p className={styles.hint}>
                Si no seleccionas ninguno, tendrás que elegir el calendario cada vez que entres a la página de Citas
              </p>
            </div>
          </div>
        </div>

        {/* Calendarios para Atribución */}
        <div className={styles.section}>
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
                  Selecciona calendarios ({tempAttributionCalendars.length}/{calendars.length})
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
                  const isSelected = tempAttributionCalendars.includes(calendar.id)
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
                        style={{
                          width: '18px',
                          height: '18px',
                          cursor: 'pointer',
                          accentColor: 'var(--color-primary)'
                        }}
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

        {/* Espacio para configuraciones futuras */}
        <div className={styles.section} style={{ borderTop: '1px solid var(--color-border)', paddingTop: '24px', opacity: 0.5 }}>
          <h3 className={styles.sectionTitle}>Más Configuraciones (Próximamente)</h3>
          <p className={styles.sectionDescription}>
            Aquí podrás configurar otras opciones relacionadas con calendarios y citas
          </p>
        </div>

        {/* Botones de acción */}
        <div className={styles.actions} style={{ display: 'flex', gap: '12px' }}>
          <Button
            onClick={handleSave}
            disabled={saving || !hasChanges}
          >
            {saving ? (
              <>
                <Loader2 size={18} className={styles.spinIcon} />
                Guardando...
              </>
            ) : (
              'Guardar Configuración'
            )}
          </Button>

          {hasChanges && (
            <Button
              variant="ghost"
              onClick={handleReset}
              disabled={saving}
            >
              Cancelar
            </Button>
          )}
        </div>
      </Card>
    </div>
  )
}
