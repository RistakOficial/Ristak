import React, { useState, useEffect } from 'react'
import { Card, Button, Modal } from '@/components/common'
import {
  Zap,
  CheckCircle,
  XCircle,
  AlertCircle,
  Eye,
  EyeOff,
  RefreshCw,
  Trash2,
  Loader2,
  Info
} from 'lucide-react'
import { Badge } from '@/components/common/Badge'
import { highLevelService } from '@/services/highLevelService'
import { getIntegrationsStatus } from '@/services/integrationsService'
import { useNotification } from '@/contexts/NotificationContext'
import { useTheme } from '@/contexts/ThemeContext'
import { requestAIAgentClose } from '@/utils/aiAgentEvents'
import styles from './HighLevelIntegration.module.css'

interface IntegrationStatus {
  highlevel: {
    configured: boolean
    connected: boolean
    locationId: string | null
    locationData: any | null
  }
  meta: {
    connected: boolean
    configured: boolean
  }
}

export const HighLevelIntegration: React.FC = () => {
  const { showToast } = useNotification()
  const { theme } = useTheme()
  const [loading, setLoading] = useState(false)
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [locationId, setLocationId] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null)
  const [ghlConfig, setGhlConfig] = useState<any>(null)
  const [isEditMode, setIsEditMode] = useState(false)
  const [showDisconnectModal, setShowDisconnectModal] = useState(false)

  useEffect(() => {
    loadIntegrationStatus()
    loadGHLConfig()
  }, [])

  const loadIntegrationStatus = async () => {
    try {
      // En Ajustes siempre se consulta el estado fresco (sin caché compartido)
      const data = await getIntegrationsStatus({ forceRefresh: true })
      setIntegrationStatus(data as unknown as IntegrationStatus)
    } catch (error) {
      showToast('error', 'Error', 'No se pudo cargar el estado de integración')
    }
  }

  const loadGHLConfig = async () => {
    try {
      const config = await highLevelService.getConfig()
      setGhlConfig(config)
      if (config.locationId) {
        setLocationId(config.locationId)
      }
    } catch (error) {
      // Silent error
    }
  }

  const handleSaveConfig = async () => {
    if (!locationId.trim() || !apiToken.trim()) {
      showToast('error', 'Error', 'Por favor completa todos los campos')
      return
    }

    setLoading(true)
    try {
      const result = await highLevelService.saveConfig({
        locationId: locationId.trim(),
        apiToken: apiToken.trim()
      })

      if (result.success) {
        showToast('success', 'Éxito', 'Configuración guardada correctamente')
        setIsEditMode(false)
        setApiToken('')
        await loadIntegrationStatus()
        await loadGHLConfig()
      } else {
        showToast('error', 'Error', result.error || 'No se pudo guardar la configuración')
      }
    } catch (error) {
      showToast('error', 'Error', 'Error al guardar la configuración')
    } finally {
      setLoading(false)
    }
  }

  const handleDisconnect = async () => {
    setShowDisconnectModal(false)
    setLoading(true)
    try {
      const result = await highLevelService.disconnect()
      if (result.success) {
        showToast('success', 'Desconectado', 'Cuenta desconectada exitosamente')
        setLocationId('')
        setApiToken('')
        setIsEditMode(false)
        await loadIntegrationStatus()
        await loadGHLConfig()
      } else {
        showToast('error', 'Error', result.error || 'No se pudo desconectar')
      }
    } catch (error) {
      showToast('error', 'Error', 'Error al desconectar la cuenta')
    } finally {
      setLoading(false)
    }
  }

  const handleRefreshStatus = async () => {
    requestAIAgentClose()
    setCheckingStatus(true)
    try {
      // Ejecutar sincronización completa (igual que cuando conectas por primera vez)
      const result = await highLevelService.syncAllData()

      if (result.success) {
        showToast('success', 'Sincronizando', 'Sincronización completa iniciada. Los datos se actualizarán en unos momentos.')

        // Actualizar estado después de iniciar sincronización
        await loadIntegrationStatus()
        await loadGHLConfig()
      } else {
        showToast('error', 'Error', result.error || 'No se pudo iniciar la sincronización')
      }
    } catch (error: any) {
      showToast('error', 'Error', error?.message || 'Error al sincronizar los datos')
    } finally {
      setCheckingStatus(false)
    }
  }

  const isConnected = integrationStatus?.highlevel?.connected
  const isConfigured = ghlConfig?.configured
  const locationData = integrationStatus?.highlevel?.locationData

  return (
    <div className={styles.integrationContainer}>
      <Card className={styles.mainCard}>
        {/* Header */}
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerLeft}>
              <div className={styles.logoContainer}>
                <img
                  src={theme === 'dark'
                    ? "https://images.leadconnectorhq.com/image/f_webp/q_80/r_1200/u_https://cdn.filesafe.space/location%2FknES3eSWYIsc5YSZ3YLl%2Fimages%2F63413f4d-3691-4d3e-8e9c-31ba9bd55cf9.png?alt=media"
                    : "https://images.leadconnectorhq.com/image/f_webp/q_80/r_1200/u_https://assets.cdn.filesafe.space/knES3eSWYIsc5YSZ3YLl/media/68dc14a7380f78f9f6ed8a5c.png"
                  }
                  alt="GoHighLevel"
                  style={{ height: '100%', width: 'auto', objectFit: 'contain' }}
                />
              </div>
              <div>
                <h2 className={styles.pageTitle}>HighLevel</h2>
                <p className={styles.pageSubtitle}>
                  Sincroniza contactos, pagos y citas con tu cuenta
                </p>
              </div>
            </div>
            <div className={styles.headerRight}>
              {checkingStatus ? (
                <Badge variant="warning">
                  <Loader2 size={16} className={styles.spinIcon} />
                  <span>Verificando...</span>
                </Badge>
              ) : isConnected ? (
                <Badge variant="success">
                  <CheckCircle size={16} />
                  <span>Conectado</span>
                </Badge>
              ) : isConfigured ? (
                <Badge variant="warning">
                  <AlertCircle size={16} />
                  <span>Sin conexión</span>
                </Badge>
              ) : (
                <Badge variant="error">
                  <XCircle size={16} />
                  <span>No configurado</span>
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* Información de la cuenta */}
        {isConfigured && !isEditMode && locationData && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Información de la Cuenta</h3>
            <div className={styles.sectionActions}>
              <Button
                variant="ghost"
                size="small"
                onClick={handleRefreshStatus}
                disabled={checkingStatus}
              >
                <RefreshCw size={16} className={checkingStatus ? styles.spinIcon : ''} />
                {checkingStatus ? 'Sincronizando...' : 'Sincronizar ahora'}
              </Button>
              <Button
                variant="ghost"
                size="small"
                onClick={() => setIsEditMode(true)}
              >
                <Zap size={16} />
                Editar
              </Button>
              <Button
                variant="ghost"
                size="small"
                onClick={() => setShowDisconnectModal(true)}
                disabled={loading}
              >
                <Trash2 size={16} />
                Desconectar
              </Button>
            </div>
          </div>

          <div className={styles.infoGrid}>
            {locationData.name && (
              <div className={styles.infoItem}>
                <label className={styles.infoLabel}>Nombre del Location</label>
                <div className={styles.infoValue}>{locationData.name}</div>
              </div>
            )}
            {locationData.email && (
              <div className={styles.infoItem}>
                <label className={styles.infoLabel}>Email</label>
                <div className={styles.infoValue}>{locationData.email}</div>
              </div>
            )}
            {locationData.phone && (
              <div className={styles.infoItem}>
                <label className={styles.infoLabel}>Teléfono</label>
                <div className={styles.infoValue}>{locationData.phone}</div>
              </div>
            )}
            {locationData.address && (
              <div className={styles.infoItem}>
                <label className={styles.infoLabel}>Dirección</label>
                <div className={styles.infoValue}>{locationData.address}</div>
              </div>
            )}
            {locationData.city && (
              <div className={styles.infoItem}>
                <label className={styles.infoLabel}>Ciudad</label>
                <div className={styles.infoValue}>{locationData.city}</div>
              </div>
            )}
            {locationData.state && (
              <div className={styles.infoItem}>
                <label className={styles.infoLabel}>Estado</label>
                <div className={styles.infoValue}>{locationData.state}</div>
              </div>
            )}
            {locationData.country && (
              <div className={styles.infoItem}>
                <label className={styles.infoLabel}>País</label>
                <div className={styles.infoValue}>{locationData.country}</div>
              </div>
            )}
            {locationData.timezone && (
              <div className={styles.infoItem}>
                <label className={styles.infoLabel}>Zona Horaria</label>
                <div className={styles.infoValue}>{locationData.timezone}</div>
              </div>
            )}
          </div>
        </div>
        )}

        {/* Configuración de conexión */}
        {isConfigured && !isEditMode && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Configuración de Conexión</h3>
          </div>

          <div className={styles.infoGrid}>
            <div className={styles.infoItem}>
              <label className={styles.infoLabel}>Location ID</label>
              <div className={styles.infoValue}>
                <code>{ghlConfig?.locationId || 'No disponible'}</code>
              </div>
            </div>

            <div className={styles.infoItem}>
              <label className={styles.infoLabel}>API Token</label>
              <div className={styles.infoValue}>
                <code>{ghlConfig?.apiTokenPreview || '••••••••••••'}</code>
              </div>
            </div>

            <div className={styles.infoItem}>
              <label className={styles.infoLabel}>Estado de Conexión</label>
              <div className={styles.infoValue}>
                {isConnected ? (
                  <Badge variant="success">
                    <CheckCircle size={14} />
                    Conexión activa
                  </Badge>
                ) : (
                  <Badge variant="error">
                    <XCircle size={14} />
                    Sin conexión
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </div>
        )}

        {/* Formulario de configuración */}
        {(!isConfigured || isEditMode) && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>
              {isEditMode ? 'Editar Configuración' : 'Configurar Integración'}
            </h3>
          </div>

          <div className={styles.setupSteps}>
            {/* Paso 1 */}
            <div className={styles.step}>
              <div className={styles.stepNumber}>1</div>
              <div className={styles.stepContent}>
                <h4 className={styles.stepTitle}>Obtén tu Location ID</h4>
                <p className={styles.stepDescription}>
                  Ve a HighLevel, entra a Settings {'>'} Business Profile y busca el Location ID en la esquina superior derecha del primer contenedor, cerca de la zona donde aparece la foto o perfil.
                </p>
                <div className={styles.stepBody}>
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>Location ID</label>
                    <input
                      type="text"
                      className={styles.formInput}
                      placeholder="Tu Location ID de HighLevel"
                      value={locationId}
                      onChange={(e) => setLocationId(e.target.value)}
                    />
                    <div className={styles.formHint}>
                      El ID único de tu location en HighLevel
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Paso 2 */}
            <div className={styles.step}>
              <div className={styles.stepNumber}>2</div>
              <div className={styles.stepContent}>
                <h4 className={styles.stepTitle}>Crea un API Token</h4>
                <p className={styles.stepDescription}>
                  Crea una integración privada en HighLevel, selecciona todos los ámbitos/scopes y copia el token generado.
                </p>
                <div className={styles.stepBody}>
                  <div className={styles.stepGuidePanel}>
                    <div className={styles.stepGuideTitle}>
                      <Info size={15} />
                      <span>Instrucciones para crear el token</span>
                    </div>
                    <ol className={styles.integrationGuide}>
                      <li>En HighLevel ve a <strong>Settings {'>'} Integrations {'>'} Private Integrations</strong> / <strong>Integraciones privadas</strong>.</li>
                      <li>Haz clic en <strong>Create new integration</strong> / <strong>Crear nueva integración</strong>.</li>
                      <li>Escribe el nombre <strong>"Ristak"</strong>. La descripción es opcional.</li>
                      <li>En <strong>Scopes</strong> o <strong>Ámbitos</strong>, abre la caja desplegable y selecciona <strong>Select all</strong> / <strong>Seleccionar todo</strong>.</li>
                      <li>Baja hasta el final y haz clic en <strong>Create</strong> / <strong>Crear</strong>.</li>
                      <li>Cuando aparezca el token largo, pulsa <strong>Copy</strong> / <strong>Copiar</strong>, cierra la confirmación y pega ese token aquí abajo.</li>
                    </ol>
                  </div>

                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>API Token</label>
                    <div className={styles.inputGroup}>
                      <input
                        type={showToken ? 'text' : 'password'}
                        className={styles.formInput}
                        placeholder="Tu API Token de HighLevel"
                        value={apiToken}
                        onChange={(e) => setApiToken(e.target.value)}
                      />
                      <button
                        className={styles.inputButton}
                        onClick={() => setShowToken(!showToken)}
                        type="button"
                      >
                        {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                    <div className={styles.formHint}>
                      Pega aquí el token largo que HighLevel te mostró después de crear la integración.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className={`${styles.formActions} ${styles.setupFormActions}`}>
            {isEditMode && (
              <Button
                variant="ghost"
                onClick={() => {
                  setIsEditMode(false)
                  setApiToken('')
                }}
                disabled={loading}
              >
                Cancelar
              </Button>
            )}
            <Button
              variant="primary"
              onClick={handleSaveConfig}
              disabled={loading || !locationId.trim() || !apiToken.trim()}
            >
              {loading ? (
                <>
                  <Loader2 size={16} className={styles.spinIcon} />
                  Guardando...
                </>
              ) : (
                <>
                  <CheckCircle size={16} />
                  Guardar Configuración
                </>
              )}
            </Button>
          </div>
        </div>
        )}

      </Card>

      <Modal
        isOpen={showDisconnectModal}
        onClose={() => setShowDisconnectModal(false)}
        title="¿Desconectar HighLevel?"
        message="Se eliminarán todas las configuraciones de HighLevel. Esta acción no se puede deshacer. ¿Estás seguro?"
        type="confirm"
        confirmText="Desconectar"
        cancelText="Cancelar"
        onConfirm={handleDisconnect}
        typeToConfirm="DESCONECTAR"
      />

    </div>
  )
}
