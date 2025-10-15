import React, { useState, useEffect } from 'react'
import { Card, Button } from '@/components/common'
import {
  Zap,
  CheckCircle,
  XCircle,
  AlertCircle,
  Eye,
  EyeOff,
  Copy,
  Check,
  RefreshCw,
  Trash2,
  Loader2,
  Info,
  Type,
  ChevronDown
} from 'lucide-react'
import { highLevelService } from '@/services/highLevelService'
import { useNotification } from '@/contexts/NotificationContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useTheme } from '@/contexts/ThemeContext'
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
  const { labels, updateLabels } = useLabels()
  const { theme } = useTheme()
  const [loading, setLoading] = useState(false)
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [locationId, setLocationId] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null)
  const [ghlConfig, setGhlConfig] = useState<any>(null)
  const [isEditMode, setIsEditMode] = useState(false)
  const [copiedScopes, setCopiedScopes] = useState<Set<string>>(new Set())

  // Estados para labels personalizados
  const [savingLabels, setSavingLabels] = useState(false)
  const [customLabels, setCustomLabels] = useState({
    customer: '',
    lead: ''
  })
  const [openDropdown, setOpenDropdown] = useState<'customer' | 'lead' | null>(null)

  useEffect(() => {
    setCustomLabels({
      customer: labels.customer,
      lead: labels.lead
    })
  }, [labels])

  // Cerrar dropdown al hacer click fuera
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('[data-dropdown]')) {
        setOpenDropdown(null)
      }
    }

    if (openDropdown) {
      document.addEventListener('click', handleClickOutside)
      return () => document.removeEventListener('click', handleClickOutside)
    }
  }, [openDropdown])

  const customerOptions = ['Cliente', 'Paciente', 'Proyecto', 'Miembro', 'Alumno']
  const leadOptions = ['Interesado', 'Prospecto', 'Mensaje', 'Lead', 'Consulta']

  const scopes = [
    'payments.readonly',
    'payments.write',
    'invoices.readonly',
    'invoices.write',
    'invoices/schedule.readonly',
    'invoices/schedule.write',
    'contacts.readonly',
    'contacts.write',
    'opportunities.readonly',
    'opportunities.write',
    'products.readonly',
    'products.write',
    'calendars.readonly',
    'calendars.write',
    'calendars/events.readonly',
    'calendars/events.write',
    'locations.readonly',
    'businesses.readonly',
    'businesses.write',
    'calendars/resources.readonly',
    'calendars/resources.write',
    'conversations.readonly',
    'conversations.write',
    'conversations/message.readonly',
    'conversations/message.write'
  ]

  useEffect(() => {
    loadIntegrationStatus()
    loadGHLConfig()
  }, [])

  const loadIntegrationStatus = async () => {
    try {
      const response = await fetch('/api/integrations/status')
      const data = await response.json()
      setIntegrationStatus(data)
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
    if (!confirm('¿Estás seguro de desconectar tu cuenta de HighLevel?')) {
      return
    }

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

  const handleSaveLabels = async (customer: string, lead: string) => {
    setSavingLabels(true)
    try {
      // Generar automáticamente los plurales agregando "s"
      const labelsToSave = {
        customer: customer,
        customers: customer + 's',
        lead: lead,
        leads: lead + 's'
      }

      await updateLabels(labelsToSave)
      showToast('success', 'Guardado', 'Etiquetas actualizadas')
    } catch (error) {
      showToast('error', 'Error', 'No se pudieron guardar las etiquetas')
    } finally {
      setSavingLabels(false)
    }
  }

  const handleRefreshStatus = async () => {
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
    } catch (error) {
      showToast('error', 'Error', 'Error al sincronizar los datos')
    } finally {
      setCheckingStatus(false)
    }
  }

  const copyScopeToClipboard = async (scope: string) => {
    try {
      await navigator.clipboard.writeText(scope)
      setCopiedScopes(prev => new Set(prev).add(scope))
      setTimeout(() => {
        setCopiedScopes(prev => {
          const newSet = new Set(prev)
          newSet.delete(scope)
          return newSet
        })
      }, 2000)
    } catch (error) {
      showToast('error', 'Error', 'No se pudo copiar al portapapeles')
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
              <p className={styles.pageSubtitle}>
                Sincroniza contactos, pagos y citas con tu cuenta
              </p>
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
                onClick={handleDisconnect}
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
                  Ve a tu cuenta de HighLevel, entra a Settings {'>'} Business Profile
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
                  En HighLevel, ve a Settings {'>'} Integrations {'>'} API Key
                </p>
                <div className={styles.infoBox}>
                  <div className={styles.infoBoxTitle}>
                    <Info size={16} />
                    <span>Scopes requeridos</span>
                  </div>
                  <div className={styles.scopesGrid}>
                    {scopes.map((scope) => (
                      <div
                        key={scope}
                        className={`${styles.scopeItem} ${copiedScopes.has(scope) ? styles.scopeCopied : ''}`}
                        onClick={() => copyScopeToClipboard(scope)}
                      >
                        <span>{scope}</span>
                        {copiedScopes.has(scope) ? (
                          <Check size={14} />
                        ) : (
                          <Copy size={14} />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div className={styles.stepBody}>
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
                      El token generado con los permisos necesarios
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className={styles.formActions}>
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

        {/* Personalización de Labels */}
        {isConfigured && !isEditMode && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Personaliza tu App</h3>
          </div>
          <p className={styles.sectionDescription}>
            Elige cómo llamar a tus contactos y leads en toda la aplicación
          </p>

          <div className={styles.labelsGrid}>
            <div className={styles.labelField}>
              <label className={styles.formLabel}>¿Cómo llamas a tus clientes?</label>
              <div className={styles.customDropdown} data-dropdown>
                <button
                  type="button"
                  className={styles.dropdownTrigger}
                  onClick={(e) => {
                    setOpenDropdown(openDropdown === 'customer' ? null : 'customer')
                  }}
                >
                  <span>{customLabels.customer || 'Seleccionar...'}</span>
                  <ChevronDown size={18} className={openDropdown === 'customer' ? styles.iconRotated : ''} />
                </button>
                {openDropdown === 'customer' && (
                  <div className={styles.dropdownMenuWrapper}>
                    <div className={styles.dropdownMenu}>
                      {customerOptions.map((option) => (
                        <div
                          key={option}
                          className={`${styles.dropdownItem} ${customLabels.customer === option ? styles.dropdownItemActive : ''}`}
                          onClick={() => {
                            setCustomLabels({ ...customLabels, customer: option })
                            handleSaveLabels(option, customLabels.lead)
                            setOpenDropdown(null)
                          }}
                        >
                          {option}
                          {customLabels.customer === option && <Check size={16} />}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className={styles.labelField}>
              <label className={styles.formLabel}>¿Cómo llamas a tus leads?</label>
              <div className={styles.customDropdown} data-dropdown>
                <button
                  type="button"
                  className={styles.dropdownTrigger}
                  onClick={(e) => {
                    setOpenDropdown(openDropdown === 'lead' ? null : 'lead')
                  }}
                >
                  <span>{customLabels.lead || 'Seleccionar...'}</span>
                  <ChevronDown size={18} className={openDropdown === 'lead' ? styles.iconRotated : ''} />
                </button>
                {openDropdown === 'lead' && (
                  <div className={styles.dropdownMenuWrapper}>
                    <div className={styles.dropdownMenu}>
                      {leadOptions.map((option) => (
                        <div
                          key={option}
                          className={`${styles.dropdownItem} ${customLabels.lead === option ? styles.dropdownItemActive : ''}`}
                          onClick={() => {
                            setCustomLabels({ ...customLabels, lead: option })
                            handleSaveLabels(customLabels.customer, option)
                            setOpenDropdown(null)
                          }}
                        >
                          {option}
                          {customLabels.lead === option && <Check size={16} />}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {savingLabels && (
            <div className={styles.savingIndicator}>
              <Loader2 size={14} className={styles.spinIcon} />
              <span>Guardando...</span>
            </div>
          )}
        </div>
        )}
      </Card>
    </div>
  )
}
