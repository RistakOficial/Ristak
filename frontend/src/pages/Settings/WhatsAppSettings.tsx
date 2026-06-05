import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, CheckCircle, Cloud, ExternalLink, FileText, KeyRound, RefreshCw, Send, ShieldCheck, Smartphone, Unplug } from 'lucide-react'
import { SiWhatsapp } from 'react-icons/si'
import { Button } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { WhatsAppApiAlert, WhatsAppApiPhoneNumber, WhatsAppApiStatus, WhatsAppApiTemplate, whatsappApiService } from '@/services/whatsappApiService'
import { WhatsAppWebLog, WhatsAppWebLogs, WhatsAppWebStatus, whatsappWebService } from '@/services/whatsappWebService'
import { MessageTemplates } from './MessageTemplates'
import styles from './WhatsAppSettings.module.css'

type BusinessProfile = {
  businessName?: string
  name?: string
  verifiedName?: string
  description?: string
  about?: string
  email?: string
  profilePictureUrl?: string
  vertical?: string
  website?: string | string[]
  websites?: string[]
  category?: string
}

type WhatsAppChannel = 'api' | 'web'

const CONNECTION_FLOW_TIMEOUT_MS = 120_000
const YCLOUD_REGISTER_URL = 'https://www.ycloud.com/console/#/entry/register?'

function parseJson<T>(value?: string | null): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function formatLogDate(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatDateTime(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
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
  const number = phone.display_phone_number || phone.phone_number || 'Numero'
  return phone.verified_name ? `${number} · ${phone.verified_name}` : number
}

function getTemplateLabel(template: WhatsAppApiTemplate) {
  return `${template.name} · ${template.language}`
}

function getTemplateVariablesCount(template?: WhatsAppApiTemplate | null) {
  if (!template?.components?.length) return 0
  const matches = JSON.stringify(template.components).match(/{{\s*\d+\s*}}/g)
  return matches ? new Set(matches).size : 0
}

function getAlertClass(alert: WhatsAppApiAlert) {
  if (alert.severity === 'critical') return styles.apiAlertCritical
  if (alert.severity === 'warning') return styles.apiAlertWarning
  return styles.apiAlertInfo
}

function getTemplateStatusClass(template: WhatsAppApiTemplate) {
  if (template.status === 'APPROVED') return styles.templateStatusApproved
  if (template.status === 'PENDING' || template.status === 'IN_APPEAL') return styles.templateStatusPending
  return styles.templateStatusBlocked
}

function renderLog(log: WhatsAppWebLog) {
  return (
    <div key={log.id} className={styles.logItem}>
      <div>{formatLogDate(log.message_timestamp || log.created_at)}</div>
      <div>{log.direction || ''} · {log.message_type || ''}</div>
      <div>{log.phone || ''} {log.push_name ? `· ${log.push_name}` : ''}</div>
      <div>{log.message_text || '(sin texto)'}</div>
      <div>contact_id: {log.contact_id || ''}</div>
      <div>remote_jid: {log.remote_jid || ''}</div>
      <div>source_id: {log.detected_source_id || ''}</div>
      <div>ctwa: {log.detected_ctwa_clid || ''}</div>
      <div>url: {log.detected_source_url || ''}</div>
      <div>headline: {log.detected_headline || ''}</div>
    </div>
  )
}

export const WhatsAppSettings: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [activeChannel, setActiveChannel] = useState<WhatsAppChannel>('api')

  const [status, setStatus] = useState<WhatsAppWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [qrRequested, setQrRequested] = useState(false)
  const [manualDisconnected, setManualDisconnected] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [logs, setLogs] = useState<WhatsAppWebLogs | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)

  const [apiStatus, setApiStatus] = useState<WhatsAppApiStatus | null>(null)
  const [apiLoading, setApiLoading] = useState(true)
  const [apiConnecting, setApiConnecting] = useState(false)
  const [apiRefreshing, setApiRefreshing] = useState(false)
  const [apiDisconnecting, setApiDisconnecting] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [selectedPhoneId, setSelectedPhoneId] = useState('')
  const [discoveredApiPhones, setDiscoveredApiPhones] = useState<WhatsAppApiPhoneNumber[]>([])
  const [apiPhoneLookupLoading, setApiPhoneLookupLoading] = useState(false)
  const [apiPhoneLookupAttempted, setApiPhoneLookupAttempted] = useState(false)
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [templateTo, setTemplateTo] = useState('')
  const [templateVariables, setTemplateVariables] = useState('[]')
  const [templateSending, setTemplateSending] = useState(false)

  const requestInFlight = useRef(false)
  const connectionStartedAt = useRef<number | null>(null)

  const session = status?.session
  const isConnected = session?.status === 'connected'
  const businessProfile = useMemo(
    () => parseJson<BusinessProfile>(session?.business_profile_json),
    [session?.business_profile_json]
  )
  const displayName = session?.push_name ||
    businessProfile?.businessName ||
    businessProfile?.name ||
    'WhatsApp Business'
  const profileImage = session?.profile_picture_url
  const showQr = qrRequested && !isConnected && Boolean(session?.qr_image) && !manualDisconnected
  const isWaitingForQr = connecting && !isConnected && !showQr && !manualDisconnected

  const availableApiPhones = useMemo(() => {
    return apiStatus?.phoneNumbers.length ? apiStatus.phoneNumbers : discoveredApiPhones
  }, [apiStatus?.phoneNumbers, discoveredApiPhones])

  const selectedPhone = useMemo(() => {
    return availableApiPhones.find(phone => phone.id === selectedPhoneId) || null
  }, [availableApiPhones, selectedPhoneId])

  const apiTemplates = apiStatus?.templates?.items || []
  const approvedTemplates = useMemo(() => {
    return apiTemplates.filter(template => template.status === 'APPROVED')
  }, [apiTemplates])
  const selectedTemplate = useMemo(() => {
    return apiTemplates.find(template => template.id === selectedTemplateId) || approvedTemplates[0] || apiTemplates[0] || null
  }, [apiTemplates, approvedTemplates, selectedTemplateId])
  const selectedTemplateVariablesCount = getTemplateVariablesCount(selectedTemplate)
  const apiConnected = Boolean(apiStatus?.connected)
  const hasApiCredential = Boolean(apiKey.trim() || apiStatus?.credentials.hasApiKey)
  const canLookupApiPhones = hasApiCredential
  const canSubmitApi = hasApiCredential &&
    (apiConnected || (availableApiPhones.length > 0 && Boolean(selectedPhoneId)))

  const isConnectionFlowFresh = () => {
    return Boolean(connectionStartedAt.current && Date.now() - connectionStartedAt.current < CONNECTION_FLOW_TIMEOUT_MS)
  }

  const loadStatus = async () => {
    const nextStatus = await whatsappWebService.getStatus()
    setStatus(nextStatus)
    const currentStatus = nextStatus.session?.status

    if (currentStatus === 'connected') {
      setConnecting(false)
      setQrRequested(false)
      connectionStartedAt.current = null
    } else if (currentStatus === 'qr') {
      setConnecting(false)
      setQrRequested(true)
    } else if (currentStatus === 'connecting' || currentStatus === 'reconnecting') {
      if (qrRequested && isConnectionFlowFresh()) setConnecting(true)
    } else if (currentStatus === 'disconnected') {
      if (qrRequested && isConnectionFlowFresh()) {
        setConnecting(true)
      } else {
        setConnecting(false)
        connectionStartedAt.current = null
      }
    }

    return nextStatus
  }

  const loadApiStatus = async () => {
    const nextStatus = await whatsappApiService.getStatus()
    setApiStatus(nextStatus)
    if (nextStatus.phoneNumbers.length) {
      setDiscoveredApiPhones([])
      setApiPhoneLookupAttempted(false)
    }

    const preferredPhoneId = nextStatus.sender.phoneNumberId ||
      nextStatus.phoneNumbers.find(phone => phone.phone_number === nextStatus.sender.phone)?.id ||
      nextStatus.phoneNumbers[0]?.id ||
      ''

    setSelectedPhoneId(preferredPhoneId)
    setSelectedTemplateId((current) => {
      const templates = nextStatus.templates?.items || []
      if (current && templates.some(template => template.id === current)) return current
      return templates.find(template => template.status === 'APPROVED')?.id || templates[0]?.id || ''
    })

    return nextStatus
  }

  const startConnection = async () => {
    if (requestInFlight.current) return
    requestInFlight.current = true
    setManualDisconnected(false)
    setConnecting(true)
    setQrRequested(true)
    connectionStartedAt.current = Date.now()

    try {
      const nextStatus = await whatsappWebService.connect({ reset: true })
      setStatus(nextStatus)
      const currentStatus = nextStatus.session?.status
      if (currentStatus === 'connected') {
        setConnecting(false)
        setQrRequested(false)
        connectionStartedAt.current = null
      } else if (currentStatus === 'qr') {
        setConnecting(false)
        setQrRequested(true)
      } else if (currentStatus === 'disconnected' && !isConnectionFlowFresh()) {
        setConnecting(false)
        connectionStartedAt.current = null
      }
    } catch (error) {
      setConnecting(false)
      connectionStartedAt.current = null
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo generar el QR')
    } finally {
      requestInFlight.current = false
      setLoading(false)
    }
  }

  const lookupApiPhoneNumbers = async () => {
    if (!canLookupApiPhones || apiPhoneLookupLoading) return

    setApiPhoneLookupLoading(true)
    setApiPhoneLookupAttempted(true)
    try {
      const result = await whatsappApiService.previewPhoneNumbers(apiKey.trim() || undefined)
      const phones = result.phoneNumbers || []
      setDiscoveredApiPhones(phones)
      setSelectedPhoneId((current) => {
        if (current && phones.some(phone => phone.id === current)) return current
        return phones[0]?.id || ''
      })

      if (phones.length) {
        showToast('success', 'Numeros encontrados', 'Elige el numero de WhatsApp Business que vas a usar')
      } else {
        showToast('warning', 'Sin numeros', 'YCloud todavia no muestra numeros conectados en esta cuenta')
      }
    } catch (error) {
      setDiscoveredApiPhones([])
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudieron buscar tus numeros')
    } finally {
      setApiPhoneLookupLoading(false)
    }
  }

  const connectApi = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!canSubmitApi || apiConnecting) return

    setApiConnecting(true)
    try {
      const nextStatus = await whatsappApiService.connect({
        apiKey: apiKey.trim() || undefined,
        phoneNumberId: selectedPhone?.id || undefined,
        senderPhone: selectedPhone?.phone_number || undefined,
        wabaId: selectedPhone?.waba_id || undefined
      })
      setApiStatus(nextStatus)
      setDiscoveredApiPhones([])
      setApiPhoneLookupAttempted(false)
      setApiKey('')

      if (nextStatus.requiresPhoneSelection) {
        showToast('warning', 'WhatsApp Business conectado', 'Selecciona el numero emisor para terminar')
      } else {
        showToast('success', 'WhatsApp Business conectado', 'YCloud y tu numero quedaron listos')
      }
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
      showToast('success', 'Actualizado', 'WhatsApp Business se sincronizo con YCloud')
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo actualizar WhatsApp Business')
    } finally {
      setApiRefreshing(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      try {
        await Promise.all([
          loadStatus(),
          loadApiStatus()
        ])
        if (cancelled) return
      } catch (error) {
        if (!cancelled) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo leer WhatsApp')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
          setApiLoading(false)
        }
      }
    }

    bootstrap()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (isConnected || manualDisconnected || !qrRequested) return

    const interval = window.setInterval(async () => {
      try {
        await loadStatus()
      } catch {
        // El siguiente ciclo reintenta.
      }
    }, 2500)

    return () => window.clearInterval(interval)
  }, [isConnected, manualDisconnected, qrRequested])

  useEffect(() => {
    if (!apiStatus) return
    const templates = apiStatus.templates?.items || []
    if (!templates.length) {
      if (selectedTemplateId) setSelectedTemplateId('')
      return
    }
    if (selectedTemplateId && templates.some(template => template.id === selectedTemplateId)) return
    setSelectedTemplateId(templates.find(template => template.status === 'APPROVED')?.id || templates[0]?.id || '')
  }, [apiStatus, selectedTemplateId])

  const confirmDisconnect = () => {
    showConfirm(
      'Desconectar WhatsApp QR',
      'Se cerrara la conexion actual. Para volver a conectar, abre esta pagina otra vez y se generara un QR nuevo.',
      async () => {
        setDisconnecting(true)
        setConnecting(false)
        setQrRequested(false)
        connectionStartedAt.current = null
        setManualDisconnected(true)
        try {
          const nextStatus = await whatsappWebService.disconnect()
          setStatus(nextStatus)
          showToast('success', 'Desconectado', 'WhatsApp QR se desconecto correctamente')
        } catch (error) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo desconectar')
        } finally {
          setDisconnecting(false)
        }
      },
      'Desconectar',
      'Cancelar'
    )
  }

  const confirmApiDisconnect = () => {
    showConfirm(
      'Desconectar WhatsApp Business',
      'Se pausara la conexion con YCloud. Los mensajes y contactos guardados se quedan intactos.',
      async () => {
        setApiDisconnecting(true)
        try {
          const nextStatus = await whatsappApiService.disconnect()
          setApiStatus(nextStatus)
          showToast('success', 'Desconectado', 'WhatsApp Business quedo pausado')
        } catch (error) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo desconectar WhatsApp Business')
        } finally {
          setApiDisconnecting(false)
        }
      },
      'Desconectar',
      'Cancelar'
    )
  }

  const openLogs = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    setShowLogs(true)
    setLogsLoading(true)
    try {
      setLogs(await whatsappWebService.getLogs())
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudieron leer los logs')
    } finally {
      setLogsLoading(false)
    }
  }

  const sendTemplate = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!selectedTemplate || templateSending) return

    if (selectedTemplate.status !== 'APPROVED') {
      showToast('warning', 'Plantilla no aprobada', 'Solo se pueden enviar plantillas APPROVED')
      return
    }

    let parsedVariables: unknown = []
    const cleanVariables = templateVariables.trim()
    if (cleanVariables) {
      try {
        parsedVariables = JSON.parse(cleanVariables)
      } catch {
        showToast('error', 'Variables invalidas', 'Usa JSON valido para las variables de la plantilla')
        return
      }
    }

    setTemplateSending(true)
    try {
      await whatsappApiService.sendTemplate({
        to: templateTo.trim(),
        from: apiStatus?.sender.phone || undefined,
        templateId: selectedTemplate.id,
        templateName: selectedTemplate.name,
        language: selectedTemplate.language,
        variables: parsedVariables
      })
      showToast('success', 'Plantilla enviada', 'YCloud acepto el envio por WhatsApp Business')
      setTemplateTo('')
      await loadApiStatus()
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo enviar la plantilla')
    } finally {
      setTemplateSending(false)
    }
  }

  const renderApiForm = (compact = false) => (
    <form className={compact ? styles.apiInlineForm : styles.apiConnectForm} onSubmit={connectApi}>
      <label className={styles.fieldLabel}>
        <span>API key de YCloud</span>
        <div className={styles.apiKeyRow}>
          <div className={styles.inputWrap}>
            <KeyRound size={17} />
            <input
              type="password"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value)
                setApiPhoneLookupAttempted(false)
                setDiscoveredApiPhones([])
                if (!apiStatus?.phoneNumbers.length) setSelectedPhoneId('')
              }}
              placeholder={apiStatus?.credentials.hasApiKey ? 'Llave guardada' : 'Pega tu llave de YCloud'}
              autoComplete="off"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            loading={apiPhoneLookupLoading}
            disabled={!canLookupApiPhones}
            onClick={lookupApiPhoneNumbers}
          >
            <RefreshCw size={17} />
            Buscar numeros
          </Button>
        </div>
      </label>

      {availableApiPhones.length ? (
        <label className={styles.fieldLabel}>
          <span>Numero de WhatsApp Business</span>
          <div className={styles.selectWrap}>
            <Smartphone size={17} />
            <select value={selectedPhoneId} onChange={(event) => setSelectedPhoneId(event.target.value)}>
              <option value="">Elegir numero</option>
              {availableApiPhones.map((phone) => (
                <option key={phone.id} value={phone.id}>{getPhoneLabel(phone)}</option>
              ))}
            </select>
          </div>
        </label>
      ) : (
        <div className={styles.apiEmptySelector}>
          <Smartphone size={18} />
          <span>
            {apiPhoneLookupAttempted
              ? 'No encontramos numeros conectados en YCloud. Primero conecta tu WhatsApp Business en YCloud y vuelve a buscar.'
              : 'Pega tu llave y toca Buscar numeros. Ristak los traera de YCloud para que solo elijas uno.'}
          </span>
        </div>
      )}

      <Button type="submit" loading={apiConnecting} disabled={!canSubmitApi}>
        <Cloud size={18} />
        {apiConnected ? 'Actualizar conexion' : 'Conectar WhatsApp Business'}
      </Button>
    </form>
  )

  const renderYCloudGuide = () => (
    <div className={styles.apiTutorial}>
      <div className={styles.apiTutorialHeader}>
        <span>Guia rapida</span>
        <strong>Conecta YCloud paso a paso</strong>
      </div>
      <ol className={styles.apiTutorialSteps}>
        <li>
          <span>1</span>
          <div>
            <strong>Crea o entra a tu cuenta de YCloud</strong>
            <p>Usa el correo del negocio. No necesitas configurar nada raro todavia.</p>
            <a className={styles.apiTutorialButton} href={YCLOUD_REGISTER_URL} target="_blank" rel="noopener noreferrer">
              Abrir registro de YCloud
              <ExternalLink size={14} />
            </a>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>Conecta el numero que ya usas</strong>
            <p>En YCloud busca la opcion para usar tu mismo WhatsApp Business. Si aparece en ingles, elige WhatsApp Business App / Coexistence.</p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>Copia tu llave de conexion</strong>
            <p>Cuando el numero ya salga conectado, copia la llave que YCloud llama API key y pegala aqui.</p>
          </div>
        </li>
        <li>
          <span>4</span>
          <div>
            <strong>Presiona conectar</strong>
            <p>Ristak revisa la cuenta, guarda el numero, consulta saldo, plantillas y contactos disponibles automaticamente.</p>
          </div>
        </li>
      </ol>
    </div>
  )

  const renderApiStage = () => {
    if (apiLoading) {
      return <div className={`${styles.skeletonBlock} ${styles.skeletonStage}`} />
    }

    if (apiConnected && apiStatus) {
      const balance = apiStatus.balance
      const alerts = apiStatus.alerts?.items || []
      const selectedApiPhone = selectedPhone || apiStatus.selectedPhone
      const apiBusinessProfile = parseJson<BusinessProfile>(selectedApiPhone?.business_profile_json)
      const apiProfileImage = selectedApiPhone?.profile_picture_url || apiBusinessProfile?.profilePictureUrl || ''
      const apiDisplayNumber = apiStatus.sender.phone ||
        selectedApiPhone?.display_phone_number ||
        selectedApiPhone?.phone_number ||
        'Numero conectado'
      const apiDisplayName = selectedApiPhone?.verified_name ||
        apiBusinessProfile?.verifiedName ||
        apiBusinessProfile?.businessName ||
        apiBusinessProfile?.name ||
        'WhatsApp Business'
      const phoneRows = (apiStatus.phoneNumbers.length ? apiStatus.phoneNumbers : selectedApiPhone ? [selectedApiPhone] : [])
        .filter(Boolean) as WhatsAppApiPhoneNumber[]

      return (
        <div className={styles.apiConnectedState}>
          <section className={styles.connectionSection}>
            <div className={styles.sectionTop}>
              <div className={styles.connectionSummary}>
                <div className={styles.connectionAvatar}>
                  {apiProfileImage ? (
                    <img src={apiProfileImage} alt="" />
                  ) : (
                    <SiWhatsapp size={24} />
                  )}
                </div>
                <div>
                  <span className={styles.sectionEyebrow}>Conexión</span>
                  <h3>{apiDisplayNumber}</h3>
                  <p>{apiDisplayName}</p>
                </div>
                <span className={styles.connectedLabel}>
                  <ShieldCheck size={16} />
                  Conectado
                </span>
              </div>

              <div className={styles.apiActions}>
                <Button variant="outline" onClick={refreshApi} loading={apiRefreshing}>
                  <RefreshCw size={17} />
                  Sincronizar
                </Button>
                <Button variant="danger" onClick={confirmApiDisconnect} loading={apiDisconnecting}>
                  <Unplug size={17} />
                  Desconectar
                </Button>
              </div>
            </div>

            {alerts.length ? (
              <div className={styles.apiAlertList}>
                {alerts.map((alert) => (
                  <div key={alert.id} className={`${styles.apiAlert} ${getAlertClass(alert)}`}>
                    <AlertTriangle size={18} />
                    <div>
                      <strong>{alert.title}</strong>
                      {alert.message && <p>{alert.message}</p>}
                      <small>{alert.alert_type} · {formatDateTime(alert.updated_at) || 'Ahora'}</small>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.apiHealthyBanner}>
                <CheckCircle size={18} />
                <span>Sin alertas activas de YCloud</span>
              </div>
            )}

            {apiStatus.requiresPhoneSelection && (
              <div className={styles.apiNotice}>
                Selecciona el numero emisor para dejar el envio listo.
              </div>
            )}

            <div className={styles.numberTable} role="table" aria-label="Numeros conectados a WhatsApp Business">
              <div className={styles.numberTableHeader} role="row">
                <span>Número</span>
                <span>Nombre</span>
                <span>Estado</span>
                <span>Calidad</span>
              </div>

              {phoneRows.length ? phoneRows.map((phone) => {
                const profile = parseJson<BusinessProfile>(phone.business_profile_json)
                const phoneImage = phone.profile_picture_url || profile?.profilePictureUrl || ''
                const isSender = phone.id === selectedPhoneId ||
                  phone.phone_number === apiStatus.sender.phone ||
                  phone.display_phone_number === apiStatus.sender.phone

                return (
                  <div key={phone.id} className={styles.numberTableRow} role="row">
                    <span className={styles.numberCell}>
                      <span className={styles.numberAvatar}>
                        {phoneImage ? <img src={phoneImage} alt="" /> : <SiWhatsapp size={15} />}
                      </span>
                      <strong>{phone.display_phone_number || phone.phone_number || apiDisplayNumber}</strong>
                    </span>
                    <span>{phone.verified_name || profile?.verifiedName || profile?.businessName || profile?.name || 'Sin nombre'}</span>
                    <span>
                      <mark className={isSender ? styles.statusMarkActive : styles.statusMarkMuted}>
                        {isSender ? 'Emisor' : phone.status || 'Disponible'}
                      </mark>
                    </span>
                    <span>{phone.quality_rating || 'UNKNOWN'}</span>
                  </div>
                )
              }) : (
                <div className={styles.numberTableEmpty}>Sin número conectado</div>
              )}
            </div>

            <div className={styles.connectionStats}>
              <span>Saldo: {balance ? formatCurrency(balance.amount, balance.currency) : 'Pendiente'}</span>
              <span>Límite: {selectedApiPhone?.messaging_limit || 'Sin dato'}</span>
              <span>{formatMetric(apiStatus.stats.messages)} mensajes</span>
              <span>{formatMetric(apiStatus.stats.contacts)} contactos</span>
              <span>{formatMetric(apiStatus.templates?.approved || 0)} / {formatMetric(apiStatus.templates?.total || 0)} plantillas aprobadas</span>
              <span>{formatMetric(apiStatus.alerts?.total || 0)} alertas activas</span>
              <span>{formatMetric(apiStatus.stats.templateSends || 0)} envíos con plantilla</span>
            </div>

            {apiStatus.lastError && <p className={styles.errorText}>{apiStatus.lastError}</p>}

            {apiStatus.requiresPhoneSelection && renderApiForm(true)}
          </section>

          <section className={styles.templatesSection}>
            <div className={styles.sectionTop}>
              <div>
                <span className={styles.sectionEyebrow}>Plantillas</span>
                <h3>Carpetas y mensajes</h3>
                <p>Crea plantillas con variables dinámicas para usarlas después con WhatsApp Business.</p>
              </div>
            </div>
            <MessageTemplates embedded />
          </section>
        </div>
      )
    }

    return (
      <div className={styles.apiIdleState}>
        <span className={styles.apiLogoMark}><Cloud size={42} /></span>
        <h3>Conectar WhatsApp Business</h3>
        <p>YCloud · WhatsApp Business oficial</p>
        {apiStatus?.lastError && <p className={styles.errorText}>{apiStatus.lastError}</p>}
        {renderYCloudGuide()}
        {renderApiForm()}
      </div>
    )
  }

  const renderWebStage = () => (
    <>
      {showLogs ? (
        <div className={styles.logsView}>
          <button type="button" className={styles.logsBackButton} onClick={() => setShowLogs(false)}>
            <ArrowLeft size={15} />
            Volver
          </button>
          {logsLoading ? (
            <p>Cargando logs...</p>
          ) : (
            <>
              <div>
                <h3>Chats recientes</h3>
                {(logs?.recent || []).length ? (logs?.recent || []).map(renderLog) : <p>Sin logs</p>}
              </div>
              <div>
                <h3>Con atribucion detectada</h3>
                {(logs?.attributed || []).length ? (logs?.attributed || []).map(renderLog) : <p>Sin atribucion</p>}
              </div>
            </>
          )}
        </div>
      ) : isConnected ? (
        <div className={styles.connectedState}>
          <div className={styles.avatar}>
            {profileImage ? (
              <img src={profileImage} alt="" />
            ) : (
              <SiWhatsapp size={58} />
            )}
            <span className={styles.checkBadge}><CheckCircle size={22} /></span>
          </div>

          <div className={styles.connectedCopy}>
            <span className={styles.connectedLabel}>
              <ShieldCheck size={18} />
              Conectado
            </span>
            <h3>{session?.phone || 'Numero conectado'}</h3>
            <p>{displayName}</p>
            {businessProfile?.category && (
              <span className={styles.profileCategory}>{businessProfile.category}</span>
            )}
          </div>

          <div className={styles.connectedActions}>
            <Button variant="danger" onClick={confirmDisconnect} loading={disconnecting}>
              <Unplug size={17} />
              Desconectar
            </Button>
            <a href="#" className={styles.logsLink} onClick={openLogs}>Ver logs</a>
          </div>
        </div>
      ) : showQr ? (
        <div className={styles.qrState}>
          <img src={session?.qr_image || ''} alt="Codigo QR para conectar WhatsApp QR" />
          <p>Escanea el codigo desde WhatsApp para conectar la cuenta.</p>
          <Button variant="outline" size="md" onClick={startConnection}>
            <RefreshCw size={16} />
            Generar QR nuevo
          </Button>
        </div>
      ) : manualDisconnected ? (
        <div className={styles.disconnectedState}>
          <SiWhatsapp size={52} />
          <h3>Desconectado</h3>
          <Button size="lg" onClick={startConnection} loading={connecting}>
            <SiWhatsapp size={18} />
            Conectar WhatsApp QR
          </Button>
        </div>
      ) : isWaitingForQr ? (
        <div className={styles.qrState} role="status" aria-live="polite" aria-label="Generando QR">
          <div className={`${styles.skeletonBlock} ${styles.skeletonQr}`} />
          {session?.last_error && <p className={styles.errorText}>{session.last_error}</p>}
          <Button variant="outline" size="md" onClick={startConnection}>
            <RefreshCw size={16} />
            Generar QR nuevo
          </Button>
        </div>
      ) : (
        <div className={styles.idleState}>
          <SiWhatsapp size={58} />
          <h3>Conectar WhatsApp QR</h3>
          <p>Genera un QR nuevo y escanealo desde WhatsApp para conectar la cuenta.</p>
          {session?.last_error && <p className={styles.errorText}>{session.last_error}</p>}
          <Button size="lg" onClick={startConnection} loading={connecting}>
            <SiWhatsapp size={18} />
            Conectar WhatsApp QR
          </Button>
        </div>
      )}
    </>
  )

  if (loading || apiLoading) {
    return (
      <div className={styles.shell}>
        <div className={styles.skeletonHeaderRow} role="status" aria-live="polite" aria-label="Cargando configuracion">
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
      <div className={styles.header}>
        <span className={styles.logoMark}><SiWhatsapp size={30} /></span>
        <div>
          <p className={styles.eyebrow}>Configuracion</p>
          <h2 className={styles.title}>WhatsApp</h2>
        </div>
      </div>

      <div className={styles.channelTabs} role="tablist" aria-label="Canales de WhatsApp">
        <button
          type="button"
          className={`${styles.channelTab} ${activeChannel === 'api' ? styles.channelTabActive : ''}`}
          onClick={() => setActiveChannel('api')}
        >
          <Cloud size={17} />
          WhatsApp Business
        </button>
        <button
          type="button"
          className={`${styles.channelTab} ${activeChannel === 'web' ? styles.channelTabActive : ''}`}
          onClick={() => setActiveChannel('web')}
        >
          <SiWhatsapp size={17} />
          WhatsApp QR
        </button>
      </div>

      <div className={styles.stage}>
        {activeChannel === 'api' ? renderApiStage() : renderWebStage()}
      </div>
    </div>
  )
}
