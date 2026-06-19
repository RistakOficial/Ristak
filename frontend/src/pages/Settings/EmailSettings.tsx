import React, { useEffect, useState } from 'react'
import {
  AtSign,
  CheckCircle2,
  ChevronDown,
  KeyRound,
  Mail,
  Pencil,
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
import styles from './EmailSettings.module.css'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const SECURITY_OPTIONS = [
  { value: 'starttls', label: 'STARTTLS' },
  { value: 'ssl', label: 'SSL/TLS' },
  { value: 'none', label: 'Sin cifrado' }
]

const EMPTY_SIGNATURE_HTML = ''

function formatDateTime(value?: string | null) {
  if (!value) return 'Sin registro'
  try {
    return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return 'Sin registro'
  }
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
  const [disconnecting, setDisconnecting] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [advancedDirty, setAdvancedDirty] = useState(false)
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
  const usesAdvancedSmtp = advancedOpen || advancedDirty
  const validPort = Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) <= 65535
  const advancedValid = !usesAdvancedSmtp || Boolean(host.trim() && validPort && (username.trim() || fromEmailValue))
  const canSubmit = Boolean(
    EMAIL_PATTERN.test(fromEmailValue) &&
    fromName.trim() &&
    (password.trim() || canReuseStoredPassword) &&
    (!replyToValue || EMAIL_PATTERN.test(replyToValue)) &&
    advancedValid
  )

  const applyStatusToForm = (nextStatus: EmailStatus) => {
    setFromName(nextStatus.sender.fromName)
    setFromEmail(nextStatus.sender.fromEmail)
    setReplyTo(nextStatus.sender.replyTo)
    setHost(nextStatus.smtp.host)
    setPort(String(nextStatus.smtp.port || 587))
    setSecurity(nextStatus.smtp.security || 'starttls')
    setUsername('')
    setPassword('')
    setTestTo(nextStatus.sender.fromEmail || '')
    setDetection(null)
    setDetectionError('')
    setAdvancedDirty(false)
    setAdvancedOpen(false)
    setDetailsOpen(false)
  }

  const applyDetectionToAdvanced = (nextDetection: EmailProviderDetection) => {
    setHost(nextDetection.smtp.host)
    setPort(String(nextDetection.smtp.port || 587))
    setSecurity(nextDetection.smtp.security || 'starttls')
    setUsername(nextDetection.smtp.username || nextDetection.email)
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
  }, [fromEmail, connected, editing, advancedDirty])

  const markAdvancedDirty = () => {
    setAdvancedDirty(true)
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

      const nextStatus = await emailService.connect({
        fromEmail: fromEmailValue,
        password: password.trim() || undefined,
        fromName: fromName.trim(),
        replyTo: replyToValue,
        testTo: fromEmailValue,
        smtp
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
      'Cancelar'
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
            <p>{detection.mx.found ? 'Dominio revisado y configuración lista.' : 'Dominio revisado; si no conecta, usa Avanzado.'}</p>
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
          <span>Servidor SMTP</span>
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
          <span>Usuario SMTP</span>
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
          Configuración avanzada
          <ChevronDown size={16} className={advancedOpen ? styles.chevronOpen : ''} />
        </Button>
        {advancedOpen && renderAdvancedFields()}
      </div>

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
            <strong>Recibe la prueba</strong>
            <p>Al conectar, Ristak envía un correo de prueba automáticamente.</p>
          </div>
        </li>
      </ol>
    </div>
  )

  const renderConnectStage = () => (
    <section className={styles.connectPanel}>
      <div className={styles.connectCopy}>
        <p className={styles.eyebrow}>Correo de salida</p>
        <h3>Conecta tu correo sin tocar SMTP</h3>
        <span>Ristak detecta el proveedor y prepara la conexión por debajo.</span>
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
            <Badge variant="success" className={styles.inlineBadge}>
              <ShieldCheck size={14} />
              Conectado
            </Badge>
          </div>

          <dl className={styles.summaryList}>
            <div>
              <dt>Proveedor</dt>
              <dd>{status.providerLabel || 'SMTP del dominio'}</dd>
            </div>
            <div>
              <dt>Respuestas a</dt>
              <dd>{status.sender.replyTo || status.sender.fromEmail}</dd>
            </div>
            <div>
              <dt>Última verificación</dt>
              <dd>{formatDateTime(status.timestamps.lastVerifiedAt)}</dd>
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
              Detalles avanzados
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
            <h3>Enviar otra prueba</h3>
            <span>Usa esto cuando quieras confirmar la entrega a otro correo.</span>
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
          {status.lastError && <p className={styles.errorText}>{status.lastError}</p>}
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
        subtitle="Conecta el remitente que usará tu cuenta para enviar correos."
      />

      <div className={styles.stage}>
        {connected ? renderConnectedStage() : renderConnectStage()}
      </div>

      {renderSignatureSection()}
    </div>
  )
}
