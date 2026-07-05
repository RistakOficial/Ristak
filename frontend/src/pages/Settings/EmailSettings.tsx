import React, { useEffect, useState } from 'react'
import {
  AtSign,
  CheckCircle2,
  ChevronDown,
  Inbox,
  KeyRound,
  Mail,
  Pencil,
  RefreshCw,
  Save,
  Send,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Type,
  Unplug,
  User
} from 'lucide-react'
import { Badge, Button, CustomSelect, EmailRichTextEditor, PageHeader, Switch, sanitizeEmailRichHtmlForEditor } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import {
  EmailProviderDetection,
  EmailSignatureConfig,
  EmailSmtpSecurity,
  EmailStatus,
  emailService
} from '@/services/emailService'
import { formatDateTime as formatBusinessDateTime } from '@/utils/format'
import styles from './EmailSettings.module.css'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const SECURITY_OPTIONS = [
  { value: 'starttls', label: 'STARTTLS' },
  { value: 'ssl', label: 'SSL/TLS' },
  { value: 'none', label: 'Sin cifrado' }
]

const EMPTY_SIGNATURE_HTML = ''

function formatDateTime(value?: string | null) {
  return formatBusinessDateTime(value, {
    fallback: 'Sin registro',
    intlOptions: { dateStyle: 'medium', timeStyle: 'short' }
  })
}

function getSecurityLabel(value?: string | null) {
  if (value === 'ssl') return 'SSL/TLS'
  if (value === 'none') return 'Sin cifrado'
  return 'STARTTLS'
}

export const EmailSettings: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [status, setStatus] = useState<EmailStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testingInbound, setTestingInbound] = useState(false)
  const [syncingInbound, setSyncingInbound] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [advancedDirty, setAdvancedDirty] = useState(false)
  const [inboundDirty, setInboundDirty] = useState(false)
  const [manualInboundOpen, setManualInboundOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)

  const [fromEmail, setFromEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fromName, setFromName] = useState('')
  const [replyTo, setReplyTo] = useState('')
  const [testTo, setTestTo] = useState('')

  const [host, setHost] = useState('')
  const [port, setPort] = useState('587')
  const [security, setSecurity] = useState<EmailSmtpSecurity>('starttls')
  const [username, setUsername] = useState('')

  const [inboundEnabled, setInboundEnabled] = useState(true)
  const [inboundHost, setInboundHost] = useState('')
  const [inboundPort, setInboundPort] = useState('993')
  const [inboundSecurity, setInboundSecurity] = useState<EmailSmtpSecurity>('ssl')
  const [inboundUsername, setInboundUsername] = useState('')
  const [inboundMailbox, setInboundMailbox] = useState('INBOX')

  const [detection, setDetection] = useState<EmailProviderDetection | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [detectionError, setDetectionError] = useState('')

  const [signature, setSignature] = useState<EmailSignatureConfig | null>(null)
  const [signatureEnabled, setSignatureEnabled] = useState(false)
  const [includeBeforeQuotedText, setIncludeBeforeQuotedText] = useState(true)
  const [savingSignature, setSavingSignature] = useState(false)
  const [signatureHtml, setSignatureHtml] = useState(EMPTY_SIGNATURE_HTML)

  const connected = Boolean(status?.connected)
  const fromEmailValue = fromEmail.trim().toLowerCase()
  const replyToValue = replyTo.trim().toLowerCase()
  const hasStoredCredentials = Boolean(status?.smtp.hasPassword)
  const canReuseStoredPassword = Boolean(
    connected &&
    hasStoredCredentials &&
    status?.sender.fromEmail?.toLowerCase() === fromEmailValue
  )
  const usesAdvancedSmtp = advancedDirty
  const usesManualInbound = inboundDirty
  const validPort = Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) <= 65535
  const validInboundPort = Number.isInteger(Number(inboundPort)) && Number(inboundPort) > 0 && Number(inboundPort) <= 65535
  const advancedValid = !usesAdvancedSmtp || Boolean(host.trim() && validPort && (username.trim() || fromEmailValue))
  const inboundValid = !inboundEnabled || !usesManualInbound || Boolean(inboundHost.trim() && validInboundPort && (inboundUsername.trim() || fromEmailValue) && inboundMailbox.trim())
  const canSubmit = Boolean(
    EMAIL_PATTERN.test(fromEmailValue) &&
    fromName.trim() &&
    (password.trim() || canReuseStoredPassword) &&
    (!replyToValue || EMAIL_PATTERN.test(replyToValue)) &&
    advancedValid &&
    inboundValid
  )

  const applyStatusToForm = (nextStatus: EmailStatus) => {
    setFromName(nextStatus.sender.fromName)
    setFromEmail(nextStatus.sender.fromEmail)
    setReplyTo(nextStatus.sender.replyTo)
    setHost(nextStatus.smtp.host)
    setPort(String(nextStatus.smtp.port || 587))
    setSecurity(nextStatus.smtp.security || 'starttls')
    setUsername('')
    setInboundEnabled(nextStatus.connected ? nextStatus.inbound?.enabled !== false : true)
    setInboundHost(nextStatus.inbound?.host || '')
    setInboundPort(String(nextStatus.inbound?.port || 993))
    setInboundSecurity(nextStatus.inbound?.security || 'ssl')
    setInboundUsername('')
    setInboundMailbox(nextStatus.inbound?.mailbox || 'INBOX')
    setPassword('')
    setTestTo(nextStatus.sender.fromEmail || '')
    setDetection(null)
    setDetectionError('')
    setAdvancedDirty(false)
    setInboundDirty(false)
    setAdvancedOpen(false)
    setManualInboundOpen(false)
    setDetailsOpen(false)
  }

  const applyDetectionToAdvanced = (nextDetection: EmailProviderDetection) => {
    setHost(nextDetection.smtp.host)
    setPort(String(nextDetection.smtp.port || 587))
    setSecurity(nextDetection.smtp.security || 'starttls')
    setUsername(nextDetection.smtp.username || nextDetection.email)
    applyDetectionToInbound(nextDetection)
  }

  const applyDetectionToInbound = (nextDetection: EmailProviderDetection) => {
    if (!inboundDirty) {
      setInboundHost(nextDetection.imap.host)
      setInboundPort(String(nextDetection.imap.port || 993))
      setInboundSecurity(nextDetection.imap.security || 'ssl')
      setInboundUsername(nextDetection.imap.username || nextDetection.email)
      setInboundMailbox(nextDetection.imap.mailbox || 'INBOX')
    }
  }

  const setSignatureEditorHtml = (html: string) => {
    setSignatureHtml(sanitizeEmailRichHtmlForEditor(html))
  }

  const applySignatureToForm = (nextSignature: EmailSignatureConfig) => {
    setSignature(nextSignature)
    setSignatureEnabled(Boolean(nextSignature.enabled))
    setIncludeBeforeQuotedText(nextSignature.includeBeforeQuotedText !== false)
    setSignatureEditorHtml(nextSignature.html || EMPTY_SIGNATURE_HTML)
  }

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      try {
        const [nextStatus, nextSignature] = await Promise.all([
          emailService.getStatus(),
          emailService.getSignature()
        ])
        if (cancelled) return
        setStatus(nextStatus)
        applyStatusToForm(nextStatus)
        applySignatureToForm(nextSignature)
      } catch (error) {
        if (!cancelled) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo leer la configuración de correo')
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
    if (connected && !editing) return

    const email = fromEmail.trim().toLowerCase()
    setDetection(null)
    setDetectionError('')

    if (!EMAIL_PATTERN.test(email)) {
      setDetecting(false)
      return
    }

    let cancelled = false
    const timer = window.setTimeout(async () => {
      setDetecting(true)
      try {
        const nextDetection = await emailService.detect(email)
        if (cancelled) return
        setDetection(nextDetection)
        setDetectionError('')
        if (!advancedDirty) {
          applyDetectionToAdvanced(nextDetection)
        } else if (!inboundDirty) {
          applyDetectionToInbound(nextDetection)
        }
      } catch (error) {
        if (!cancelled) {
          setDetectionError(error instanceof Error ? error.message : 'No se pudo detectar el proveedor')
        }
      } finally {
        if (!cancelled) setDetecting(false)
      }
    }, 450)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [fromEmail, connected, editing, advancedDirty, inboundDirty])

  const markAdvancedDirty = () => {
    setAdvancedDirty(true)
  }

  const markInboundDirty = () => {
    setInboundDirty(true)
  }

  const connectEmail = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!canSubmit || connecting) return

    setConnecting(true)
    try {
      const smtp = usesAdvancedSmtp
        ? {
            host: host.trim(),
            port: Number(port),
            security,
            username: username.trim() || fromEmailValue
          }
        : undefined
      const inbound = !inboundEnabled
        ? { enabled: false }
        : usesManualInbound
          ? {
            enabled: true,
            host: inboundHost.trim(),
            port: Number(inboundPort),
            security: inboundSecurity,
            username: inboundUsername.trim() || fromEmailValue,
            mailbox: inboundMailbox.trim() || 'INBOX'
          }
          : { enabled: true }

      const nextStatus = await emailService.connect({
        fromEmail: fromEmailValue,
        password: password.trim() || undefined,
        fromName: fromName.trim(),
        replyTo: replyToValue,
        testTo: fromEmailValue,
        smtp,
        inbound
      })
      setStatus(nextStatus)
      applyStatusToForm(nextStatus)
      setEditing(false)
      showToast('success', 'Correo conectado', `Se guardó cifrado y enviamos una prueba a ${fromEmailValue}`)
    } catch (error) {
      showToast('error', 'No se pudo conectar', error instanceof Error ? error.message : 'Revisa el correo y el app password e intenta de nuevo')
    } finally {
      setConnecting(false)
    }
  }

  const testInbound = async () => {
    if (testingInbound) return
    setTestingInbound(true)
    try {
      const result = await emailService.testInbound()
      const nextStatus = await emailService.getStatus()
      setStatus(nextStatus)
      showToast('success', 'Recepción conectada', `Ristak abrió ${result.mailbox || 'INBOX'} correctamente`)
    } catch (error) {
      showToast('error', 'No se pudo probar recepción', error instanceof Error ? error.message : 'Revisa los ajustes de recepción')
    } finally {
      setTestingInbound(false)
    }
  }

  const syncInbound = async () => {
    if (syncingInbound) return
    setSyncingInbound(true)
    try {
      const result = await emailService.syncInbound()
      const nextStatus = await emailService.getStatus()
      setStatus(nextStatus)
      if (result.skipped) {
        showToast('info', 'Sincronización omitida', result.reason === 'already_running' ? 'Ya hay una sincronización en curso' : 'La recepción no está configurada')
      } else {
        showToast('success', 'Correos sincronizados', `Importados: ${result.imported || 0}`)
      }
    } catch (error) {
      showToast('error', 'No se pudo sincronizar', error instanceof Error ? error.message : 'Intenta nuevamente')
    } finally {
      setSyncingInbound(false)
    }
  }

  const sendTest = async (event?: React.FormEvent) => {
    event?.preventDefault()
    const recipient = testTo.trim()
    if (!EMAIL_PATTERN.test(recipient)) {
      showToast('warning', 'Correo inválido', 'Escribe un correo válido para enviar la prueba')
      return
    }

    setTesting(true)
    try {
      await emailService.sendTest(recipient)
      const nextStatus = await emailService.getStatus()
      setStatus(nextStatus)
      showToast('success', 'Prueba enviada', `Revisa la bandeja de ${recipient} (puede tardar unos segundos)`)
    } catch (error) {
      showToast('error', 'No se pudo enviar', error instanceof Error ? error.message : 'Intenta nuevamente')
    } finally {
      setTesting(false)
    }
  }

  const confirmDisconnect = () => {
    showConfirm(
      'Desconectar correo',
      'Se eliminarán las credenciales locales. Para reconectar tendrás que pegar el app password otra vez.',
      async () => {
        setDisconnecting(true)
        try {
          const nextStatus = await emailService.disconnect()
          setStatus(nextStatus)
          setEditing(false)
          applyStatusToForm(nextStatus)
          showToast('success', 'Desconectado', 'El correo quedó sin credenciales locales')
        } catch (error) {
          showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo desconectar el correo')
        } finally {
          setDisconnecting(false)
        }
      },
      'Desconectar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'DESCONECTAR' }
    )
  }

  const saveSignature = async () => {
    const html = signatureHtml
    setSavingSignature(true)
    try {
      const nextSignature = await emailService.saveSignature({
        enabled: signatureEnabled,
        html,
        includeBeforeQuotedText
      })
      applySignatureToForm(nextSignature)
      showToast('success', 'Firma guardada', signatureEnabled ? 'Se agregará a todos los correos salientes' : 'La firma quedó guardada pero desactivada')
    } catch (error) {
      showToast('error', 'No se pudo guardar', error instanceof Error ? error.message : 'Intenta nuevamente')
    } finally {
      setSavingSignature(false)
    }
  }

  const renderDetectionStatus = () => {
    if (detecting) {
      return (
        <div className={styles.detectStatus}>
          <span className={styles.detectIcon} aria-hidden="true" />
          <div>
            <strong>Detectando proveedor</strong>
            <p>Revisando dominio y registros MX.</p>
          </div>
        </div>
      )
    }

    if (detection) {
      return (
        <div className={styles.detectStatus} data-state="success">
          <CheckCircle2 size={18} />
          <div>
            <strong>{detection.provider.label}</strong>
            <p>{detection.mx.found ? 'Dominio revisado y configuración lista.' : 'Dominio revisado; si no conecta, usa ajustes manuales.'}</p>
          </div>
          <Badge variant={detection.provider.confidence === 'high' ? 'success' : 'warning'} className={styles.inlineBadge}>
            {detection.provider.detectedBy === 'mx' ? 'MX' : 'Dominio'}
          </Badge>
        </div>
      )
    }

    if (detectionError) {
      return <p className={styles.errorText}>{detectionError}</p>
    }

    return null
  }

  const renderAdvancedFields = () => (
    <div className={styles.advancedFields}>
      <div className={styles.formRow}>
        <label className={styles.fieldLabel}>
          <span>Servidor de envío</span>
          <div className={styles.inputWrap} data-ristak-unstyled>
            <Server size={17} />
            <input
              value={host}
              onChange={(event) => {
                markAdvancedDirty()
                setHost(event.target.value)
              }}
              placeholder="smtp.tudominio.com"
              autoComplete="off"
            />
          </div>
        </label>
        <label className={styles.fieldLabel}>
          <span>Puerto</span>
          <div className={styles.inputWrap} data-ristak-unstyled>
            <input
              value={port}
              onChange={(event) => {
                markAdvancedDirty()
                setPort(event.target.value.replace(/[^0-9]/g, ''))
              }}
              placeholder="587"
              inputMode="numeric"
              autoComplete="off"
            />
          </div>
        </label>
      </div>

      <div className={styles.formRow}>
        <label className={styles.fieldLabel}>
          <span>Seguridad</span>
          <CustomSelect
            value={security}
            options={SECURITY_OPTIONS}
            onValueChange={(value) => {
              markAdvancedDirty()
              setSecurity(value as EmailSmtpSecurity)
            }}
          />
        </label>
        <label className={styles.fieldLabel}>
          <span>Usuario de envío</span>
          <div className={styles.inputWrap} data-ristak-unstyled>
            <User size={17} />
            <input
              value={username}
              onChange={(event) => {
                markAdvancedDirty()
                setUsername(event.target.value)
              }}
              placeholder={status?.smtp.usernameMasked || fromEmailValue || 'usuario@dominio.com'}
              autoComplete="off"
            />
          </div>
        </label>
      </div>
    </div>
  )

  const renderInboundFields = () => (
    <div className={styles.inboundBlock}>
      <div className={styles.inboundHeader}>
        <div className={styles.inboundTitle}>
          <span className={styles.inboundIcon}><Inbox size={17} /></span>
          <div>
            <strong>Recepción de correos</strong>
            <span>Activa por defecto. Ristak revisa la bandeja principal y guarda las respuestas en el chat del contacto.</span>
          </div>
        </div>
        <label className={styles.switchRow}>
          <Switch
            checked={inboundEnabled}
            onChange={(checked) => {
              setInboundEnabled(checked)
            }}
            aria-label="Activar recepción de correos"
          />
          <span>{inboundEnabled ? 'Activa' : 'Desactivada'}</span>
        </label>
      </div>

      {inboundEnabled && (
        <div className={styles.inboundBody}>
          <div className={styles.autoConfigSummary}>
            <div className={styles.autoConfigItem}>
              <span>Servidor detectado</span>
              <strong>{inboundHost || detection?.imap.host || 'Se detecta al conectar'}</strong>
            </div>
            <div className={styles.autoConfigItem}>
              <span>Bandeja</span>
              <strong>{inboundMailbox || 'INBOX'}</strong>
            </div>
            <div className={styles.autoConfigItem}>
              <span>Seguridad</span>
              <strong>{getSecurityLabel(inboundSecurity || detection?.imap.security)}</strong>
            </div>
          </div>

          <p className={styles.helperText}>
            Para Gmail, Workspace, Outlook, Yahoo, iCloud, Zoho, Titan y proveedores comunes no tienes que llenar servidor, puerto ni seguridad. Ristak lo detecta y lo prueba al conectar.
          </p>

          <div className={styles.advancedBlock}>
            <Button
              type="button"
              variant="ghost"
              className={styles.advancedToggle}
              onClick={() => setManualInboundOpen(value => !value)}
            >
              <SlidersHorizontal size={16} />
              Ajustes manuales de recepción
              <ChevronDown size={16} className={manualInboundOpen ? styles.chevronOpen : ''} />
            </Button>
            {manualInboundOpen && (
              <div className={styles.advancedFields}>
                <p className={styles.helperText}>
                  Úsalo sólo si tu proveedor te dio datos IMAP personalizados. IMAP es la conexión que permite leer respuestas; normalmente usa puerto 993 con SSL/TLS.
                </p>
                <div className={styles.formRow}>
                  <label className={styles.fieldLabel}>
                    <span>Servidor de recepción</span>
                    <div className={styles.inputWrap} data-ristak-unstyled>
                      <Server size={17} />
                      <input
                        value={inboundHost}
                        onChange={(event) => {
                          markInboundDirty()
                          setInboundHost(event.target.value)
                        }}
                        placeholder="imap.tudominio.com"
                        autoComplete="off"
                      />
                    </div>
                  </label>
                  <label className={styles.fieldLabel}>
                    <span>Puerto de recepción</span>
                    <div className={styles.inputWrap} data-ristak-unstyled>
                      <input
                        value={inboundPort}
                        onChange={(event) => {
                          markInboundDirty()
                          setInboundPort(event.target.value.replace(/[^0-9]/g, ''))
                        }}
                        placeholder="993"
                        inputMode="numeric"
                        autoComplete="off"
                      />
                    </div>
                  </label>
                </div>

                <div className={styles.formRow}>
                  <label className={styles.fieldLabel}>
                    <span>Seguridad de recepción</span>
                    <CustomSelect
                      value={inboundSecurity}
                      options={SECURITY_OPTIONS}
                      onValueChange={(value) => {
                        markInboundDirty()
                        setInboundSecurity(value as EmailSmtpSecurity)
                      }}
                    />
                  </label>
                  <label className={styles.fieldLabel}>
                    <span>Usuario de recepción</span>
                    <div className={styles.inputWrap} data-ristak-unstyled>
                      <User size={17} />
                      <input
                        value={inboundUsername}
                        onChange={(event) => {
                          markInboundDirty()
                          setInboundUsername(event.target.value)
                        }}
                        placeholder={status?.inbound?.usernameMasked || fromEmailValue || 'usuario@dominio.com'}
                        autoComplete="off"
                      />
                    </div>
                  </label>
                </div>

                <label className={styles.fieldLabel}>
                  <span>Bandeja</span>
                  <div className={styles.inputWrap} data-ristak-unstyled>
                    <Inbox size={17} />
                    <input
                      value={inboundMailbox}
                      onChange={(event) => {
                        markInboundDirty()
                        setInboundMailbox(event.target.value)
                      }}
                      placeholder="INBOX"
                      autoComplete="off"
                    />
                  </div>
                </label>
              </div>
            )}
          </div>
        </div>
      )}

      {status?.inbound?.lastError && inboundEnabled && <p className={styles.errorText}>{status.inbound.lastError}</p>}
    </div>
  )

  const renderForm = () => (
    <form className={styles.connectForm} onSubmit={connectEmail}>
      <div className={styles.formRow}>
        <label className={styles.fieldLabel}>
          <span>Correo de envío</span>
          <div className={styles.inputWrap} data-ristak-unstyled>
            <AtSign size={17} />
            <input
              type="email"
              value={fromEmail}
              onChange={(event) => setFromEmail(event.target.value)}
              placeholder="hola@tudominio.com"
              autoComplete="email"
            />
          </div>
        </label>
        <label className={styles.fieldLabel}>
          <span>Contraseña o app password</span>
          <div className={styles.inputWrap} data-ristak-unstyled>
            <KeyRound size={17} />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={canReuseStoredPassword ? 'Password guardado' : 'Pega tu app password'}
              autoComplete="new-password"
            />
          </div>
        </label>
      </div>

      <div className={styles.formRow}>
        <label className={styles.fieldLabel}>
          <span>Nombre del remitente</span>
          <div className={styles.inputWrap} data-ristak-unstyled>
            <User size={17} />
            <input
              value={fromName}
              onChange={(event) => setFromName(event.target.value)}
              placeholder="Mi Negocio"
              autoComplete="organization"
            />
          </div>
        </label>
        <label className={styles.fieldLabel}>
          <span>Correo para respuestas (opcional)</span>
          <div className={styles.inputWrap} data-ristak-unstyled>
            <Mail size={17} />
            <input
              type="email"
              value={replyTo}
              onChange={(event) => setReplyTo(event.target.value)}
              placeholder="respuestas@tudominio.com"
              autoComplete="email"
            />
          </div>
        </label>
      </div>

      {renderDetectionStatus()}

      <div className={styles.advancedBlock}>
        <Button
          type="button"
          variant="ghost"
          className={styles.advancedToggle}
          onClick={() => setAdvancedOpen(value => !value)}
        >
          <SlidersHorizontal size={16} />
          Ajustes manuales de envío
          <ChevronDown size={16} className={advancedOpen ? styles.chevronOpen : ''} />
        </Button>
        {advancedOpen && renderAdvancedFields()}
      </div>

      {renderInboundFields()}

      <div className={styles.formActions}>
        <Button type="submit" loading={connecting} disabled={!canSubmit}>
          <Mail size={18} />
          {connected ? 'Actualizar conexión' : 'Conectar correo'}
        </Button>
        {editing && (
          <Button variant="secondary" type="button" onClick={() => {
            if (status) applyStatusToForm(status)
            setEditing(false)
          }}>
            Cancelar
          </Button>
        )}
      </div>
    </form>
  )

  const renderGuide = () => (
    <div className={styles.tutorial}>
      <p className={styles.eyebrow}>Conectar mi correo</p>
      <ol className={styles.tutorialSteps}>
        <li>
          <span>1</span>
          <div>
            <strong>Escribe tu correo</strong>
            <p>Ristak detecta el proveedor con el dominio y los MX.</p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>Pega el app password</strong>
            <p>La contraseña se usa para probar la conexión y se guarda cifrada.</p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>Prueba envío y recepción</strong>
            <p>Ristak valida el envío, deja activa la recepción y empieza a revisar la bandeja principal.</p>
          </div>
        </li>
      </ol>
    </div>
  )

  const renderConnectStage = () => (
    <section className={styles.connectPanel}>
      <div className={styles.connectCopy}>
        <p className={styles.eyebrow}>Correo</p>
        <h3>Conecta envío y recepción</h3>
        <span>Ristak detecta el proveedor, prepara el envío y deja listas las respuestas sin que tengas que configurar puertos.</span>
      </div>
      {status?.lastError && <p className={styles.errorText}>{status.lastError}</p>}
      <div className={styles.connectContent}>
        {renderGuide()}
        {renderForm()}
      </div>
    </section>
  )

  const renderConnectedStage = () => {
    if (!status) return null
    const inboundState = status.inbound?.connected
      ? { label: 'Recepción activa', variant: 'success' as const }
      : status.inbound?.enabled
        ? { label: 'Recepción con error', variant: 'warning' as const }
        : { label: 'Solo envío', variant: 'neutral' as const }

    if (editing) {
      return (
        <section className={styles.connectPanel}>
          <div className={styles.connectCopy}>
            <p className={styles.eyebrow}>Conexión activa</p>
            <h3>Actualizar correo de envío</h3>
            <span>Cambia el remitente o pega un app password nuevo. Ristak volverá a probar todo antes de guardar.</span>
          </div>
          <div className={styles.connectContent}>
            {renderGuide()}
            {renderForm()}
          </div>
        </section>
      )
    }

    return (
      <div className={styles.connectedLayout}>
        <section className={styles.summaryCard}>
          <div className={styles.summaryHeader}>
            <div className={styles.summaryIdentity}>
              <span className={styles.summaryAvatar}><Mail size={22} /></span>
              <div className={styles.summaryText}>
                <strong>{status.sender.fromName || status.sender.fromEmail}</strong>
                <span>{status.sender.fromEmail}</span>
              </div>
            </div>
            <div className={styles.summaryBadges}>
              <Badge variant="success" className={styles.inlineBadge}>
                <ShieldCheck size={14} />
                Envío conectado
              </Badge>
              <Badge variant={inboundState.variant} className={styles.inlineBadge}>
                <Inbox size={14} />
                {inboundState.label}
              </Badge>
            </div>
          </div>

          <dl className={styles.summaryList}>
            <div>
              <dt>Proveedor</dt>
              <dd>{status.providerLabel || 'Correo del dominio'}</dd>
            </div>
            <div>
              <dt>Respuestas a</dt>
              <dd>{status.sender.replyTo || status.sender.fromEmail}</dd>
            </div>
            <div>
              <dt>Recepción</dt>
              <dd>{status.inbound?.enabled ? `Activa en ${status.inbound.mailbox || 'INBOX'}` : 'Desactivada'}</dd>
            </div>
            <div>
              <dt>Última verificación</dt>
              <dd>{formatDateTime(status.timestamps.lastVerifiedAt)}</dd>
            </div>
            <div>
              <dt>Última revisión de entrada</dt>
              <dd>{formatDateTime(status.inbound?.lastSyncAt)}</dd>
            </div>
            <div>
              <dt>Última prueba</dt>
              <dd>{formatDateTime(status.timestamps.lastTestAt)}</dd>
            </div>
          </dl>

          <div className={styles.detailsBlock}>
            <Button
              type="button"
              variant="ghost"
              className={styles.advancedToggle}
              onClick={() => setDetailsOpen(value => !value)}
            >
              <SlidersHorizontal size={16} />
              Datos técnicos de conexión
              <ChevronDown size={16} className={detailsOpen ? styles.chevronOpen : ''} />
            </Button>
            {detailsOpen && (
              <dl className={styles.advancedSummary}>
                <div>
                  <dt>Servidor</dt>
                  <dd>{status.smtp.host}:{status.smtp.port}</dd>
                </div>
                <div>
                  <dt>Seguridad</dt>
                  <dd>{getSecurityLabel(status.smtp.security)}</dd>
                </div>
                <div>
                  <dt>Usuario</dt>
                  <dd>{status.smtp.usernameMasked || 'Sin usuario'}</dd>
                </div>
                {status.inbound?.enabled && (
                  <>
                    <div>
                      <dt>Servidor de recepción</dt>
                      <dd>{status.inbound.host}:{status.inbound.port}</dd>
                    </div>
                    <div>
                      <dt>Seguridad de recepción</dt>
                      <dd>{getSecurityLabel(status.inbound.security)}</dd>
                    </div>
                    <div>
                      <dt>Usuario de recepción</dt>
                      <dd>{status.inbound.usernameMasked || 'Sin usuario'}</dd>
                    </div>
                    <div>
                      <dt>Bandeja</dt>
                      <dd>{status.inbound.mailbox || 'INBOX'}</dd>
                    </div>
                  </>
                )}
              </dl>
            )}
          </div>

          <div className={styles.summaryActions}>
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil size={16} />
              Editar conexión
            </Button>
            <Button variant="danger" onClick={confirmDisconnect} loading={disconnecting}>
              <Unplug size={16} />
              Desconectar
            </Button>
          </div>
        </section>

        <section className={styles.testCard}>
          <div className={styles.testCopy}>
            <p className={styles.eyebrow}>Prueba</p>
            <h3>Probar correo</h3>
            <span>Confirma que el correo sale y que las respuestas pueden llegar al chat.</span>
          </div>
          <form className={styles.testForm} onSubmit={sendTest}>
            <div className={styles.inputWrap} data-ristak-unstyled>
              <AtSign size={17} />
              <input
                type="email"
                value={testTo}
                onChange={(event) => setTestTo(event.target.value)}
                placeholder="tucorreo@tudominio.com"
                autoComplete="email"
              />
            </div>
            <Button type="submit" loading={testing} disabled={!testTo.trim()}>
              <Send size={16} />
              Enviar prueba
            </Button>
          </form>
          <div className={styles.testDivider} />
          <div className={styles.inboundTestBlock}>
            <div>
              <strong>Recepción de correos</strong>
              <span>Último correo recibido: {formatDateTime(status.inbound?.lastMessageAt)}</span>
            </div>
            <div className={styles.testActions}>
              <Button
                type="button"
                variant="outline"
                onClick={testInbound}
                loading={testingInbound}
                disabled={!status.inbound?.enabled}
              >
                <Inbox size={16} />
                Probar recepción
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={syncInbound}
                loading={syncingInbound}
                disabled={!status.inbound?.enabled}
              >
                <RefreshCw size={16} />
                Buscar correos ahora
              </Button>
            </div>
          </div>
          {status.lastError && <p className={styles.errorText}>{status.lastError}</p>}
          {status.inbound?.lastError && <p className={styles.errorText}>{status.inbound.lastError}</p>}
        </section>
      </div>
    )
  }

  const renderSignatureSection = () => (
    <section className={styles.signaturePanel}>
      <div className={styles.signatureHeader}>
        <div className={styles.signatureTitle}>
          <span className={styles.signatureIcon}><Type size={18} /></span>
          <div>
            <p className={styles.eyebrow}>Firma</p>
            <h3>Firma para todos los correos de envío</h3>
            <span>Crea, edita y guarda la firma que se agregará automáticamente a los correos salientes.</span>
          </div>
        </div>
        <label className={styles.switchRow}>
          <Switch
            checked={signatureEnabled}
            onChange={setSignatureEnabled}
            aria-label="Habilitar firma en todos los correos salientes"
          />
          <span>Habilitar firma</span>
        </label>
      </div>

      <EmailRichTextEditor
        value={signatureHtml}
        onChange={setSignatureHtml}
        placeholder="Escribe o pega tu firma de correo..."
        codePlaceholder="<table><tr><td>Tu firma...</td></tr></table>"
        onWarning={(title, message) => showToast('warning', title, message)}
        onHtmlApplied={() => showToast('success', 'HTML aplicado', 'La firma quedó lista para revisar y guardar')}
      />

      <div className={styles.signatureFooter}>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={includeBeforeQuotedText}
            onChange={(event) => setIncludeBeforeQuotedText(event.target.checked)}
          />
          <span>Incluir esta firma antes del texto citado en las respuestas</span>
        </label>
        <div className={styles.signatureSaveGroup}>
          {signature?.updatedAt && <span className={styles.signatureSavedText}>Última actualización: {formatDateTime(signature.updatedAt)}</span>}
          <Button type="button" onClick={saveSignature} loading={savingSignature}>
            <Save size={16} />
            Guardar firma
          </Button>
        </div>
      </div>
    </section>
  )

  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.skeletonHeaderRow} role="status" aria-live="polite" aria-label="Cargando Correos">
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
        title="Correos"
        subtitle="Conecta el remitente que usará tu cuenta para enviar y recibir correos."
      />

      <div className={styles.stage}>
        {connected ? renderConnectedStage() : renderConnectStage()}
      </div>

      {renderSignatureSection()}
    </div>
  )
}
