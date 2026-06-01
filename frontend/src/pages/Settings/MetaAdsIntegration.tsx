import React, { useState, useEffect } from 'react'
import { Card, Button } from '@/components/common'
import { CheckCircle, RefreshCw, Save, Trash2, XCircle } from 'lucide-react'
import { SiWhatsapp } from 'react-icons/si'
import { useNotification } from '@/contexts/NotificationContext'
import { useTheme } from '@/contexts/ThemeContext'
import { useAppConfig, useIsRenderDomain } from '@/hooks'
import { campaignsService } from '@/services/campaignsService'
import styles from './HighLevelIntegration.module.css'

interface MetaCredentials {
  adAccountId: string
  accessToken: string
  pixelId: string
  pageId: string
  pixelApiToken: string
  whatsappBusinessAccountId?: string
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
  const [isSavingToken, setIsSavingToken] = useState(false)

  // Estado para guardar Pixel API Token
  const [isSavingPixelToken, setIsSavingPixelToken] = useState(false)

  // Estado para guardar Page ID
  const [isSavingPageId, setIsSavingPageId] = useState(false)
  const [savedPageId, setSavedPageId] = useState<string>('')  // Page ID que viene del backend (guardado)
  const [whatsappBusinessAccountIdDraft, setWhatsappBusinessAccountIdDraft] = useState('')

  // Estado para re-sincronización al cambiar el switch
  const [isSyncingSnippet, setIsSyncingSnippet] = useState(false)

  // Estado para sincronización manual de Meta Ads
  const [isSyncingMetaAds, setIsSyncingMetaAds] = useState(false)

  const { showToast } = useNotification()
  const { theme } = useTheme()

  // Detectar si estamos en dominio .onrender.com
  const isRenderDomain = useIsRenderDomain()

  // Switch para incluir Meta Pixel en snippet (default: true)
  const [includeMetaPixel, setIncludeMetaPixel, savingPixelPref] = useAppConfig('include_meta_pixel', true)
  const [whatsappScheduleEventEnabled, setWhatsappScheduleEventEnabled, savingWhatsappScheduleEvent] = useAppConfig('meta_whatsapp_schedule_enabled', false)
  const [whatsappPurchaseEventEnabled, setWhatsappPurchaseEventEnabled, savingWhatsappPurchaseEvent] = useAppConfig('meta_whatsapp_purchase_enabled', false)
  const [whatsappBusinessAccountId, setWhatsappBusinessAccountId, savingWhatsappBusinessAccountId] = useAppConfig('meta_whatsapp_business_account_id', '')

  // Cargar credenciales al montar el componente
  useEffect(() => {
    loadCredentials()
  }, [])

  useEffect(() => {
    setWhatsappBusinessAccountIdDraft(whatsappBusinessAccountId || '')
  }, [whatsappBusinessAccountId])

  const loadCredentials = async () => {
    setIsLoading(true)
    try {
      const response = await fetch('/api/meta/custom-values')
      const data = await response.json()

      if (data.success && data.data) {
        setCredentials(data.data)

        // Guardar el Page ID que viene del backend
        if (data.data.pageId) {
          setSavedPageId(data.data.pageId)
        }

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
            } catch {
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
    } catch {
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
    } catch {
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
      setSavedPageId('')  // Limpiar Page ID guardado
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
    } else if (field === 'pageId') {
      // Si se elimina el Page ID, limpiar también el savedPageId
      setCredentials(prev => ({ ...prev, pageId: '' }))
      setSavedPageId('')
    } else {
      // Para otros campos, solo limpiar el campo actual
      setCredentials(prev => ({ ...prev, [field]: '' }))
    }
  }

  const handleInputChange = (field: keyof MetaCredentials, value: string) => {
    setCredentials(prev => ({ ...prev, [field]: value }))
  }

  // Función para validar Access Token y cargar cuentas
  const handleContinueWithToken = async () => {
    if (!credentials.accessToken || credentials.accessToken.length < 50) {
      showToast('error', 'Token inválido', 'El Access Token parece estar incompleto')
      return
    }

    setIsSavingToken(true)

    try {
      // Solo validar el token y cargar cuentas (NO guardamos aún en DB)
      // El guardado ocurre cuando el usuario selecciona la cuenta
      showToast('info', 'Validando token...', 'Cargando tus cuentas de anuncios')
      setRealAccessToken(credentials.accessToken)

      // Cargar cuentas desde Meta API
      await fetchAdAccounts(credentials.accessToken)

      showToast('success', 'Token válido', 'Selecciona tu cuenta de anuncios')
    } catch (error) {
      showToast('error', 'Error', 'No se pudo validar el token o cargar las cuentas')
      setRealAccessToken('') // Resetear si falla
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

  // Guardar Page ID con botón (independiente del flujo principal)
  const handleSavePageId = async () => {
    if (!credentials.pageId) {
      showToast('error', 'Page ID requerido', 'Ingresa el Page ID primero')
      return
    }

    // NO requiere que estén configurados otros campos
    if (!credentials.adAccountId) {
      showToast('warning', 'Configura primero', 'Primero debes conectar tu cuenta de anuncios')
      return
    }

    setIsSavingPageId(true)

    try {
      const response = await fetch('/api/meta/save-and-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adAccountId: credentials.adAccountId,
          accessToken: realAccessToken || credentials.accessToken,
          pixelId: credentials.pixelId || '',  // Puede estar vacío
          pageId: credentials.pageId,
          pixelApiToken: credentials.pixelApiToken || ''
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Page ID guardado', 'Configuración actualizada')
        setSavedPageId(credentials.pageId)  // Marcar como guardado
        await loadCredentials()  // Recargar para ver el chip
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar el Page ID')
      }
    } catch (error) {
      showToast('error', 'Error', 'No se pudo guardar el Page ID')
    } finally {
      setIsSavingPageId(false)
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

  // Toggle para incluir/excluir Meta Pixel en snippet de tracking
  const handleToggleMetaPixel = async (newValue: boolean) => {
    try {
      // Guardar preferencia en DB (sistema híbrido)
      await setIncludeMetaPixel(newValue)

      // Re-sincronizar snippet automáticamente
      setIsSyncingSnippet(true)
      const response = await fetch('/api/tracking/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })

      const data = await response.json()

      if (data.success) {
        showToast(
          'success',
          'Snippet actualizado',
          newValue
            ? 'El snippet ahora incluye el Meta Pixel'
            : 'El snippet ahora NO incluye el Meta Pixel'
        )
      } else {
        showToast('error', 'Error', data.error || 'No se pudo sincronizar el snippet')
      }
    } catch (error) {
      showToast('error', 'Error', 'No se pudo actualizar el snippet')
    } finally {
      setIsSyncingSnippet(false)
    }
  }

  const handleToggleWhatsappScheduleEvent = async (newValue: boolean) => {
    try {
      await setWhatsappScheduleEventEnabled(newValue)
      showToast(
        'success',
        'Evento de cita actualizado',
        newValue ? 'LeadSubmitted se enviará cuando aplique' : 'LeadSubmitted quedó apagado'
      )
    } catch {
      showToast('error', 'Error', 'No se pudo actualizar el evento de cita')
    }
  }

  const handleToggleWhatsappPurchaseEvent = async (newValue: boolean) => {
    try {
      await setWhatsappPurchaseEventEnabled(newValue)
      showToast(
        'success',
        'Evento de pago actualizado',
        newValue ? 'Purchase se enviará cuando aplique' : 'Purchase quedó apagado'
      )
    } catch {
      showToast('error', 'Error', 'No se pudo actualizar el evento de pago')
    }
  }

  const handleSaveWhatsappBusinessAccountId = async () => {
    const normalizedValue = whatsappBusinessAccountIdDraft.trim()

    if (!normalizedValue) {
      showToast('error', 'WABA ID requerido', 'Ingresa el WhatsApp Business Account ID')
      return
    }

    try {
      await setWhatsappBusinessAccountId(normalizedValue)
      showToast('success', 'WABA ID guardado', 'WhatsApp Business listo para CAPI')
    } catch {
      showToast('error', 'Error', 'No se pudo guardar el WABA ID')
    }
  }

  // Sincronización manual de Meta Ads
  const handleSyncMetaAds = async () => {
    setIsSyncingMetaAds(true)
    showToast('info', 'Sincronizando...', 'Iniciando sincronización de Meta Ads (últimos 35 meses)')

    try {
      const result = await campaignsService.syncMetaAds()

      if (result.success) {
        showToast(
          'success',
          'Sincronización iniciada',
          result.message || 'La sincronización de Meta Ads fue iniciada en segundo plano'
        )
      } else {
        showToast(
          'error',
          'Error al sincronizar',
          result.error || 'No se pudo completar la sincronización'
        )
      }
    } catch (error) {
      showToast('error', 'Error', 'No se pudo conectar con el servidor')
    } finally {
      setIsSyncingMetaAds(false)
    }
  }

  const isMetaConfigured = Boolean(credentials.accessToken && credentials.adAccountId)

  return (
    <div className={styles.integrationContainer}>
      <Card className={styles.mainCard}>
        {/* Header */}
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerLeft}>
              <div className={styles.logoContainer}>
                <img
                  src={theme === 'light'
                    ? 'https://img.icons8.com/fluency/96/meta.png'
                    : 'https://img.icons8.com/ios-filled/150/FFFFFF/meta.png'
                  }
                  alt="Meta"
                />
              </div>
              <div>
                <h2 className={styles.pageTitle}>Meta Ads</h2>
                <p className={styles.pageSubtitle}>
                  Conecta tu cuenta de anuncios de Facebook
                </p>
              </div>
            </div>
            <div className={styles.headerRight}>
              {isMetaConfigured ? (
                <div className={styles.statusConnected}>
                  <CheckCircle size={16} />
                  <span>Configurado</span>
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

        {/* Formulario simple */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Configuración</h3>
          </div>

          {isLoading ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
              Cargando credenciales...
            </div>
          ) : (
            <div className={styles.sectionContent}>
                {/* 1. App Access Token */}
                <div className={styles.formGroup}>
                    <label className={styles.formLabel}>
                      Access Token <span style={{ color: 'var(--color-error)' }}>*</span>
                    </label>
                    <p className={styles.formHint} style={{ marginBottom: '8px' }}>
                      Genera un token desde{' '}
                      <a href="https://business.facebook.com/settings/system-users" target="_blank" rel="noopener noreferrer" className={styles.link}>
                        business.facebook.com
                      </a>
                      {' '}con permisos <code className={styles.codeInline}>ads_read</code>
                    </p>
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
                        {!realAccessToken && !isLoadingAccounts && (
                          <div className={styles.formActions}>
                            <Button
                              type="button"
                              variant="primary"
                              onClick={handleContinueWithToken}
                              disabled={isSavingToken || !credentials.accessToken || credentials.accessToken.length < 50}
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

                {/* 2. Cuenta de Anuncios */}
                {realAccessToken && (
                  <div className={styles.formGroup}>
                      <label className={styles.formLabel}>
                        Cuenta de anuncios <span style={{ color: 'var(--color-error)' }}>*</span>
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

                {/* 3. Pixel de Meta */}
                {credentials.adAccountId && (
                  <div className={styles.formGroup}>
                      <label className={styles.formLabel}>
                        Meta Pixel <span className={styles.formHint}>(opcional)</span>
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

                {/* 4. Pixel API Token */}
                {credentials.pixelId && (
                  <div className={styles.formGroup}>
                    <label className={styles.formLabel}>
                      Pixel API Token <span className={styles.formHint}>(opcional)</span>
                    </label>
                    <p className={styles.formHint} style={{ marginBottom: '8px' }}>
                      Solo si usas Conversions API. Genera desde{' '}
                      <a href="https://business.facebook.com/events_manager2" target="_blank" rel="noopener noreferrer" className={styles.link}>
                        Events Manager
                      </a>
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
                        <div className={styles.formActions}>
                          <Button
                            type="button"
                            variant="primary"
                            onClick={handleSavePixelApiToken}
                            disabled={isSavingPixelToken || !credentials.pixelApiToken}
                          >
                            <RefreshCw size={16} className={isSavingPixelToken ? styles.spinning : ''} />
                            {isSavingPixelToken ? 'Guardando...' : 'Guardar Pixel API Token'}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Switch para incluir Meta Pixel en snippet */}
                {credentials.pixelId && !isRenderDomain && (
                  <div className={styles.formGroup} style={{ marginTop: '32px', paddingTop: '32px', borderTop: '1px solid var(--color-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                      <div>
                        <label className={styles.formLabel} style={{ marginBottom: '4px' }}>
                          Incluir en snippet de tracking
                        </label>
                        <p className={styles.formHint} style={{ margin: 0, fontSize: '0.875rem' }}>
                          El snippet de Web Tracking incluirá automáticamente el código del Meta Pixel
                        </p>
                      </div>
                      <label className={styles.switchContainer}>
                        <input
                          type="checkbox"
                          checked={includeMetaPixel === true}
                          onChange={(e) => handleToggleMetaPixel(e.target.checked)}
                          disabled={isSyncingSnippet || savingPixelPref}
                          className={styles.switchInput}
                        />
                        <span className={styles.switchSlider}></span>
                      </label>
                    </div>
                    {isSyncingSnippet && (
                      <div style={{
                        marginTop: '12px',
                        padding: '12px',
                        background: 'var(--color-warning-bg)',
                        border: '1px solid var(--color-warning)',
                        borderRadius: '6px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px'
                      }}>
                        <RefreshCw size={16} className={styles.spinning} />
                        <span style={{ fontSize: '0.875rem' }}>Sincronizando snippet...</span>
                      </div>
                    )}
                  </div>
                )}

                {/* 5. Page ID - AL FINAL y completamente opcional */}
                {credentials.adAccountId && (
                  <div className={styles.formGroup} style={{ marginTop: '32px', paddingTop: '32px', borderTop: '1px solid var(--color-border)' }}>
                    <label className={styles.formLabel}>
                      Facebook Page ID <span className={styles.formHint}>(opcional)</span>
                    </label>
                    <p className={styles.formHint} style={{ marginBottom: '8px' }}>
                      Solo necesario si usas funciones específicas de páginas de Facebook
                    </p>
                    {savedPageId && credentials.pageId === savedPageId ? (
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
                      <>
                        <input
                          type="text"
                          value={credentials.pageId}
                          onChange={(e) => handleInputChange('pageId', e.target.value)}
                          placeholder="1234567890123456"
                          className={styles.formInput}
                        />
                        <div className={styles.formActions}>
                          <Button
                            type="button"
                            variant="primary"
                            onClick={handleSavePageId}
                            disabled={isSavingPageId || !credentials.pageId}
                          >
                            <RefreshCw size={16} className={isSavingPageId ? styles.spinning : ''} />
                            {isSavingPageId ? 'Guardando...' : 'Guardar Page ID'}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Sincronización manual de Meta Ads */}
                {credentials.accessToken && credentials.adAccountId && (
                  <div className={styles.formGroup} style={{ marginTop: '32px', paddingTop: '32px', borderTop: '1px solid var(--color-border)' }}>
                    <label className={styles.formLabel} style={{ marginBottom: '8px' }}>
                      Sincronización manual
                    </label>
                    <p className={styles.formHint} style={{ marginBottom: '16px' }}>
                      Sincroniza manualmente los datos de Meta Ads (últimos 35 meses). La sincronización automática ocurre cada hora.
                    </p>
                    <div className={styles.formActions}>
                      <Button
                        type="button"
                        variant="primary"
                        onClick={handleSyncMetaAds}
                        disabled={isSyncingMetaAds}
                      >
                        <RefreshCw size={18} className={isSyncingMetaAds ? styles.spinning : ''} />
                        {isSyncingMetaAds ? 'Sincronizando...' : 'Sincronizar datos de Meta Ads'}
                      </Button>
                    </div>
                  </div>
                )}
            </div>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.whatsappEventsHeader}>
            <div className={styles.whatsappEventsTitleGroup}>
              <span className={styles.whatsappEventsIcon} aria-hidden="true">
                <SiWhatsapp size={24} />
              </span>
              <div>
                <h3 className={styles.sectionTitle}>Eventos personalizados de WhatsApp</h3>
                <p className={styles.sectionDescription}>
                  Conversiones server-side para citas agendadas y primeros pagos.
                </p>
              </div>
            </div>
          </div>

          <div className={styles.whatsappEventsList}>
            <div className={styles.whatsappEventRow} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label className={styles.formLabel} style={{ marginBottom: '4px' }}>
                  WhatsApp Business Account ID
                </label>
                <p className={styles.formHint} style={{ margin: 0 }}>
                  Se envía como whatsapp_business_account_id en los eventos de Meta.
                </p>
              </div>
              <div className={styles.inputGroup} style={{ width: '100%' }}>
                <input
                  type="text"
                  value={whatsappBusinessAccountIdDraft}
                  onChange={(e) => setWhatsappBusinessAccountIdDraft(e.target.value)}
                  placeholder="123456789012345"
                  className={styles.formInput}
                />
                <Button
                  type="button"
                  onClick={handleSaveWhatsappBusinessAccountId}
                  disabled={
                    savingWhatsappBusinessAccountId ||
                    !whatsappBusinessAccountIdDraft.trim() ||
                    whatsappBusinessAccountIdDraft.trim() === whatsappBusinessAccountId
                  }
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    whiteSpace: 'nowrap'
                  }}
                >
                  <Save size={16} />
                  {savingWhatsappBusinessAccountId ? 'Guardando...' : 'Guardar'}
                </Button>
              </div>
            </div>

            <div className={styles.whatsappEventRow}>
              <div>
                <label className={styles.formLabel} style={{ marginBottom: '4px' }}>
                  Activar evento de cita agendada
                </label>
                <p className={styles.formHint} style={{ margin: 0 }}>
                  Envía LeadSubmitted una sola vez por contacto.
                </p>
              </div>
              <label className={styles.switchContainer}>
                <input
                  type="checkbox"
                  checked={whatsappScheduleEventEnabled === true}
                  onChange={(e) => handleToggleWhatsappScheduleEvent(e.target.checked)}
                  disabled={savingWhatsappScheduleEvent}
                  className={styles.switchInput}
                />
                <span className={styles.switchSlider}></span>
              </label>
            </div>

            <div className={styles.whatsappEventRow}>
              <div>
                <label className={styles.formLabel} style={{ marginBottom: '4px' }}>
                  Activar evento de pago recibido
                </label>
                <p className={styles.formHint} style={{ margin: 0 }}>
                  Envía Purchase una sola vez por contacto.
                </p>
              </div>
              <label className={styles.switchContainer}>
                <input
                  type="checkbox"
                  checked={whatsappPurchaseEventEnabled === true}
                  onChange={(e) => handleToggleWhatsappPurchaseEvent(e.target.checked)}
                  disabled={savingWhatsappPurchaseEvent}
                  className={styles.switchInput}
                />
                <span className={styles.switchSlider}></span>
              </label>
            </div>
          </div>
        </div>

      </Card>
    </div>
  )
}
