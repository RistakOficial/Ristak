import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  ExternalLink,
  HardDrive,
  RefreshCw,
  Server,
  Video
} from 'lucide-react'
import { Badge, Button, Card, Loading, PageContainer, PageHeader, SecretInput } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import bunnyIntegrationService, { type BunnyAccountStatus } from '@/services/bunnyIntegrationService'
import { formatDateTime } from '@/utils/format'
import styles from './BunnyIntegration.module.css'

const POLL_INTERVAL_MS = 2500

function migrationProgress(status: BunnyAccountStatus | null) {
  const migration = status?.migration
  if (!migration) return 0
  const total = Math.max(0, migration.totalAssets) + Math.max(0, migration.totalVideos)
  if (!total) return migration.status === 'completed' ? 100 : 0
  const migrated = Math.max(0, migration.migratedAssets) + Math.max(0, migration.migratedVideos)
  return Math.min(100, Math.max(0, Math.round((migrated / total) * 100)))
}

function migrationCopy(status: BunnyAccountStatus) {
  const migration = status.migration
  if (!migration) return null
  if (migration.direction === 'to_managed') {
    return 'Estamos regresando tus archivos al almacenamiento administrado antes de desconectar la cuenta.'
  }
  if (migration.phase === 'stream') {
    return 'Los archivos ya están listos. Ahora se están trasladando las versiones optimizadas de video.'
  }
  return 'Tus archivos se están copiando de forma segura. El original se conserva hasta verificar cada copia.'
}

export const BunnyIntegration: React.FC = () => {
  const { showConfirm, showToast } = useNotification()
  const { timezone } = useTimezone()
  const [status, setStatus] = useState<BunnyAccountStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const loadStatus = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (!quiet) setLoading(true)
    try {
      setStatus(await bunnyIntegrationService.getStatus())
    } catch (error) {
      if (!quiet) {
        showToast('error', 'No se pudo abrir Bunny.net', error instanceof Error ? error.message : 'Intenta otra vez.')
      }
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    const shouldPoll = status?.state === 'disconnecting'
      || status?.migration?.status === 'pending'
      || status?.migration?.status === 'running'
    if (!shouldPoll) return undefined

    const timer = window.setInterval(() => {
      void loadStatus({ quiet: true })
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [loadStatus, status?.migration?.status, status?.state])

  const progress = useMemo(() => migrationProgress(status), [status])
  const sameAsManaged = Boolean(status?.sameAsManagedStorage && status?.sameAsManagedStream)
  const migrationActive = status?.migration?.status === 'pending' || status?.migration?.status === 'running'

  const connect = async (event: React.FormEvent) => {
    event.preventDefault()
    const cleanApiKey = apiKey.trim()
    if (!cleanApiKey) {
      showToast('warning', 'Falta la API key', 'Pega la Account API Key de Bunny.net para continuar.')
      return
    }

    setSaving(true)
    try {
      const nextStatus = await bunnyIntegrationService.connect(cleanApiKey)
      setStatus(nextStatus)
      setApiKey('')
      setShowApiKey(false)
      showToast(
        'success',
        nextStatus.connected ? 'Bunny.net conectado' : 'Conexión guardada',
        nextStatus.migration?.status === 'completed'
          ? 'Tus próximas cargas ya usarán tu cuenta.'
          : 'La mudanza de tus archivos ya empezó.'
      )
    } catch (error) {
      showToast('error', 'No se pudo conectar', error instanceof Error ? error.message : 'Revisa la API key e intenta otra vez.')
    } finally {
      setSaving(false)
    }
  }

  const retryMigration = async () => {
    setRetrying(true)
    try {
      setStatus(await bunnyIntegrationService.retryMigration())
      showToast('info', 'Migración reanudada', 'Ristak volverá a intentar únicamente lo que quedó pendiente.')
    } catch (error) {
      showToast('error', 'No se pudo reanudar', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      setRetrying(false)
    }
  }

  const disconnect = async () => {
    setDisconnecting(true)
    try {
      const result = await bunnyIntegrationService.disconnect()
      setStatus(result.status)
      showToast(
        'success',
        result.migrationRequired ? 'Desconexión en curso' : 'Bunny.net desconectado',
        result.migrationRequired
          ? 'Ristak conservará la cuenta conectada sólo hasta terminar de regresar tus archivos.'
          : 'Las próximas cargas volverán al almacenamiento administrado.'
      )
    } catch (error) {
      showToast('error', 'No se pudo desconectar', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      setDisconnecting(false)
    }
  }

  const confirmDisconnect = () => {
    showConfirm(
      'Desconectar Bunny.net',
      'Ristak regresará primero todos tus archivos al almacenamiento administrado. Si ya rebasaste la cuota disponible, la desconexión se detendrá para no perder nada.',
      disconnect,
      'Desconectar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'DESCONECTAR' }
    )
  }

  if (loading) return <Loading message="Revisando la conexión de Bunny.net..." page="settings-form" />

  return (
    <PageContainer className={styles.page}>
      <PageHeader
        eyebrow="Plataformas conectadas"
        title="Bunny.net"
        subtitle="Usa tu propia cuenta para guardar archivos y video sin consumir la cuota administrada de Ristak. Bunny.net conserva sus propios límites, costos y políticas."
        actions={status?.connected ? <Badge variant="success">Conectado</Badge> : <Badge variant="neutral">Sin conectar</Badge>}
      />

      <div className={styles.content}>
        {!status?.connected && status?.state !== 'disconnecting' ? (
          <Card className={styles.setup}>
            <div className={styles.sectionHeading}>
              <span className={styles.sectionIcon} aria-hidden="true"><Cloud size={22} /></span>
              <div>
                <h2>Conecta tu cuenta</h2>
                <p>Ristak crea o reutiliza automáticamente la zona de archivos, el CDN y la biblioteca de video.</p>
              </div>
            </div>

            <form className={styles.form} onSubmit={connect}>
              <div className={styles.field}>
                <label htmlFor="bunny-account-api-key">Account API Key</label>
                <SecretInput
                  id="bunny-account-api-key"
                  value={apiKey}
                  onChange={setApiKey}
                  visible={showApiKey}
                  onVisibleChange={setShowApiKey}
                  placeholder="Pega aquí tu Account API Key"
                  disabled={saving}
                />
                <small>La encuentras en Bunny.net → Account → API. Se guarda cifrada y nunca vuelve a mostrarse completa.</small>
              </div>

              <div className={styles.formActions}>
                <Button
                  type="button"
                  variant="secondary"
                  leftIcon={<ExternalLink size={17} />}
                  onClick={() => window.open('https://bunny.net', '_blank', 'noopener,noreferrer')}
                >
                  Crear cuenta en Bunny.net
                </Button>
                <Button type="submit" loading={saving} leftIcon={<Cloud size={17} />}>
                  Conectar Bunny.net
                </Button>
              </div>
            </form>

            <div className={styles.benefits}>
              <span><HardDrive size={18} aria-hidden="true" /> Archivos en tu propia cuenta</span>
              <span><Video size={18} aria-hidden="true" /> Video optimizado con Bunny Stream</span>
              <span><Server size={18} aria-hidden="true" /> Entrega rápida desde CDN</span>
            </div>
          </Card>
        ) : (
          <Card className={styles.connection}>
            <div className={styles.sectionHeading}>
              <span className={styles.sectionIcon} aria-hidden="true"><CheckCircle2 size={22} /></span>
              <div>
                <h2>{status.state === 'disconnecting' ? 'Desconectando con seguridad' : 'Tu almacenamiento está activo'}</h2>
                <p>
                  {sameAsManaged
                    ? 'Esta cuenta ya era la misma que usaba Ristak. No se duplicó ni se movió ningún archivo.'
                    : 'Las cargas nuevas ya van directo a tu cuenta. Los archivos anteriores se trasladan sin interrumpir su uso.'}
                </p>
              </div>
            </div>

            <dl className={styles.details}>
              <div><dt>Storage Zone</dt><dd>{status.storageZone || '—'}</dd></div>
              <div><dt>CDN</dt><dd>{status.cdnHostname || '—'}</dd></div>
              <div><dt>Biblioteca de video</dt><dd>{status.streamLibraryName || '—'}</dd></div>
              <div><dt>API key</dt><dd>{status.apiKeyPreview || 'Protegida'}</dd></div>
              <div><dt>Conectado</dt><dd>{formatDateTime(status.connectedAt, { timezone })}</dd></div>
            </dl>

            {status.migration && (migrationActive || status.migration.status === 'needs_attention') ? (
              <div className={styles.migration} aria-live="polite">
                <div className={styles.migrationHeader}>
                  <div>
                    <span className={styles.migrationTitle}>
                      {status.migration.status === 'needs_attention' ? 'La mudanza necesita atención' : 'Mudando tus archivos'}
                    </span>
                    <p>{status.migration.lastError || migrationCopy(status)}</p>
                  </div>
                  <strong>{progress}%</strong>
                </div>
                <div
                  className={styles.progressTrack}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                  aria-label="Avance de la migración"
                >
                  <span className={styles.progressValue} style={{ '--bunny-progress': `${progress}%` } as React.CSSProperties} />
                </div>
                {status.migration.status === 'needs_attention' ? (
                  <div className={styles.warning}>
                    <AlertTriangle size={18} aria-hidden="true" />
                    <span>Nada se borró sin una copia verificada. Puedes reintentar lo pendiente.</span>
                    <Button variant="secondary" size="sm" loading={retrying} leftIcon={<RefreshCw size={16} />} onClick={retryMigration}>
                      Reintentar
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {status.connected ? (
              <div className={styles.connectionActions}>
                <form className={styles.rotateForm} onSubmit={connect}>
                  <div className={styles.field}>
                    <label htmlFor="bunny-rotated-api-key">Actualizar API key de esta misma cuenta</label>
                    <span className={styles.rotateRow}>
                      <SecretInput
                        id="bunny-rotated-api-key"
                        value={apiKey}
                        onChange={setApiKey}
                        visible={showApiKey}
                        onVisibleChange={setShowApiKey}
                        placeholder="Nueva Account API Key"
                        disabled={saving || migrationActive}
                      />
                      <Button type="submit" variant="secondary" size="sm" loading={saving} disabled={!apiKey.trim() || migrationActive}>
                        Actualizar
                      </Button>
                    </span>
                  </div>
                </form>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={confirmDisconnect}
                  loading={disconnecting}
                  disabled={migrationActive}
                >
                  Desconectar
                </Button>
              </div>
            ) : null}
          </Card>
        )}
      </div>
    </PageContainer>
  )
}
