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

  // Estado para el botón "Continuar" del Access Token
  const [showContinueButton, setShowContinueButton] = useState(false)
  const [isSavingToken, setIsSavingToken] = useState(false)

  // Estado para guardar Pixel API Token
  const [isSavingPixelToken, setIsSavingPixelToken] = useState(false)

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
    // Esta función ya no se usa, reemplazada por handleSelectAndSaveAccount
    handleSelectAndSaveAccount(account)
  }

  const handleSelectPixel = (pixel: Pixel) => {
    // Esta función ya no se usa, reemplazada por handleSelectAndSavePixel
    handleSelectAndSavePixel(pixel)
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

    // Mostrar botón "Continuar" si está escribiendo en accessToken
    if (field === 'accessToken' && value.length > 50) {
      setShowContinueButton(true)
    } else if (field === 'accessToken' && value.length <= 50) {
      setShowContinueButton(false)
    }
  }

  // Función para guardar Access Token y cargar cuentas
  const handleContinueWithToken = async () => {
    if (!credentials.accessToken || credentials.accessToken.length < 50) {
      showToast('error', 'Token inválido', 'El Access Token parece estar incompleto')
      return
    }

    setIsSavingToken(true)

    try {
      // Guardar el token en DB + Custom Values
      const response = await fetch('/api/meta/save-and-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adAccountId: '',  // Aún no hay cuenta
          accessToken: credentials.accessToken,
          pixelId: '',
          pageId: '',
          pixelApiToken: ''
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Token guardado', 'Cargando cuentas de anuncios...')
        setRealAccessToken(credentials.accessToken)
        setShowContinueButton(false)

        // Cargar cuentas
        await fetchAdAccounts(credentials.accessToken)
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar el token')
      }
    } catch (error) {
      showToast('error', 'Error', 'No se pudo conectar con el servidor')
    } finally {
      setIsSavingToken(false)
    }
  }

  // Auto-guardar cuando selecciona cuenta
  const handleSelectAndSaveAccount = async (account: AdAccount) => {
    const accountIdWithoutPrefix = account.id.replace(/^act_/, '')
    setCredentials(prev => ({ ...prev, adAccountId: accountIdWithoutPrefix }))

    try {
      // Guardar en DB + Custom Values
      const response = await fetch('/api/meta/save-and-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adAccountId: accountIdWithoutPrefix,
          accessToken: realAccessToken || credentials.accessToken,
          pixelId: credentials.pixelId,
          pageId: credentials.pageId,
          pixelApiToken: ''  // No guardamos este aquí
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Cuenta guardada', `${account.name} configurada`)
        // Auto-cargar pixeles
        if (realAccessToken) {
          fetchPixels(account.id, realAccessToken)
        }
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar la cuenta')
      }
    } catch (error) {
      showToast('error', 'Error', 'No se pudo guardar la cuenta')
    }
  }

  // Auto-guardar cuando selecciona pixel
  const handleSelectAndSavePixel = async (pixel: Pixel) => {
    setCredentials(prev => ({ ...prev, pixelId: pixel.id }))

    try {
      const response = await fetch('/api/meta/save-and-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adAccountId: credentials.adAccountId,
          accessToken: realAccessToken || credentials.accessToken,
          pixelId: pixel.id,
          pageId: credentials.pageId,
          pixelApiToken: ''  // No guardamos este aquí
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Pixel guardado', `${pixel.name} configurado`)
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar el pixel')
      }
    } catch (error) {
      showToast('error', 'Error', 'No se pudo guardar el pixel')
    }
  }

  // Auto-guardar Page ID cuando termina de escribir
  const handleSavePageId = async () => {
    if (!credentials.pageId) return

    try {
      const response = await fetch('/api/meta/save-and-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adAccountId: credentials.adAccountId,
          accessToken: realAccessToken || credentials.accessToken,
          pixelId: credentials.pixelId,
          pageId: credentials.pageId,
          pixelApiToken: ''  // No guardamos este aquí
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Page ID guardado', 'Configuración actualizada')
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar el Page ID')
      }
    } catch (error) {
      showToast('error', 'Error', 'No se pudo guardar el Page ID')
    }
  }

  // Guardar SOLO Pixel API Token (separado)
  const handleSavePixelApiToken = async () => {
    if (!credentials.pixelApiToken) {
      showToast('error', 'Token requerido', 'Ingresa el Pixel API Token primero')
      return
    }

    setIsSavingPixelToken(true)

    try {
      const response = await fetch('/api/meta/save-pixel-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pixelApiToken: credentials.pixelApiToken
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Pixel API Token guardado', 'Token guardado en DB y Custom Values')
        await loadCredentials()  // Recargar para ver el token enmascarado
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar el Pixel API Token')
      }
    } catch (error) {
      showToast('error', 'Error', 'No se pudo conectar con el servidor')
    } finally {
      setIsSavingPixelToken(false)
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
                {/* 1. App Access Token - SIEMPRE VISIBLE */}
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
                      <>
                        <input
                          type="text"
                          value={credentials.accessToken}
                          onChange={(e) => handleInputChange('accessToken', e.target.value)}
                          placeholder="EAAabcdef..."
                          className={styles.formInput}
                        />
                        {showContinueButton && !isLoadingAccounts && (
                          <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'center' }}>
                            <Button
                              onClick={handleContinueWithToken}
                              disabled={isSavingToken}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                padding: '10px 20px',
                                fontSize: '14px',
                                backgroundColor: '#0866FF',
                                color: 'white',
                                border: 'none',
                                borderRadius: '6px',
                                cursor: isSavingToken ? 'not-allowed' : 'pointer',
                                opacity: isSavingToken ? 0.6 : 1
                              }}
                            >
                              {isSavingToken ? 'Guardando...' : 'Continuar'}
                            </Button>
                          </div>
                        )}
                      </>
                    )}
                  {isLoadingAccounts && (
                    <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                      Cargando cuentas de anuncios...
                    </div>
                  )}
                </div>

                {/* 2. Cuenta de Anuncios - SOLO SI HAY TOKEN */}
                {(credentials.accessToken || realAccessToken) && (
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
                          placeholder="act_123456789012345"
                          className={styles.formInput}
                        />
                      )}
                  </div>
                )}

                {/* 3. Pixel de Meta - SOLO SI HAY CUENTA */}
                {credentials.adAccountId && (
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
                          placeholder="1234567890123456"
                          className={styles.formInput}
                        />
                      )}
                  </div>
                )}

                {/* 4. Page ID - SOLO SI HAY TOKEN */}
                {(credentials.accessToken || realAccessToken) && (
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
                        onBlur={handleSavePageId}
                        placeholder="1234567890123456"
                        className={styles.formInput}
                      />
                    )}
                  </div>
                )}

                {/* 5. Pixel API Token - SOLO SI HAY PIXEL */}
                {credentials.pixelId && (
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>
                      Pixel API Token <span className={styles.formHint}>(opcional, para Conversions API)</span>
                    </label>
                    <p className={styles.infoText} style={{ marginBottom: '12px', fontSize: '13px' }}>
                      Para usar la Conversions API de Meta, genera un token manualmente desde el Events Manager.
                    </p>
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
                      <>
                        <input
                          type="text"
                          value={credentials.pixelApiToken}
                          onChange={(e) => handleInputChange('pixelApiToken', e.target.value)}
                          placeholder="Pega aquí el token generado desde Events Manager"
                          className={styles.formInput}
                        />
                        <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'center' }}>
                          <Button
                            onClick={handleSavePixelApiToken}
                            disabled={isSavingPixelToken || !credentials.pixelApiToken}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              padding: '10px 20px',
                              fontSize: '14px',
                              backgroundColor: '#10b981',
                              color: 'white',
                              border: 'none',
                              borderRadius: '6px',
                              cursor: (isSavingPixelToken || !credentials.pixelApiToken) ? 'not-allowed' : 'pointer',
                              opacity: (isSavingPixelToken || !credentials.pixelApiToken) ? 0.6 : 1
                            }}
                          >
                            <RefreshCw size={16} className={isSavingPixelToken ? styles.spinning : ''} />
                            {isSavingPixelToken ? 'Guardando...' : 'Guardar Pixel API Token'}
                          </Button>
                        </div>
                      </>
                    )}
                    <div className={styles.infoBox} style={{ marginTop: '12px' }}>
                      <p style={{ margin: 0, fontSize: '12px' }}>
                        <strong>¿Cómo obtener este token?</strong><br />
                        1. Ve a <a href="https://business.facebook.com/events_manager2" target="_blank" rel="noopener noreferrer" className={styles.link}>Events Manager</a><br />
                        2. Selecciona tu Pixel → Settings → Conversions API<br />
                        3. Click en "Generate Access Token" → Copia y pega aquí
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

        </div>
        {/* FIN GRID 2 COLUMNAS */}

      </Card>
    </div>
  )
}
