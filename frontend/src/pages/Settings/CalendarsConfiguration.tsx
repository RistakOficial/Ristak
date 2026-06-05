import React, { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  Card,
  Button,
  Modal,
  CustomSelect,
  Loading,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator
} from '@/components/common'
import {
  ArrowLeft,
  Calendar,
  Loader2,
  CheckCircle,
  XCircle,
  Info,
  Plus,
  Copy,
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
  SlidersHorizontal,
  RefreshCw,
  Pencil,
  ChevronDown,
  MoreHorizontal,
  Link2,
  Bell,
  BellOff,
  Smartphone
} from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { useAppConfig, useHighLevelConnected } from '@/hooks'
import { useAuth } from '@/contexts/AuthContext'
import { calendarsService, type Calendar as CalendarType, type GoogleCalendarIntegrationStatus } from '@/services/calendarsService'
import styles from './HighLevelIntegration.module.css'
import pageStyles from './CalendarsConfiguration.module.css'

type CalendarSettingsView = 'calendars' | 'google'
type CalendarSourcePreference = 'combined' | 'ristak' | 'ghl' | 'google'

const GOOGLE_HELP_LINKS = {
  googleCloudWelcome: 'https://cloud.google.com/welcome',
  calendarApi: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
  serviceAccounts: 'https://docs.cloud.google.com/iam/docs/service-accounts-create?hl=es-419',
  serviceAccountKeys: 'https://docs.cloud.google.com/iam/docs/keys-create-delete?hl=es-419',
  googleCalendar: 'https://calendar.google.com',
  shareCalendar: 'https://support.google.com/calendar/answer/37082?hl=es-419',
  calendarId: 'https://support.google.com/calendar/answer/44105?hl=es-419',
  videoSearch: 'https://www.youtube.com/results?search_query=Google+Cloud+service+account+JSON+key+Google+Calendar+API'
}

const normalizeBase64 = (value: string) => {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/')
  return normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
}

const normalizeGoogleCalendarIdInput = (value: string) => {
  const raw = value.trim()
  if (!raw) return ''

  try {
    const url = new URL(raw)
    const cid = url.searchParams.get('cid')
    if (cid) {
      const decoded = window.atob(normalizeBase64(cid)).trim()
      if (decoded) return decoded
    }

    const src = url.searchParams.get('src')
    if (src) {
      const decoded = decodeURIComponent(src).trim()
      if (decoded) return decoded
    }
  } catch {
    // Si no es URL, el valor ya es el Calendar ID.
  }

  return raw
}

const normalizeCalendarMatchValue = (value?: string | null) => String(value || '').trim().toLowerCase()

const googleDefaultPromptKey = (calendar?: CalendarType | null) => (
  normalizeCalendarMatchValue(calendar?.googleCalendarId || calendar?.id)
)

const getGoogleFailureHelp = (message = '') => {
  const lowerMessage = message.toLowerCase()

  if (lowerMessage.includes('not found')) {
    return {
      title: 'Google no encuentra ese calendario para el Service Account',
      steps: [
        'Revisa que el Calendar ID esté escrito exacto; raulgomez y raulgomiez serían calendarios distintos.',
        'Comparte ese calendario con el email técnico del Service Account, no con tu cuenta personal.',
        'El permiso debe ser “Hacer cambios en eventos”; “ver libre/ocupado” no alcanza.',
        'Si es cuenta de Workspace y no te deja compartir, un admin debe permitir compartir calendarios fuera del dominio.'
      ]
    }
  }

  if (lowerMessage.includes('forbidden') || lowerMessage.includes('permission') || lowerMessage.includes('insufficient')) {
    return {
      title: 'El calendario existe, pero faltan permisos',
      steps: [
        'Abre Settings and sharing del calendario exacto.',
        'Busca el email técnico del Service Account en “Shared with”.',
        'Cambia el permiso a “Hacer cambios en eventos”.',
        'Guarda y vuelve a probar la conexión.'
      ]
    }
  }

  if (lowerMessage.includes('invalid_grant') || lowerMessage.includes('authenticate')) {
    return {
      title: 'El JSON del Service Account no puede autenticarse',
      steps: [
        'Genera una llave JSON nueva desde Keys del Service Account.',
        'Pega el JSON completo, incluyendo private_key y client_email.',
        'No pegues un OAuth Client ni una API key; Ristak necesita Service Account JSON.'
      ]
    }
  }

  return {
    title: 'La prueba falló; revisa estos puntos primero',
    steps: [
      'Calendar API debe estar habilitada en el proyecto de Google Cloud.',
      'El JSON debe ser de tipo service_account.',
      'El Calendar ID debe salir de Integrate calendar.',
      'El calendario debe estar compartido con permiso para hacer cambios en eventos.'
    ]
  }
}

export const CalendarsConfiguration: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const { locationId, accessToken } = useAuth()

  // Estados de configuración (usa sistema híbrido)
  const [defaultCalendarId, setDefaultCalendarId] = useAppConfig<string>('default_calendar_id', '')
  const [attributionCalendarIds, setAttributionCalendarIds] = useAppConfig<string[]>('attribution_calendar_ids', [])
  const [calendarSourcePreference, setCalendarSourcePreference] = useAppConfig<CalendarSourcePreference>('calendar_source_preference', 'combined')
  const [googleDefaultPromptHandledIds, setGoogleDefaultPromptHandledIds] = useAppConfig<string[]>('google_default_calendar_prompt_handled_ids', [])
  const [calendarPushEnabled, setCalendarPushEnabled] = useAppConfig<boolean>('calendar_push_notifications_enabled', false)
  const [calendarPushNotificationIds, setCalendarPushNotificationIds] = useAppConfig<string[]>('calendar_push_notification_calendar_ids', [])

  // El origen de calendarios solo tiene sentido con una integración de terceros
  // (HighLevel). Sin ella, Ristak es la única fuente posible.
  const { connected: highLevelConnected, loading: highLevelLoading } = useHighLevelConnected()

  // Estados locales
  const [calendars, setCalendars] = useState<CalendarType[]>([])
  const [loadingCalendars, setLoadingCalendars] = useState(true)
  const [activeView, setActiveView] = useState<CalendarSettingsView>('calendars')
  const [googleIntegration, setGoogleIntegration] = useState<GoogleCalendarIntegrationStatus | null>(null)
  const [loadingGoogleIntegration, setLoadingGoogleIntegration] = useState(true)
  const [savingGoogleIntegration, setSavingGoogleIntegration] = useState(false)
  const [testingGoogleIntegration, setTestingGoogleIntegration] = useState(false)
  const [syncingGoogleIntegration, setSyncingGoogleIntegration] = useState(false)
  const [disconnectingGoogleIntegration, setDisconnectingGoogleIntegration] = useState(false)
  const [editingGoogleIntegration, setEditingGoogleIntegration] = useState(false)
  const [googleGuideExpanded, setGoogleGuideExpanded] = useState(false)
  const [googleDefaultPromptCalendar, setGoogleDefaultPromptCalendar] = useState<CalendarType | null>(null)
  const [savingGoogleDefaultPrompt, setSavingGoogleDefaultPrompt] = useState(false)
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

  // Estados de edición inline de calendario
  const [expandedCalendarId, setExpandedCalendarId] = useState<string | null>(null)
  const [selectedCalendar, setSelectedCalendar] = useState<CalendarType | null>(null)
  const [savingConfig, setSavingConfig] = useState(false)
  const [deletingCalendarId, setDeletingCalendarId] = useState<string | null>(null)

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
    if (!loadingGoogleIntegration && !googleIntegration?.connected && calendarSourcePreference === 'google') {
      setCalendarSourcePreference('ristak').catch(() => {})
    }
  }, [highLevelLoading, highLevelConnected, loadingGoogleIntegration, googleIntegration?.connected, calendarSourcePreference, setCalendarSourcePreference])

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
      return data
    } catch (error: any) {
      showToast('error', 'Error al cargar calendarios', error.message)
      return []
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
      if (data.connected) {
        try {
          const revealed = await calendarsService.revealGoogleServiceAccount()
          setServiceAccountJson(revealed.serviceAccountJson || '')
        } catch {
          setServiceAccountJson('')
        }
      } else {
        setServiceAccountJson('')
      }
      setEditingGoogleIntegration(!data.connected)
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

  const findConnectedGoogleCalendar = (
    calendarList: CalendarType[] = calendars,
    integrationStatus: GoogleCalendarIntegrationStatus | null = googleIntegration
  ) => {
    const connectedCalendarId = normalizeCalendarMatchValue(integrationStatus?.calendarId || googleCalendarId)
    const googleCalendars = calendarList.filter((calendar) => calendar.source === 'google')

    if (!googleCalendars.length) return null

    return googleCalendars.find((calendar) => (
      normalizeCalendarMatchValue(calendar.googleCalendarId) === connectedCalendarId ||
      normalizeCalendarMatchValue(calendar.name) === connectedCalendarId
    )) || (googleCalendars.length === 1 ? googleCalendars[0] : null)
  }

  const maybeShowGoogleDefaultPrompt = (
    calendarList: CalendarType[],
    integrationStatus: GoogleCalendarIntegrationStatus | null
  ) => {
    const importedCalendar = findConnectedGoogleCalendar(calendarList, integrationStatus)
    if (!importedCalendar) return

    const promptKey = googleDefaultPromptKey(importedCalendar)
    if (!promptKey || googleDefaultPromptHandledIds.includes(promptKey)) return

    const alreadyConfigured = defaultCalendarId === importedCalendar.id && attributionCalendarIds.includes(importedCalendar.id)
    if (alreadyConfigured) return

    setGoogleDefaultPromptCalendar(importedCalendar)
  }

  const maybeShowGoogleDefaultPromptFromCalendars = async (
    calendarList: CalendarType[],
    integrationStatus: GoogleCalendarIntegrationStatus | null
  ) => {
    if (findConnectedGoogleCalendar(calendarList, integrationStatus)) {
      maybeShowGoogleDefaultPrompt(calendarList, integrationStatus)
      return
    }

    const allCalendars = await calendarsService.getCalendars(locationId, accessToken, 'combined')
    maybeShowGoogleDefaultPrompt(allCalendars, integrationStatus)
  }

  const markGoogleDefaultPromptHandled = async (calendar: CalendarType) => {
    const promptKey = googleDefaultPromptKey(calendar)
    if (!promptKey || googleDefaultPromptHandledIds.includes(promptKey)) return

    await setGoogleDefaultPromptHandledIds([...googleDefaultPromptHandledIds, promptKey])
  }

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
    const normalizedCalendarId = normalizeGoogleCalendarIdInput(googleCalendarId)

    if (!normalizedCalendarId) {
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
        calendarId: normalizedCalendarId,
        serviceAccountJson: serviceAccountJson.trim()
      })
      setGoogleIntegration(data)
      setGoogleCalendarId(data.calendarId || normalizedCalendarId)
      try {
        const revealed = await calendarsService.revealGoogleServiceAccount()
        setServiceAccountJson(revealed.serviceAccountJson || serviceAccountJson.trim())
      } catch {
        setServiceAccountJson(serviceAccountJson.trim())
      }
      setEditingGoogleIntegration(false)
      const updatedCalendars = await loadCalendars()
      await maybeShowGoogleDefaultPromptFromCalendars(updatedCalendars, data)
      showToast('success', 'Google Calendar guardado', 'La conexión quedó guardada. Ahora puedes probar o sincronizar manualmente.')
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
      setEditingGoogleIntegration(false)
      const updatedCalendars = await loadCalendars()
      await maybeShowGoogleDefaultPromptFromCalendars(updatedCalendars, data)
      showToast('success', 'Google Calendar probado', data.lastTestMessage || 'Permisos validados correctamente')
    } catch (error: any) {
      await loadGoogleIntegration()
      showToast('error', 'La prueba falló', error.message || 'Revisa permisos del calendario')
    } finally {
      setTestingGoogleIntegration(false)
    }
  }

  const handleSyncGoogleIntegration = async () => {
    setSyncingGoogleIntegration(true)
    try {
      const data = await calendarsService.syncGoogleIntegration()
      setGoogleIntegration(data)
      setGoogleCalendarId(data.calendarId || googleCalendarId)
      const updatedCalendars = await loadCalendars()
      await maybeShowGoogleDefaultPromptFromCalendars(updatedCalendars, data)
      showToast('success', 'Google Calendar sincronizado', data.lastSyncMessage || 'Calendarios y citas importados a Ristak')
    } catch (error: any) {
      await loadGoogleIntegration()
      showToast('error', 'No se pudo sincronizar Google Calendar', error.message || 'Revisa permisos y comparte el calendario con el Service Account')
    } finally {
      setSyncingGoogleIntegration(false)
    }
  }

  const handleAcceptGoogleDefaultPrompt = async () => {
    if (!googleDefaultPromptCalendar) return

    setSavingGoogleDefaultPrompt(true)
    try {
      await setDefaultCalendarId(googleDefaultPromptCalendar.id)

      if (!attributionCalendarIds.includes(googleDefaultPromptCalendar.id)) {
        await setAttributionCalendarIds([...attributionCalendarIds, googleDefaultPromptCalendar.id])
      }

      await markGoogleDefaultPromptHandled(googleDefaultPromptCalendar)
      setGoogleDefaultPromptCalendar(null)
      showToast(
        'success',
        'Calendario predeterminado actualizado',
        `${googleDefaultPromptCalendar.name} quedó como calendario de citas y conversión`
      )
    } catch (error: any) {
      showToast('error', 'No se pudo guardar el calendario predeterminado', error.message || 'Intenta nuevamente')
    } finally {
      setSavingGoogleDefaultPrompt(false)
    }
  }

  const handleDismissGoogleDefaultPrompt = async () => {
    if (!googleDefaultPromptCalendar) return

    setSavingGoogleDefaultPrompt(true)
    try {
      await markGoogleDefaultPromptHandled(googleDefaultPromptCalendar)
      setGoogleDefaultPromptCalendar(null)
      showToast('info', 'Sin cambios', 'El calendario se queda conectado sin hacerlo predeterminado')
    } catch (error: any) {
      showToast('error', 'No se pudo cerrar la pregunta', error.message || 'Intenta nuevamente')
    } finally {
      setSavingGoogleDefaultPrompt(false)
    }
  }

  const handleCloseGoogleDefaultPromptModal = () => {
    if (savingGoogleDefaultPrompt) return
    void handleDismissGoogleDefaultPrompt()
  }

  const handleEditGoogleIntegration = async () => {
    setEditingGoogleIntegration(true)

    if (serviceAccountJson.trim()) return

    try {
      const revealed = await calendarsService.revealGoogleServiceAccount()
      setServiceAccountJson(revealed.serviceAccountJson || '')
    } catch (error: any) {
      showToast('error', 'No se pudo cargar el JSON', error.message || 'Pega el JSON manualmente para reemplazarlo')
    }
  }

  const handleDisconnectGoogleIntegration = async () => {
    showConfirm(
      'Desconectar Google Calendar',
      'Las citas locales se conservan, pero esta instalacion dejara de sincronizar con Google Calendar.',
      () => {
        const disconnectGoogleIntegration = async () => {
          setDisconnectingGoogleIntegration(true)
          try {
            const data = await calendarsService.deleteGoogleIntegration()
            setGoogleIntegration(data)
            setGoogleCalendarId('')
            setServiceAccountJson('')
            setEditingGoogleIntegration(false)
            await loadCalendars()
            showToast('success', 'Google Calendar desconectado', 'La integración quedó removida de esta instalación')
          } catch (error: any) {
            showToast('error', 'No se pudo desconectar', error.message || 'Intenta nuevamente')
          } finally {
            setDisconnectingGoogleIntegration(false)
          }
        }

        void disconnectGoogleIntegration()
      },
      'Desconectar',
      'Cancelar'
    )
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

  const handleCalendarPushEnabledToggle = async () => {
    try {
      await setCalendarPushEnabled(!calendarPushEnabled)
      showToast(
        'success',
        !calendarPushEnabled ? 'Avisos encendidos' : 'Avisos apagados',
        !calendarPushEnabled
          ? 'Ristak enviará avisos a los celulares que ya dieron permiso.'
          : 'Ristak dejará de enviar avisos de nuevas citas.'
      )
    } catch (error: any) {
      showToast('error', 'No se pudo guardar el ajuste', error.message || 'Intenta nuevamente')
    }
  }

  const handleCalendarPushSelectionToggle = async (calendarId: string) => {
    const newSelection = calendarPushNotificationIds.includes(calendarId)
      ? calendarPushNotificationIds.filter(id => id !== calendarId)
      : [...calendarPushNotificationIds, calendarId]

    try {
      await setCalendarPushNotificationIds(newSelection)
      showToast(
        'success',
        'Calendarios de aviso actualizados',
        newSelection.length
          ? `${newSelection.length} calendario${newSelection.length !== 1 ? 's' : ''} enviarán avisos.`
          : 'Todos los calendarios enviarán avisos.'
      )
    } catch (error: any) {
      showToast('error', 'No se pudo guardar el ajuste', error.message || 'Intenta nuevamente')
    }
  }

  const handleUseAllCalendarPushNotifications = async () => {
    try {
      await setCalendarPushNotificationIds([])
      showToast('success', 'Avisos para todos', 'Todos los calendarios activos podrán avisar nuevas citas.')
    } catch (error: any) {
      showToast('error', 'No se pudo guardar el ajuste', error.message || 'Intenta nuevamente')
    }
  }

  const handleOpenCalendarEditor = (calendar: CalendarType) => {
    if (expandedCalendarId === calendar.id) {
      setExpandedCalendarId(null)
      setSelectedCalendar(null)
      return
    }

    setSelectedCalendar(calendar)
    setExpandedCalendarId(calendar.id)
  }

  const handleCloseCalendarEditor = () => {
    setExpandedCalendarId(null)
    setSelectedCalendar(null)
  }

  const handleSaveCalendarConfig = async () => {
    if (!selectedCalendar) return

    setSavingConfig(true)
    try {
      // Construir payload con todos los campos editables
      const updateData: any = {
        name: selectedCalendar.name?.trim() || 'Calendario',
        eventTitle: selectedCalendar.eventTitle?.trim() || selectedCalendar.name?.trim() || 'Cita',
        eventColor: selectedCalendar.eventColor || '#3b82f6',
        isActive: selectedCalendar.isActive,
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
      handleCloseCalendarEditor()
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

  const handleDeleteCalendar = (calendar: CalendarType) => {
    const isExternalCalendar = calendar.source === 'google' || calendar.source === 'ghl'

    showConfirm(
      'Eliminar calendario',
      isExternalCalendar
        ? `${calendar.name} viene de ${calendar.source === 'google' ? 'Google Calendar' : 'HighLevel'}. Para quitarlo de verdad hay que desconectarlo o quitarlo desde el origen; Ristak no lo va a borrar porque se volveria a sincronizar.`
        : `Se eliminará ${calendar.name} y sus citas locales asociadas. Esta acción no se puede deshacer.`,
      () => {
        const deleteCalendar = async () => {
          if (isExternalCalendar) {
            showToast('warning', 'Calendario sincronizado', 'Elimínalo o desconéctalo desde el origen para que no vuelva a aparecer.')
            return
          }

          setDeletingCalendarId(calendar.id)
          try {
            await calendarsService.deleteCalendar(calendar.id, accessToken || undefined)

            if (defaultCalendarId === calendar.id) {
              const nextDefault = calendars.find(item => item.id !== calendar.id)?.id || ''
              await setDefaultCalendarId(nextDefault)
            }

            if (attributionCalendarIds.includes(calendar.id)) {
              await setAttributionCalendarIds(attributionCalendarIds.filter(id => id !== calendar.id))
            }

            if (expandedCalendarId === calendar.id) {
              handleCloseCalendarEditor()
            }

            await loadCalendars()
            showToast('success', 'Calendario eliminado', `${calendar.name} ya no aparece en Ristak`)
          } catch (error: any) {
            showToast('error', 'No se pudo eliminar', error.message || 'Intenta nuevamente')
          } finally {
            setDeletingCalendarId(null)
          }
        }

        void deleteCalendar()
      },
      isExternalCalendar ? 'Entendido' : 'Eliminar',
      'Cancelar'
    )
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

  const renderGoogleDefaultPromptModal = () => googleDefaultPromptCalendar ? createPortal(
    <Modal
      isOpen={Boolean(googleDefaultPromptCalendar)}
      onClose={handleCloseGoogleDefaultPromptModal}
      title="Calendario importado desde Google"
      size="md"
      showCloseButton={!savingGoogleDefaultPrompt}
    >
      <div className={pageStyles.defaultPromptModal}>
        <div className={pageStyles.defaultPromptIcon}>
          <Calendar size={24} />
        </div>
        <div className={pageStyles.defaultPromptBody}>
          <p className={pageStyles.defaultPromptEyebrow}>Google Calendar conectado</p>
          <h3>¿Quieres convertirlo en tu calendario personalizado y predeterminado de citas?</h3>
          <div className={pageStyles.defaultPromptCalendar}>
            <strong>{googleDefaultPromptCalendar.name}</strong>
            <span>{googleDefaultPromptCalendar.googleCalendarId || googleIntegration?.calendarId || 'Calendar ID pendiente'}</span>
          </div>
          <p>
            Si eliges que sí, Ristak lo pondrá como calendario personalizado predeterminado y también lo marcará como calendario de conversión.
            Si eliges que no, se queda conectado y puedes cambiarlo después desde la lista de calendarios.
          </p>
        </div>
        <div className={pageStyles.defaultPromptActions}>
          <Button
            onClick={handleAcceptGoogleDefaultPrompt}
            disabled={savingGoogleDefaultPrompt}
          >
            {savingGoogleDefaultPrompt ? (
              <>
                <Loader2 size={16} className={styles.spinIcon} />
                Guardando...
              </>
            ) : (
              <>
                <Star size={16} />
                Sí, convertirlo
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            onClick={handleDismissGoogleDefaultPrompt}
            disabled={savingGoogleDefaultPrompt}
          >
            No, dejarlo así
          </Button>
        </div>
      </div>
    </Modal>,
    document.body
  ) : null

  const handleCalendarSourcePreferenceChange = async (value: string) => {
    const nextValue = value as CalendarSourcePreference
    await setCalendarSourcePreference(nextValue)
    showToast(
      'success',
      'Origen guardado',
      nextValue === 'combined'
        ? 'Todos los calendarios se mostrarán juntos'
        : nextValue === 'ristak'
          ? 'Solo se mostrarán calendarios de Ristak'
          : nextValue === 'ghl'
            ? 'Solo se mostrarán calendarios de HighLevel'
            : 'Solo se mostrarán calendarios de Google'
    )
    await loadCalendars()
  }

  const renderCalendarSourceSelect = () => {
    const showSourceSelector = highLevelConnected || googleIntegration?.connected
    if (!showSourceSelector) return null

    const options = [
      { value: 'combined', label: 'Todos' },
      { value: 'ristak', label: 'Solo Ristak' },
      ...(highLevelConnected ? [{ value: 'ghl', label: 'Solo HighLevel' }] : []),
      ...(googleIntegration?.connected ? [{ value: 'google', label: 'Solo Google' }] : [])
    ]

    return (
      <label className={pageStyles.sourceControl}>
        <SlidersHorizontal size={16} />
        <span>Origen</span>
        <select
          className={pageStyles.sourceSelect}
          value={calendarSourcePreference}
          onChange={(event) => void handleCalendarSourcePreferenceChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown size={14} className={pageStyles.sourceChevron} />
      </label>
    )
  }

  const renderCalendarSourceBadge = (calendar: CalendarType) => (
    <span className={pageStyles.metaPill}>
      {calendar.source === 'ghl' ? 'HighLevel' : calendar.source === 'google' ? 'Google' : 'Ristak'}
    </span>
  )

  const renderCalendarInlineEditor = (calendar: CalendarType) => {
    if (expandedCalendarId !== calendar.id || !selectedCalendar || selectedCalendar.id !== calendar.id) {
      return null
    }

    const updateSelectedCalendar = (patch: Partial<CalendarType>) => {
      setSelectedCalendar({ ...selectedCalendar, ...patch })
    }

    return (
      <div className={pageStyles.calendarEditor}>
        <div className={pageStyles.editorHeader}>
          <div>
            <h4>Configuración del calendario</h4>
            <p>{calendar.name}</p>
          </div>
          <Button
            variant="ghost"
            size="small"
            onClick={handleCloseCalendarEditor}
            disabled={savingConfig}
          >
            Cancelar
          </Button>
        </div>

        <div className={pageStyles.editorSections}>
          <section className={pageStyles.editorSection}>
            <div className={pageStyles.editorSectionHeader}>
              <strong>Información</strong>
              <span>Nombre, título y estado visible.</span>
            </div>
            <div className={pageStyles.editorFields}>
              <label className={`${pageStyles.editorField} ${pageStyles.editorFieldLarge}`}>
                <span>Nombre</span>
                <input
                  className={styles.input}
                  value={selectedCalendar.name || ''}
                  onChange={(event) => updateSelectedCalendar({ name: event.target.value })}
                />
              </label>

              <label className={pageStyles.editorField}>
                <span>Título de evento</span>
                <input
                  className={styles.input}
                  value={selectedCalendar.eventTitle || ''}
                  onChange={(event) => updateSelectedCalendar({ eventTitle: event.target.value })}
                />
              </label>

              <label className={pageStyles.editorField}>
                <span>Color</span>
                <input
                  type="color"
                  className={pageStyles.colorInput}
                  value={selectedCalendar.eventColor || '#3b82f6'}
                  onChange={(event) => updateSelectedCalendar({ eventColor: event.target.value })}
                />
              </label>

              <div className={pageStyles.editorField}>
                <span>Estado</span>
                <button
                  type="button"
                  className={`${pageStyles.editorToggle} ${selectedCalendar.isActive ? pageStyles.editorToggleActive : ''}`}
                  onClick={() => updateSelectedCalendar({ isActive: !selectedCalendar.isActive })}
                  aria-pressed={selectedCalendar.isActive}
                >
                  <span />
                  {selectedCalendar.isActive ? 'Activo' : 'Inactivo'}
                </button>
              </div>
            </div>
          </section>

          <section className={pageStyles.editorSection}>
            <div className={pageStyles.editorSectionHeader}>
              <strong>Horarios</strong>
              <span>Duración, intervalo y fuente de disponibilidad.</span>
            </div>
            <div className={pageStyles.editorFields}>
              <label className={pageStyles.editorField}>
                <span>Duración</span>
                <div className={pageStyles.inlineFieldGroup}>
                  <input
                    type="number"
                    className={styles.input}
                    value={selectedCalendar.slotDuration}
                    onChange={(event) => updateSelectedCalendar({ slotDuration: parseInt(event.target.value, 10) || 0 })}
                    min="1"
                  />
                  <CustomSelect
                    value={selectedCalendar.slotDurationUnit}
                    onChange={(value) => updateSelectedCalendar({ slotDurationUnit: value })}
                    options={[
                      { value: 'mins', label: 'Minutos' },
                      { value: 'hours', label: 'Horas' }
                    ]}
                  />
                </div>
              </label>

              <label className={pageStyles.editorField}>
                <span>Intervalo</span>
                <div className={pageStyles.inlineFieldGroup}>
                  <input
                    type="number"
                    className={styles.input}
                    value={selectedCalendar.slotInterval}
                    onChange={(event) => updateSelectedCalendar({ slotInterval: parseInt(event.target.value, 10) || 0 })}
                    min="1"
                  />
                  <CustomSelect
                    value={selectedCalendar.slotIntervalUnit}
                    onChange={(value) => updateSelectedCalendar({ slotIntervalUnit: value })}
                    options={[
                      { value: 'mins', label: 'Minutos' },
                      { value: 'hours', label: 'Horas' }
                    ]}
                  />
                </div>
              </label>

              <label className={`${pageStyles.editorField} ${pageStyles.editorFieldLarge}`}>
                <span>Disponibilidad</span>
                <CustomSelect
                  value={selectedCalendar.availabilityType !== undefined ? String(selectedCalendar.availabilityType) : ''}
                  onChange={(value) => updateSelectedCalendar({
                    availabilityType: value === '' ? undefined : parseInt(value, 10)
                  })}
                  options={[
                    { value: '', label: 'Horarios abiertos + disponibilidad personalizada' },
                    { value: '0', label: 'Solo horarios abiertos' },
                    { value: '1', label: 'Solo disponibilidad personalizada' }
                  ]}
                />
              </label>
            </div>
          </section>

          <section className={pageStyles.editorSection}>
            <div className={pageStyles.editorSectionHeader}>
              <strong>Reglas de reserva</strong>
              <span>Cuándo y cuántas citas puede tomar este calendario.</span>
            </div>
            <div className={pageStyles.editorFields}>
              <label className={pageStyles.editorField}>
                <span>Anticipación mínima</span>
                <div className={pageStyles.inlineFieldGroup}>
                  <input
                    type="number"
                    className={styles.input}
                    value={selectedCalendar.allowBookingAfter || 0}
                    onChange={(event) => updateSelectedCalendar({ allowBookingAfter: parseInt(event.target.value, 10) || 0 })}
                    min="0"
                  />
                  <CustomSelect
                    value={selectedCalendar.allowBookingAfterUnit || 'hours'}
                    onChange={(value) => updateSelectedCalendar({ allowBookingAfterUnit: value })}
                    options={[
                      { value: 'hours', label: 'Horas' },
                      { value: 'days', label: 'Días' },
                      { value: 'weeks', label: 'Semanas' },
                      { value: 'months', label: 'Meses' }
                    ]}
                  />
                </div>
              </label>

              <label className={pageStyles.editorField}>
                <span>Ventana para agendar</span>
                <div className={pageStyles.inlineFieldGroup}>
                  <input
                    type="number"
                    className={styles.input}
                    value={selectedCalendar.allowBookingFor || 30}
                    onChange={(event) => updateSelectedCalendar({ allowBookingFor: parseInt(event.target.value, 10) || 1 })}
                    min="1"
                  />
                  <CustomSelect
                    value={selectedCalendar.allowBookingForUnit || 'days'}
                    onChange={(value) => updateSelectedCalendar({ allowBookingForUnit: value })}
                    options={[
                      { value: 'days', label: 'Días' },
                      { value: 'weeks', label: 'Semanas' },
                      { value: 'months', label: 'Meses' }
                    ]}
                  />
                </div>
              </label>

              <label className={pageStyles.editorField}>
                <span>Personas por horario</span>
                <input
                  type="number"
                  className={styles.input}
                  value={selectedCalendar.appoinmentPerSlot}
                  onChange={(event) => updateSelectedCalendar({ appoinmentPerSlot: parseInt(event.target.value, 10) || 1 })}
                  min="1"
                />
              </label>

              <label className={pageStyles.editorField}>
                <span>Límite diario</span>
                <input
                  type="number"
                  className={styles.input}
                  value={selectedCalendar.appoinmentPerDay}
                  onChange={(event) => updateSelectedCalendar({ appoinmentPerDay: parseInt(event.target.value, 10) || 0 })}
                  min="0"
                />
              </label>
            </div>
          </section>

          <section className={pageStyles.editorSection}>
            <div className={pageStyles.editorSectionHeader}>
              <strong>Espacios y demanda</strong>
              <span>Buffers antes/después y disponibilidad simulada.</span>
            </div>
            <div className={pageStyles.editorFields}>
              <label className={pageStyles.editorField}>
                <span>Buffer antes</span>
                <div className={pageStyles.inlineFieldGroup}>
                  <input
                    type="number"
                    className={styles.input}
                    value={selectedCalendar.preBuffer || 0}
                    onChange={(event) => updateSelectedCalendar({ preBuffer: parseInt(event.target.value, 10) || 0 })}
                    min="0"
                  />
                  <CustomSelect
                    value={selectedCalendar.preBufferUnit || 'mins'}
                    onChange={(value) => updateSelectedCalendar({ preBufferUnit: value })}
                    options={[
                      { value: 'mins', label: 'Minutos' },
                      { value: 'hours', label: 'Horas' }
                    ]}
                  />
                </div>
              </label>

              <label className={pageStyles.editorField}>
                <span>Buffer después</span>
                <div className={pageStyles.inlineFieldGroup}>
                  <input
                    type="number"
                    className={styles.input}
                    value={selectedCalendar.slotBuffer || 0}
                    onChange={(event) => updateSelectedCalendar({ slotBuffer: parseInt(event.target.value, 10) || 0 })}
                    min="0"
                  />
                  <CustomSelect
                    value={selectedCalendar.slotBufferUnit || 'mins'}
                    onChange={(value) => updateSelectedCalendar({ slotBufferUnit: value })}
                    options={[
                      { value: 'mins', label: 'Minutos' },
                      { value: 'hours', label: 'Horas' }
                    ]}
                  />
                </div>
              </label>

              <div className={`${pageStyles.editorField} ${pageStyles.editorFieldLarge}`}>
                <span>Parecer ocupado</span>
                <div className={pageStyles.lookBusyRow}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedCalendar.lookBusyConfig?.enabled || false}
                      onChange={(event) => updateSelectedCalendar({
                        lookBusyConfig: {
                          enabled: event.target.checked,
                          LookBusyPercentage: selectedCalendar.lookBusyConfig?.LookBusyPercentage || 0
                        }
                      })}
                    />
                    Activar
                  </label>

                  {selectedCalendar.lookBusyConfig?.enabled && (
                    <label className={pageStyles.lookBusyPercent}>
                      <span>Ocultar</span>
                      <input
                        type="number"
                        className={styles.input}
                        value={selectedCalendar.lookBusyConfig?.LookBusyPercentage || 0}
                        onChange={(event) => updateSelectedCalendar({
                          lookBusyConfig: {
                            enabled: true,
                            LookBusyPercentage: parseInt(event.target.value, 10) || 0
                          }
                        })}
                        min="0"
                        max="100"
                      />
                      <span>%</span>
                    </label>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className={pageStyles.editorFooter}>
          <Button
            onClick={handleSaveCalendarConfig}
            disabled={savingConfig}
          >
            {savingConfig ? (
              <>
                <Loader2 size={16} className={styles.spinIcon} />
                Guardando...
              </>
            ) : (
              'Guardar cambios'
            )}
          </Button>
          <Button
            variant="ghost"
            onClick={handleCloseCalendarEditor}
            disabled={savingConfig}
          >
            Cancelar
          </Button>
        </div>
      </div>
    )
  }

  const renderCalendarNotificationsPanel = () => (
    <section className={pageStyles.notificationsPanel}>
      <div className={pageStyles.notificationsHeader}>
        <div className={pageStyles.notificationsTitle}>
          <span className={pageStyles.notificationsIcon}>
            {calendarPushEnabled ? <Bell size={18} /> : <BellOff size={18} />}
          </span>
          <div>
            <h3>Avisos en celulares</h3>
            <p>Cuando alguien agenda, Ristak avisa a los celulares que ya dieron permiso.</p>
          </div>
        </div>

        <button
          type="button"
          className={`${pageStyles.editorToggle} ${calendarPushEnabled ? pageStyles.editorToggleActive : ''}`}
          onClick={handleCalendarPushEnabledToggle}
          aria-pressed={calendarPushEnabled}
        >
          <span />
          {calendarPushEnabled ? 'Encendidos' : 'Apagados'}
        </button>
      </div>

      <div className={pageStyles.phoneInstallHint}>
        <Smartphone size={16} />
        <span>El usuario debe abrir Ristak desde el icono del celular y tocar “Activar” en Avisos.</span>
      </div>

      <div className={pageStyles.notificationCalendarPicker}>
        <div className={pageStyles.notificationPickerHeader}>
          <strong>Calendarios que mandan aviso</strong>
          <span>{calendarPushNotificationIds.length ? `${calendarPushNotificationIds.length} elegido${calendarPushNotificationIds.length === 1 ? '' : 's'}` : 'Todos'}</span>
        </div>

        <button
          type="button"
          className={`${pageStyles.notificationAllButton} ${calendarPushNotificationIds.length === 0 ? pageStyles.notificationAllButtonActive : ''}`}
          onClick={handleUseAllCalendarPushNotifications}
        >
          Todos los calendarios
        </button>

        {calendars.length > 0 && (
          <div className={pageStyles.notificationChips}>
            {calendars.map((calendar) => {
              const selected = calendarPushNotificationIds.includes(calendar.id)
              return (
                <button
                  key={calendar.id}
                  type="button"
                  className={`${pageStyles.notificationChip} ${selected ? pageStyles.notificationChipActive : ''}`}
                  onClick={() => handleCalendarPushSelectionToggle(calendar.id)}
                >
                  <span style={{ backgroundColor: calendar.eventColor || 'var(--color-primary)' }} />
                  {calendar.name}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )

  const renderCalendarRow = (calendar: CalendarType) => {
    const isAttributed = attributionCalendarIds.includes(calendar.id)
    const isDefault = defaultCalendarId === calendar.id
    const isExpanded = expandedCalendarId === calendar.id
    const handleRowClick = (event: React.MouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement
      if (target.closest('button, a, input, select, textarea, [role="menuitem"]')) return
      handleOpenCalendarEditor(calendar)
    }

    return (
      <div key={calendar.id} className={pageStyles.calendarItem}>
        <article
          className={`${pageStyles.calendarRow} ${isDefault ? pageStyles.calendarRowDefault : ''} ${isExpanded ? pageStyles.calendarRowEditing : ''}`}
          onClick={handleRowClick}
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
                    <Star size={12} fill="currentColor" />
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
            </div>
          </div>

          <div className={pageStyles.calendarActions} onClick={(event) => event.stopPropagation()}>
            <div className={`${pageStyles.conversionControl} ${isAttributed ? pageStyles.conversionControlActive : ''}`}>
              <span className={`${styles.toggleLabel} ${isAttributed ? styles.toggleLabelActive : ''}`}>
                Conversión
              </span>
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
            </div>
            <div className={pageStyles.rowActionColumn}>
              <span>Acciones</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={pageStyles.moreButton}
                    aria-label={`Acciones para ${calendar.name}`}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className={pageStyles.actionsMenu}>
                  <DropdownMenuItem
                    className={pageStyles.menuItem}
                    disabled={isDefault}
                    onSelect={() => void handleDefaultCalendarChange(calendar.id)}
                  >
                    <Star size={15} />
                    Convertir en predeterminado
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={pageStyles.menuItem}
                    onSelect={() => handleOpenCalendarEditor(calendar)}
                  >
                    <Pencil size={15} />
                    Editar
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={pageStyles.menuItem}
                    onSelect={() => void handleCopyPublicUrl(calendar)}
                  >
                    <Link2 size={15} />
                    Enlace para compartir
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className={`${pageStyles.menuItem} ${pageStyles.dangerMenuItem}`}
                    disabled={deletingCalendarId === calendar.id}
                    onSelect={() => handleDeleteCalendar(calendar)}
                  >
                    {deletingCalendarId === calendar.id ? (
                      <Loader2 size={15} className={styles.spinIcon} />
                    ) : (
                      <Trash2 size={15} />
                    )}
                    Eliminar
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </article>
        {renderCalendarInlineEditor(calendar)}
      </div>
    )
  }

  const renderCalendarsTab = () => (
    <div className={pageStyles.tabPanel}>
      <div className={pageStyles.panelToolbar}>
        <div className={pageStyles.toolbarActions}>
          <Button variant="outline" size="small" onClick={() => setShowCreateModal(true)}>
            <Plus size={16} />
            Crear calendario
          </Button>
          {renderCalendarSourceSelect()}
        </div>
      </div>

      <details className={pageStyles.compactHelp}>
        <summary>¿Qué significa “conversión”?</summary>
        <p>Los calendarios marcados alimentan citas en reportes, campañas, viaje del cliente y eventos de Meta/WhatsApp. Si no marcas ninguno, Ristak toma todos.</p>
      </details>

      {renderCalendarNotificationsPanel()}

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
    const testFailed = googleIntegration?.lastTestStatus === 'error'
    const syncFailed = googleIntegration?.lastSyncStatus === 'error'
    const showWizard = !isConnected || editingGoogleIntegration
    const busyGoogleAction = savingGoogleIntegration || testingGoogleIntegration || syncingGoogleIntegration || disconnectingGoogleIntegration
    const latestGoogleError = syncFailed
      ? googleIntegration?.lastSyncMessage
      : testFailed
        ? googleIntegration?.lastTestMessage
        : ''
    const failureHelp = latestGoogleError ? getGoogleFailureHelp(latestGoogleError) : null
    const guideToggleLabel = googleGuideExpanded ? 'Contraer guía' : 'Expandir guía'

    const renderGoogleGuide = () => (
      <aside className={pageStyles.guidePanel}>
        <div className={pageStyles.guideHeader}>
          <BookOpen size={20} />
          <div>
            <h2>Guía para principiantes</h2>
            <p>Paso a paso sin perderte en Google Cloud.</p>
          </div>
          <button
            type="button"
            className={`${pageStyles.guideToggle} ${googleGuideExpanded ? pageStyles.guideToggleOpen : ''}`}
            onClick={() => setGoogleGuideExpanded((current) => !current)}
            aria-expanded={googleGuideExpanded}
          >
            {guideToggleLabel}
            <ChevronDown size={16} />
          </button>
        </div>

        <div className={pageStyles.guidePreview}>
          <strong>Resumen rápido</strong>
          <span>El correo real de Gmail identifica el calendario. El correo largo del Service Account solo sirve para compartir permisos. El JSON autentica a Ristak.</span>
        </div>

        {googleGuideExpanded && (
          <div className={pageStyles.guideBody}>
            <div className={pageStyles.setupNotice}>
              <strong>Antes de empezar</strong>
              <span>Haz todo con la misma cuenta de Google donde vive el calendario. Revisa el perfil arriba a la derecha tanto en Google Cloud como en Google Calendar.</span>
              <span>No confundas el correo real del calendario con el correo técnico del Service Account; son dos cosas distintas.</span>
            </div>

            <ol className={pageStyles.setupSteps}>
              <li>
                <span className={pageStyles.stepNumber}>1</span>
                <div className={pageStyles.stepBody}>
                  <strong>Entra a Google Cloud</strong>
                  <p>Abre <a href={GOOGLE_HELP_LINKS.googleCloudWelcome} target="_blank" rel="noreferrer">cloud.google.com/welcome</a> con el mismo Gmail donde tienes el calendario que quieres conectar.</p>
                  <span>En la esquina superior derecha confirma que el perfil seleccionado sea el correcto.</span>
                </div>
              </li>
              <li>
                <span className={pageStyles.stepNumber}>2</span>
                <div className={pageStyles.stepBody}>
                  <strong>Crea o selecciona el proyecto</strong>
                  <p>En la esquina superior izquierda, junto al logo de Google Cloud, abre el selector de proyecto.</p>
                  <span>Si ya tienes un proyecto, selecciónalo. Si no tienes ninguno, crea uno llamado <code>Ristak - Google Calendar</code>.</span>
                  <span>Si la página se queda rara después de crearlo, refresca y vuelve a seleccionar ese proyecto en el selector.</span>
                </div>
              </li>
              <li>
                <span className={pageStyles.stepNumber}>3</span>
                <div className={pageStyles.stepBody}>
                  <strong>Activa Google Calendar API</strong>
                  <p>En Google Cloud entra a <code>APIs y servicios</code>. Si no lo ves, usa la barra superior de búsqueda y escribe <code>APIs y servicios</code>.</p>
                  <span>En el menú izquierdo abre <code>Biblioteca</code>, busca <code>Google Calendar</code>, selecciona <code>Google Calendar API</code> y presiona <code>Habilitar</code>.</span>
                  <span>Sin esta API activa, Ristak no podrá probar la conexión aunque el JSON esté correcto.</span>
                </div>
              </li>
              <li>
                <span className={pageStyles.stepNumber}>4</span>
                <div className={pageStyles.stepBody}>
                  <strong>Crea la cuenta de servicio</strong>
                  <p>Abre el menú de navegación de Google Cloud, entra a <code>IAM y administración</code> y después a <code>Cuentas de servicio</code>.</p>
                  <span>Si Google te pide un proyecto reciente, selecciona <code>Ristak - Google Calendar</code> o el proyecto que elegiste.</span>
                  <span>Haz clic en <code>Crear cuenta de servicio</code> y ponle el nombre <code>Ristak - Google Calendar</code>.</span>
                  <span>Cuando Google pida permisos del proyecto, déjalo en blanco y continúa. No necesitas elegir <code>Propietario</code> / <code>Owner</code>.</span>
                  <span>La parte de <code>principales con acceso</code> o usuarios administradores también puede quedarse vacía; es opcional.</span>
                </div>
              </li>
              <li>
                <span className={pageStyles.stepNumber}>5</span>
                <div className={pageStyles.stepBody}>
                  <strong>Copia el email técnico</strong>
                  <p>Al terminar, Google crea un correo largo del Service Account, parecido a <code>ristak-calendar@proyecto.iam.gserviceaccount.com</code>.</p>
                  <span>Copia ese correo. No es tu Gmail y no es el Calendar ID; solo lo vas a usar para compartirle permisos al calendario.</span>
                </div>
              </li>
              <li>
                <span className={pageStyles.stepNumber}>6</span>
                <div className={pageStyles.stepBody}>
                  <strong>Comparte el calendario con ese email técnico</strong>
                  <p>Abre <a href={GOOGLE_HELP_LINKS.googleCalendar} target="_blank" rel="noreferrer">calendar.google.com</a> con el mismo Gmail donde está el calendario.</p>
                  <span>En la izquierda, abre <code>Mis calendarios</code>, encuentra el calendario, toca los tres puntitos y entra a <code>Configurar y compartir</code>.</span>
                  <span>Busca <code>Compartir con personas o grupos específicos</code>, toca <code>Añadir personas y grupos</code> y pega el email técnico del Service Account.</span>
                  <span>En permisos selecciona <code>Hacer cambios y gestionar el uso compartido</code>. Con solo libre/ocupado no alcanza para crear, editar o cancelar citas.</span>
                </div>
              </li>
              <li>
                <span className={pageStyles.stepNumber}>7</span>
                <div className={pageStyles.stepBody}>
                  <strong>Crea la clave JSON</strong>
                  <p>Regresa a Google Cloud, entra a <code>IAM y administración &gt; Cuentas de servicio</code> y abre la cuenta que creaste.</p>
                  <span>En las pestañas superiores entra a <code>Claves</code>, luego <code>Agregar clave</code>, <code>Crear clave nueva</code>, elige <code>JSON</code> y presiona <code>Crear</code>.</span>
                  <span>Copia el JSON completo. Debe incluir <code>type</code>, <code>project_id</code>, <code>private_key</code> y <code>client_email</code>.</span>
                </div>
              </li>
              <li>
                <span className={pageStyles.stepNumber}>8</span>
                <div className={pageStyles.stepBody}>
                  <strong>Conecta en Ristak</strong>
                  <p>Pega en Ristak el JSON completo y el correo real del calendario que quieres conectar.</p>
                  <span>Para el calendario principal normalmente ese Calendar ID es tu Gmail, por ejemplo <code>cliente@gmail.com</code>.</span>
                  <span>No pegues el correo largo del Service Account como Calendar ID, a menos que de verdad sea el ID del calendario.</span>
                  <span>Después presiona <code>Conectar</code>, luego <code>Probar conexión</code> y finalmente <code>Sincronizar ahora</code>.</span>
                </div>
              </li>
            </ol>

            <div className={pageStyles.supportLinks}>
              <a href={GOOGLE_HELP_LINKS.googleCloudWelcome} target="_blank" rel="noreferrer">
                <Globe2 size={16} />
                Entrar a Google Cloud
              </a>
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
              <a href={GOOGLE_HELP_LINKS.googleCalendar} target="_blank" rel="noreferrer">
                <Calendar size={16} />
                Abrir Google Calendar
              </a>
              <a href={GOOGLE_HELP_LINKS.shareCalendar} target="_blank" rel="noreferrer">
                <Calendar size={16} />
                Compartir calendario
              </a>
              <a href={GOOGLE_HELP_LINKS.calendarId} target="_blank" rel="noreferrer">
                <Info size={16} />
                Encontrar Calendar ID
              </a>
              <a href={GOOGLE_HELP_LINKS.videoSearch} target="_blank" rel="noreferrer">
                <PlayCircle size={16} />
                Videos paso a paso
              </a>
            </div>
          </div>
        )}
      </aside>
    )

    return (
      <div className={pageStyles.googleLayout}>
        {renderGoogleGuide()}

        <section className={pageStyles.connectionPanel}>
          {showWizard ? (
            <>
              <div className={pageStyles.connectionHeader}>
                <div>
                  <h2>{isConnected ? 'Editar Google Calendar' : 'Conectar Google Calendar'}</h2>
                  <p>Service Account sin OAuth.</p>
                </div>
                <span className={`${pageStyles.statusPill} ${isConnected ? pageStyles.statusWarn : pageStyles.statusOff}`}>
                  {isConnected ? <Info size={15} /> : <XCircle size={15} />}
                  {isConnected ? 'Editando' : 'Paso 1'}
                </span>
              </div>

              <div className={pageStyles.wizardIntro}>
                <strong>Clave</strong>
                <span>Calendar ID = correo real del calendario. Service Account = email técnico para compartir permisos.</span>
              </div>

              <div className={pageStyles.formGrid}>
                <label className={pageStyles.field}>
                  <span>Correo del calendario o Calendar ID real</span>
                  <input
                    value={googleCalendarId}
                    onChange={(event) => setGoogleCalendarId(event.target.value)}
                    onBlur={() => setGoogleCalendarId(normalizeGoogleCalendarIdInput(googleCalendarId))}
                    placeholder="cliente@gmail.com, cliente@empresa.com, nombre@group.calendar.google.com o link con cid"
                    autoComplete="off"
                  />
                  <small>Normalmente es el Gmail real del cliente. No pegues el email técnico aquí.</small>
                </label>

                <label className={pageStyles.field}>
                  <span>JSON del Service Account</span>
                  <textarea
                    value={serviceAccountJson}
                    onChange={(event) => setServiceAccountJson(event.target.value)}
                    placeholder='{"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\\n...","client_email":"..."}'
                    spellCheck={false}
                  />
                  <small>{isConnected ? 'JSON guardado y editable. Se mantiene cifrado.' : 'Se guarda cifrado y queda disponible para edición.'}</small>
                </label>
              </div>

              <div className={pageStyles.serviceEmailBox}>
                <FileKey2 size={18} />
                <div>
                  <span>Email técnico para compartir el calendario</span>
                  <strong>{serviceAccountEmailForSharing || 'Pega el JSON para ver el email técnico antes de guardar'}</strong>
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
                <Button onClick={handleSaveGoogleIntegration} disabled={savingGoogleIntegration || testingGoogleIntegration || syncingGoogleIntegration}>
                  {savingGoogleIntegration ? (
                    <>
                      <Loader2 size={16} className={styles.spinIcon} />
                      Guardando...
                    </>
                  ) : (
                    <>
                      <KeyRound size={16} />
                      {isConnected ? 'Guardar cambios' : 'Conectar'}
                    </>
                  )}
                </Button>
                {isConnected && (
                  <Button variant="ghost" onClick={() => setEditingGoogleIntegration(false)} disabled={busyGoogleAction}>
                    Cancelar edición
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className={pageStyles.connectionHeader}>
                <div>
                  <h2>Google Calendar</h2>
                  <p>Conexión activa para sincronizar citas.</p>
                </div>
                <span className={`${pageStyles.statusPill} ${pageStyles.statusOk}`}>
                  <CheckCircle size={15} />
                  Conectado
                </span>
              </div>

              <div className={pageStyles.connectedCard}>
                <div className={pageStyles.connectedIcon}>
                  <Globe2 size={22} />
                </div>
                <div className={pageStyles.connectedMain}>
                  <div className={pageStyles.connectedTitle}>
                    <h3>{googleIntegration?.calendarSummary || 'Google Calendar'}</h3>
                    <span>Conectado</span>
                  </div>
                  <p>{googleIntegration?.calendarId || 'Calendar ID pendiente'}</p>
                </div>
              </div>

              <div className={pageStyles.connectedActions}>
                <Button onClick={handleSyncGoogleIntegration} disabled={busyGoogleAction}>
                  {syncingGoogleIntegration ? (
                    <>
                      <Loader2 size={16} className={styles.spinIcon} />
                      Sincronizando...
                    </>
                  ) : (
                    <>
                      <RefreshCw size={16} />
                      Sincronizar ahora
                    </>
                  )}
                </Button>
                <Button variant="outline" onClick={handleTestGoogleIntegration} disabled={busyGoogleAction}>
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
                <Button variant="ghost" onClick={handleEditGoogleIntegration} disabled={busyGoogleAction}>
                  <Pencil size={16} />
                  Editar
                </Button>
                <Button variant="ghost" onClick={handleDisconnectGoogleIntegration} disabled={busyGoogleAction}>
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
              </div>
            </>
          )}

          {(testFailed || syncFailed) && (
            <div className={pageStyles.resultStack}>
              {testFailed && (
                <div className={`${pageStyles.testResult} ${pageStyles.testError}`}>
                  Última prueba fallida: {googleIntegration?.lastTestMessage}
                </div>
              )}
              {syncFailed && (
                <div className={`${pageStyles.testResult} ${pageStyles.testError}`}>
                  Última sincronización fallida: {googleIntegration?.lastSyncMessage}
                </div>
              )}
              {failureHelp && (
                <div className={pageStyles.failureHelp}>
                  <strong>{failureHelp.title}</strong>
                  {failureHelp.steps.map((step) => (
                    <span key={step}>{step}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

      </div>
    )
  }

  const renderGoogleHeaderAction = () => {
    const isConnected = Boolean(googleIntegration?.connected)

    return (
      <button
        type="button"
        className={`${pageStyles.googleHeaderButton} ${isConnected ? pageStyles.googleHeaderButtonConnected : ''}`}
        onClick={() => {
          setActiveView('google')
          setEditingGoogleIntegration(!isConnected)
        }}
      >
        <span className={pageStyles.googleCalendarMark}>
          <Calendar size={16} />
        </span>
        <span>{isConnected ? 'Conectado' : 'Integrar Google Calendar'}</span>
      </button>
    )
  }

  if (loadingCalendars) {
    return <Loading message="Cargando calendarios..." page="calendar-settings" />
  }

  return (
    <div className={styles.integrationContainer}>
      <Card className={`${styles.mainCard} ${pageStyles.mainCard}`}>
        <div className={pageStyles.header}>
          <div className={pageStyles.headerIdentity}>
            {activeView === 'google' ? (
              <button
                type="button"
                className={pageStyles.backButton}
                onClick={() => setActiveView('calendars')}
                aria-label="Volver a calendarios"
              >
                <ArrowLeft size={18} />
              </button>
            ) : (
              <div className={pageStyles.headerIcon}>
                <Calendar size={20} />
              </div>
            )}
            <div>
              <h2>{activeView === 'google' ? 'Configuración de Google Calendar' : 'Configuración de calendario'}</h2>
              <p>
                {activeView === 'google'
                  ? 'Conecta, prueba y sincroniza Google Calendar con Ristak.'
                  : 'Administra calendarios, predeterminado y conversiones.'}
              </p>
            </div>
          </div>
          {activeView === 'calendars' && renderGoogleHeaderAction()}
        </div>

        {activeView === 'calendars' ? renderCalendarsTab() : renderGoogleCalendarTab()}
      </Card>

      {renderCreateCalendarModal()}
      {renderGoogleDefaultPromptModal()}
    </div>
  )
}
