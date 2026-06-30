import React, { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  Clock3,
  Cloud,
  ExternalLink,
  FileText,
  Hash as HashIcon,
  KeyRound,
  Link2,
  MoreHorizontal,
  Plus,
  QrCode,
  RefreshCw,
  Send,
  ShieldCheck,
  Star,
  Unplug,
  Wallet
} from 'lucide-react'
import { SiWhatsapp } from 'react-icons/si'
import {
  Badge,
  Button,
  CustomSelect,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Modal,
  NumberInput,
  PageHeader,
  SearchField,
  Switch
} from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { useUrlStringState } from '@/hooks'
import { WhatsAppApiAlert, WhatsAppApiPhoneNumber, WhatsAppApiStatus, WhatsAppQrDripDelayUnit, WhatsAppQrDripSettings, WhatsAppQrSession, whatsappApiService } from '@/services/whatsappApiService'
import { formatInTimezone, getStoredBusinessTimezone } from '@/utils/timezone'
import { MessageTemplates } from './MessageTemplates'
import styles from './WhatsAppSettings.module.css'

type BusinessProfile = {
  businessName?: string
  name?: string
  verifiedName?: string
  profilePictureUrl?: string
  category?: string
}

type ConnectedSection = 'numbers' | 'templates' | 'alerts'
type PhoneFilter = 'all' | 'main' | 'qr' | 'attention'
type AlertFilter = 'all' | 'critical' | 'warning' | 'info'
type ConnectionChoice = 'api' | 'qr'
const phoneFilters: PhoneFilter[] = ['all', 'main', 'qr', 'attention']
const alertFilters: AlertFilter[] = ['all', 'critical', 'warning', 'info']
const isPhoneFilter = (value?: string | null): value is PhoneFilter => phoneFilters.includes(value as PhoneFilter)
const isAlertFilter = (value?: string | null): value is AlertFilter => alertFilters.includes(value as AlertFilter)
const isQueryText = (value?: string | null): value is string => typeof value === 'string'

const YCLOUD_REGISTER_URL = 'https://www.ycloud.com/console/#/entry/register'
const YCLOUD_CONSOLE_URL = 'https://www.ycloud.com/console/#/app/dashboard/analytics'
const META_WHATSAPP_PAYMENT_CONFIG_URL = 'https://business.facebook.com/latest/settings/whatsapp_account'
const QR_DRIP_DISABLE_CONFIRM_WORD = 'APAGAR'
const DEFAULT_QR_DRIP_SETTINGS: Required<WhatsAppQrDripSettings> = {
  enabled: true,
  delaySeconds: 30,
  delayUnit: 'seconds',
  minDelaySeconds: 15,
  maxDelaySeconds: 600
}
const QR_DRIP_EXAMPLE_NAMES = ['María López', 'Carlos Vega', 'Ana Ruiz', 'Luis Ortega', 'Diana Solís']
const QR_DRIP_DELAY_UNIT_OPTIONS: Array<{ value: WhatsAppQrDripDelayUnit; label: string }> = [
  { value: 'seconds', label: 'Segundos' },
  { value: 'minutes', label: 'Minutos' }
]

function parseJson<T>(value?: string | null): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function formatMetric(value?: number | null) {
  return new Intl.NumberFormat('es-MX').format(Number(value || 0))
}

function formatCurrency(amount?: number | null, currency?: string | null) {
  const cleanCurrency = currency || 'USD'
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: cleanCurrency,
      maximumFractionDigits: 2
    }).format(Number(amount || 0))
  } catch {
    return `${new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 }).format(Number(amount || 0))} ${cleanCurrency}`
  }
}

function getPhoneLabel(phone: WhatsAppApiPhoneNumber) {
  const number = phone.display_phone_number || phone.phone_number || 'Número'
  return phone.verified_name ? `${number} · ${phone.verified_name}` : number
}

function getPhoneProfile(phone?: WhatsAppApiPhoneNumber | null) {
  return parseJson<BusinessProfile>(phone?.business_profile_json)
}

function getAlertClass(severity?: string | null) {
  if (severity === 'critical') return styles.apiAlertCritical
  if (severity === 'warning') return styles.apiAlertWarning
  return styles.apiAlertInfo
}

function normalizeAlertText(value?: string | null) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function getAlertWeight(severity?: string | null) {
  const normalized = String(severity || '').toLowerCase()
  if (normalized === 'critical') return 3
  if (normalized === 'warning') return 2
  return 1
}

function getQrStatusLabel(status?: string | null) {
  const normalized = String(status || '').toLowerCase()
  if (!normalized) return 'Sin QR'
  if (normalized === 'connected') return 'QR conectado'
  if (normalized === 'qr_pending') return 'Escanea QR'
  if (normalized === 'starting') return 'Preparando QR'
  if (normalized === 'restarting') return 'Reiniciando QR'
  if (normalized === 'reconnecting') return 'Reconectando QR'
  if (normalized === 'number_mismatch') return 'Número incorrecto'
  if (normalized === 'bad_session') return 'Reconectar QR'
  if (normalized === 'connection_replaced') return 'Sesión reemplazada'
  if (normalized === 'disconnected_515') return 'Reiniciar QR'
  if (normalized === 'logged_out') return 'QR cerrado'
  if (normalized.startsWith('disconnected')) return 'QR desconectado'
  return 'QR apagado'
}

function isQrWorkingStatus(status?: string | null) {
  return ['connected', 'qr_pending', 'starting', 'restarting', 'reconnecting'].includes(String(status || '').toLowerCase())
}

function normalizeQrDripSettings(settings?: WhatsAppQrDripSettings | null): Required<WhatsAppQrDripSettings> {
  const delaySeconds = Number(settings?.delaySeconds)
  const minDelaySeconds = Number(settings?.minDelaySeconds) || DEFAULT_QR_DRIP_SETTINGS.minDelaySeconds
  const maxDelaySeconds = Number(settings?.maxDelaySeconds) || DEFAULT_QR_DRIP_SETTINGS.maxDelaySeconds
  const delayUnit = settings?.delayUnit === 'minutes' ? 'minutes' : DEFAULT_QR_DRIP_SETTINGS.delayUnit
  return {
    enabled: settings?.enabled ?? DEFAULT_QR_DRIP_SETTINGS.enabled,
    delaySeconds: Number.isFinite(delaySeconds)
      ? Math.min(Math.max(Math.round(delaySeconds), minDelaySeconds), maxDelaySeconds)
      : DEFAULT_QR_DRIP_SETTINGS.delaySeconds,
    delayUnit,
    minDelaySeconds,
    maxDelaySeconds
  }
}

function clampQrDripDelaySeconds(seconds: number, settings: Required<WhatsAppQrDripSettings>) {
  return Math.min(Math.max(Math.round(seconds), settings.minDelaySeconds), settings.maxDelaySeconds)
}

function getQrDripDelayAmount(delaySeconds: number, unit: WhatsAppQrDripDelayUnit) {
  if (unit === 'minutes') {
    return Number((Math.max(1, delaySeconds) / 60).toFixed(2))
  }

  return Math.max(1, Math.round(delaySeconds))
}

function getQrDripDelayBounds(settings: Required<WhatsAppQrDripSettings>, unit: WhatsAppQrDripDelayUnit) {
  if (unit === 'minutes') {
    return {
      min: Number((settings.minDelaySeconds / 60).toFixed(2)),
      max: Number((settings.maxDelaySeconds / 60).toFixed(2)),
      step: 0.25
    }
  }

  return {
    min: settings.minDelaySeconds,
    max: settings.maxDelaySeconds,
    step: 5
  }
}

function parseQrDripDelayUnit(value: string): WhatsAppQrDripDelayUnit {
  return value === 'minutes' ? 'minutes' : 'seconds'
}

function formatQrDripDelay(seconds: number) {
  const safeSeconds = Math.max(1, Math.round(Number(seconds) || DEFAULT_QR_DRIP_SETTINGS.delaySeconds))
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = safeSeconds % 60
  if (minutes && remainder) return `${minutes} min ${remainder} s`
  if (minutes) return `${minutes} min`
  return `${safeSeconds} s`
}

function buildQrDripExample(delaySeconds: number) {
  const base = new Date()
  const timezone = getStoredBusinessTimezone()

  return QR_DRIP_EXAMPLE_NAMES.map((name, index) => {
    const sendAt = new Date(base.getTime() + (index * Math.max(1, delaySeconds) * 1000))
    return {
      name,
      offset: index === 0 ? 'Ahora' : `+${formatQrDripDelay(index * delaySeconds)}`,
      time: formatInTimezone(sendAt, timezone, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    }
  })
}

const whatsappSections: ConnectedSection[] = ['numbers', 'templates', 'alerts']
const isWhatsAppSection = (value?: string): value is ConnectedSection => whatsappSections.includes(value as ConnectedSection)
const parseWhatsAppSection = (pathname: string): ConnectedSection => {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const whatsappIndex = segments.indexOf('whatsapp')
  const section = whatsappIndex >= 0 ? segments[whatsappIndex + 1] : ''
  return isWhatsAppSection(section) ? section : 'numbers'
}
const buildWhatsAppSettingsPath = (section: ConnectedSection) => `/settings/whatsapp/${section}`

export const WhatsAppSettings: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const navigate = useNavigate()
  const location = useLocation()
  const routeSection = useMemo(() => parseWhatsAppSection(location.pathname), [location.pathname])
  const [activeSection, setActiveSection] = useState<ConnectedSection>(routeSection)
  const [phoneFilter, setPhoneFilter] = useUrlStringState<PhoneFilter>('phoneFilter', 'all', isPhoneFilter)
  const [alertFilter, setAlertFilter] = useUrlStringState<AlertFilter>('alertFilter', 'all', isAlertFilter)
  const [phoneSearch, setPhoneSearch] = useUrlStringState<string>('phoneSearch', '', isQueryText)
  const [alertSearch, setAlertSearch] = useUrlStringState<string>('alertSearch', '', isQueryText)
  const [apiStatus, setApiStatus] = useState<WhatsAppApiStatus | null>(null)
  const [apiLoading, setApiLoading] = useState(true)
  const [apiConnecting, setApiConnecting] = useState(false)
  const [apiRefreshing, setApiRefreshing] = useState(false)
  const [apiDisconnecting, setApiDisconnecting] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [selectedPhoneId, setSelectedPhoneId] = useState('')
  const [metaBusinessAccountId, setMetaBusinessAccountId] = useState('')
  const [qrConnectingPhoneId, setQrConnectingPhoneId] = useState('')
  const [qrDisconnectingPhoneId, setQrDisconnectingPhoneId] = useState('')
  const [qrConsentPhone, setQrConsentPhone] = useState<WhatsAppApiPhoneNumber | null>(null)
  const [connectionChoice, setConnectionChoice] = useState<ConnectionChoice | null>(null)
  const [addNumberModalOpen, setAddNumberModalOpen] = useState(false)
  const [addNumberChoice, setAddNumberChoice] = useState<ConnectionChoice | null>(null)
  const [qrStandalonePhone, setQrStandalonePhone] = useState('')
  const [qrStandaloneLabel, setQrStandaloneLabel] = useState('')
  const [qrCreatingPhone, setQrCreatingPhone] = useState(false)
  // El modal de QR tiene dos pasos: primero el aviso de riesgo y, al aceptar,
  // el código QR en grande dentro del mismo modal.
  const [qrModalView, setQrModalView] = useState<'consent' | 'qr'>('consent')
  const [qrDripModalOpen, setQrDripModalOpen] = useState(false)
  const [qrDripDelayDraft, setQrDripDelayDraft] = useState(DEFAULT_QR_DRIP_SETTINGS.delaySeconds)
  const [qrDripDelayUnitDraft, setQrDripDelayUnitDraft] = useState<WhatsAppQrDripDelayUnit>(DEFAULT_QR_DRIP_SETTINGS.delayUnit)
  const [qrDripSaving, setQrDripSaving] = useState(false)
  const [qrDripDisableConfirmOpen, setQrDripDisableConfirmOpen] = useState(false)
  const [defaultingPhoneId, setDefaultingPhoneId] = useState('')

  const apiConnected = Boolean(apiStatus?.connected)
  const hasWhatsAppNumbers = Boolean(apiStatus?.phoneNumbers?.length)
  const hasAnyWhatsAppConnection = apiConnected || hasWhatsAppNumbers
  const qrDripSettings = useMemo(() => normalizeQrDripSettings(apiStatus?.qr?.drip), [apiStatus?.qr?.drip])
  const qrDripExample = useMemo(() => buildQrDripExample(qrDripDelayDraft), [qrDripDelayDraft])
  const qrDripDelayBounds = useMemo(() => getQrDripDelayBounds(qrDripSettings, qrDripDelayUnitDraft), [qrDripDelayUnitDraft, qrDripSettings])
  const qrDripDelayAmountDraft = useMemo(() => getQrDripDelayAmount(qrDripDelayDraft, qrDripDelayUnitDraft), [qrDripDelayDraft, qrDripDelayUnitDraft])
  const qrDripDelayChanged = qrDripDelayDraft !== qrDripSettings.delaySeconds || qrDripDelayUnitDraft !== qrDripSettings.delayUnit

  useEffect(() => {
    setQrDripDelayDraft(qrDripSettings.delaySeconds)
    setQrDripDelayUnitDraft(qrDripSettings.delayUnit)
  }, [qrDripSettings.delaySeconds, qrDripSettings.delayUnit])

  useEffect(() => {
    setActiveSection(current => current === routeSection ? current : routeSection)
  }, [routeSection])

  const selectSection = (section: ConnectedSection) => {
    setActiveSection(section)
    navigate(buildWhatsAppSettingsPath(section))
  }

  const selectedPhone = useMemo(() => {
    return apiStatus?.phoneNumbers.find(phone => phone.id === selectedPhoneId) || apiStatus?.selectedPhone || apiStatus?.phoneNumbers[0] || null
  }, [apiStatus?.phoneNumbers, apiStatus?.selectedPhone, selectedPhoneId])
  const ycloudAssetId = selectedPhone?.waba_id || apiStatus?.sender.wabaId || ''

  const qrSessionsByPhoneId = useMemo(() => {
    return new Map<string, WhatsAppQrSession>(
      (apiStatus?.qr?.sessions || []).map((session) => [session.phoneNumberId, session])
    )
  }, [apiStatus?.qr?.sessions])

  const hasApiCredential = Boolean(apiKey.trim() || apiStatus?.credentials.hasApiKey)
  const canSubmitApi = hasApiCredential

  const loadApiStatus = async () => {
    const nextStatus = await whatsappApiService.getStatus()
    setApiStatus(nextStatus)

    if (nextStatus.phoneNumbers.length) {
      // La lista completa se muestra abajo; este id solo marca el principal.
    }

    const preferredPhoneId = nextStatus.sender.phoneNumberId ||
      nextStatus.phoneNumbers.find(phone => phone.is_default_sender)?.id ||
      nextStatus.phoneNumbers.find(phone => phone.phone_number === nextStatus.sender.phone)?.id ||
      nextStatus.phoneNumbers[0]?.id ||
      ''

    setSelectedPhoneId(preferredPhoneId)
    return nextStatus
  }

  const paymentConfigUrl = useMemo(() => {
    const businessId = metaBusinessAccountId.trim()
    const assetId = ycloudAssetId.trim()

    if (!businessId || !assetId) return ''

    const params = new URLSearchParams({
      business_id: businessId,
      selected_asset_id: assetId,
      selected_asset_type: 'whatsapp-business-account'
    })

    return `${META_WHATSAPP_PAYMENT_CONFIG_URL}?${params.toString()}`
  }, [metaBusinessAccountId, ycloudAssetId])

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      try {
        await loadApiStatus()
      } catch (error) {
        if (!cancelled) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo leer WhatsApp Business')
        }
      } finally {
        if (!cancelled) setApiLoading(false)
      }
    }

    bootstrap()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const connected = params.get('meta_connected')
    if (!connected) return

    if (connected === '1') {
      showToast('success', 'Meta conectado', 'La conexión directa quedó guardada. Actívala cuando quieras usarla para enviar.')
      loadApiStatus().catch(() => null)
    } else {
      showToast('error', 'Meta no se conectó', params.get('meta_error') || 'Revisa la configuración en el portal.')
    }

    params.delete('meta_connected')
    params.delete('meta_error')
    navigate({
      pathname: location.pathname,
      search: params.toString() ? `?${params.toString()}` : ''
    }, { replace: true })
  }, [location.pathname, location.search, navigate, showToast])

  useEffect(() => {
    let cancelled = false

    const loadMetaBusinessAccount = async () => {
      try {
        const data = await whatsappApiService.getMetaBusinessAccount()

        if (!cancelled) setMetaBusinessAccountId(String(data.whatsappBusinessAccountId || '').trim())
      } catch {
        if (!cancelled) {
          setMetaBusinessAccountId('')
        }
      }
    }

    loadMetaBusinessAccount()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const hasPendingQr = apiStatus?.phoneNumbers.some((phone) => {
      const status = String(qrSessionsByPhoneId.get(phone.id)?.status || phone.qr_status || '').toLowerCase()
      return status === 'starting' || status === 'qr_pending' || status === 'restarting' || status === 'reconnecting'
    })

    if (!hasPendingQr && !qrConnectingPhoneId) return

    const timer = window.setInterval(() => {
      loadApiStatus().catch(() => null)
    }, 4000)

    return () => window.clearInterval(timer)
  }, [apiStatus?.phoneNumbers, qrConnectingPhoneId, qrSessionsByPhoneId])

  const connectApi = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!canSubmitApi || apiConnecting) return

    setApiConnecting(true)
    try {
      const nextStatus = await whatsappApiService.connect({
        apiKey: apiKey.trim() || undefined
      })
      setApiStatus(nextStatus)
      setApiKey('')
      selectSection('numbers')

      showToast('success', 'WhatsApp conectado', 'Ristak sincronizo los números disponibles de WhatsApp API')
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo conectar WhatsApp Business')
    } finally {
      setApiConnecting(false)
      setApiLoading(false)
    }
  }

  const refreshApi = async () => {
    setApiRefreshing(true)
    try {
      const nextStatus = await whatsappApiService.refresh()
      setApiStatus(nextStatus)
      showToast('success', 'Actualizado', 'WhatsApp se sincronizo con WhatsApp API')
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo actualizar WhatsApp')
    } finally {
      setApiRefreshing(false)
    }
  }

  const refreshWhatsAppStatus = async () => {
    if (apiConnected) {
      await refreshApi()
      return
    }

    setApiRefreshing(true)
    try {
      await loadApiStatus()
      showToast('success', 'Actualizado', 'Se actualizó el estado de WhatsApp')
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo actualizar WhatsApp')
    } finally {
      setApiRefreshing(false)
    }
  }

  const mergeQrDripSettings = (settings: WhatsAppQrDripSettings) => {
    setApiStatus(current => {
      if (!current) return current
      return {
        ...current,
        qr: {
          consentText: current.qr?.consentText || '',
          sessions: current.qr?.sessions || [],
          ...current.qr,
          drip: settings
        }
      }
    })
  }

  const saveQrDripSettings = async (patch: Partial<WhatsAppQrDripSettings>, options: { quiet?: boolean } = {}) => {
    setQrDripSaving(true)
    try {
      const nextSettings = await whatsappApiService.updateQrDripSettings(patch)
      mergeQrDripSettings(nextSettings)
      setQrDripDelayDraft(nextSettings.delaySeconds)
      setQrDripDelayUnitDraft(normalizeQrDripSettings(nextSettings).delayUnit)
      if (!options.quiet) {
        showToast(
          'success',
          'Anti-bloqueos actualizado',
          nextSettings.enabled
            ? `Los mensajes por QR saldrán con ${formatQrDripDelay(nextSettings.delaySeconds)} entre cada envío automático.`
            : 'El envío por QR ya no tendrá retardo automático.'
        )
      }
      return nextSettings
    } catch (error) {
      showToast('error', 'No se pudo guardar', error instanceof Error ? error.message : 'Intenta nuevamente.')
      throw error
    } finally {
      setQrDripSaving(false)
    }
  }

  const requestQrDripToggle = (nextEnabled: boolean) => {
    if (!nextEnabled) {
      setQrDripDisableConfirmOpen(true)
      return
    }

    saveQrDripSettings({ enabled: true }).catch(() => null)
  }

  const saveQrDripDelay = () => {
    saveQrDripSettings({ delaySeconds: qrDripDelayDraft, delayUnit: qrDripDelayUnitDraft }).catch(() => null)
  }

  const updateQrDripDelayAmount = (amount: number) => {
    const nextSeconds = qrDripDelayUnitDraft === 'minutes' ? amount * 60 : amount
    setQrDripDelayDraft(clampQrDripDelaySeconds(nextSeconds, qrDripSettings))
  }

  const updateQrDripDelayUnit = (value: string) => {
    setQrDripDelayUnitDraft(parseQrDripDelayUnit(value))
  }

  const openAddNumberModal = () => {
    setAddNumberChoice(null)
    setQrStandalonePhone('')
    setQrStandaloneLabel('')
    setAddNumberModalOpen(true)
  }

  const openQrConsentAfterCreate = async (phone: WhatsAppApiPhoneNumber) => {
    const nextStatus = await loadApiStatus()
    const hydratedPhone = nextStatus.phoneNumbers.find(item => item.id === phone.id) || phone
    setSelectedPhoneId(hydratedPhone.id)
    setQrModalView('consent')
    setQrConsentPhone(hydratedPhone)
  }

  const createQrNumber = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!qrStandalonePhone.trim() || qrCreatingPhone) return

    setQrCreatingPhone(true)
    try {
      const phone = await whatsappApiService.createQrPhoneNumber({
        phoneNumber: qrStandalonePhone.trim(),
        label: qrStandaloneLabel.trim() || undefined
      })
      setAddNumberModalOpen(false)
      setConnectionChoice(null)
      setQrStandalonePhone('')
      setQrStandaloneLabel('')
      await openQrConsentAfterCreate(phone)
    } catch (error) {
      showToast('error', 'No se pudo preparar QR', error instanceof Error ? error.message : 'Intenta con otro número.')
    } finally {
      setQrCreatingPhone(false)
    }
  }

  const makePhoneDefault = async (phone: WhatsAppApiPhoneNumber) => {
    if (!phone.id || defaultingPhoneId) return

    setDefaultingPhoneId(phone.id)
    try {
      const nextStatus = await whatsappApiService.setDefaultPhoneNumber(phone.id)
      setApiStatus(nextStatus)
      setSelectedPhoneId(phone.id)
      showToast('success', 'Número principal guardado', `${getPhoneLabel(phone)} quedó como respaldo para chats nuevos.`)
    } catch (error) {
      showToast('error', 'No se pudo guardar', error instanceof Error ? error.message : 'Intenta marcarlo otra vez.')
    } finally {
      setDefaultingPhoneId('')
    }
  }

  const confirmApiDisconnect = () => {
    showConfirm(
      'Desconectar WhatsApp',
      'Se eliminará la llave local de WhatsApp API. Los mensajes, contactos y plantillas guardadas se quedan intactos, pero para reconectar tendrás que pegar la API Key otra vez.',
      async () => {
        setApiDisconnecting(true)
        try {
          const nextStatus = await whatsappApiService.disconnect()
          setApiStatus(nextStatus)
          showToast('success', 'Desconectado', 'WhatsApp Business quedó sin credenciales locales')
        } catch (error) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo desconectar WhatsApp')
        } finally {
          setApiDisconnecting(false)
        }
      },
      'Desconectar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'DESCONECTAR' }
    )
  }

  const openQrConsentForPhone = (phone: WhatsAppApiPhoneNumber) => {
    // Si ya hay un QR generándose para este número, abrir directo en el QR.
    const session = qrSessionsByPhoneId.get(phone.id)
    const status = String(session?.status || phone.qr_status || '').toLowerCase()
    const alreadyPending = ['qr_pending', 'starting', 'restarting', 'reconnecting'].includes(status)
    setQrModalView(alreadyPending && session?.qrCodeDataUrl ? 'qr' : 'consent')
    setQrConsentPhone(phone)
  }

  const confirmQrConnection = async (phone: WhatsAppApiPhoneNumber) => {
    setQrModalView('qr')
    setQrConnectingPhoneId(phone.id)
    try {
      const session = await whatsappApiService.connectQr({
        phoneNumberId: phone.id,
        acceptedRisk: true
      })
      await loadApiStatus()
      if (session.status === 'connected') {
        showToast('success', 'QR conectado', 'Este número ya puede mandar mensajes individuales por QR')
      } else if (session.status === 'qr_pending') {
        showToast('info', 'Escanea el QR', 'Usa WhatsApp en ese mismo número para completar la conexión')
      } else {
        showToast('warning', 'QR pendiente', session.lastError || 'Revisa el estado del código QR')
      }
    } catch (error) {
      showToast('error', 'No se pudo abrir QR', error instanceof Error ? error.message : 'Intenta nuevamente')
    } finally {
      setQrConnectingPhoneId('')
    }
  }

  const disconnectQrForPhone = (phone: WhatsAppApiPhoneNumber) => {
    showConfirm(
      'Desconectar QR',
      `Se apagara el envio por QR para ${getPhoneLabel(phone)}. La conexión oficial de WhatsApp API y los mensajes guardados se quedan intactos.`,
      async () => {
        setQrDisconnectingPhoneId(phone.id)
        try {
          await whatsappApiService.disconnectQr(phone.id)
          await loadApiStatus()
          showToast('success', 'QR desconectado', 'Este número ya no enviara mensajes por QR')
        } catch (error) {
          showToast('error', 'No se pudo desconectar', error instanceof Error ? error.message : 'Intenta nuevamente')
        } finally {
          setQrDisconnectingPhoneId('')
        }
      },
      'Desconectar',
      'Cancelar'
    )
  }

  const connectionAlerts = useMemo(() => {
    return (apiStatus?.alerts?.items || []).filter((alert) => {
      const type = String(alert.alert_type || '').toLowerCase()
      const entity = String(alert.entity_type || '').toLowerCase()
      return entity !== 'template' && !type.includes('template')
    })
  }, [apiStatus?.alerts?.items])

  const connectionAlertGroups = useMemo(() => {
    const groups = new Map<string, {
      key: string
      severity: string
      title: string
      message: string
      count: number
      titles: string[]
      alerts: WhatsAppApiAlert[]
    }>()

    for (const alert of connectionAlerts) {
      const severity = String(alert.severity || 'info').toLowerCase()
      const title = normalizeAlertText(alert.title) || 'Aviso de WhatsApp'
      const message = normalizeAlertText(alert.message)
      const key = `${severity}|${message || title}`
      const existing = groups.get(key)

      if (existing) {
        existing.count += 1
        existing.alerts.push(alert)
        if (!existing.titles.includes(title)) existing.titles.push(title)
        continue
      }

      groups.set(key, {
        key,
        severity,
        title,
        message,
        count: 1,
        titles: [title],
        alerts: [alert]
      })
    }

    return Array.from(groups.values()).sort((a, b) => {
      const severityDiff = getAlertWeight(b.severity) - getAlertWeight(a.severity)
      if (severityDiff !== 0) return severityDiff
      return b.count - a.count
    })
  }, [connectionAlerts])

  const renderApiForm = () => (
    <form className={styles.apiConnectForm} onSubmit={connectApi}>
      <label className={styles.fieldLabel}>
        <span>Llave de conexión de WhatsApp API</span>
        <div className={styles.apiKeyRow}>
          <div className={styles.inputWrap} data-ristak-unstyled>
            <KeyRound size={17} />
            <input
              type="password"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value)
              }}
              placeholder={apiStatus?.credentials.hasApiKey ? 'Llave guardada' : 'Pega tu llave de WhatsApp API'}
              autoComplete="off"
            />
          </div>
        </div>
      </label>

      <Button type="submit" loading={apiConnecting} disabled={!canSubmitApi}>
        <Cloud size={18} />
        {apiConnected ? 'Actualizar conexión' : 'Conectar WhatsApp API'}
      </Button>
    </form>
  )

  const renderYCloudGuide = () => (
    <div className={styles.apiTutorial}>
      <div className={styles.apiTutorialHeader}>
        <span>Guia rapida</span>
        <strong>Conecta tu cuenta oficial</strong>
      </div>
      <ol className={styles.apiTutorialSteps}>
        <li>
          <span>1</span>
          <div>
            <strong>Entra a WhatsApp API</strong>
            <p>Usa la cuenta del negocio donde tienes tu WhatsApp Business.</p>
            <a className={styles.apiTutorialButton} href={YCLOUD_REGISTER_URL} target="_blank" rel="noopener noreferrer">
              Abrir WhatsApp API
              <ExternalLink size={14} />
            </a>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>Copia tu llave de conexión</strong>
            <p>Pégala aquí y Ristak se conectará a tu cuenta.</p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>Revisa tus números</strong>
            <p>Al conectar, Ristak mostrará todos los números disponibles en esta misma pantalla.</p>
          </div>
        </li>
      </ol>
    </div>
  )

  const renderConnectionBack = (onBack: () => void) => (
    <button type="button" className={styles.backButton} onClick={onBack}>
      <ArrowLeft size={15} />
      Volver
    </button>
  )

  const renderConnectionChooser = (onSelect: (choice: ConnectionChoice) => void) => (
    <div className={styles.connectionPicker}>
      <button type="button" className={styles.connectionCard} onClick={() => onSelect('api')}>
        <Cloud size={22} />
        <strong>WhatsApp API</strong>
        <span>Conexión oficial para plantillas, revisión de Meta y envío estable.</span>
      </button>
      <button type="button" className={styles.connectionCard} onClick={() => onSelect('qr')}>
        <QrCode size={22} />
        <strong>Mediante QR</strong>
        <span>Conecta un número por WhatsApp Web para uso manual o respaldo.</span>
      </button>
    </div>
  )

  const renderQrNumberForm = () => (
    <form className={styles.qrStandaloneForm} onSubmit={createQrNumber}>
      <label className={styles.fieldLabel}>
        <span>Número de WhatsApp</span>
        <div className={styles.inputWrap} data-ristak-unstyled>
          <SiWhatsapp size={17} />
          <input
            value={qrStandalonePhone}
            onChange={(event) => setQrStandalonePhone(event.target.value)}
            placeholder="+52 656 123 4567"
            autoComplete="tel"
          />
        </div>
      </label>
      <label className={styles.fieldLabel}>
        <span>Nombre interno</span>
        <div className={styles.inputWrap} data-ristak-unstyled>
          <HashIcon size={17} />
          <input
            value={qrStandaloneLabel}
            onChange={(event) => setQrStandaloneLabel(event.target.value)}
            placeholder="Recepción, ventas, soporte..."
          />
        </div>
      </label>
      <Button type="submit" loading={qrCreatingPhone} disabled={!qrStandalonePhone.trim()}>
        <QrCode size={17} />
        Conectar mediante QR
      </Button>
    </form>
  )

  const renderApiConnectionOptions = () => (
    <div className={styles.connectionOptions}>
      <section className={styles.connectionOption}>
        <p className={styles.connectionOptionTitle}>Conectar con Meta</p>
        <Button
          type="button"
          variant="secondary"
          className={styles.metaConnectButtonDisabled}
          disabled
        >
          <Link2 size={17} />
          Próximamente
        </Button>
      </section>

      <div className={styles.connectionDivider} aria-hidden="true">
        <span>O</span>
      </div>

      <section className={styles.connectionOption}>
        <p className={styles.connectionOptionTitle}>Ingresa usando YCloud</p>
        {renderApiForm()}
      </section>
    </div>
  )

  const renderAddNumberContent = () => {
    if (!addNumberChoice) {
      return (
        <div className={styles.qrConsentBody}>
          <p>Elige cómo quieres agregar este número de WhatsApp a Ristak.</p>
          {renderConnectionChooser(setAddNumberChoice)}
        </div>
      )
    }

    if (addNumberChoice === 'api') {
      return (
        <div className={styles.qrConsentBody}>
          {renderConnectionBack(() => setAddNumberChoice(null))}
          <p>La conexión directa de otro número por Meta estará disponible pronto.</p>
          <Button type="button" variant="secondary" className={styles.metaConnectButtonDisabled} disabled>
            <Link2 size={17} />
            Próximamente
          </Button>
        </div>
      )
    }

    return (
      <div className={styles.qrConsentBody}>
        {renderConnectionBack(() => setAddNumberChoice(null))}
        <p>Agrega el número y después escanea el QR desde WhatsApp en ese mismo celular.</p>
        {renderQrNumberForm()}
      </div>
    )
  }

  const renderConnectStage = () => {
    if (apiLoading) {
      return <div className={`${styles.skeletonBlock} ${styles.skeletonStage}`} />
    }

    if (!connectionChoice) {
      return (
        <section className={styles.connectPanel}>
          <div className={styles.connectCopy}>
            <p className={styles.eyebrow}>Conexión</p>
            <h3>Elige cómo conectar WhatsApp</h3>
            <span>Conecta por WhatsApp API para plantillas oficiales o mediante QR para una sesión de WhatsApp Web.</span>
          </div>
          {apiStatus?.lastError && <p className={styles.errorText}>{apiStatus.lastError}</p>}
          {renderConnectionChooser(setConnectionChoice)}
        </section>
      )
    }

    if (connectionChoice === 'qr') {
      return (
        <section className={styles.connectPanel}>
          {renderConnectionBack(() => setConnectionChoice(null))}
          <div className={styles.connectCopy}>
            <p className={styles.eyebrow}>Mediante QR</p>
            <h3>Conecta un número por QR</h3>
            <span>Ristak validará que el QR escaneado sea de este mismo número antes de activarlo.</span>
          </div>
          {renderQrNumberForm()}
        </section>
      )
    }

    return (
      <section className={styles.connectPanel}>
        {renderConnectionBack(() => setConnectionChoice(null))}
        <div className={styles.connectCopy}>
          <p className={styles.eyebrow}>Conexión</p>
          <h3>Conecta WhatsApp Business</h3>
          <span>Usa WhatsApp API para enviar mensajes oficiales, revisar saldo y mandar plantillas a Meta.</span>
        </div>
        {apiStatus?.lastError && <p className={styles.errorText}>{apiStatus.lastError}</p>}
        <div className={styles.connectContent}>
          {renderYCloudGuide()}
          {renderApiConnectionOptions()}
        </div>
      </section>
    )
  }

  const renderNumbersStage = () => {
    if (!apiStatus) return null

    const selectedApiPhone = selectedPhone || apiStatus.selectedPhone || apiStatus.phoneNumbers[0] || null
    const balance = apiStatus.balance
    const phoneRows = apiStatus.phoneNumbers.length ? apiStatus.phoneNumbers : selectedApiPhone ? [selectedApiPhone] : []
    const enrichedPhones = phoneRows.map((phone) => {
      const phoneProfile = getPhoneProfile(phone)
      const qrSession = qrSessionsByPhoneId.get(phone.id)
      const qrStatus = qrSession?.status || phone.qr_status || ''
      const qrError = isQrWorkingStatus(qrStatus) ? '' : (qrSession?.lastError || phone.qr_last_error || '')
      const isSender = Boolean(phone.is_default_sender) ||
        phone.id === selectedPhoneId ||
        phone.phone_number === apiStatus.sender.phone ||
        phone.display_phone_number === apiStatus.sender.phone
      const qrPending = ['starting', 'qr_pending', 'restarting', 'reconnecting'].includes(String(qrStatus).toLowerCase())
      const qrConnected = String(qrStatus).toLowerCase() === 'connected'
      const apiEnabled = apiConnected && Number(phone.api_send_enabled ?? 1) !== 0
      const displayName = phone.verified_name || phoneProfile?.verifiedName || phoneProfile?.businessName || phoneProfile?.name || 'Sin nombre'
      const needsAttention = Boolean(qrError) || ['RED', 'FLAGGED', 'RESTRICTED'].includes(String(phone.quality_rating || '').toUpperCase())

      return { phone, displayName, isSender, qrSession, qrStatus, qrError, qrPending, qrConnected, apiEnabled, needsAttention }
    })
    const query = phoneSearch.trim().toLowerCase()
    const qrConnectedCount = enrichedPhones.filter((row) => row.qrConnected).length
    const needsAttentionCount = enrichedPhones.filter((row) => row.needsAttention).length
    const filteredPhones = enrichedPhones.filter((row) => {
      if (phoneFilter === 'main' && !row.isSender) return false
      if (phoneFilter === 'qr' && !row.qrConnected) return false
      if (phoneFilter === 'attention' && !row.needsAttention) return false
      if (!query) return true

      return [
        row.phone.display_phone_number,
        row.phone.phone_number,
        row.phone.id,
        row.displayName,
        row.phone.quality_rating,
        row.phone.messaging_limit,
        getQrStatusLabel(row.qrStatus)
      ].some((value) => String(value || '').toLowerCase().includes(query))
    })
    const balanceLabel = balance ? formatCurrency(balance.amount, balance.currency) : 'Saldo pendiente'
    const hasAdvancedActions = Boolean(paymentConfigUrl || apiConnected)

    return (
      <div className={styles.layout}>
        <aside className={styles.sideNav} aria-label="Filtros de números de WhatsApp">
          <div className={styles.sideHeader}>
            <strong>Números</strong>
            <span>{formatMetric(phoneRows.length)} activos</span>
          </div>
          <button type="button" className={`${styles.sideItem} ${phoneFilter === 'all' ? styles.sideItemActive : ''}`} onClick={() => setPhoneFilter('all')}>
            <HashIcon size={16} />
            <span>Todos los números</span>
            <b>{phoneRows.length}</b>
          </button>
          <button type="button" className={`${styles.sideItem} ${phoneFilter === 'main' ? styles.sideItemActive : ''}`} onClick={() => setPhoneFilter('main')}>
            <Star size={16} />
            <span>Principal</span>
            <b>{enrichedPhones.filter((row) => row.isSender).length}</b>
          </button>
          <button type="button" className={`${styles.sideItem} ${phoneFilter === 'qr' ? styles.sideItemActive : ''}`} onClick={() => setPhoneFilter('qr')}>
            <QrCode size={16} />
            <span>QR conectado</span>
            <b>{qrConnectedCount}</b>
          </button>
          <button type="button" className={`${styles.sideItem} ${phoneFilter === 'attention' ? styles.sideItemActive : ''}`} onClick={() => setPhoneFilter('attention')}>
            <AlertTriangle size={16} />
            <span>Revisar</span>
            <b>{needsAttentionCount}</b>
          </button>
        </aside>

        <main className={styles.tablePanel}>
          <div className={styles.toolbar}>
            <SearchField
              className={styles.toolbarSearch}
              value={phoneSearch}
              placeholder="Buscar por número, nombre o estado"
              onChange={(nextSearch) => setPhoneSearch(nextSearch)}
              onClear={() => setPhoneSearch('')}
            />
            <div className={styles.toolbarActions}>
              <span className={styles.toolbarMeta}>
                <Wallet size={15} />
                {formatMetric(filteredPhones.length)} de {formatMetric(phoneRows.length)} números · {balanceLabel}
              </span>
              <Button variant="primary" onClick={openAddNumberModal}>
                <Plus size={16} />
                Agregar número
              </Button>
              <Button variant="outline" onClick={refreshWhatsAppStatus} loading={apiRefreshing}>
                <RefreshCw size={16} />
                Sincronizar
              </Button>
              {hasAdvancedActions && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" aria-label="Más acciones de WhatsApp">
                      <MoreHorizontal size={16} />
                      Más acciones
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className={styles.actionsMenu}>
                    {paymentConfigUrl && (
                      <DropdownMenuItem asChild>
                        <a href={paymentConfigUrl} target="_blank" rel="noopener noreferrer">
                          <ExternalLink size={15} />
                          Configurar pagos de Meta
                        </a>
                      </DropdownMenuItem>
                    )}
                    {apiConnected && (
                      <>
                        <DropdownMenuItem asChild>
                          <a href={YCLOUD_CONSOLE_URL} target="_blank" rel="noopener noreferrer">
                            <ExternalLink size={15} />
                            Abrir consola API
                          </a>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className={styles.destructiveMenuItem}
                          disabled={apiDisconnecting}
                          onSelect={(event) => {
                            event.preventDefault()
                            confirmApiDisconnect()
                          }}
                        >
                          <Unplug size={15} />
                          Desconectar WhatsApp API
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>

          {renderQrDripPanel(true)}

          {filteredPhones.length > 0 ? (
            <div className={styles.tableWrap}>
              <table className={styles.table} data-ristak-table data-ristak-table-element>
                <thead>
                  <tr>
                    <th>Número</th>
                    <th>Nombre</th>
                    <th>Envío oficial</th>
                    <th>Respaldo QR</th>
                    <th>Calidad</th>
                    <th>Límite</th>
                    <th aria-label="Acciones" />
                  </tr>
                </thead>
                <tbody>
                  {filteredPhones.map((row) => {
                    const { phone, qrPending, qrConnected, qrError, qrStatus, displayName, isSender, apiEnabled } = row

                    return (
                      <React.Fragment key={phone.id}>
                        <tr>
                          <td>
                            <strong>{phone.display_phone_number || phone.phone_number || 'Número'}</strong>
                            <span>{phone.id}</span>
                          </td>
                          <td>{displayName}</td>
                          <td>
                            <div className={styles.apiCell}>
                              <Badge variant={apiEnabled ? 'success' : 'neutral'}>
                                {apiEnabled ? (isSender ? 'Principal' : 'Oficial') : 'No conectado'}
                              </Badge>
                              {isSender && <span>Usado por defecto</span>}
                            </div>
                          </td>
                          <td>
                            <div className={styles.qrCell}>
                              <Badge variant={qrConnected ? 'info' : qrPending ? 'warning' : 'neutral'}>
                                {getQrStatusLabel(qrStatus)}
                              </Badge>
                              {qrConnected ? (
                                <Button
                                  variant="outline"
                                  size="small"
                                  loading={qrDisconnectingPhoneId === phone.id}
                                  onClick={() => disconnectQrForPhone(phone)}
                                >
                                  <Unplug size={14} />
                                  Desconectar QR
                                </Button>
                              ) : (
                                <Button
                                  variant="primary"
                                  size="small"
                                  loading={qrConnectingPhoneId === phone.id}
                                  onClick={() => openQrConsentForPhone(phone)}
                                >
                                  <QrCode size={14} />
                                  {qrPending ? 'Ver QR' : 'Conectar'}
                                </Button>
                              )}
                            </div>
                          </td>
                          <td>{phone.quality_rating || 'Sin dato'}</td>
                          <td>{phone.messaging_limit || 'Sin dato'}</td>
                          <td>
                            <div className={styles.rowActions}>
                              {!isSender && (
                                <button type="button" onClick={() => makePhoneDefault(phone)} disabled={defaultingPhoneId === phone.id} title="Hacer principal" aria-label={`Hacer principal ${getPhoneLabel(phone)}`}>
                                  <Star size={15} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {qrError ? (
                          <tr className={styles.detailRow}>
                            <td colSpan={7}>
                              <p className={styles.errorText}>{qrError}</p>
                            </td>
                          </tr>
                        ) : null}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.emptyState}>
              <HashIcon size={26} />
              <strong>No hay números en esta vista</strong>
              <span>Cambia el filtro o sincroniza WhatsApp API.</span>
            </div>
          )}

          {apiStatus.lastError && <p className={styles.errorText}>{apiStatus.lastError}</p>}
        </main>
      </div>
    )
  }

  const renderAlertsStage = () => {
    const query = alertSearch.trim().toLowerCase()
    const filteredAlerts = connectionAlertGroups.filter((group) => {
      if (alertFilter !== 'all' && group.severity !== alertFilter) return false
      if (!query) return true

      return [
        group.title,
        group.message,
        group.severity,
        ...group.titles
      ].some((value) => String(value || '').toLowerCase().includes(query))
    })

    const countBySeverity = (severity: AlertFilter) => (
      connectionAlertGroups.filter((group) => severity === 'all' || group.severity === severity).length
    )

    return (
      <div className={styles.layout}>
        <aside className={styles.sideNav} aria-label="Filtros de alertas de WhatsApp">
          <div className={styles.sideHeader}>
            <strong>Alertas</strong>
            <span>{connectionAlertGroups.length} temas</span>
          </div>
          <button type="button" className={`${styles.sideItem} ${alertFilter === 'all' ? styles.sideItemActive : ''}`} onClick={() => setAlertFilter('all')}>
            <HashIcon size={16} />
            <span>Todas las alertas</span>
            <b>{countBySeverity('all')}</b>
          </button>
          <button type="button" className={`${styles.sideItem} ${alertFilter === 'critical' ? styles.sideItemActive : ''}`} onClick={() => setAlertFilter('critical')}>
            <AlertTriangle size={16} />
            <span>Importantes</span>
            <b>{countBySeverity('critical')}</b>
          </button>
          <button type="button" className={`${styles.sideItem} ${alertFilter === 'warning' ? styles.sideItemActive : ''}`} onClick={() => setAlertFilter('warning')}>
            <AlertTriangle size={16} />
            <span>Advertencias</span>
            <b>{countBySeverity('warning')}</b>
          </button>
          <button type="button" className={`${styles.sideItem} ${alertFilter === 'info' ? styles.sideItemActive : ''}`} onClick={() => setAlertFilter('info')}>
            <ShieldCheck size={16} />
            <span>Avisos</span>
            <b>{countBySeverity('info')}</b>
          </button>
        </aside>

        <main className={styles.tablePanel}>
          <div className={styles.toolbar}>
            <SearchField
              className={styles.toolbarSearch}
              value={alertSearch}
              placeholder="Buscar por alerta o detalle"
              onChange={(nextSearch) => setAlertSearch(nextSearch)}
              onClear={() => setAlertSearch('')}
            />
            <span>{filteredAlerts.length} alertas</span>
          </div>

          {filteredAlerts.length > 0 ? (
            <div className={styles.tableWrap}>
              <table className={styles.table} data-ristak-table data-ristak-table-element>
                <thead>
                  <tr>
                    <th>Alerta</th>
                    <th>Tipo</th>
                    <th>Avisos</th>
                    <th>Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAlerts.map((group) => (
                    <tr key={group.key}>
                      <td>
                        <strong>{group.title}</strong>
                        {group.titles.length > 1 && <span>{group.titles.slice(1).join(', ')}</span>}
                      </td>
                      <td><span className={`${styles.statusPill} ${getAlertClass(group.severity)}`}>{group.severity === 'critical' ? 'Importante' : group.severity === 'warning' ? 'Advertencia' : 'Aviso'}</span></td>
                      <td>{group.count}</td>
                      <td>{group.message || 'Sin detalle adicional'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.emptyState}>
              <ShieldCheck size={26} />
              <strong>No hay alertas en esta vista</strong>
              <span>WhatsApp no tiene avisos para este filtro.</span>
            </div>
          )}
        </main>
      </div>
    )
  }

  const renderTemplatesStage = () => {
    if (!apiConnected) {
      return (
        <section className={styles.lockedState}>
          <FileText size={36} />
          <h3>Conecta WhatsApp para enviar plantillas a Meta</h3>
          <p>Cuando la conexión esté lista, aquí podrás crear plantillas, enviarlas a revisión y ver si Meta las aprobó o rechazó.</p>
          <Button onClick={() => selectSection('numbers')}>
            <Cloud size={17} />
            Ir a números
          </Button>
        </section>
      )
    }

    return <MessageTemplates embedded />
  }

  const renderQrDripPanel = (compact = false) => (
    <section className={`${styles.qrDripPanel} ${compact ? styles.qrDripPanelCompact : ''}`} aria-label="Sistema anti-bloqueos de WhatsApp">
      <div className={styles.qrDripIcon} aria-hidden="true">
        <Clock3 size={18} />
      </div>
      <div className={styles.qrDripCopy}>
        <div className={styles.qrDripTitleRow}>
          <h3>Pausas automáticas para QR</h3>
          <Badge variant={qrDripSettings.enabled ? 'success' : 'warning'}>
            {qrDripSettings.enabled ? 'Activo' : 'Apagado'}
          </Badge>
        </div>
        <p>
          Si una automatización usa QR, Ristak espera {formatQrDripDelay(qrDripSettings.delaySeconds)} entre mensajes.
        </p>
      </div>
      <div className={styles.qrDripControls}>
        <Switch
          checked={qrDripSettings.enabled}
          disabled={qrDripSaving}
          onChange={requestQrDripToggle}
          aria-label="Activar sistema anti-bloqueos de WhatsApp"
        />
        <Button variant="outline" size="small" onClick={() => setQrDripModalOpen(true)}>
          Configurar
        </Button>
      </div>
    </section>
  )

  const renderQrDripSettingsModal = () => (
    <div className={styles.qrDripSettingsBody}>
      <div className={styles.qrDripIntro}>
        <span className={styles.qrDripIntroIcon} aria-hidden="true">
          <Clock3 size={18} />
        </span>
        <div>
          <strong>Configuración global para WhatsApp Web / QR</strong>
          <p>
            Aplica a todos los números conectados por QR y a cualquier respaldo QR que use una automatización.
          </p>
        </div>
      </div>

      <div className={styles.qrDripSwitchRow}>
        <div>
          <strong>Modo goteo automático</strong>
          <span>El primer mensaje sale al momento; los siguientes esperan el intervalo configurado.</span>
        </div>
        <Switch
          checked={qrDripSettings.enabled}
          disabled={qrDripSaving}
          onChange={requestQrDripToggle}
          aria-label="Activar modo goteo automático"
        />
      </div>

      <div className={styles.fieldLabel}>
        <span id="qr-drip-delay-label">Esperar antes del siguiente mensaje QR</span>
        <div className={styles.qrDripInputRow} role="group" aria-labelledby="qr-drip-delay-label">
          <NumberInput
            className={styles.qrDripNumberInput}
            value={qrDripDelayAmountDraft}
            min={qrDripDelayBounds.min}
            max={qrDripDelayBounds.max}
            step={qrDripDelayBounds.step}
            onValueChange={updateQrDripDelayAmount}
            aria-label="Tiempo entre mensajes QR automáticos"
          />
          <CustomSelect
            className={styles.qrDripUnitSelect}
            value={qrDripDelayUnitDraft}
            options={QR_DRIP_DELAY_UNIT_OPTIONS}
            onValueChange={updateQrDripDelayUnit}
            aria-label="Unidad del goteo automático"
          />
        </div>
        <span className={styles.qrDripDelayHint}>Equivale a {formatQrDripDelay(qrDripDelayDraft)} entre mensajes.</span>
      </div>

      <div className={styles.qrDripExampleBox}>
        <div className={styles.qrDripExampleHeader}>
          <Send size={16} />
          <div>
            <strong>Ejemplo de calendario de goteo</strong>
            <span>Si llegan 5 recordatorios automáticos al mismo tiempo.</span>
          </div>
        </div>
        <ol className={styles.qrDripTimeline}>
          {qrDripExample.map((item) => (
            <li key={item.name}>
              <span>{item.offset}</span>
              <strong>{item.name}</strong>
              <em>{item.time}</em>
            </li>
          ))}
        </ol>
      </div>

      <div className={styles.qrDripNotes}>
        <p>Esto reduce picos raros de actividad en sesiones tipo WhatsApp Web. No garantiza que WhatsApp no limite el número, pero baja el riesgo de envíos masivos repentinos.</p>
        <p>Si apagas el sistema, cada automatización que use QR intentará enviar en cuanto le toque.</p>
      </div>

      <div className={styles.qrModalActions}>
        <Button variant="secondary" onClick={() => setQrDripModalOpen(false)}>
          Cerrar
        </Button>
        <Button
          variant="primary"
          loading={qrDripSaving}
          onClick={saveQrDripDelay}
          disabled={!qrDripDelayChanged}
        >
          Guardar tiempo
        </Button>
      </div>
    </div>
  )

  if (apiLoading) {
    return (
      <div className={styles.shell}>
        <div className={styles.skeletonHeaderRow} role="status" aria-live="polite" aria-label="Cargando WhatsApp">
          <div className={`${styles.skeletonBlock} ${styles.skeletonLogo}`} />
          <div className={styles.skeletonHeaderText}>
            <div className={`${styles.skeletonBlock} ${styles.skeletonEyebrow}`} />
            <div className={`${styles.skeletonBlock} ${styles.skeletonTitle}`} />
          </div>
        </div>
        <div className={`${styles.skeletonBlock} ${styles.skeletonStage}`} />
      </div>
    )
  }

  return (
    <div className={styles.shell}>
      <PageHeader
        eyebrow="Sistema"
        title="WhatsApp"
        subtitle="Conexiones por WhatsApp API o mediante QR para números, alertas y plantillas."
        actions={hasAnyWhatsAppConnection ? (
          <div className={styles.headerActions} role="group" aria-label="Secciones de WhatsApp">
            <button
              type="button"
              className={`${styles.headerActionButton} ${activeSection === 'numbers' ? styles.headerActionActive : ''}`}
              onClick={() => selectSection('numbers')}
            >
              <SiWhatsapp size={15} />
              Números
            </button>
            {apiConnected && (
              <>
                <button
                  type="button"
                  className={`${styles.headerActionButton} ${activeSection === 'templates' ? styles.headerActionActive : ''}`}
                  onClick={() => selectSection('templates')}
                >
                  <FileText size={15} />
                  Plantillas
                </button>
                <button
                  type="button"
                  className={`${styles.headerActionButton} ${activeSection === 'alerts' ? styles.headerActionActive : ''}`}
                  onClick={() => selectSection('alerts')}
                >
                  <AlertTriangle size={15} />
                  Alertas
                  {connectionAlertGroups.length > 0 && <b>{connectionAlertGroups.length}</b>}
                </button>
              </>
            )}
          </div>
        ) : null}
      />

      <div className={styles.stage}>
        {!hasAnyWhatsAppConnection
          ? renderConnectStage()
          : activeSection === 'templates' && apiConnected
            ? renderTemplatesStage()
            : activeSection === 'alerts' && apiConnected
              ? renderAlertsStage()
              : renderNumbersStage()}
      </div>

      <Modal
        isOpen={addNumberModalOpen}
        onClose={() => setAddNumberModalOpen(false)}
        title="Agregar número de WhatsApp"
        type="custom"
        size="md"
      >
        {renderAddNumberContent()}
      </Modal>

      <Modal
        isOpen={qrDripModalOpen}
        onClose={() => setQrDripModalOpen(false)}
        title="Sistema anti-bloqueos de WhatsApp"
        type="custom"
        size="lg"
      >
        {renderQrDripSettingsModal()}
      </Modal>

      <Modal
        isOpen={qrDripDisableConfirmOpen}
        onClose={() => setQrDripDisableConfirmOpen(false)}
        title="Apagar anti-bloqueos de WhatsApp"
        message="Si apagas esto, los mensajes automáticos por QR pueden salir todos juntos y WhatsApp puede restringir o bloquear el número."
        type="confirm"
        confirmText="Apagar sistema"
        cancelText="Mantener encendido"
        typeToConfirm={QR_DRIP_DISABLE_CONFIRM_WORD}
        onConfirm={async () => {
          await saveQrDripSettings({ enabled: false })
        }}
      />

      {(() => {
        const qrModalSession = qrConsentPhone ? qrSessionsByPhoneId.get(qrConsentPhone.id) : null
        const qrModalStatus = String(qrModalSession?.status || qrConsentPhone?.qr_status || '').toLowerCase()
        const qrModalPending = ['qr_pending', 'starting', 'restarting', 'reconnecting'].includes(qrModalStatus)
        const qrModalConnected = qrModalStatus === 'connected'
        const qrModalGenerating = Boolean(qrConsentPhone && qrConnectingPhoneId === qrConsentPhone.id && !qrModalSession?.qrCodeDataUrl)
        const qrModalError = qrModalView === 'qr' && !qrModalPending && !qrModalConnected && !qrModalGenerating
          ? (qrModalSession?.lastError || 'WhatsApp cerró este intento. Genera otro código QR.')
          : ''

        return (
          <Modal
            isOpen={Boolean(qrConsentPhone)}
            onClose={() => setQrConsentPhone(null)}
            title={qrModalView === 'consent' ? 'Conectar QR de WhatsApp' : `Escanea el QR con ${qrConsentPhone ? getPhoneLabel(qrConsentPhone) : 'tu número'}`}
            type="custom"
            size="md"
          >
            {qrModalView === 'consent' ? (
              <div className={styles.qrConsentBody}>
                <p>
                  Este paso no es obligatorio. WhatsApp API sigue siendo la conexión principal; el QR solo funciona como respaldo para {qrConsentPhone ? getPhoneLabel(qrConsentPhone) : 'este número'}.
                </p>
                <ul className={styles.qrConsentList}>
                  <li>Usa WhatsApp Web por QR, no la API oficial de Meta.</li>
                  <li>WhatsApp puede cerrar la sesión, bloquear el número o restringir la cuenta.</li>
                  <li>Si WhatsApp bloquea el número, puede que no se pueda recuperar.</li>
                  <li>Ristak lo usa para detalles extra, mensajes fuera de 24 horas o si la API queda restringida.</li>
                </ul>
                <p className={styles.qrConsentNote}>
                  Escanea el QR solamente con ese mismo número. Si conectas otro, Ristak lo rechazara.
                </p>
                <div className={styles.qrModalActions}>
                  <Button variant="secondary" onClick={() => setQrConsentPhone(null)}>
                    No conectar
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      if (qrConsentPhone) confirmQrConnection(qrConsentPhone)
                    }}
                  >
                    Acepto el riesgo y conectar
                  </Button>
                </div>
              </div>
            ) : (
              <div className={styles.qrModalBody}>
                {qrModalConnected ? (
                  <>
                    <div className={styles.qrModalState}>
                      <ShieldCheck size={34} className={styles.qrModalSuccessIcon} />
                      <strong>¡QR conectado!</strong>
                      <span>Este número ya puede mandar mensajes individuales por WhatsApp Web.</span>
                    </div>
                    {renderQrDripPanel(true)}
                  </>
                ) : qrModalSession?.qrCodeDataUrl && qrModalPending ? (
                  <>
                    <div className={styles.qrModalImage}>
                      <img
                        src={qrModalSession.qrCodeDataUrl}
                        alt={`Código QR para ${qrConsentPhone ? getPhoneLabel(qrConsentPhone) : 'WhatsApp'}`}
                      />
                    </div>
                    <ol className={styles.qrModalSteps}>
                      <li>Abre WhatsApp en el celular con ese mismo número.</li>
                      <li>Ve a Ajustes &gt; Dispositivos vinculados &gt; Vincular dispositivo.</li>
                      <li>Apunta la cámara a este código.</li>
                    </ol>
                    <p className={styles.qrModalHint}>
                      El código se renueva solo. Esta ventana se actualizará cuando completes el escaneo.
                    </p>
                  </>
                ) : qrModalError ? (
                  <div className={styles.qrModalState}>
                    <AlertTriangle size={30} />
                    <strong>No se pudo generar el QR</strong>
                    <span>{qrModalError}</span>
                  </div>
                ) : (
                  <div className={styles.qrModalState}>
                    <RefreshCw size={28} className={styles.qrModalSpinner} />
                    <strong>{qrModalGenerating ? 'Generando código QR…' : 'Conectando con WhatsApp…'}</strong>
                    <span>{qrModalGenerating ? 'Esto tarda unos segundos.' : 'Estamos vinculando tu número. Esto tarda unos segundos.'}</span>
                  </div>
                )}
                <div className={styles.qrModalActions}>
                  <Button variant="secondary" onClick={() => setQrConsentPhone(null)}>
                    {qrModalConnected ? 'Listo' : 'Cerrar'}
                  </Button>
                  {qrModalError && qrConsentPhone && (
                    <Button
                      variant="primary"
                      loading={qrConnectingPhoneId === qrConsentPhone.id}
                      onClick={() => confirmQrConnection(qrConsentPhone)}
                    >
                      Generar otro QR
                    </Button>
                  )}
                </div>
              </div>
            )}
          </Modal>
        )
      })()}

      <Modal
        isOpen={Boolean(apiStatus?.needsDefaultSelection)}
        onClose={() => null}
        title="Elige tu número principal"
        type="custom"
        size="md"
        showCloseButton={false}
      >
        <div className={styles.qrConsentBody}>
          <p>
            Hay varios números de WhatsApp conectados y ninguno está marcado como principal.
            El número principal se usa para contactos nuevos, importaciones, campañas y
            automatizaciones cuando un chat no tiene un número asignado.
          </p>
          {(apiStatus?.phoneNumbers || []).map((phone) => (
            <button
              key={phone.id}
              type="button"
              className={styles.defaultPickerOption}
              disabled={Boolean(defaultingPhoneId)}
              onClick={() => makePhoneDefault(phone)}
            >
              {defaultingPhoneId === phone.id ? 'Guardando…' : getPhoneLabel(phone)}
              {phone.verified_name ? <span className={styles.defaultPickerOptionHint}>{phone.verified_name}</span> : null}
            </button>
          ))}
        </div>
      </Modal>
    </div>
  )
}
