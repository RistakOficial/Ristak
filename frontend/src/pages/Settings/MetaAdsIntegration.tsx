import React, { useState, useEffect } from 'react'
import { Card, Button } from '@/components/common'
import { RefreshCw, Trash2 } from 'lucide-react'
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
                      <h4 className={styles.stepTitle}>Crear App en Meta</h4>
                      <p className={styles.stepDescription}>
                        Abre{' '}
                        <a href="https://developers.facebook.com" target="_blank" rel="noopener noreferrer" className={styles.link}>
                          developers.facebook.com
                        </a>
                        , crea una app tipo "Empresa" y agrega "Marketing API"
                      </p>
                    </div>
                  </div>

                  {/* Paso 2 */}
                  <div className={styles.step}>
                    <div className={styles.stepNumber}>2</div>
                    <div className={styles.stepContent}>
                      <h4 className={styles.stepTitle}>Generar Token de Sistema</h4>
                      <p className={styles.stepDescription}>
                        Ve a{' '}
                        <a href="https://business.facebook.com" target="_blank" rel="noopener noreferrer" className={styles.link}>
                          business.facebook.com
                        </a>
                        , crea un usuario del sistema y genera un token con permisos{' '}
                        <code className={styles.codeInline}>ads_read</code> y{' '}
                        <code className={styles.codeInline}>business_management</code>
                      </p>
                    </div>
                  </div>

                  {/* Paso 3 */}
                  <div className={styles.step}>
                    <div className={styles.stepNumber}>3</div>
                    <div className={styles.stepContent}>
                      <h4 className={styles.stepTitle}>Obtener Account ID</h4>
                      <p className={styles.stepDescription}>
                        Abre el Administrador de Anuncios y copia el ID de la cuenta (solo los números, sin "act_")
                      </p>
                    </div>
                  </div>

                  {/* Paso 4 */}
                  <div className={styles.step}>
                    <div className={styles.stepNumber}>4</div>
                    <div className={styles.stepContent}>
                      <h4 className={styles.stepTitle}>Conectar aquí</h4>
                      <p className={styles.stepDescription}>
                        Pega tu token, selecciona la cuenta y guarda. Todo se sincroniza automáticamente con HighLevel
                      </p>
                    </div>
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
              </div>
            )}
          </div>

        </div>
        {/* FIN GRID 2 COLUMNAS */}

      </Card>
    </div>
  )
}
