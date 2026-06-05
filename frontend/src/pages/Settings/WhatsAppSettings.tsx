import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CheckCircle, Cloud, KeyRound, RefreshCw, ShieldCheck, Smartphone, Unplug } from 'lucide-react'
import { SiWhatsapp } from 'react-icons/si'
import { Button, Card } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { WhatsAppApiPhoneNumber, WhatsAppApiStatus, whatsappApiService } from '@/services/whatsappApiService'
import { WhatsAppWebLog, WhatsAppWebLogs, WhatsAppWebStatus, whatsappWebService } from '@/services/whatsappWebService'
import styles from './WhatsAppSettings.module.css'

type BusinessProfile = {
  businessName?: string
  name?: string
  description?: string
  email?: string
  website?: string | string[]
  category?: string
}

type WhatsAppChannel = 'api' | 'web'

const CONNECTION_FLOW_TIMEOUT_MS = 120_000

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

function getPhoneLabel(phone: WhatsAppApiPhoneNumber) {
  const number = phone.display_phone_number || phone.phone_number || 'Numero'
  return phone.verified_name ? `${number} · ${phone.verified_name}` : number
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
  const [manualPhone, setManualPhone] = useState('')

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

  const selectedPhone = useMemo(() => {
    return apiStatus?.phoneNumbers.find(phone => phone.id === selectedPhoneId) || null
  }, [apiStatus?.phoneNumbers, selectedPhoneId])

  const canSubmitApi = Boolean(apiKey.trim() || apiStatus?.credentials.hasApiKey)
  const apiConnected = Boolean(apiStatus?.connected)

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

    const preferredPhoneId = nextStatus.sender.phoneNumberId ||
      nextStatus.phoneNumbers.find(phone => phone.phone_number === nextStatus.sender.phone)?.id ||
      nextStatus.phoneNumbers[0]?.id ||
      ''

    setSelectedPhoneId(preferredPhoneId)
    setManualPhone(nextStatus.sender.phone || '')

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

  const connectApi = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!canSubmitApi || apiConnecting) return

    setApiConnecting(true)
    try {
      const nextStatus = await whatsappApiService.connect({
        apiKey: apiKey.trim() || undefined,
        phoneNumberId: selectedPhone?.id || undefined,
        senderPhone: selectedPhone?.phone_number || manualPhone.trim() || undefined,
        wabaId: selectedPhone?.waba_id || undefined
      })
      setApiStatus(nextStatus)
      setApiKey('')

      if (nextStatus.requiresPhoneSelection) {
        showToast('warning', 'WhatsApp_API conectado', 'Selecciona el numero emisor para terminar')
      } else {
        showToast('success', 'WhatsApp_API conectado', 'YCloud y el webhook quedaron activos')
      }
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo conectar WhatsApp_API')
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
      showToast('success', 'Actualizado', 'WhatsApp_API se sincronizo con YCloud')
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo actualizar WhatsApp_API')
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

  const confirmDisconnect = () => {
    showConfirm(
      'Desconectar WhatsApp Business',
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
          showToast('success', 'Desconectado', 'WhatsApp Business se desconecto correctamente')
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
      'Desconectar WhatsApp_API',
      'Se pausara el webhook de YCloud. Los mensajes y contactos guardados se quedan intactos.',
      async () => {
        setApiDisconnecting(true)
        try {
          const nextStatus = await whatsappApiService.disconnect()
          setApiStatus(nextStatus)
          showToast('success', 'Desconectado', 'WhatsApp_API quedo pausado')
        } catch (error) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo desconectar WhatsApp_API')
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

  const renderApiForm = (compact = false) => (
    <form className={compact ? styles.apiInlineForm : styles.apiConnectForm} onSubmit={connectApi}>
      <label className={styles.fieldLabel}>
        <span>API key de YCloud</span>
        <div className={styles.inputWrap}>
          <KeyRound size={17} />
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={apiStatus?.credentials.hasApiKey ? 'API key guardada' : 'X-API-Key'}
            autoComplete="off"
          />
        </div>
      </label>

      {apiStatus?.phoneNumbers.length ? (
        <label className={styles.fieldLabel}>
          <span>Numero emisor</span>
          <div className={styles.selectWrap}>
            <Smartphone size={17} />
            <select value={selectedPhoneId} onChange={(event) => setSelectedPhoneId(event.target.value)}>
              <option value="">Elegir numero</option>
              {apiStatus.phoneNumbers.map((phone) => (
                <option key={phone.id} value={phone.id}>{getPhoneLabel(phone)}</option>
              ))}
            </select>
          </div>
        </label>
      ) : (
        <label className={styles.fieldLabel}>
          <span>Numero emisor</span>
          <div className={styles.inputWrap}>
            <Smartphone size={17} />
            <input
              type="tel"
              value={manualPhone}
              onChange={(event) => setManualPhone(event.target.value)}
              placeholder="+52..."
              autoComplete="tel"
            />
          </div>
        </label>
      )}

      <Button type="submit" loading={apiConnecting} disabled={!canSubmitApi}>
        <Cloud size={18} />
        {apiConnected ? 'Actualizar conexion' : 'Conectar WhatsApp_API'}
      </Button>
    </form>
  )

  const renderApiStage = () => {
    if (apiLoading) {
      return <div className={`${styles.skeletonBlock} ${styles.skeletonStage}`} />
    }

    if (apiConnected && apiStatus) {
      return (
        <div className={styles.apiConnectedState}>
          <div className={styles.apiHero}>
            <span className={styles.apiLogoMark}><Cloud size={38} /></span>
            <span className={styles.connectedLabel}>
              <ShieldCheck size={18} />
              WhatsApp_API activo
            </span>
            <h3>{apiStatus.sender.phone || 'Webhook conectado'}</h3>
            <p>{selectedPhone?.verified_name || selectedPhone?.display_phone_number || 'YCloud'}</p>
          </div>

          {apiStatus.requiresPhoneSelection && (
            <div className={styles.apiNotice}>
              Selecciona el numero emisor para dejar el envio listo.
            </div>
          )}

          <div className={styles.apiMetricsGrid}>
            <div><span>Mensajes</span><strong>{formatMetric(apiStatus.stats.messages)}</strong></div>
            <div><span>Contactos</span><strong>{formatMetric(apiStatus.stats.contacts)}</strong></div>
            <div><span>Atribucion</span><strong>{formatMetric(apiStatus.stats.attributedMessages)}</strong></div>
            <div><span>Eventos</span><strong>{formatMetric(apiStatus.stats.webhookEvents)}</strong></div>
          </div>

          <div className={styles.apiDetailsGrid}>
            <div>
              <span>Webhook</span>
              <strong>{apiStatus.webhook.status || 'activo'}</strong>
              <small>{apiStatus.webhook.url || 'Sin URL'}</small>
            </div>
            <div>
              <span>Ultima sync</span>
              <strong>{formatDateTime(apiStatus.timestamps.lastSyncedAt) || 'Pendiente'}</strong>
              <small>{apiStatus.webhook.id || 'Sin endpoint'}</small>
            </div>
          </div>

          {apiStatus.lastError && <p className={styles.errorText}>{apiStatus.lastError}</p>}

          {apiStatus.requiresPhoneSelection && renderApiForm(true)}

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
      )
    }

    return (
      <div className={styles.apiIdleState}>
        <span className={styles.apiLogoMark}><Cloud size={42} /></span>
        <h3>Conectar WhatsApp_API</h3>
        <p>YCloud · Cloud API oficial</p>
        {apiStatus?.lastError && <p className={styles.errorText}>{apiStatus.lastError}</p>}
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
          <img src={session?.qr_image || ''} alt="Codigo QR para conectar WhatsApp Business" />
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
            Conectar WhatsApp
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
          <h3>Conectar WhatsApp Business</h3>
          <p>Genera un QR nuevo y escanealo desde WhatsApp para conectar la cuenta.</p>
          {session?.last_error && <p className={styles.errorText}>{session.last_error}</p>}
          <Button size="lg" onClick={startConnection} loading={connecting}>
            <SiWhatsapp size={18} />
            Conectar WhatsApp
          </Button>
        </div>
      )}
    </>
  )

  if (loading || apiLoading) {
    return (
      <Card className={styles.shell}>
        <div className={styles.skeletonHeaderRow} role="status" aria-live="polite" aria-label="Cargando configuracion">
          <div className={`${styles.skeletonBlock} ${styles.skeletonLogo}`} />
          <div className={styles.skeletonHeaderText}>
            <div className={`${styles.skeletonBlock} ${styles.skeletonEyebrow}`} />
            <div className={`${styles.skeletonBlock} ${styles.skeletonTitle}`} />
          </div>
        </div>
        <div className={`${styles.skeletonBlock} ${styles.skeletonStage}`} />
      </Card>
    )
  }

  return (
    <Card className={styles.shell}>
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
          WhatsApp_API
        </button>
        <button
          type="button"
          className={`${styles.channelTab} ${activeChannel === 'web' ? styles.channelTabActive : ''}`}
          onClick={() => setActiveChannel('web')}
        >
          <SiWhatsapp size={17} />
          Baileys QR
        </button>
      </div>

      <div className={styles.stage}>
        {activeChannel === 'api' ? renderApiStage() : renderWebStage()}
      </div>
    </Card>
  )
}
