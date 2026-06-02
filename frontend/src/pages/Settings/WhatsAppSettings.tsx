import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CheckCircle, RefreshCw, ShieldCheck, Unplug } from 'lucide-react'
import { SiWhatsapp } from 'react-icons/si'
import { Button, Card } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
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
  const [status, setStatus] = useState<WhatsAppWebStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [qrRequested, setQrRequested] = useState(false)
  const [manualDisconnected, setManualDisconnected] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [logs, setLogs] = useState<WhatsAppWebLogs | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)
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

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      try {
        await loadStatus()
        if (cancelled) return
      } catch (error) {
        if (!cancelled) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo leer WhatsApp Business')
        }
      } finally {
        if (!cancelled) setLoading(false)
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

  if (loading) {
    return (
      <Card className={styles.shell}>
        <div className={styles.generatingState}>
          <RefreshCw size={26} className={styles.spin} />
          <span>Cargando configuracion</span>
        </div>
      </Card>
    )
  }

  return (
    <Card className={styles.shell}>
      <div className={styles.header}>
        <span className={styles.logoMark}><SiWhatsapp size={30} /></span>
        <div>
          <p className={styles.eyebrow}>Configuracion</p>
          <h2 className={styles.title}>WhatsApp Business</h2>
        </div>
      </div>

      <div className={styles.stage}>
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
          <div className={styles.generatingState}>
            <RefreshCw size={34} className={styles.spin} />
            <span>Generando QR</span>
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
      </div>
    </Card>
  )
}
