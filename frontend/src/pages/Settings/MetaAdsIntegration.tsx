import React, { useState, useEffect } from 'react'
import { Card, Button } from '@/components/common'
import { CheckCircle, ExternalLink, ChevronDown, ChevronUp, AlertCircle, Info, RefreshCw, Trash2 } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { useTheme } from '@/contexts/ThemeContext'
import { campaignsService } from '@/services/campaignsService'
import styles from './HighLevelIntegration.module.css'

interface MetaCredentials {
  adAccountId: string
  accessToken: string
  pixelId: string
  pageId: string
  pixelApiToken: string
}

interface AdAccount {
  id: string
  account_id: string
  name: string
  currency: string
  timezone_name: string
  account_status: number
}

interface Pixel {
  id: string
  name: string
  creation_time: string
  last_fired_time: string
}

export const MetaAdsIntegration: React.FC = () => {
  const [openSection, setOpenSection] = useState<number | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [credentials, setCredentials] = useState<MetaCredentials>({
    adAccountId: '',
    accessToken: '',
    pixelId: '',
    pageId: '',
    pixelApiToken: ''
  })

  // Estados para dropdowns
  const [adAccounts, setAdAccounts] = useState<AdAccount[]>([])
  const [pixels, setPixels] = useState<Pixel[]>([])
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false)
  const [isLoadingPixels, setIsLoadingPixels] = useState(false)

  // Token real (revelado) para llamadas a Meta API
  const [realAccessToken, setRealAccessToken] = useState<string>('')

  const { showToast } = useNotification()
  const { theme } = useTheme()

  const toggleSection = (section: number) => {
    setOpenSection(openSection === section ? null : section)
  }

  // Cargar credenciales al montar el componente
  useEffect(() => {
    loadCredentials()
  }, [])

  const loadCredentials = async () => {
    setIsLoading(true)
    try {
      const response = await fetch('/api/meta/custom-values')
      const data = await response.json()

      if (data.success && data.data) {
        setCredentials(data.data)

        // Si hay access token guardado, cargar cuentas y pixeles
        if (data.data.accessToken) {
          let tokenToUse = data.data.accessToken

          // Si está enmascarado, obtener el token real desde el backend
          if (data.data.accessToken.startsWith('***')) {
            try {
              const revealResponse = await fetch('/api/meta/config/reveal/access_token')
              const revealData = await revealResponse.json()

              if (revealData.success && revealData.accessToken) {
                tokenToUse = revealData.accessToken
              }
            } catch (error) {
              console.error('Error revelando token:', error)
              // Si falla, no hacer nada más (no cargar cuentas)
              setIsLoading(false)
              return
            }
          }

          // Guardar el token real en estado separado
          setRealAccessToken(tokenToUse)

          // Cargar cuentas de anuncios
          await fetchAdAccounts(tokenToUse, data.data.adAccountId)

          // Si hay adAccountId, cargar pixeles también
          if (data.data.adAccountId) {
            const accountIdWithPrefix = data.data.adAccountId.startsWith('act_')
              ? data.data.adAccountId
              : `act_${data.data.adAccountId}`
            await fetchPixels(accountIdWithPrefix, tokenToUse, data.data.pixelId)
          }
        }
      }
    } catch (error) {
      console.error('Error cargando credenciales:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const fetchAdAccounts = async (token: string, savedAdAccountId?: string) => {
    if (!token) {
      showToast('error', 'Token requerido', 'Primero ingresa tu Access Token')
      return
    }

    setIsLoadingAccounts(true)
    try {
      const result = await campaignsService.fetchAdAccounts(token)
      if (result.success && result.adAccounts.length > 0) {
        setAdAccounts(result.adAccounts)

        // Si hay un ID guardado, buscar coincidencia (sin el prefijo "act_")
        if (savedAdAccountId) {
          const normalizedSavedId = savedAdAccountId.replace(/^act_/, '')
          const matchingAccount = result.adAccounts.find(acc =>
            acc.id.replace(/^act_/, '') === normalizedSavedId
          )

          if (matchingAccount) {
            // Actualizar credentials con el ID sin prefijo pero guardar el objeto completo
            setCredentials(prev => ({
              ...prev,
              adAccountId: matchingAccount.id.replace(/^act_/, '')
            }))
          }
        }

        showToast('success', 'Cuentas cargadas', `Se encontraron ${result.adAccounts.length} cuentas de anuncios`)
      } else {
        showToast('warning', 'Sin cuentas', 'No se encontraron cuentas de anuncios')
        setAdAccounts([])
      }
    } catch (error) {
      showToast('error', 'Error', 'No se pudieron cargar las cuentas')
      setAdAccounts([])
    } finally {
      setIsLoadingAccounts(false)
    }
  }

  const fetchPixels = async (adAccountId: string, token: string, savedPixelId?: string) => {
    if (!adAccountId || !token) {
      showToast('error', 'Datos requeridos', 'Primero selecciona una cuenta de anuncios')
      return
    }

    setIsLoadingPixels(true)
    try {
      const result = await campaignsService.fetchPixels(adAccountId, token)

      if (result.success && result.pixels.length > 0) {
        setPixels(result.pixels)

        // Si hay un pixel ID guardado, buscar coincidencia
        if (savedPixelId) {
          const matchingPixel = result.pixels.find(p => p.id === savedPixelId)
          if (matchingPixel) {
            // Actualizar credentials para mantener el pixel seleccionado
            setCredentials(prev => ({
              ...prev,
              pixelId: matchingPixel.id
            }))
          }
        }

        showToast('success', 'Pixeles cargados', `Se encontraron ${result.pixels.length} pixeles`)
      } else {
        showToast('info', 'Sin pixeles', 'No se encontraron pixeles para esta cuenta')
        setPixels([])
      }
    } catch (error) {
      console.error('🔴 Error cargando pixeles:', error)
      showToast('error', 'Error', 'No se pudieron cargar los pixeles')
      setPixels([])
    } finally {
      setIsLoadingPixels(false)
    }
  }

  const handleSelectAdAccount = (account: AdAccount) => {
    // Guardar sin el prefijo "act_" (para GHL custom values)
    const accountIdWithoutPrefix = account.id.replace(/^act_/, '')
    setCredentials(prev => ({ ...prev, adAccountId: accountIdWithoutPrefix }))
    // Auto-cargar pixeles al seleccionar cuenta (Meta API necesita el "act_")
    if (realAccessToken) {
      fetchPixels(account.id, realAccessToken)
    }
  }

  const handleSelectPixel = (pixel: Pixel) => {
    setCredentials(prev => ({ ...prev, pixelId: pixel.id }))
  }

  const handleRemoveCredential = (field: keyof MetaCredentials) => {
    // Limpiar el campo y todos los que dependen de él (cascada)
    if (field === 'accessToken') {
      // Si se elimina el token, limpiar TODO
      setCredentials({
        adAccountId: '',
        accessToken: '',
        pixelId: '',
        pageId: '',
        pixelApiToken: ''
      })
      setRealAccessToken('')
      setAdAccounts([])
      setPixels([])
    } else if (field === 'adAccountId') {
      // Si se elimina la cuenta, limpiar pixel y pixel token
      setCredentials(prev => ({
        ...prev,
        adAccountId: '',
        pixelId: '',
        pixelApiToken: ''
      }))
      setPixels([])
    } else if (field === 'pixelId') {
      // Si se elimina el pixel, limpiar pixel token
      setCredentials(prev => ({
        ...prev,
        pixelId: '',
        pixelApiToken: ''
      }))
    } else {
      // Para otros campos, solo limpiar el campo actual
      setCredentials(prev => ({ ...prev, [field]: '' }))
    }
  }

  const handleInputChange = (field: keyof MetaCredentials, value: string) => {
    setCredentials(prev => ({ ...prev, [field]: value }))
  }

  const handleSaveAndSync = async () => {
    // Validar que al menos tengamos Ad Account ID y Access Token
    if (!credentials.adAccountId.trim() || !credentials.accessToken.trim()) {
      showToast('error', 'Campos requeridos', 'Ad Account ID y Access Token son obligatorios')
      return
    }

    setIsSyncing(true)

    try {
      const response = await fetch('/api/meta/save-and-sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(credentials)
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Credenciales guardadas', data.message)
        // Recargar credenciales para confirmar
        await loadCredentials()
      } else {
        showToast('error', 'Error al guardar', data.error)
      }
    } catch (error) {
      showToast('error', 'Error', 'No se pudo conectar con el servidor')
    } finally {
      setIsSyncing(false)
    }
  }

  return (
    <div className={styles.integrationContainer}>
      <Card className={styles.mainCard}>
        {/* Header */}
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '8px' }}>
              <img
                src={theme === 'light'
                  ? 'https://img.icons8.com/fluency/96/meta.png'
                  : 'https://img.icons8.com/ios-filled/150/FFFFFF/meta.png'
                }
                alt="Meta"
                style={{
                  width: '60px',
                  height: '60px',
                  borderRadius: '12px'
                }}
              />
              <h2 className={styles.pageTitle} style={{ margin: 0 }}>Meta Ads</h2>
            </div>
            <p className={styles.pageSubtitle}>
              Tutorial completo para conectar tus anuncios de Facebook con Ristak
            </p>
          </div>
        </div>

        {/* Layout 2 columnas: Tutorial + Formulario */}
        <div className={styles.twoColumnLayout}>

          {/* COLUMNA IZQUIERDA: Tutorial Simple */}
          <div>
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h3 className={styles.sectionTitle}>Cómo conectar Meta Ads</h3>
              </div>
              <div className={styles.sectionContent}>
                <p className={styles.infoText}>
                  Conecta tus anuncios de Facebook para ver métricas de rendimiento directamente en Ristak.
                </p>

                <div className={styles.setupSteps}>
                  {/* Paso 1 */}
                  <div className={styles.step}>
                    <div className={styles.stepNumber}>1</div>
                    <div className={styles.stepContent}>
                      <h4 className={styles.stepTitle}>Crear App en Meta Developers</h4>
                      <p className={styles.stepDescription}>
                        Ve a <a href="https://developers.facebook.com" target="_blank" rel="noopener noreferrer" className={styles.link}>developers.facebook.com</a>
                        {' '}→ Crea una App tipo "Empresa" → Agrega "Marketing API"
                      </p>
                    </div>
                  </div>

                  {/* Paso 2 */}
                  <div className={styles.step}>
                    <div className={styles.stepNumber}>2</div>
                    <div className={styles.stepContent}>
                      <h4 className={styles.stepTitle}>Generar System User Token</h4>
                      <p className={styles.stepDescription}>
                        Ve a <a href="https://business.facebook.com" target="_blank" rel="noopener noreferrer" className={styles.link}>business.facebook.com</a>
                        {' '}→ Business Settings → Usuarios del sistema → Crea uno nuevo → Genera token con permisos <code className={styles.codeInline}>ads_read</code> y <code className={styles.codeInline}>business_management</code>
                      </p>
                    </div>
                  </div>

                  {/* Paso 3 */}
                  <div className={styles.step}>
                    <div className={styles.stepNumber}>3</div>
                    <div className={styles.stepContent}>
                      <h4 className={styles.stepTitle}>Encontrar tu Ad Account ID</h4>
                      <p className={styles.stepDescription}>
                        Ve al Administrador de Anuncios → En el dropdown superior verás tu ID (números sin el prefijo "act_")
                      </p>
                    </div>
                  </div>

                  {/* Paso 4 */}
                  <div className={styles.step}>
                    <div className={styles.stepNumber}>4</div>
                    <div className={styles.stepContent}>
                      <h4 className={styles.stepTitle}>Configurar en Ristak</h4>
                      <p className={styles.stepDescription}>
                        Pega el token y selecciona tu cuenta del dropdown. Guardaremos todo automáticamente en HighLevel.
                      </p>
                    </div>
                  </div>
                </div>

                <div className={styles.infoBox} style={{ marginTop: 'var(--spacing-lg)' }}>
                  <Info size={18} />
                  <div>
                    <strong>Nota:</strong> El Pixel API Token se genera automáticamente cuando guardas la configuración. No necesitas hacer nada más.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* COLUMNA DERECHA: Formulario */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h3 className={styles.sectionTitle}>Configurar Credenciales</h3>
            </div>

            {isLoading ? (
              <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                Cargando credenciales...
              </div>
            ) : (
              <div style={{ marginTop: 'var(--spacing-lg)' }}>
                {/* 1. App Access Token */}
                <div className={styles.formGroup}>
                    <label className={styles.formLabel}>
                      App Access Token <span style={{ color: 'var(--color-error)' }}>*</span>
                    </label>
                    {credentials.accessToken && credentials.accessToken.startsWith('***') ? (
                      <div className={styles.filterChip}>
                        <span className={styles.chipText}>{credentials.accessToken}</span>
                        <button
                          onClick={() => handleRemoveCredential('accessToken')}
                          className={styles.chipDeleteButton}
                          type="button"
                        >
                          <Trash2 size={16} style={{ color: '#ef4444' }} />
                        </button>
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={credentials.accessToken}
                        onChange={(e) => handleInputChange('accessToken', e.target.value)}
                        onBlur={(e) => {
                          // Auto-cargar cuentas cuando el usuario termina de escribir/pegar
                          if (e.target.value && e.target.value.length > 50) {
                            setRealAccessToken(e.target.value) // Guardar token real
                            fetchAdAccounts(e.target.value)
                          }
                        }}
                        placeholder="EAAabcdef..."
                        className={styles.formInput}
                      />
                    )}
                  {isLoadingAccounts && (
                    <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                      Cargando cuentas de anuncios...
                    </div>
                  )}
                </div>

                {/* 2. Cuenta de Anuncios */}
                <div className={styles.formGroup}>
                    <label className={styles.formLabel}>
                      Cuenta de Anuncios <span style={{ color: 'var(--color-error)' }}>*</span>
                    </label>
                    {credentials.adAccountId ? (
                      <div className={styles.filterChip}>
                        <span className={styles.chipText}>
                          {(() => {
                            const normalizedId = credentials.adAccountId.replace(/^act_/, '')
                            const matchingAccount = adAccounts.find(acc =>
                              acc.id.replace(/^act_/, '') === normalizedId
                            )
                            return matchingAccount
                              ? `${matchingAccount.name} (${normalizedId})`
                              : normalizedId
                          })()}
                        </span>
                        <button
                          onClick={() => {
                            handleRemoveCredential('adAccountId')
                            setPixels([])
                          }}
                          className={styles.chipDeleteButton}
                          type="button"
                        >
                          <Trash2 size={16} style={{ color: '#ef4444' }} />
                        </button>
                      </div>
                    ) : adAccounts.length > 0 ? (
                      <select
                        className={styles.formInput}
                        onChange={(e) => {
                          const account = adAccounts.find(a => a.id === e.target.value)
                          if (account) handleSelectAdAccount(account)
                        }}
                        value={credentials.adAccountId || ''}
                        disabled={!credentials.accessToken && !realAccessToken}
                      >
                        <option value="">-- Selecciona una cuenta --</option>
                        {adAccounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.name} ({account.id}) - {account.currency}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={credentials.adAccountId}
                        onChange={(e) => handleInputChange('adAccountId', e.target.value)}
                        placeholder={!credentials.accessToken && !realAccessToken ? 'Primero agrega el Access Token' : 'act_123456789012345'}
                        className={styles.formInput}
                        disabled={!credentials.accessToken && !realAccessToken}
                        style={{
                          cursor: !credentials.accessToken && !realAccessToken ? 'not-allowed' : 'text',
                          opacity: !credentials.accessToken && !realAccessToken ? 0.5 : 1
                        }}
                      />
                    )}
                </div>

                {/* 3. Pixel de Meta */}
                <div className={styles.formGroup}>
                    <label className={styles.formLabel}>
                      Pixel de Meta <span className={styles.formHint}>(opcional)</span>
                    </label>
                    {credentials.pixelId ? (
                      <div className={styles.filterChip}>
                        <span className={styles.chipText}>
                          {(() => {
                            const matchingPixel = pixels.find(p => p.id === credentials.pixelId)
                            return matchingPixel
                              ? `${matchingPixel.name} (${credentials.pixelId})`
                              : credentials.pixelId
                          })()}
                        </span>
                        <button
                          onClick={() => handleRemoveCredential('pixelId')}
                          className={styles.chipDeleteButton}
                          type="button"
                        >
                          <Trash2 size={16} style={{ color: '#ef4444' }} />
                        </button>
                      </div>
                    ) : isLoadingPixels ? (
                      <div style={{ padding: '12px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
                        Cargando pixeles...
                      </div>
                    ) : pixels.length > 0 ? (
                      <select
                        className={styles.formInput}
                        onChange={(e) => {
                          const pixel = pixels.find(p => p.id === e.target.value)
                          if (pixel) handleSelectPixel(pixel)
                        }}
                        value={credentials.pixelId || ''}
                        disabled={!credentials.adAccountId}
                      >
                        <option value="">-- Sin pixel (opcional) --</option>
                        {pixels.map((pixel) => (
                          <option key={pixel.id} value={pixel.id}>
                            {pixel.name} ({pixel.id})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={credentials.pixelId}
                        onChange={(e) => handleInputChange('pixelId', e.target.value)}
                        placeholder={!credentials.adAccountId ? 'Primero selecciona la cuenta de anuncios' : '1234567890123456'}
                        className={styles.formInput}
                        disabled={!credentials.adAccountId}
                        style={{
                          cursor: !credentials.adAccountId ? 'not-allowed' : 'text',
                          opacity: !credentials.adAccountId ? 0.5 : 1
                        }}
                      />
                    )}
                </div>

                {/* 4. Pixel API Token */}
                <div className={styles.formGroup}>
                    <label className={styles.formLabel}>
                      Pixel API Token <span className={styles.formHint}>(automático)</span>
                    </label>
                    {credentials.pixelApiToken && credentials.pixelApiToken.startsWith('***') ? (
                      <div className={styles.filterChip}>
                        <span className={styles.chipText}>{credentials.pixelApiToken}</span>
                        <button
                          onClick={() => handleRemoveCredential('pixelApiToken')}
                          className={styles.chipDeleteButton}
                          type="button"
                        >
                          <Trash2 size={16} style={{ color: '#ef4444' }} />
                        </button>
                      </div>
                    ) : (
                      <input
                        type="text"
                        value=""
                        readOnly
                        placeholder={credentials.pixelId ? 'Se generará automáticamente al guardar' : 'Primero configura el Pixel ID'}
                        className={styles.formInput}
                        disabled
                        style={{
                          cursor: 'not-allowed',
                          opacity: 0.5
                        }}
                      />
                    )}
                  {credentials.pixelId && (
                    <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                      El token se genera automáticamente cuando guardas la configuración.
                    </div>
                  )}
                </div>

                {/* 5. Page ID */}
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>
                    Page ID de Facebook <span className={styles.formHint}>(opcional)</span>
                  </label>
                  {credentials.pageId ? (
                    <div className={styles.filterChip}>
                      <span className={styles.chipText}>{credentials.pageId}</span>
                      <button
                        onClick={() => handleRemoveCredential('pageId')}
                        className={styles.chipDeleteButton}
                        type="button"
                      >
                        <Trash2 size={16} style={{ color: '#ef4444' }} />
                      </button>
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={credentials.pageId}
                      onChange={(e) => handleInputChange('pageId', e.target.value)}
                      placeholder={!credentials.accessToken && !realAccessToken ? 'Primero agrega el Access Token' : '1234567890123456'}
                      className={styles.formInput}
                      style={{
                        cursor: !credentials.accessToken && !realAccessToken ? 'not-allowed' : 'text',
                        opacity: !credentials.accessToken && !realAccessToken ? 0.5 : 1
                      }}
                      disabled={!credentials.accessToken && !realAccessToken}
                    />
                  )}
                </div>

                {/* Botón de Guardar y Sincronizar */}
                <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'center' }}>
                  <Button
                    onClick={handleSaveAndSync}
                    disabled={isSyncing}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '12px 24px',
                      fontSize: '16px',
                      backgroundColor: '#0866FF',
                      color: 'white',
                      border: 'none',
                      borderRadius: '8px',
                      cursor: isSyncing ? 'not-allowed' : 'pointer',
                      opacity: isSyncing ? 0.6 : 1
                    }}
                  >
                    <RefreshCw size={18} className={isSyncing ? styles.spinning : ''} />
                    {isSyncing ? 'Guardando y sincronizando...' : 'Guardar y Sincronizar'}
                  </Button>
                </div>

                <div className={styles.infoBox} style={{ marginTop: '8px' }}>
                  <Info size={18} />
                  <div>
                    <strong>¿Qué hace este botón?</strong>
                    <br />
                    1. Guarda las credenciales en HighLevel Custom Values
                    <br />
                    2. Guarda las credenciales en Ristak (encriptadas)
                    <br />
                    3. Valida que las credenciales funcionen correctamente
                    <br />
                    4. Inicia automáticamente la sincronización de tus anuncios de Meta
                  </div>
                </div>
              </div>
            )}
          </div>

        </div>
        {/* FIN GRID 2 COLUMNAS */}

        {/* Lo que necesitas (sección completa oculta, ahora está resumido arriba) */}
        <div className={styles.section} style={{ display: 'none' }}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Lo que vas a necesitar</h3>
          </div>
          <div className={styles.sectionContent}>
            <div className={styles.checklistGrid}>
              <div className={styles.checklistItem}>
                <CheckCircle size={18} className={styles.checklistIcon} />
                <span>Una cuenta de Meta Business Manager</span>
              </div>
              <div className={styles.checklistItem}>
                <CheckCircle size={18} className={styles.checklistIcon} />
                <span>Una cuenta de anuncios de Facebook activa</span>
              </div>
              <div className={styles.checklistItem}>
                <CheckCircle size={18} className={styles.checklistIcon} />
                <span>10-15 minutos para seguir los pasos</span>
              </div>
              <div className={styles.checklistItem}>
                <CheckCircle size={18} className={styles.checklistIcon} />
                <span>Acceso a Meta Developers (gratis)</span>
              </div>
            </div>
          </div>
        </div>

        {/* Scopes Requeridos */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Permisos (Scopes) que necesitarás</h3>
          </div>
          <div className={styles.sectionContent}>
            <p className={styles.infoText}>
              Cuando generes el Access Token en el Paso 2, necesitarás seleccionar estos permisos:
            </p>
            <div className={styles.checklistGrid}>
              <div className={styles.checklistItem}>
                <CheckCircle size={18} className={styles.checklistIcon} />
                <span><code>ads_read</code> - Para leer datos de anuncios</span>
              </div>
              <div className={styles.checklistItem}>
                <CheckCircle size={18} className={styles.checklistIcon} />
                <span><code>ads_management</code> - Opcional, si quieres crear/editar campañas</span>
              </div>
              <div className={styles.checklistItem}>
                <CheckCircle size={18} className={styles.checklistIcon} />
                <span><code>business_management</code> - Para acceder a cuentas de anuncios</span>
              </div>
            </div>
          </div>
        </div>

        {/* Tutorial paso a paso */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Tutorial Paso a Paso</h3>
          </div>
          <div className={styles.sectionContent}>
            {/* Paso 1 */}
            <div className={styles.tutorialStep}>
              <div
                className={styles.stepHeader}
                onClick={() => toggleSection(1)}
              >
                <div className={styles.stepNumber}>1</div>
                <div className={styles.stepInfo}>
                  <h4 className={styles.stepTitle}>Crear una App en Meta Developers</h4>
                  <p className={styles.stepSubtitle}>Necesitas una App para generar el System User Token (Paso 2)</p>
                </div>
                {openSection === 1 ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
              </div>

              {openSection === 1 && (
                <div className={styles.stepContent}>
                  <ol className={styles.stepList}>
                    <li>
                      <strong>Ve a Meta Developers:</strong>
                      <br />
                      <a
                        href="https://developers.facebook.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.externalLink}
                      >
                        https://developers.facebook.com <ExternalLink size={14} />
                      </a>
                      <br />
                      <span className={styles.hint}>Inicia sesión con tu cuenta de Facebook</span>
                    </li>
                    <li>
                      <strong>Crea una nueva App:</strong>
                      <ul>
                        <li>Haz clic en el botón verde "Crear App" (arriba a la derecha)</li>
                        <li>Selecciona tipo: <strong>"Empresa"</strong> o <strong>"Business"</strong></li>
                        <li>Dale un nombre a tu App (ejemplo: "Ristak API" o "Mi Negocio Ads")</li>
                        <li>Correo de contacto: Pon tu email</li>
                        <li>Business Account: Selecciona tu cuenta de negocio (si tienes)</li>
                        <li>Haz clic en "Crear App"</li>
                      </ul>
                    </li>
                    <li>
                      <strong>Agrega el producto "Marketing API":</strong>
                      <ul>
                        <li>En el dashboard de tu App, verás una lista de productos</li>
                        <li>Busca <strong>"Marketing API"</strong></li>
                        <li>Haz clic en "Configurar" o "Set Up"</li>
                        <li>Acepta los términos si te los pide</li>
                      </ul>
                    </li>
                  </ol>

                  <div className={styles.infoBox}>
                    <Info size={18} />
                    <div>
                      <strong>Importante:</strong> Solo necesitas crear la App para poder generar el System User Token en el Paso 2.
                      NO necesitas copiar el App ID ni el App Secret - Ristak usa System User Token que no requiere esas credenciales.
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Paso 2 */}
            <div className={styles.tutorialStep}>
              <div
                className={styles.stepHeader}
                onClick={() => toggleSection(2)}
              >
                <div className={styles.stepNumber}>2</div>
                <div className={styles.stepInfo}>
                  <h4 className={styles.stepTitle}>Obtener un Token de Acceso Permanente (System User)</h4>
                  <p className={styles.stepSubtitle}>Este token NUNCA caduca - es la mejor opción</p>
                </div>
                {openSection === 2 ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
              </div>

              {openSection === 2 && (
                <div className={styles.stepContent}>
                  <ol className={styles.stepList}>
                    <li>
                      <strong>Ve a Meta Business Manager:</strong>
                      <br />
                      <a
                        href="https://business.facebook.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.externalLink}
                      >
                        https://business.facebook.com <ExternalLink size={14} />
                      </a>
                    </li>
                    <li>
                      <strong>Crea un System User:</strong>
                      <ul>
                        <li>En el menú de hamburguesa (☰), selecciona tu cuenta de negocio</li>
                        <li>Ve a <strong>"Configuración de la empresa"</strong> o <strong>"Business Settings"</strong></li>
                        <li>En el menú lateral, busca <strong>"Usuarios" → "Usuarios del sistema"</strong> (System Users)</li>
                        <li>Haz clic en <strong>"Agregar"</strong> o <strong>"Add"</strong></li>
                        <li>Ponle un nombre descriptivo (ejemplo: "Ristak API User")</li>
                        <li>Rol: Selecciona <strong>"Administrador"</strong> (Admin)</li>
                        <li>Haz clic en "Crear System User"</li>
                      </ul>
                    </li>
                    <li>
                      <strong>Genera el Access Token:</strong>
                      <ul>
                        <li>Haz clic en el System User que acabas de crear</li>
                        <li>Haz clic en <strong>"Generar nuevo token"</strong> o <strong>"Generate New Token"</strong></li>
                        <li>En "App", selecciona la App que creaste en el Paso 1</li>
                        <li>Selecciona los permisos que se mencionan arriba (<code>ads_read</code>, <code>ads_management</code>, <code>business_management</code>)</li>
                        <li>Duración: <strong>60 días o "Never expire"</strong></li>
                        <li>Haz clic en "Generar Token"</li>
                        <li className={styles.warningText}>
                          ⚠️ MUY IMPORTANTE: COPIA EL TOKEN AHORA - No lo volverás a ver
                        </li>
                      </ul>
                    </li>
                    <li>
                      <strong>Asigna el System User a tu cuenta de anuncios:</strong>
                      <ul>
                        <li>En Business Settings, ve a <strong>"Cuentas" → "Cuentas de anuncios"</strong></li>
                        <li>Selecciona tu cuenta de anuncios</li>
                        <li>Haz clic en <strong>"Agregar personas"</strong> o <strong>"Add People"</strong></li>
                        <li>Busca tu System User que creaste</li>
                        <li>Asígnale permisos de <strong>"Administrador de anuncios"</strong> (Ads Manager Admin)</li>
                        <li>Guarda los cambios</li>
                      </ul>
                    </li>
                  </ol>

                  <div className={styles.successBox}>
                    <CheckCircle size={18} />
                    <div>
                      <strong>Ventaja del System User:</strong> Este token NO caduca nunca (a menos que lo revokes manualmente).
                      Es la forma más profesional y segura de conectar integraciones.
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Paso 3 */}
            <div className={styles.tutorialStep}>
              <div
                className={styles.stepHeader}
                onClick={() => toggleSection(3)}
              >
                <div className={styles.stepNumber}>3</div>
                <div className={styles.stepInfo}>
                  <h4 className={styles.stepTitle}>Encontrar tu Ad Account ID</h4>
                  <p className={styles.stepSubtitle}>El ID único de tu cuenta de anuncios</p>
                </div>
                {openSection === 3 ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
              </div>

              {openSection === 3 && (
                <div className={styles.stepContent}>
                  <ol className={styles.stepList}>
                    <li>
                      <strong>Ve al Administrador de Anuncios:</strong>
                      <br />
                      <a
                        href="https://business.facebook.com/adsmanager"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.externalLink}
                      >
                        https://business.facebook.com/adsmanager <ExternalLink size={14} />
                      </a>
                    </li>
                    <li>
                      <strong>Encuentra tu Ad Account ID:</strong>
                      <ul>
                        <li>En la esquina superior izquierda, verás el nombre de tu cuenta de anuncios</li>
                        <li>Haz clic en el dropdown (flecha hacia abajo)</li>
                        <li>Verás algo como: <strong>"Mi Cuenta (ID: 123456789012345)"</strong></li>
                        <li>Copia SOLO el número (sin el prefijo "act_")</li>
                        <li>Ejemplo: Si dice <code>act_123456789012345</code>, solo copia <code>123456789012345</code></li>
                      </ul>
                    </li>
                  </ol>

                  <div className={styles.infoBox}>
                    <Info size={18} />
                    <div>
                      <strong>Alternativa:</strong> También puedes encontrarlo en Business Settings → Cuentas → Cuentas de anuncios.
                      Aparecerá como "ID de la cuenta de anuncios".
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Paso 4 */}
            <div className={styles.tutorialStep}>
              <div
                className={styles.stepHeader}
                onClick={() => toggleSection(4)}
              >
                <div className={styles.stepNumber}>4</div>
                <div className={styles.stepInfo}>
                  <h4 className={styles.stepTitle}>Guardar los valores en HighLevel Custom Values</h4>
                  <p className={styles.stepSubtitle}>Aquí es donde Ristak buscará tu configuración</p>
                </div>
                {openSection === 4 ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
              </div>

              {openSection === 4 && (
                <div className={styles.stepContent}>
                  <ol className={styles.stepList}>
                    <li>
                      <strong>Ve a tu cuenta de HighLevel:</strong>
                      <br />
                      <a
                        href="https://app.gohighlevel.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.externalLink}
                      >
                        https://app.gohighlevel.com <ExternalLink size={14} />
                      </a>
                    </li>
                    <li>
                      <strong>Accede a Custom Values:</strong>
                      <ul>
                        <li>En el menú lateral, ve a <strong>"Configuración" → "Custom Values"</strong></li>
                        <li>O busca "Custom Values" en la barra de búsqueda</li>
                      </ul>
                    </li>
                    <li>
                      <strong>Crea los siguientes Custom Values (exactamente con estos nombres):</strong>
                      <div className={styles.customValuesTable}>
                        <div className={styles.tableRow}>
                          <div className={styles.tableLabel}>Nombre del Custom Value</div>
                          <div className={styles.tableLabel}>Valor que debes pegar</div>
                        </div>
                        <div className={styles.tableRow}>
                          <div className={styles.tableCell}><code>Facebook - Ad Account ID</code></div>
                          <div className={styles.tableCell}>
                            El número de tu cuenta de anuncios (Paso 3)
                            <br />
                            <span className={styles.hint}>Ejemplo: 123456789012345</span>
                          </div>
                        </div>
                        <div className={styles.tableRow}>
                          <div className={styles.tableCell}><code>Facebook - App Access Token</code></div>
                          <div className={styles.tableCell}>
                            El token del System User (Paso 2)
                            <br />
                            <span className={styles.hint}>Ejemplo: EAAabcdef...</span>
                          </div>
                        </div>
                        <div className={styles.tableRow}>
                          <div className={styles.tableCell}><code>Facebook - Pixel ID</code></div>
                          <div className={styles.tableCell}>
                            El ID de tu Pixel (opcional)
                            <br />
                            <span className={styles.hint}>Ejemplo: 1234567890123456</span>
                          </div>
                        </div>
                      </div>
                    </li>
                    <li className={styles.warningText}>
                      <strong>⚠️ MUY IMPORTANTE:</strong> Los nombres de los Custom Values deben ser EXACTAMENTE como están arriba,
                      incluyendo mayúsculas, espacios y guiones. Si hay un error de tipeo, Ristak no encontrará la configuración.
                    </li>
                  </ol>

                  <div className={styles.infoBox}>
                    <Info size={18} />
                    <div>
                      <strong>Tip:</strong> Para crear un Custom Value en HighLevel:
                      <br />
                      1. Haz clic en "Add Custom Value"
                      <br />
                      2. Pon el nombre exacto (cópialo de arriba)
                      <br />
                      3. Pega el valor correspondiente
                      <br />
                      4. Guarda
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Paso 5 */}
            <div className={styles.tutorialStep}>
              <div
                className={styles.stepHeader}
                onClick={() => toggleSection(5)}
              >
                <div className={styles.stepNumber}>5</div>
                <div className={styles.stepInfo}>
                  <h4 className={styles.stepTitle}>Sincronizar y verificar</h4>
                  <p className={styles.stepSubtitle}>Trae tus datos de Meta a Ristak</p>
                </div>
                {openSection === 5 ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
              </div>

              {openSection === 5 && (
                <div className={styles.stepContent}>
                  <ol className={styles.stepList}>
                    <li>
                      <strong>Vuelve a la pestaña "HighLevel" en Configuración:</strong>
                      <ul>
                        <li>Ve a Configuración → HighLevel (la primera pestaña)</li>
                        <li>Haz clic en el botón <strong>"Sincronizar HighLevel"</strong></li>
                        <li>Esto traerá automáticamente tu configuración de Meta desde los Custom Values</li>
                        <li>Espera a que termine la sincronización</li>
                      </ul>
                    </li>
                    <li>
                      <strong>Ve a la página de Publicidad (Campaigns):</strong>
                      <ul>
                        <li>En el menú lateral, haz clic en "Publicidad"</li>
                        <li>Verás un botón "Sincronizar Meta Ads"</li>
                        <li>Haz clic para traer tus métricas de anuncios</li>
                        <li>La primera vez puede tardar varios minutos (trae datos históricos)</li>
                      </ul>
                    </li>
                  </ol>

                  <div className={styles.successBox}>
                    <CheckCircle size={18} />
                    <div>
                      <strong>¡Listo!</strong> A partir de ahora, Ristak sincronizará automáticamente tus métricas de Meta Ads
                      cada hora. Ya no necesitas entrar a Meta Business Manager para ver el rendimiento de tus anuncios.
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* FAQ */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Preguntas Frecuentes</h3>
          </div>
          <div className={styles.sectionContent}>
            <div className={styles.faqList}>
              <div className={styles.faqItem}>
                <h4 className={styles.faqQuestion}>¿El token del System User caduca?</h4>
                <p className={styles.faqAnswer}>
                  No, el token del System User NO caduca nunca (a menos que lo revques manualmente o cambies configuraciones de seguridad).
                  Por eso es la mejor opción para integraciones.
                </p>
              </div>

              <div className={styles.faqItem}>
                <h4 className={styles.faqQuestion}>¿Puedo usar un token normal en vez del System User?</h4>
                <p className={styles.faqAnswer}>
                  Sí, pero NO es recomendado. Los tokens normales de usuario caducan cada 60 días y tendrías que renovarlos manualmente.
                  El System User es más seguro y no requiere mantenimiento.
                </p>
              </div>

              <div className={styles.faqItem}>
                <h4 className={styles.faqQuestion}>¿Qué métricas trae Ristak de Meta Ads?</h4>
                <p className={styles.faqAnswer}>
                  Ristak trae: gasto (spend), alcance (reach), clics, CPC (costo por clic), CPM (costo por mil impresiones), CTR (click-through rate),
                  nombres de campañas, ad sets y anuncios. Todo organizado por fecha.
                </p>
              </div>

              <div className={styles.faqItem}>
                <h4 className={styles.faqQuestion}>¿Cada cuánto se actualizan los datos?</h4>
                <p className={styles.faqAnswer}>
                  Ristak sincroniza automáticamente los últimos 7 días de datos cada hora. Si quieres forzar una actualización manual,
                  ve a la página de Publicidad y haz clic en "Sincronizar Meta Ads".
                </p>
              </div>

              <div className={styles.faqItem}>
                <h4 className={styles.faqQuestion}>¿Es seguro guardar mi token en HighLevel?</h4>
                <p className={styles.faqAnswer}>
                  Sí. Los Custom Values de HighLevel están protegidos y solo son accesibles desde tu cuenta. Además, Ristak los guarda
                  cifrados en la base de datos local.
                </p>
              </div>

              <div className={styles.faqItem}>
                <h4 className={styles.faqQuestion}>¿Qué hago si me sale error al sincronizar?</h4>
                <p className={styles.faqAnswer}>
                  Primero verifica que los 4 Custom Values estén escritos EXACTAMENTE como se indica arriba (revisa mayúsculas, espacios y guiones).
                  Si el error persiste, revisa que tu System User tenga permisos de administrador en tu cuenta de anuncios.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Links útiles */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Links Útiles</h3>
          </div>
          <div className={styles.sectionContent}>
            <div className={styles.linksGrid}>
              <a
                href="https://developers.facebook.com"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.linkCard}
              >
                <span>Meta Developers</span>
                <ExternalLink size={16} />
              </a>
              <a
                href="https://business.facebook.com"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.linkCard}
              >
                <span>Meta Business Manager</span>
                <ExternalLink size={16} />
              </a>
              <a
                href="https://business.facebook.com/adsmanager"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.linkCard}
              >
                <span>Administrador de Anuncios</span>
                <ExternalLink size={16} />
              </a>
              <a
                href="https://developers.facebook.com/docs/marketing-api"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.linkCard}
              >
                <span>Documentación Marketing API</span>
                <ExternalLink size={16} />
              </a>
            </div>
          </div>
        </div>

      </Card>
    </div>
  )
}
