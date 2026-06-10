import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Card, Button, Modal, CustomSelect } from '@/components/common'
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
  Info,
  X,
  Plus,
  UserX
} from 'lucide-react'
import { highLevelService } from '@/services/highLevelService'
import { hiddenContactsService, type HiddenFilter } from '@/services/hiddenContactsService'
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

  // Estados para contactos ocultos
  const [showHiddenContactsModal, setShowHiddenContactsModal] = useState(false)
  const [hiddenFilters, setHiddenFilters] = useState<HiddenFilter[]>([])
  const [newFilter, setNewFilter] = useState('')
  const [newFilterType, setNewFilterType] = useState<'contains' | 'exact'>('contains')
  const [loadingFilters, setLoadingFilters] = useState(false)
  const [addingFilter, setAddingFilter] = useState(false)

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

  // Funciones para contactos ocultos
  const loadHiddenFilters = async () => {
    setLoadingFilters(true)
    try {
      const filters = await hiddenContactsService.getFilters()
      setHiddenFilters(filters)
    } catch (error) {
      showToast('error', 'Error', 'No se pudieron cargar los filtros')
    } finally {
      setLoadingFilters(false)
    }
  }

  const handleAddFilter = async () => {
    if (!newFilter.trim()) {
      showToast('warning', 'Filtro vacío', 'Ingresa un texto para filtrar')
      return
    }

    setAddingFilter(true)
    try {
      const filter = await hiddenContactsService.addFilter(newFilter.trim(), newFilterType)
      setHiddenFilters(prev => [filter, ...prev])
      setNewFilter('')
      setNewFilterType('contains')
      const typeText = newFilterType === 'exact' ? 'exactamente igual a' : 'contengan'
      showToast('success', 'Filtro agregado', `Los contactos ${typeText} "${newFilter.trim()}" se ocultarán`)
    } catch (error: any) {
      if (error.message?.includes('409') || error.message?.includes('existe')) {
        showToast('warning', 'Filtro duplicado', 'Este filtro ya existe')
      } else {
        showToast('error', 'Error', 'No se pudo agregar el filtro')
      }
    } finally {
      setAddingFilter(false)
    }
  }

  const handleDeleteFilter = async (id: string, text: string) => {
    try {
      await hiddenContactsService.deleteFilter(id)
      setHiddenFilters(prev => prev.filter(f => f.id !== id))
      showToast('success', 'Filtro eliminado', `El filtro "${text}" fue eliminado`)
    } catch (error) {
      showToast('error', 'Error', 'No se pudo eliminar el filtro')
    }
  }

  const handleOpenHiddenContactsModal = () => {
    setShowHiddenContactsModal(true)
    loadHiddenFilters()
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
                <div className={styles.statusConnected}>
                  <Loader2 size={16} className={styles.spinIcon} />
                  <span>Verificando...</span>
                </div>
              ) : isConnected ? (
                <div className={styles.statusConnected}>
                  <CheckCircle size={16} />
                  <span>Conectado</span>
                </div>
              ) : isConfigured ? (
                <div className={styles.statusWarning}>
                  <AlertCircle size={16} />
                  <span>Sin conexión</span>
                </div>
              ) : (
                <div className={styles.statusDisconnected}>
                  <XCircle size={16} />
                  <span>No configurado</span>
                </div>
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
                  <span className={styles.statusSuccess}>
                    <CheckCircle size={14} />
                    Conexión activa
                  </span>
                ) : (
                  <span className={styles.statusError}>
                    <XCircle size={14} />
                    Sin conexión
                  </span>
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

        {/* Sección de Contactos Ocultos */}
        {isConfigured && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h3 className={styles.sectionTitle}>Contactos Ocultos</h3>
              <p className={styles.sectionDescription}>
                Oculta contactos de prueba o internos en todas las vistas
              </p>
            </div>
          </div>

          <div className={styles.infoBox}>
            <div className={styles.infoBoxTitle}>
              <UserX size={16} />
              <span>Filtrado de Contactos</span>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
              Agrega palabras clave para ocultar contactos en todas las vistas de la aplicación.
              Los contactos que contengan estos textos en su nombre, email, teléfono o ID se ocultarán automáticamente.
            </p>
            <Button
              variant="secondary"
              onClick={handleOpenHiddenContactsModal}
            >
              <UserX size={16} />
              Gestionar contactos ocultos
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
      />

      {/* Modal de Contactos Ocultos */}
      {showHiddenContactsModal && createPortal(
        <div className={styles.modalOverlay} onClick={() => setShowHiddenContactsModal(false)}>
          <div className={styles.hiddenContactsModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2>Contactos Ocultos</h2>
              <button
                className={styles.modalClose}
                onClick={() => setShowHiddenContactsModal(false)}
              >
                <X size={20} />
              </button>
            </div>

            <div className={styles.modalBody}>
              <p className={styles.modalDescription}>
                Agrega palabras clave para ocultar contactos en todas las vistas. Los contactos que coincidan
                con estos textos en su nombre, email, teléfono o ID serán filtrados automáticamente.
              </p>

              <div className={styles.addFilterSection}>
                <div className={styles.filterInputGroup}>
                  <input
                    type="text"
                    className={styles.filterInput}
                    placeholder="Ej: test, raul, 5512345678..."
                    value={newFilter}
                    onChange={(e) => setNewFilter(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleAddFilter()}
                    disabled={addingFilter}
                  />
                  <CustomSelect
                    style={{ minWidth: 150 }}
                    value={newFilterType}
                    onChange={(e) => setNewFilterType(e.target.value as 'contains' | 'exact')}
                    disabled={addingFilter}
                  >
                    <option value="contains">Contiene</option>
                    <option value="exact">Es exactamente</option>
                  </CustomSelect>
                </div>
                <Button
                  onClick={handleAddFilter}
                  disabled={addingFilter || !newFilter.trim()}
                >
                  {addingFilter ? (
                    <Loader2 size={16} className={styles.spinIcon} />
                  ) : (
                    <Plus size={16} />
                  )}
                  Agregar
                </Button>
              </div>

              <div className={styles.filtersSection}>
                <h3 className={styles.filtersSectionTitle}>Filtros activos ({hiddenFilters.length})</h3>

                {loadingFilters ? (
                  <div className={styles.loadingFilters}>
                    <Loader2 size={20} className={styles.spinIcon} />
                    <span>Cargando filtros...</span>
                  </div>
                ) : hiddenFilters.length === 0 ? (
                  <div className={styles.emptyFilters}>
                    <UserX size={32} />
                    <p>No hay filtros configurados</p>
                    <span>Los contactos agregados aparecerán aquí</span>
                  </div>
                ) : (
                  <div className={styles.filterChips}>
                    {hiddenFilters.map((filter) => (
                      <div key={filter.id} className={styles.filterChip}>
                        <span className={styles.chipText}>{filter.filterText}</span>
                        <span className={styles.chipBadge} title={filter.matchType === 'exact' ? 'Coincidencia exacta' : 'Contiene'}>
                          {filter.matchType === 'exact' ? '=' : '⊃'}
                        </span>
                        <button
                          className={styles.chipDeleteButton}
                          onClick={() => handleDeleteFilter(filter.id, filter.filterText)}
                          title="Eliminar filtro"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className={styles.modalFooter}>
              <Button
                variant="ghost"
                onClick={() => setShowHiddenContactsModal(false)}
              >
                Cerrar
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
