import React, { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  Cloud,
  ExternalLink,
  FileText,
  Hash,
  KeyRound,
  QrCode,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Unplug,
  Wallet
} from 'lucide-react'
import { SiWhatsapp } from 'react-icons/si'
import { Button, Modal } from '@/components/common'
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

type ConnectedSection = 'numbers' | 'templates' | 'alerts'
type PhoneFilter = 'all' | 'main' | 'qr' | 'attention'
type AlertFilter = 'all' | 'critical' | 'warning' | 'info'

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

function getQrStatusLabel(status?: string | null) {
  const normalized = String(status || '').toLowerCase()
  if (!normalized) return 'QR opcional'
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
  const [phoneFilter, setPhoneFilter] = useState<PhoneFilter>('all')
  const [alertFilter, setAlertFilter] = useState<AlertFilter>('all')
  const [phoneSearch, setPhoneSearch] = useState('')
  const [alertSearch, setAlertSearch] = useState('')
  const [apiStatus, setApiStatus] = useState<WhatsAppApiStatus | null>(null)
  const [apiLoading, setApiLoading] = useState(true)
  const [apiConnecting, setApiConnecting] = useState(false)
  const [apiRefreshing, setApiRefreshing] = useState(false)
  const [apiDisconnecting, setApiDisconnecting] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [selectedPhoneId, setSelectedPhoneId] = useState('')
  const [qrConnectingPhoneId, setQrConnectingPhoneId] = useState('')
  const [qrDisconnectingPhoneId, setQrDisconnectingPhoneId] = useState('')
  const [qrConsentPhone, setQrConsentPhone] = useState<WhatsAppApiPhoneNumber | null>(null)
  const [defaultingPhoneId, setDefaultingPhoneId] = useState('')

  const apiConnected = Boolean(apiStatus?.connected)

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
      selectSection('numbers')

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

  const openQrConsentForPhone = (phone: WhatsAppApiPhoneNumber) => {
    setQrConsentPhone(phone)
  }

  const confirmQrConnection = async (phone: WhatsAppApiPhoneNumber) => {
    setQrConsentPhone(null)
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

  const renderConnectStage = () => {
    if (apiLoading) {
      return <div className={`${styles.skeletonBlock} ${styles.skeletonStage}`} />
    }

    return (
      <section className={styles.connectPanel}>
        <div className={styles.connectCopy}>
          <p className={styles.eyebrow}>Conexión</p>
          <h3>Conecta WhatsApp Business</h3>
          <span>Usa WhatsApp API para enviar mensajes oficiales, revisar saldo y mandar plantillas a Meta.</span>
        </div>
        {apiStatus?.lastError && <p className={styles.errorText}>{apiStatus.lastError}</p>}
        <div className={styles.connectContent}>
          {renderApiForm()}
          {renderYCloudGuide()}
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
      const displayName = phone.verified_name || phoneProfile?.verifiedName || phoneProfile?.businessName || phoneProfile?.name || 'Sin nombre'
      const needsAttention = Boolean(qrError) || ['RED', 'FLAGGED', 'RESTRICTED'].includes(String(phone.quality_rating || '').toUpperCase())

      return { phone, displayName, isSender, qrSession, qrStatus, qrError, qrPending, qrConnected, needsAttention }
    })
    const query = phoneSearch.trim().toLowerCase()
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

    return (
      <div className={styles.layout}>
        <aside className={styles.sideNav} aria-label="Filtros de numeros de WhatsApp">
          <div className={styles.sideHeader}>
            <strong>Numeros</strong>
            <span>{formatMetric(phoneRows.length)} activos</span>
          </div>
          <button type="button" className={`${styles.sideItem} ${phoneFilter === 'all' ? styles.sideItemActive : ''}`} onClick={() => setPhoneFilter('all')}>
            <Hash size={16} />
            <span>Todos los numeros</span>
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
            <b>{enrichedPhones.filter((row) => row.qrConnected).length}</b>
          </button>
          <button type="button" className={`${styles.sideItem} ${phoneFilter === 'attention' ? styles.sideItemActive : ''}`} onClick={() => setPhoneFilter('attention')}>
            <AlertTriangle size={16} />
            <span>Revisar</span>
            <b>{enrichedPhones.filter((row) => row.needsAttention).length}</b>
          </button>
        </aside>

        <main className={styles.tablePanel}>
          <div className={styles.toolbar}>
            <label className={styles.search}>
              <Search size={16} />
              <input value={phoneSearch} placeholder="Buscar por numero, nombre o estado" onChange={(event) => setPhoneSearch(event.target.value)} />
            </label>
            <div className={styles.toolbarActions}>
              <span>{filteredPhones.length} numeros</span>
              <span className={styles.balancePill}><Wallet size={15} />{balance ? formatCurrency(balance.amount, balance.currency) : 'Saldo pendiente'}</span>
              <Button variant="outline" onClick={refreshApi} loading={apiRefreshing}>
                <RefreshCw size={16} />
                Sincronizar
              </Button>
              <a className={styles.externalButton} href={YCLOUD_CONSOLE_URL} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={15} />
                Abrir API
              </a>
              <Button variant="danger" onClick={confirmApiDisconnect} loading={apiDisconnecting}>
                <Unplug size={16} />
                Desconectar
              </Button>
            </div>
          </div>

          {filteredPhones.length > 0 ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Numero</th>
                    <th>Nombre</th>
                    <th>API</th>
                    <th>QR opcional</th>
                    <th>Calidad</th>
                    <th>Limite</th>
                    <th aria-label="Acciones" />
                  </tr>
                </thead>
                <tbody>
                  {filteredPhones.map((row) => {
                    const { phone, qrSession, qrPending, qrConnected, qrError, qrStatus, displayName, isSender } = row

                    return (
                      <React.Fragment key={phone.id}>
                        <tr>
                          <td>
                            <strong>{phone.display_phone_number || phone.phone_number || 'Numero'}</strong>
                            <span>{phone.id}</span>
                          </td>
                          <td>{displayName}</td>
                          <td><span className={styles.statusPill}>{isSender ? 'Principal' : 'Oficial'}</span></td>
                          <td><span className={`${styles.statusPill} ${getQrStatusClass(qrStatus)}`}>{getQrStatusLabel(qrStatus)}</span></td>
                          <td>{phone.quality_rating || 'Sin dato'}</td>
                          <td>{phone.messaging_limit || 'Sin dato'}</td>
                          <td>
                            <div className={styles.rowActions}>
                              {!isSender && (
                                <button type="button" onClick={() => makePhoneDefault(phone)} disabled={defaultingPhoneId === phone.id} title="Hacer principal" aria-label={`Hacer principal ${getPhoneLabel(phone)}`}>
                                  <Star size={15} />
                                </button>
                              )}
                              {qrConnected ? (
                                <button type="button" onClick={() => disconnectQrForPhone(phone)} disabled={qrDisconnectingPhoneId === phone.id} title="Apagar QR" aria-label={`Apagar QR ${getPhoneLabel(phone)}`}>
                                  <Unplug size={15} />
                                </button>
                              ) : (
                                <button type="button" onClick={() => openQrConsentForPhone(phone)} disabled={qrConnectingPhoneId === phone.id} title={qrPending ? 'Nuevo QR' : 'Conectar QR'} aria-label={`Conectar QR ${getPhoneLabel(phone)}`}>
                                  <QrCode size={15} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {(qrSession?.qrCodeDataUrl && qrPending) || qrError ? (
                          <tr className={styles.detailRow}>
                            <td colSpan={7}>
                              {qrSession?.qrCodeDataUrl && qrPending && (
                                <div className={styles.qrPreview}>
                                  <img src={qrSession.qrCodeDataUrl} alt={`QR para ${phone.display_phone_number || phone.phone_number || 'WhatsApp'}`} />
                                  <span>Escanea este codigo desde WhatsApp en el mismo numero.</span>
                                </div>
                              )}
                              {qrError && <p className={styles.errorText}>{qrError}</p>}
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
              <Hash size={26} />
              <strong>No hay numeros en esta vista</strong>
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
            <Hash size={16} />
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
            <label className={styles.search}>
              <Search size={16} />
              <input value={alertSearch} placeholder="Buscar por alerta o detalle" onChange={(event) => setAlertSearch(event.target.value)} />
            </label>
            <span>{filteredAlerts.length} alertas</span>
          </div>

          {filteredAlerts.length > 0 ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
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
            Ir a numeros
          </Button>
        </section>
      )
    }

    return <MessageTemplates embedded />
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
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Sistema</p>
          <h2 className={styles.title}>WhatsApp</h2>
          <span>Conexion oficial por API para numeros, alertas y plantillas.</span>
        </div>
        {apiConnected ? (
          <div className={styles.headerActions} role="group" aria-label="Secciones de WhatsApp">
            <button
              type="button"
              className={`${styles.headerActionButton} ${activeSection === 'numbers' ? styles.headerActionActive : ''}`}
              onClick={() => selectSection('numbers')}
            >
              <SiWhatsapp size={15} />
              Numeros
            </button>
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
          </div>
        ) : (
          <a className={styles.headerActionButton} href={YCLOUD_REGISTER_URL} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={15} />
            Abrir WhatsApp API
          </a>
        )}
      </header>

      <div className={styles.stage}>
        {!apiConnected ? renderConnectStage() : activeSection === 'templates' ? renderTemplatesStage() : activeSection === 'alerts' ? renderAlertsStage() : renderNumbersStage()}
      </div>

      <Modal
        isOpen={Boolean(qrConsentPhone)}
        onClose={() => setQrConsentPhone(null)}
        title="Conectar QR de WhatsApp"
        type="confirm"
        size="md"
        confirmText="Acepto el riesgo y conectar"
        cancelText="No conectar"
        onConfirm={() => {
          if (qrConsentPhone) {
            confirmQrConnection(qrConsentPhone)
          }
        }}
      >
        <div className={styles.qrConsentBody}>
          <p>
            Este paso no es obligatorio. WhatsApp API sigue siendo la conexion principal; el QR solo funciona como respaldo para {qrConsentPhone ? getPhoneLabel(qrConsentPhone) : 'este numero'}.
          </p>
          <ul className={styles.qrConsentList}>
            <li>Usa WhatsApp Web por QR, no la API oficial de Meta.</li>
            <li>WhatsApp puede cerrar la sesion, bloquear el numero o restringir la cuenta.</li>
            <li>Si WhatsApp bloquea el numero, puede que no se pueda recuperar.</li>
            <li>Ristak lo usa para detalles extra, mensajes fuera de 24 horas o si la API queda restringida.</li>
          </ul>
          <p className={styles.qrConsentNote}>
            Escanea el QR solamente con ese mismo numero. Si conectas otro, Ristak lo rechazara.
          </p>
        </div>
      </Modal>
    </div>
  )
}
