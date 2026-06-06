import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Bell,
  CheckCircle,
  ChevronDown,
  Cloud,
  ExternalLink,
  FileText,
  KeyRound,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Star,
  Unplug,
  Wallet
} from 'lucide-react'
import { SiWhatsapp } from 'react-icons/si'
import { Button } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { WhatsAppApiAlert, WhatsAppApiPhoneNumber, WhatsAppApiStatus, WhatsAppQrSession, whatsappApiService } from '@/services/whatsappApiService'
import { MessageTemplates } from './MessageTemplates'
import styles from './WhatsAppSettings.module.css'

type BusinessProfile = {
  businessName?: string
  name?: string
  verifiedName?: string
  profilePictureUrl?: string
  category?: string
}

type WhatsAppSection = 'connection' | 'templates'

const YCLOUD_REGISTER_URL = 'https://www.ycloud.com/console/#/entry/register?'
const YCLOUD_CONSOLE_URL = 'https://www.ycloud.com/console/#/app/dashboard/analytics'

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
  const number = phone.display_phone_number || phone.phone_number || 'Numero'
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

function getAlertSummaryCopy(count: number, severity?: string | null) {
  const normalized = String(severity || '').toLowerCase()
  const suffix = count === 1 ? '' : 's'
  if (normalized === 'critical') return `${count} alerta${suffix} importante${suffix}`
  if (normalized === 'warning') return `${count} advertencia${suffix}`
  return `${count} aviso${suffix}`
}

function getQrStatusLabel(status?: string | null) {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'connected') return 'QR conectado'
  if (normalized === 'qr_pending') return 'Escanea QR'
  if (normalized === 'starting') return 'Preparando QR'
  if (normalized === 'restarting') return 'Reiniciando QR'
  if (normalized === 'reconnecting') return 'Reconectando QR'
  if (normalized === 'number_mismatch') return 'Numero incorrecto'
  if (normalized === 'bad_session') return 'Reconectar QR'
  if (normalized === 'connection_replaced') return 'Sesion reemplazada'
  if (normalized === 'disconnected_515') return 'Reiniciar QR'
  if (normalized === 'logged_out') return 'QR cerrado'
  if (normalized.startsWith('disconnected')) return 'QR desconectado'
  return 'QR apagado'
}

function getQrStatusClass(status?: string | null) {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'connected') return styles.qrBadgeConnected
  if (['qr_pending', 'starting', 'restarting', 'reconnecting', 'disconnected_515'].includes(normalized)) return styles.qrBadgePending
  if (['number_mismatch', 'logged_out', 'bad_session', 'connection_replaced'].includes(normalized) || normalized.includes('disconnect')) return styles.qrBadgeWarning
  return styles.qrBadgeMuted
}

function isQrWorkingStatus(status?: string | null) {
  return ['connected', 'qr_pending', 'starting', 'restarting', 'reconnecting'].includes(String(status || '').toLowerCase())
}

export const WhatsAppSettings: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [activeSection, setActiveSection] = useState<WhatsAppSection>('connection')
  const [apiStatus, setApiStatus] = useState<WhatsAppApiStatus | null>(null)
  const [apiLoading, setApiLoading] = useState(true)
  const [apiConnecting, setApiConnecting] = useState(false)
  const [apiRefreshing, setApiRefreshing] = useState(false)
  const [apiDisconnecting, setApiDisconnecting] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [selectedPhoneId, setSelectedPhoneId] = useState('')
  const [qrConnectingPhoneId, setQrConnectingPhoneId] = useState('')
  const [qrDisconnectingPhoneId, setQrDisconnectingPhoneId] = useState('')
  const [defaultingPhoneId, setDefaultingPhoneId] = useState('')
  const [alertsExpanded, setAlertsExpanded] = useState(false)

  const apiConnected = Boolean(apiStatus?.connected)

  const selectedPhone = useMemo(() => {
    return apiStatus?.phoneNumbers.find(phone => phone.id === selectedPhoneId) || apiStatus?.selectedPhone || apiStatus?.phoneNumbers[0] || null
  }, [apiStatus?.phoneNumbers, apiStatus?.selectedPhone, selectedPhoneId])

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

      showToast('success', 'WhatsApp conectado', 'Ristak sincronizo los numeros disponibles de WhatsApp API')
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
      'Se pausara la conexion con WhatsApp API. Los mensajes, contactos y plantillas guardadas se quedan intactos.',
      async () => {
        setApiDisconnecting(true)
        try {
          const nextStatus = await whatsappApiService.disconnect()
          setApiStatus(nextStatus)
          showToast('success', 'Desconectado', 'WhatsApp Business quedo pausado')
        } catch (error) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo desconectar WhatsApp')
        } finally {
          setApiDisconnecting(false)
        }
      },
      'Desconectar',
      'Cancelar'
    )
  }

  const connectQrForPhone = (phone: WhatsAppApiPhoneNumber) => {
    const label = getPhoneLabel(phone)
    const consent = apiStatus?.qr?.consentText ||
      'Acepto que esta conexion usa WhatsApp Web por QR y no la API oficial de Meta. Entiendo que puede desconectarse, fallar o poner en riesgo el numero. Ristak solo la usara para mensajes individuales cuando yo lo active.'

    showConfirm(
      'Conectar por QR',
      `${label}\n\n${consent}\n\nEscanea el QR solamente con ese mismo numero. Si conectas otro, Ristak lo rechazara.`,
      async () => {
        setQrConnectingPhoneId(phone.id)
        try {
          const session = await whatsappApiService.connectQr({
            phoneNumberId: phone.id,
            acceptedRisk: true
          })
          await loadApiStatus()
          if (session.status === 'connected') {
            showToast('success', 'QR conectado', 'Este numero ya puede mandar mensajes individuales por QR')
          } else if (session.status === 'qr_pending') {
            showToast('info', 'Escanea el QR', 'Usa WhatsApp en ese mismo numero para completar la conexion')
          } else {
            showToast('warning', 'QR pendiente', session.lastError || 'Revisa el estado del codigo QR')
          }
        } catch (error) {
          showToast('error', 'No se pudo abrir QR', error instanceof Error ? error.message : 'Intenta nuevamente')
        } finally {
          setQrConnectingPhoneId('')
        }
      },
      'Acepto y conectar',
      'Cancelar'
    )
  }

  const disconnectQrForPhone = (phone: WhatsAppApiPhoneNumber) => {
    showConfirm(
      'Desconectar QR',
      `Se apagara el envio por QR para ${getPhoneLabel(phone)}. La conexion oficial de WhatsApp API y los mensajes guardados se quedan intactos.`,
      async () => {
        setQrDisconnectingPhoneId(phone.id)
        try {
          await whatsappApiService.disconnectQr(phone.id)
          await loadApiStatus()
          showToast('success', 'QR desconectado', 'Este numero ya no enviara mensajes por QR')
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

  const templateSummary = useMemo(() => {
    const templates = apiStatus?.templates?.items || []
    const pending = templates.filter(template => ['PENDING', 'IN_APPEAL'].includes(String(template.status || '').toUpperCase())).length
    const rejected = templates.filter(template => ['REJECTED', 'DISABLED', 'PAUSED'].includes(String(template.status || '').toUpperCase())).length

    return {
      total: apiStatus?.templates?.total || templates.length,
      approved: apiStatus?.templates?.approved || templates.filter(template => String(template.status || '').toUpperCase() === 'APPROVED').length,
      pending,
      rejected
    }
  }, [apiStatus?.templates])

  const renderApiForm = () => (
    <form className={styles.apiConnectForm} onSubmit={connectApi}>
      <label className={styles.fieldLabel}>
        <span>Llave de conexión de WhatsApp API</span>
        <div className={styles.apiKeyRow}>
          <div className={styles.inputWrap}>
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
            <p>Pegala aqui y Ristak se conectara a tu cuenta.</p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>Revisa tus numeros</strong>
            <p>Al conectar, Ristak mostrara todos los numeros disponibles en esta misma pantalla.</p>
          </div>
        </li>
      </ol>
    </div>
  )

  const renderConnectionStage = () => {
    if (apiLoading) {
      return <div className={`${styles.skeletonBlock} ${styles.skeletonStage}`} />
    }

    if (!apiConnected || !apiStatus) {
      return (
        <section className={styles.apiConnectPanel}>
          <span className={styles.apiLogoMark}><Cloud size={38} /></span>
          <div className={styles.apiConnectCopy}>
            <h3>Conecta WhatsApp Business</h3>
            <p>Usa WhatsApp API para enviar mensajes oficiales, revisar saldo y mandar plantillas a Meta.</p>
          </div>
          {apiStatus?.lastError && <p className={styles.errorText}>{apiStatus.lastError}</p>}
          <div className={styles.connectContent}>
            {renderApiForm()}
            {renderYCloudGuide()}
          </div>
        </section>
      )
    }

    const selectedApiPhone = selectedPhone || apiStatus.selectedPhone || apiStatus.phoneNumbers[0] || null
    const profile = getPhoneProfile(selectedApiPhone)
    const apiProfileImage = selectedApiPhone?.profile_picture_url || profile?.profilePictureUrl || ''
    const apiDisplayNumber = 'WhatsApp API conectado'
    const apiDisplayName = apiStatus.phoneNumbers.length
      ? `${formatMetric(apiStatus.phoneNumbers.length)} numero${apiStatus.phoneNumbers.length === 1 ? '' : 's'} sincronizado${apiStatus.phoneNumbers.length === 1 ? '' : 's'}`
      : 'Sin numeros sincronizados todavia'
    const balance = apiStatus.balance
    const phoneRows = apiStatus.phoneNumbers.length ? apiStatus.phoneNumbers : selectedApiPhone ? [selectedApiPhone] : []
    const alertCount = connectionAlerts.length
    const topAlertGroup = connectionAlertGroups[0]
    const alertSummaryText = topAlertGroup
      ? getAlertSummaryCopy(alertCount, topAlertGroup.severity)
      : ''
    const alertPreview = topAlertGroup?.message || topAlertGroup?.title || 'Revisa los avisos de WhatsApp'

    return (
      <div className={styles.connectionGrid}>
        <section className={`${styles.templateSummaryCard} ${styles.balanceSummaryCard}`}>
          <div className={styles.summaryHeader}>
            <span className={styles.summaryIcon}><Wallet size={20} /></span>
            <div>
              <span className={styles.sectionEyebrow}>Saldo</span>
              <h3>{balance ? formatCurrency(balance.amount, balance.currency) : 'Pendiente'}</h3>
            </div>
          </div>
          <p className={styles.emptyText}>Si el saldo baja demasiado, WhatsApp API puede detener los envios.</p>
        </section>

        <section className={styles.connectionCard}>
          <div className={styles.connectionHeader}>
            <div className={styles.connectionIdentity}>
              <span className={styles.connectionAvatar}>
                {apiProfileImage ? <img src={apiProfileImage} alt="" /> : <SiWhatsapp size={24} />}
              </span>
              <div>
                <span className={styles.sectionEyebrow}>Conexión</span>
                <h3>{apiDisplayNumber}</h3>
                <p>{apiDisplayName}</p>
              </div>
            </div>
            <div className={styles.connectionHeaderRight}>
              <span className={styles.connectedLabel}>
                <ShieldCheck size={16} />
                Conectado
              </span>
              <div className={styles.connectionActions}>
                <Button variant="outline" onClick={refreshApi} loading={apiRefreshing}>
                  <RefreshCw size={17} />
                  Sincronizar
                </Button>
                <Button variant="danger" onClick={confirmApiDisconnect} loading={apiDisconnecting}>
                  <Unplug size={17} />
                  Desconectar
                </Button>
                <a className={styles.externalButton} href={YCLOUD_CONSOLE_URL} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={16} />
                  Abrir WhatsApp API
                </a>
              </div>
            </div>
          </div>

          {connectionAlertGroups.length ? (
            <div className={styles.apiAlertDropdown}>
              <button
                type="button"
                className={`${styles.apiAlertSummary} ${getAlertClass(topAlertGroup?.severity)}`}
                onClick={() => setAlertsExpanded((current) => !current)}
                aria-expanded={alertsExpanded}
              >
                <span className={styles.apiAlertSummaryIcon}>
                  <Bell size={17} />
                </span>
                <span className={styles.apiAlertSummaryCopy}>
                  <strong>{alertSummaryText}</strong>
                  <small>{alertPreview}</small>
                </span>
                <span className={styles.apiAlertSummaryMeta}>
                  {connectionAlertGroups.length === 1 ? 'Ver detalle' : `${connectionAlertGroups.length} temas`}
                </span>
                <ChevronDown
                  size={18}
                  className={`${styles.apiAlertChevron} ${alertsExpanded ? styles.apiAlertChevronOpen : ''}`}
                />
              </button>

              {alertsExpanded && (
                <div className={styles.apiAlertDetails}>
                  {connectionAlertGroups.map((group) => {
                    const extraTitles = group.titles.filter((title) => title !== group.title)

                    return (
                      <article key={group.key} className={`${styles.apiAlert} ${getAlertClass(group.severity)}`}>
                        <AlertTriangle size={18} />
                        <div>
                          <div className={styles.apiAlertHeader}>
                            <strong>{group.title}</strong>
                            {group.count > 1 && <span>{group.count} avisos</span>}
                          </div>
                          {group.message && <p>{group.message}</p>}
                          {extraTitles.length > 0 && (
                            <small className={styles.apiAlertRelated}>
                              Tambien incluye: {extraTitles.join(', ')}
                            </small>
                          )}
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className={styles.apiHealthyBanner}>
              <CheckCircle size={18} />
              <span>Listo para enviar mensajes</span>
            </div>
          )}

          {phoneRows.length > 0 && (
            <div className={styles.phoneTableWrap}>
              <table className={styles.phoneTable}>
                <thead>
                  <tr>
                    <th>Numero</th>
                    <th>Nombre</th>
                    <th>API</th>
                    <th>QR</th>
                    <th>Calidad</th>
                    <th>Limite</th>
                    <th className={styles.actionColumn}>Accion</th>
                  </tr>
                </thead>
                <tbody>
                  {phoneRows.map((phone) => {
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
                    const displayName = phone.verified_name || phoneProfile?.verifiedName || phoneProfile?.businessName || phoneProfile?.name || 'Sin nombre'

                    return (
                      <React.Fragment key={phone.id}>
                        <tr>
                          <td>
                            <strong>{phone.display_phone_number || phone.phone_number || 'Numero'}</strong>
                            <small>{phone.id}</small>
                          </td>
                          <td>{displayName}</td>
                          <td>
                            <span className={styles.phoneBadges}>
                              <mark>{isSender ? 'Principal' : 'Oficial'}</mark>
                            </span>
                          </td>
                          <td>
                            <span className={styles.phoneBadges}>
                              <mark className={getQrStatusClass(qrStatus)}>{getQrStatusLabel(qrStatus)}</mark>
                            </span>
                          </td>
                          <td>{phone.quality_rating || 'Sin dato'}</td>
                          <td>{phone.messaging_limit || 'Sin dato'}</td>
                          <td className={styles.actionCell}>
                            <div className={styles.phoneActions}>
                              {!isSender && (
                                <button
                                  type="button"
                                  className={styles.phoneActionButton}
                                  onClick={() => makePhoneDefault(phone)}
                                  disabled={defaultingPhoneId === phone.id}
                                >
                                  <Star size={14} />
                                  {defaultingPhoneId === phone.id ? 'Guardando' : 'Hacer principal'}
                                </button>
                              )}
                              {qrConnected ? (
                                <button
                                  type="button"
                                  className={styles.phoneActionDanger}
                                  onClick={() => disconnectQrForPhone(phone)}
                                  disabled={qrDisconnectingPhoneId === phone.id}
                                >
                                  <Unplug size={14} />
                                  {qrDisconnectingPhoneId === phone.id ? 'Apagando' : 'Apagar QR'}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className={styles.phoneActionButton}
                                  onClick={() => connectQrForPhone(phone)}
                                  disabled={qrConnectingPhoneId === phone.id}
                                >
                                  <QrCode size={14} />
                                  {qrConnectingPhoneId === phone.id ? 'Abriendo' : qrPending ? 'Nuevo QR' : 'Conectar QR'}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {(qrSession?.qrCodeDataUrl && qrPending) || qrError ? (
                          <tr className={styles.phoneDetailRow}>
                            <td colSpan={7}>
                              {qrSession?.qrCodeDataUrl && qrPending && (
                                <div className={styles.qrPreview}>
                                  <img src={qrSession.qrCodeDataUrl} alt={`QR para ${phone.display_phone_number || phone.phone_number || 'WhatsApp'}`} />
                                  <span>Escanea este codigo desde WhatsApp en el mismo numero.</span>
                                </div>
                              )}
                              {qrError && <p className={styles.phoneError}>{qrError}</p>}
                            </td>
                          </tr>
                        ) : null}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {apiStatus.lastError && <p className={styles.errorText}>{apiStatus.lastError}</p>}
        </section>
      </div>
    )
  }

  const renderTemplatesStage = () => {
    if (!apiConnected) {
      return (
        <section className={styles.templatesLocked}>
          <FileText size={36} />
          <h3>Conecta WhatsApp para enviar plantillas a Meta</h3>
          <p>Cuando la conexión esté lista, aquí podrás crear plantillas, enviarlas a revisión y ver si Meta las aprobó o rechazó.</p>
          <Button onClick={() => setActiveSection('connection')}>
            <Cloud size={17} />
            Ir a conexión
          </Button>
        </section>
      )
    }

    return (
      <section className={styles.templatesWorkspace}>
        <div className={styles.templatesHeader}>
          <div>
            <span className={styles.sectionEyebrow}>Plantillas</span>
            <h3>Mensajes aprobados por Meta</h3>
            <p>Crea, manda a revisión y sincroniza el estado real desde WhatsApp API.</p>
          </div>
          <div className={styles.templatesSummaryBar}>
            <span>{formatMetric(templateSummary.approved)} aprobadas</span>
            <span>{formatMetric(templateSummary.pending)} en revisión</span>
            <span>{formatMetric(templateSummary.rejected)} rechazadas</span>
          </div>
        </div>
        <MessageTemplates embedded />
      </section>
    )
  }

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
      <div className={styles.header}>
        <span className={styles.logoMark}><SiWhatsapp size={30} /></span>
        <div className={styles.headerCopy}>
          <p className={styles.eyebrow}>Configuracion</p>
          <h2 className={styles.title}>WhatsApp</h2>
          <span>Conexión oficial por API para mensajes, saldo y plantillas.</span>
        </div>
      </div>

      <div className={styles.sectionSwitch} aria-label="Secciones de WhatsApp">
        <button
          type="button"
          className={`${styles.sectionSwitchButton} ${activeSection === 'connection' ? styles.sectionSwitchButtonActive : ''}`}
          onClick={() => setActiveSection('connection')}
        >
          <ShieldCheck size={17} />
          Conexión
        </button>
        <button
          type="button"
          className={`${styles.sectionSwitchButton} ${activeSection === 'templates' ? styles.sectionSwitchButtonActive : ''}`}
          onClick={() => setActiveSection('templates')}
        >
          <FileText size={17} />
          Plantillas
        </button>
      </div>

      <div className={styles.stage}>
        {activeSection === 'connection' ? renderConnectionStage() : renderTemplatesStage()}
      </div>
    </div>
  )
}
