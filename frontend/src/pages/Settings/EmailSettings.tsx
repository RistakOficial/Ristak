import React, { useEffect, useState } from 'react'
import {
  AtSign,
  KeyRound,
  Mail,
  Pencil,
  Send,
  Server,
  ShieldCheck,
  Unplug,
  User
} from 'lucide-react'
import { Button, PageHeader } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { EmailStatus, emailService } from '@/services/emailService'
import styles from './EmailSettings.module.css'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function formatDateTime(value?: string | null) {
  if (!value) return 'Sin registro'
  try {
    return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return 'Sin registro'
  }
}

export const EmailSettings: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [status, setStatus] = useState<EmailStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const [host, setHost] = useState('')
  const [port, setPort] = useState('587')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [fromName, setFromName] = useState('')
  const [fromEmail, setFromEmail] = useState('')
  const [replyTo, setReplyTo] = useState('')
  const [testTo, setTestTo] = useState('')

  const connected = Boolean(status?.connected)

  const applyStatusToForm = (nextStatus: EmailStatus) => {
    setHost(nextStatus.smtp.host)
    setPort(String(nextStatus.smtp.port || 587))
    setFromName(nextStatus.sender.fromName)
    setFromEmail(nextStatus.sender.fromEmail)
    setReplyTo(nextStatus.sender.replyTo)
    // Usuario y password se quedan vacíos mientras la conexión sigue activa.
    setUsername('')
    setPassword('')
  }

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      try {
        const nextStatus = await emailService.getStatus()
        if (cancelled) return
        setStatus(nextStatus)
        applyStatusToForm(nextStatus)
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

  const hasStoredCredentials = Boolean(status?.smtp.hasPassword)
  const canSubmit = Boolean(
    host.trim() &&
    port.trim() &&
    (username.trim() || status?.smtp.usernameMasked) &&
    (password.trim() || hasStoredCredentials) &&
    EMAIL_PATTERN.test(fromEmail.trim() || username.trim())
  )

  const connectEmail = async (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!canSubmit || connecting) return

    setConnecting(true)
    try {
      const nextStatus = await emailService.connect({
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        password: password.trim() || undefined,
        fromName: fromName.trim(),
        fromEmail: fromEmail.trim(),
        replyTo: replyTo.trim()
      })
      setStatus(nextStatus)
      applyStatusToForm(nextStatus)
      setEditing(false)
      showToast('success', 'Correo conectado', 'Ristak verificó la conexión SMTP y ya puede enviar correos')
    } catch (error) {
      showToast('error', 'No se pudo conectar', error instanceof Error ? error.message : 'Revisa los datos SMTP e intenta de nuevo')
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
      'Se eliminarán las credenciales SMTP locales. Para reconectar tendrás que pegar usuario y app password otra vez.',
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

  const renderForm = () => (
    <form className={styles.connectForm} onSubmit={connectEmail}>
      <div className={styles.formRow}>
        <label className={styles.fieldLabel}>
          <span>Servidor SMTP</span>
          <div className={styles.inputWrap} data-ristak-unstyled>
            <Server size={17} />
            <input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="smtp.gmail.com"
              autoComplete="off"
            />
          </div>
        </label>
        <label className={styles.fieldLabel}>
          <span>Puerto</span>
          <div className={styles.inputWrap} data-ristak-unstyled>
            <input
              value={port}
              onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ''))}
              placeholder="587"
              inputMode="numeric"
              autoComplete="off"
            />
          </div>
        </label>
      </div>

      <div className={styles.formRow}>
        <label className={styles.fieldLabel}>
          <span>Usuario SMTP</span>
          <div className={styles.inputWrap} data-ristak-unstyled>
            <User size={17} />
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={status?.smtp.usernameMasked || 'tucorreo@tudominio.com'}
              autoComplete="off"
            />
          </div>
        </label>
        <label className={styles.fieldLabel}>
          <span>Password o app password</span>
          <div className={styles.inputWrap} data-ristak-unstyled>
            <KeyRound size={17} />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={hasStoredCredentials ? 'Password guardado' : 'Pega tu app password'}
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
              autoComplete="off"
            />
          </div>
        </label>
        <label className={styles.fieldLabel}>
          <span>Correo del remitente</span>
          <div className={styles.inputWrap} data-ristak-unstyled>
            <AtSign size={17} />
            <input
              value={fromEmail}
              onChange={(event) => setFromEmail(event.target.value)}
              placeholder="hola@tudominio.com"
              autoComplete="off"
            />
          </div>
        </label>
      </div>

      <label className={styles.fieldLabel}>
        <span>Correo para respuestas (opcional)</span>
        <div className={styles.inputWrap} data-ristak-unstyled>
          <Mail size={17} />
          <input
            value={replyTo}
            onChange={(event) => setReplyTo(event.target.value)}
            placeholder="respuestas@tudominio.com"
            autoComplete="off"
          />
        </div>
      </label>

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
      <div className={styles.tutorialHeader}>
        <span>Guia rapida</span>
        <strong>Conecta el correo de tu cuenta</strong>
      </div>
      <ol className={styles.tutorialSteps}>
        <li>
          <span>1</span>
          <div>
            <strong>Consigue tus datos SMTP</strong>
            <p>En Gmail usa smtp.gmail.com con un app password. En Outlook, GoDaddy u otros, búscalos como "datos SMTP".</p>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>Pega los datos aquí</strong>
            <p>Ristak verifica la conexión con tu servidor antes de guardarla.</p>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>Envía un correo de prueba</strong>
            <p>Al conectar podrás mandarte una prueba para confirmar que todo llega bien.</p>
          </div>
        </li>
      </ol>
    </div>
  )

  const renderConnectStage = () => (
    <section className={styles.connectPanel}>
      <div className={styles.connectCopy}>
        <p className={styles.eyebrow}>Conexión</p>
        <h3>Conecta el correo de tu cuenta</h3>
        <span>Configura el remitente que Ristak usará para enviar correos a tus contactos.</span>
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
            <p className={styles.eyebrow}>Conexión</p>
            <h3>Actualizar datos SMTP</h3>
            <span>Cambia el servidor, las credenciales o el remitente. Ristak verificará la conexión antes de guardar.</span>
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
            <span className={`${styles.statusPill} ${styles.statusPillConnected}`}>
              <ShieldCheck size={14} />
              Conectado
            </span>
          </div>

          <dl className={styles.summaryList}>
            <div>
              <dt>Servidor SMTP</dt>
              <dd>{status.smtp.host}:{status.smtp.port}</dd>
            </div>
            <div>
              <dt>Usuario</dt>
              <dd>{status.smtp.usernameMasked || 'Sin usuario'}</dd>
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
            <h3>Envía un correo de prueba</h3>
            <span>Confirma que tus correos llegan bien antes de usarlos con tus contactos.</span>
          </div>
          <form className={styles.testForm} onSubmit={sendTest}>
            <div className={styles.inputWrap} data-ristak-unstyled>
              <AtSign size={17} />
              <input
                value={testTo}
                onChange={(event) => setTestTo(event.target.value)}
                placeholder="tucorreo@tudominio.com"
                autoComplete="off"
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
        subtitle="Configura el remitente que usará tu cuenta para enviar correos."
      />

      <div className={styles.stage}>
        {connected ? renderConnectedStage() : renderConnectStage()}
      </div>
    </div>
  )
}
