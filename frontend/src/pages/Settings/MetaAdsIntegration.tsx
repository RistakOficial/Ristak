import React, { useEffect, useRef, useState } from 'react'
import { Card, Button, Icon } from '@/components/common'
import { ArrowLeft, ArrowRight, CheckCircle, ExternalLink, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { useTheme } from '@/contexts/ThemeContext'
import { useAppConfig, useIsRenderDomain } from '@/hooks'
import { campaignsService } from '@/services/campaignsService'
import styles from './MetaAdsIntegration.module.css'

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

interface FetchCollectionResult {
  success: boolean
  count: number
}

type SecretTokenField = 'accessToken' | 'pixelApiToken'

const MASKED_SECRET_PREFIX = '***'
const SECRET_MASK_FILL = '*'.repeat(180)

const isMaskedSecretValue = (value = '') => value.trim().startsWith(MASKED_SECRET_PREFIX)

const getMaskedSecretTail = (value = '') => (
  isMaskedSecretValue(value)
    ? value.trim().slice(MASKED_SECRET_PREFIX.length)
    : value.trim()
)

export const MetaAdsIntegration: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true)
  const [credentials, setCredentials] = useState<MetaCredentials>({
    adAccountId: '',
    accessToken: '',
    pixelId: '',
    pageId: '',
    pixelApiToken: ''
  })
  const [adAccounts, setAdAccounts] = useState<AdAccount[]>([])
  const [pixels, setPixels] = useState<Pixel[]>([])
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false)
  const [isLoadingPixels, setIsLoadingPixels] = useState(false)
  const [realAccessToken, setRealAccessToken] = useState('')
  const [realPixelApiToken, setRealPixelApiToken] = useState('')
  const [isSavingToken, setIsSavingToken] = useState(false)
  const [isSavingPixelToken, setIsSavingPixelToken] = useState(false)
  const [isRevealingAccessToken, setIsRevealingAccessToken] = useState(false)
  const [isRevealingPixelApiToken, setIsRevealingPixelApiToken] = useState(false)
  const [isSavingPageId, setIsSavingPageId] = useState(false)
  const [savedPageId, setSavedPageId] = useState('')
  const [isSyncingSnippet, setIsSyncingSnippet] = useState(false)
  const [isSyncingMetaAds, setIsSyncingMetaAds] = useState(false)
  const [activeStep, setActiveStep] = useState(0)
  const accessTokenInputRef = useRef<HTMLInputElement>(null)
  const pixelApiTokenInputRef = useRef<HTMLInputElement>(null)

  const { showToast } = useNotification()
  const { theme } = useTheme()
  const isRenderDomain = useIsRenderDomain()
  const [includeMetaPixel, setIncludeMetaPixel, savingPixelPref] = useAppConfig('include_meta_pixel', true)
  const [whatsappScheduleEventEnabled, setWhatsappScheduleEventEnabled, savingWhatsappScheduleEvent] = useAppConfig('meta_whatsapp_schedule_enabled', false)
  const [whatsappPurchaseEventEnabled, setWhatsappPurchaseEventEnabled, savingWhatsappPurchaseEvent] = useAppConfig('meta_whatsapp_purchase_enabled', false)

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
        setSavedPageId(data.data.pageId || '')

        if (data.data.accessToken) {
          let tokenToUse = data.data.accessToken

          if (isMaskedSecretValue(data.data.accessToken)) {
            try {
              const revealResponse = await fetch('/api/meta/config/reveal/access_token')
              const revealData = await revealResponse.json()

              if (revealData.success && revealData.accessToken) {
                tokenToUse = revealData.accessToken
              }
            } catch {
              setIsLoading(false)
              return
            }
          }

          setRealAccessToken(tokenToUse)
          await fetchAdAccounts(tokenToUse, data.data.adAccountId, { silent: true })

          if (data.data.adAccountId) {
            const accountIdWithPrefix = data.data.adAccountId.startsWith('act_')
              ? data.data.adAccountId
              : `act_${data.data.adAccountId}`
            await fetchPixels(accountIdWithPrefix, tokenToUse, data.data.pixelId, { silent: true })
          }
        }

        if (data.data.pixelApiToken && !isMaskedSecretValue(data.data.pixelApiToken)) {
          setRealPixelApiToken(data.data.pixelApiToken)
        }
      }
    } catch {
    } finally {
      setIsLoading(false)
    }
  }

  const fetchAdAccounts = async (
    token: string,
    savedAdAccountId?: string,
    options: { silent?: boolean } = {}
  ): Promise<FetchCollectionResult> => {
    if (!token) {
      if (!options.silent) {
        showToast('error', 'Token requerido', 'Primero ingresa tu Access Token')
      }
      return { success: false, count: 0 }
    }

    setIsLoadingAccounts(true)
    try {
      const result = await campaignsService.fetchAdAccounts(token)
      if (result.success && result.adAccounts.length > 0) {
        setAdAccounts(result.adAccounts)

        if (savedAdAccountId) {
          const normalizedSavedId = savedAdAccountId.replace(/^act_/, '')
          const matchingAccount = result.adAccounts.find(acc =>
            acc.id.replace(/^act_/, '') === normalizedSavedId
          )

          if (matchingAccount) {
            setCredentials(prev => ({
              ...prev,
              adAccountId: matchingAccount.id.replace(/^act_/, '')
            }))
          }
        }

        if (!options.silent) {
          showToast('success', 'Cuentas cargadas', `Se encontraron ${result.adAccounts.length} cuentas de anuncios`)
        }

        return { success: true, count: result.adAccounts.length }
      }

      if (result.success) {
        if (!options.silent) {
          showToast('warning', 'Sin cuentas', 'No se encontraron cuentas de anuncios')
        }
        setAdAccounts([])
        return { success: true, count: 0 }
      } else {
        if (!options.silent) {
          showToast('error', 'Error', 'No se pudieron cargar las cuentas')
        }
        setAdAccounts([])
        return { success: false, count: 0 }
      }
    } catch {
      if (!options.silent) {
        showToast('error', 'Error', 'No se pudieron cargar las cuentas')
      }
      setAdAccounts([])
      return { success: false, count: 0 }
    } finally {
      setIsLoadingAccounts(false)
    }
  }

  const fetchPixels = async (
    adAccountId: string,
    token: string,
    savedPixelId?: string,
    options: { silent?: boolean } = {}
  ): Promise<FetchCollectionResult> => {
    if (!adAccountId || !token) {
      if (!options.silent) {
        showToast('error', 'Datos requeridos', 'Primero selecciona una cuenta de anuncios')
      }
      return { success: false, count: 0 }
    }

    setIsLoadingPixels(true)
    try {
      const result = await campaignsService.fetchPixels(adAccountId, token)

      if (result.success && result.pixels.length > 0) {
        setPixels(result.pixels)

        if (savedPixelId) {
          const matchingPixel = result.pixels.find(p => p.id === savedPixelId)
          if (matchingPixel) {
            setCredentials(prev => ({
              ...prev,
              pixelId: matchingPixel.id
            }))
          }
        }

        if (!options.silent) {
          showToast('success', 'Pixeles cargados', `Se encontraron ${result.pixels.length} pixeles`)
        }

        return { success: true, count: result.pixels.length }
      }

      if (result.success) {
        if (!options.silent) {
          showToast('info', 'Sin pixeles', 'No se encontraron pixeles para esta cuenta')
        }
        setPixels([])
        return { success: true, count: 0 }
      } else {
        if (!options.silent) {
          showToast('error', 'Error', 'No se pudieron cargar los pixeles')
        }
        setPixels([])
        return { success: false, count: 0 }
      }
    } catch {
      if (!options.silent) {
        showToast('error', 'Error', 'No se pudieron cargar los pixeles')
      }
      setPixels([])
      return { success: false, count: 0 }
    } finally {
      setIsLoadingPixels(false)
    }
  }

  const handleSelectAdAccount = (account: AdAccount) => {
    handleSelectAndSaveAccount(account)
  }

  const handleSelectPixel = (pixel: Pixel) => {
    handleSelectAndSavePixel(pixel)
  }

  const handleRemoveCredential = (field: keyof MetaCredentials) => {
    if (field === 'accessToken') {
      setCredentials({
        adAccountId: '',
        accessToken: '',
        pixelId: '',
        pageId: '',
        pixelApiToken: ''
      })
      setRealAccessToken('')
      setRealPixelApiToken('')
      setAdAccounts([])
      setPixels([])
      setSavedPageId('')
      setActiveStep(0)
    } else if (field === 'adAccountId') {
      setCredentials(prev => ({
        ...prev,
        adAccountId: '',
        pixelId: '',
        pixelApiToken: ''
      }))
      setRealPixelApiToken('')
      setPixels([])
      setActiveStep(1)
    } else if (field === 'pixelId') {
      setCredentials(prev => ({
        ...prev,
        pixelId: '',
        pixelApiToken: ''
      }))
      setRealPixelApiToken('')
      setActiveStep(2)
    } else if (field === 'pageId') {
      setCredentials(prev => ({ ...prev, pageId: '' }))
      setSavedPageId('')
    } else if (field === 'pixelApiToken') {
      setCredentials(prev => ({ ...prev, pixelApiToken: '' }))
      setRealPixelApiToken('')
    } else {
      setCredentials(prev => ({ ...prev, [field]: '' }))
    }
  }

  const handleInputChange = (field: keyof MetaCredentials, value: string) => {
    setCredentials(prev => ({ ...prev, [field]: value }))
  }

  const focusSecretInput = (field: SecretTokenField) => {
    const focusAndSelect = () => {
      const input = field === 'accessToken'
        ? accessTokenInputRef.current
        : pixelApiTokenInputRef.current

      input?.focus()
      input?.select()
    }

    window.setTimeout(focusAndSelect, 0)
    window.setTimeout(focusAndSelect, 80)
  }

  const handleEditStoredSecret = async (field: SecretTokenField) => {
    const isAccessToken = field === 'accessToken'
    let revealedToken = isAccessToken ? realAccessToken : realPixelApiToken

    if (!revealedToken) {
      if (isAccessToken) {
        setIsRevealingAccessToken(true)
      } else {
        setIsRevealingPixelApiToken(true)
      }

      try {
        const endpoint = isAccessToken
          ? '/api/meta/config/reveal/access_token'
          : '/api/meta/config/reveal/pixel_api_token'
        const response = await fetch(endpoint)
        const data = await response.json()

        revealedToken = isAccessToken ? data.accessToken : data.pixelApiToken

        if (!data.success || !revealedToken) {
          throw new Error(data.error || 'Token no disponible')
        }
      } catch {
        showToast(
          'error',
          'No se pudo revelar',
          isAccessToken ? 'No se pudo cargar el Access Token original' : 'No se pudo cargar el Pixel API Token original'
        )
        return
      } finally {
        if (isAccessToken) {
          setIsRevealingAccessToken(false)
        } else {
          setIsRevealingPixelApiToken(false)
        }
      }
    }

    if (isAccessToken) {
      setRealAccessToken(revealedToken)
    } else {
      setRealPixelApiToken(revealedToken)
    }

    setCredentials(prev => ({ ...prev, [field]: revealedToken }))
    focusSecretInput(field)
  }

  const handleSecretChipKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    field: SecretTokenField
  ) => {
    if (event.key !== 'Enter' && event.key !== ' ') return

    event.preventDefault()
    handleEditStoredSecret(field)
  }

  const renderMaskedSecretValue = (value: string, isRevealing: boolean) => (
    <span className={styles.secretTokenText}>
      {isRevealing ? (
        <span className={styles.secretRevealStatus}>Cargando token...</span>
      ) : (
        <>
          <span className={styles.secretMaskFill} aria-hidden="true">
            {SECRET_MASK_FILL}
          </span>
          <span className={styles.secretTokenTail}>{getMaskedSecretTail(value)}</span>
        </>
      )}
    </span>
  )

  const handleContinueWithToken = async () => {
    if (!credentials.accessToken || credentials.accessToken.length < 50) {
      showToast('error', 'Token inválido', 'El Access Token parece estar incompleto')
      return
    }

    setIsSavingToken(true)

    try {
      showToast('info', 'Validando token...', 'Cargando tus cuentas de anuncios')
      setRealAccessToken(credentials.accessToken)
      const accountsResult = await fetchAdAccounts(credentials.accessToken)

      if (!accountsResult.success) {
        setRealAccessToken('')
        return
      }

      if (accountsResult.count > 0) {
        showToast('success', 'Token válido', 'Selecciona tu cuenta de anuncios')
      }

      setActiveStep(1)
    } catch {
      showToast('error', 'Error', 'No se pudo validar el token o cargar las cuentas')
      setRealAccessToken('')
    } finally {
      setIsSavingToken(false)
    }
  }

  const handleSelectAndSaveAccount = async (account: AdAccount) => {
    const accountIdWithoutPrefix = account.id.replace(/^act_/, '')
    setCredentials(prev => ({ ...prev, adAccountId: accountIdWithoutPrefix }))

    try {
      const response = await fetch('/api/meta/save-and-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adAccountId: accountIdWithoutPrefix,
          accessToken: realAccessToken || credentials.accessToken,
          pixelId: credentials.pixelId,
          pageId: credentials.pageId,
          pixelApiToken: ''
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Cuenta guardada', `${account.name} configurada`)
        setActiveStep(2)
        if (realAccessToken) {
          fetchPixels(account.id, realAccessToken)
        }
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar la cuenta')
      }
    } catch {
      showToast('error', 'Error', 'No se pudo guardar la cuenta')
    }
  }

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
          pixelApiToken: ''
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Pixel guardado', `${pixel.name} configurado`)
        setActiveStep(3)
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar el pixel')
      }
    } catch {
      showToast('error', 'Error', 'No se pudo guardar el pixel')
    }
  }

  const handleSavePageId = async () => {
    if (!credentials.pageId) {
      showToast('error', 'Page ID requerido', 'Ingresa el Page ID primero')
      return
    }

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
          pixelId: credentials.pixelId || '',
          pageId: credentials.pageId,
          pixelApiToken: credentials.pixelApiToken || ''
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Page ID guardado', 'Configuración actualizada')
        setSavedPageId(credentials.pageId)
        await loadCredentials()
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar el Page ID')
      }
    } catch {
      showToast('error', 'Error', 'No se pudo guardar el Page ID')
    } finally {
      setIsSavingPageId(false)
    }
  }

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
        await loadCredentials()
        setActiveStep(4)
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar el Pixel API Token')
      }
    } catch {
      showToast('error', 'Error', 'No se pudo conectar con el servidor')
    } finally {
      setIsSavingPixelToken(false)
    }
  }

  const handleToggleMetaPixel = async (newValue: boolean) => {
    try {
      await setIncludeMetaPixel(newValue)

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
    } catch {
      showToast('error', 'Error', 'No se pudo actualizar el snippet')
    } finally {
      setIsSyncingSnippet(false)
    }
  }

  const handleToggleWhatsappScheduleEvent = async (newValue: boolean) => {
    if (newValue && !savedPageId) {
      showToast(
        'warning',
        'Page ID requerido',
        'Primero guarda el Facebook Page ID en el paso 5 para activar eventos personalizados de WhatsApp'
      )
      return
    }

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
    if (newValue && !savedPageId) {
      showToast(
        'warning',
        'Page ID requerido',
        'Primero guarda el Facebook Page ID en el paso 5 para activar eventos personalizados de WhatsApp'
      )
      return
    }

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
    } catch {
      showToast('error', 'Error', 'No se pudo conectar con el servidor')
    } finally {
      setIsSyncingMetaAds(false)
    }
  }

  const isMetaConfigured = Boolean(credentials.accessToken && credentials.adAccountId)
  const hasAccessToken = Boolean(realAccessToken || isMaskedSecretValue(credentials.accessToken))
  const hasAdAccount = Boolean(credentials.adAccountId)
  const hasPixel = Boolean(credentials.pixelId)
  const hasPixelApiToken = Boolean(credentials.pixelApiToken)
  const hasPageId = Boolean(savedPageId)
  const shouldShowAccessTokenAction = Boolean(
    credentials.accessToken &&
    !isMaskedSecretValue(credentials.accessToken) &&
    (!realAccessToken || credentials.accessToken !== realAccessToken)
  )
  const shouldShowPixelApiTokenAction = Boolean(
    credentials.pixelApiToken &&
    !isMaskedSecretValue(credentials.pixelApiToken) &&
    (!realPixelApiToken || credentials.pixelApiToken !== realPixelApiToken)
  )
  const metaSetupSteps = [
    {
      title: 'Access Token',
      description: 'System User Token',
      done: hasAccessToken,
      required: true,
      unlocked: true
    },
    {
      title: 'Cuenta de anuncios',
      description: 'Campañas y reportes',
      done: hasAdAccount,
      required: true,
      unlocked: hasAccessToken
    },
    {
      title: 'Meta Pixel',
      description: 'Medición web opcional',
      done: hasPixel,
      required: false,
      unlocked: hasAdAccount
    },
    {
      title: 'Pixel API Token',
      description: 'Conversions API',
      done: hasPixelApiToken,
      required: false,
      unlocked: hasPixel
    },
    {
      title: 'Facebook Page ID',
      description: 'Caja separada',
      done: hasPageId,
      required: false,
      unlocked: hasAdAccount
    }
  ]
  const completedMetaSetupSteps = metaSetupSteps.filter(step => step.done).length
  const hasRailActions = Boolean((credentials.pixelId && !isRenderDomain) || (credentials.accessToken && credentials.adAccountId))

  const getSelectedAdAccountLabel = () => {
    if (!credentials.adAccountId) return 'Pendiente'
    const normalizedId = credentials.adAccountId.replace(/^act_/, '')
    const matchingAccount = adAccounts.find(acc =>
      acc.id.replace(/^act_/, '') === normalizedId
    )

    return matchingAccount
      ? `${matchingAccount.name} (${normalizedId})`
      : normalizedId
  }

  const getSelectedPixelLabel = () => {
    if (!credentials.pixelId) return 'Opcional'
    const matchingPixel = pixels.find(p => p.id === credentials.pixelId)
    return matchingPixel ? `${matchingPixel.name} (${credentials.pixelId})` : credentials.pixelId
  }

  const getStepBlockMessage = (stepIndex = activeStep) => {
    if (stepIndex === 1 && !hasAccessToken) {
      return 'Primero valida el Access Token para cargar tus cuentas de anuncios'
    }

    if ((stepIndex === 2 || stepIndex === 4) && !hasAdAccount) {
      return 'Primero selecciona y guarda una cuenta de anuncios'
    }

    if (stepIndex === 3 && !hasPixel) {
      return 'Primero selecciona un Meta Pixel para guardar el Pixel API Token'
    }

    return 'Completa el paso anterior para continuar'
  }

  const handleNextStep = () => {
    const currentStep = metaSetupSteps[activeStep]

    if (!currentStep?.unlocked) {
      showToast('warning', 'Paso bloqueado', getStepBlockMessage(activeStep))
      return
    }

    if (currentStep.required && !currentStep.done) {
      showToast('warning', 'Falta un dato', getStepBlockMessage(activeStep + 1))
      return
    }

    if (activeStep === 2 && !hasPixel) {
      setActiveStep(4)
      return
    }

    setActiveStep(step => Math.min(step + 1, metaSetupSteps.length - 1))
  }

  const handlePreviousStep = () => {
    setActiveStep(step => step === 4 && !hasPixel ? 2 : Math.max(step - 1, 0))
  }

  const handleSelectStep = (stepIndex: number) => {
    const selectedStep = metaSetupSteps[stepIndex]

    if (!selectedStep?.unlocked) {
      showToast('warning', 'Paso bloqueado', getStepBlockMessage(stepIndex))
      return
    }

    setActiveStep(stepIndex)
  }

  const renderStepContent = () => {
    if (activeStep === 0) {
      return (
        <>
          <div className={styles.stepIntro}>
            <span className={styles.stepEyebrow}>Paso 1</span>
            <h3 className={styles.stepTitle}>Conecta el Access Token</h3>
            <p className={styles.stepText}>
              Genera un System User Token de Meta con permisos para leer campañas. Este token desbloquea la selección de cuenta de anuncios.
            </p>
            <a href="https://business.facebook.com/settings/system-users" target="_blank" rel="noopener noreferrer" className={styles.inlineDocLink}>
              Abrir Business Settings
              <ExternalLink size={14} />
            </a>
          </div>

          <div className={`${styles.formGroup} ${styles.formGroupWide}`}>
            <span id="metaAccessTokenLabel" className={styles.formLabel}>Access Token</span>
            {credentials.accessToken && isMaskedSecretValue(credentials.accessToken) ? (
              <div
                className={`${styles.filterChip} ${styles.secretTokenChip}`}
                onClick={() => handleEditStoredSecret('accessToken')}
                onKeyDown={(event) => handleSecretChipKeyDown(event, 'accessToken')}
                role="button"
                tabIndex={0}
                aria-label="Mostrar y editar Access Token"
                title="Mostrar y editar Access Token"
              >
                {renderMaskedSecretValue(credentials.accessToken, isRevealingAccessToken)}
                <button
                  onClick={(event) => {
                    event.stopPropagation()
                    handleRemoveCredential('accessToken')
                  }}
                  className={styles.chipDeleteButton}
                  type="button"
                  aria-label="Eliminar Access Token"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ) : (
              <div className={styles.inputActionRow}>
                <input
                  id="metaAccessToken"
                  ref={accessTokenInputRef}
                  type="text"
                  value={credentials.accessToken}
                  onChange={(event) => handleInputChange('accessToken', event.target.value)}
                  placeholder="EAAabcdef..."
                  className={`${styles.formInput} ${styles.secretTokenInput}`}
                  aria-labelledby="metaAccessTokenLabel"
                  autoComplete="off"
                  spellCheck={false}
                />
                {shouldShowAccessTokenAction && !isLoadingAccounts && (
                  <Button
                    type="button"
                    variant="primary"
                    onClick={handleContinueWithToken}
                    disabled={isSavingToken || !credentials.accessToken || credentials.accessToken.length < 50}
                  >
                    {isSavingToken ? 'Guardando...' : realAccessToken ? 'Actualizar' : 'Continuar'}
                  </Button>
                )}
              </div>
            )}
          </div>

          {isLoadingAccounts && (
            <div className={styles.inlineStatus}>
              <RefreshCw size={14} className={styles.spinning} />
              Cargando cuentas de anuncios...
            </div>
          )}
        </>
      )
    }

    if (activeStep === 1) {
      return (
        <>
          <div className={styles.stepIntro}>
            <span className={styles.stepEyebrow}>Paso 2</span>
            <h3 className={styles.stepTitle}>Selecciona la cuenta de anuncios</h3>
            <p className={styles.stepText}>
              Esta cuenta alimenta campañas, costos y reportes. Al seleccionarla se guarda automáticamente y se cargan los pixeles disponibles.
            </p>
          </div>

          {!hasAccessToken ? (
            <p className={styles.stepHint}>{getStepBlockMessage(1)}</p>
          ) : (
            <label className={`${styles.formGroup} ${styles.formGroupWide}`}>
              <span className={styles.formLabel}>Cuenta de anuncios</span>
              {credentials.adAccountId ? (
                <div className={styles.filterChip}>
                  <span className={styles.chipText}>{getSelectedAdAccountLabel()}</span>
                  <button
                    onClick={() => {
                      handleRemoveCredential('adAccountId')
                      setPixels([])
                    }}
                    className={styles.chipDeleteButton}
                    type="button"
                    aria-label="Eliminar cuenta de anuncios"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ) : adAccounts.length > 0 ? (
                <select
                  className={styles.formInput}
                  onChange={(event) => {
                    const account = adAccounts.find(a => a.id === event.target.value)
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
                  onChange={(event) => handleInputChange('adAccountId', event.target.value)}
                  placeholder="act_123456789012345"
                  className={styles.formInput}
                />
              )}
            </label>
          )}
        </>
      )
    }

    if (activeStep === 2) {
      return (
        <>
          <div className={styles.stepIntro}>
            <span className={styles.stepEyebrow}>Paso 3</span>
            <h3 className={styles.stepTitle}>Elige el Meta Pixel</h3>
            <p className={styles.stepText}>
              Es opcional para conectar Meta Ads, pero necesario si quieres incluir el pixel en el snippet o usar Conversions API.
            </p>
          </div>

          {!hasAdAccount ? (
            <p className={styles.stepHint}>{getStepBlockMessage(2)}</p>
          ) : (
            <>
              <label className={`${styles.formGroup} ${styles.formGroupWide}`}>
                <span className={styles.formLabel}>Meta Pixel</span>
                {credentials.pixelId ? (
                  <div className={styles.filterChip}>
                    <span className={styles.chipText}>{getSelectedPixelLabel()}</span>
                    <button
                      onClick={() => handleRemoveCredential('pixelId')}
                      className={styles.chipDeleteButton}
                      type="button"
                      aria-label="Eliminar Meta Pixel"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ) : isLoadingPixels ? (
                  <div className={styles.inlineStatus}>
                    <RefreshCw size={14} className={styles.spinning} />
                    Cargando pixeles...
                  </div>
                ) : pixels.length > 0 ? (
                  <select
                    className={styles.formInput}
                    onChange={(event) => {
                      const pixel = pixels.find(p => p.id === event.target.value)
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
                    onChange={(event) => handleInputChange('pixelId', event.target.value)}
                    placeholder="1234567890123456"
                    className={styles.formInput}
                  />
                )}
              </label>
              <p className={styles.stepHint}>
                Si no necesitas pixel por ahora, puedes saltar directo al Facebook Page ID.
              </p>
            </>
          )}
        </>
      )
    }

    if (activeStep === 3) {
      return (
        <>
          <div className={styles.stepIntro}>
            <span className={styles.stepEyebrow}>Paso 4</span>
            <h3 className={styles.stepTitle}>Guarda el Pixel API Token</h3>
            <p className={styles.stepText}>
              Este token sólo aplica si usas Conversions API. Se guarda separado para no mezclarlo con el Access Token principal.
            </p>
            <a href="https://business.facebook.com/events_manager2" target="_blank" rel="noopener noreferrer" className={styles.inlineDocLink}>
              Abrir Events Manager
              <ExternalLink size={14} />
            </a>
          </div>

          {!hasPixel ? (
            <p className={styles.stepHint}>{getStepBlockMessage(3)}</p>
          ) : (
            <div className={`${styles.formGroup} ${styles.formGroupWide}`}>
              <span id="metaPixelApiTokenLabel" className={styles.formLabel}>Pixel API Token</span>
              {credentials.pixelApiToken && isMaskedSecretValue(credentials.pixelApiToken) ? (
                <div
                  className={`${styles.filterChip} ${styles.secretTokenChip}`}
                  onClick={() => handleEditStoredSecret('pixelApiToken')}
                  onKeyDown={(event) => handleSecretChipKeyDown(event, 'pixelApiToken')}
                  role="button"
                  tabIndex={0}
                  aria-label="Mostrar y editar Pixel API Token"
                  title="Mostrar y editar Pixel API Token"
                >
                  {renderMaskedSecretValue(credentials.pixelApiToken, isRevealingPixelApiToken)}
                  <button
                    onClick={(event) => {
                      event.stopPropagation()
                      handleRemoveCredential('pixelApiToken')
                    }}
                    className={styles.chipDeleteButton}
                    type="button"
                    aria-label="Eliminar Pixel API Token"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ) : (
                <div className={styles.inputActionRow}>
                  <input
                    id="metaPixelApiToken"
                    ref={pixelApiTokenInputRef}
                    type="text"
                    value={credentials.pixelApiToken}
                    onChange={(event) => handleInputChange('pixelApiToken', event.target.value)}
                    placeholder="Pega aquí el token generado desde Events Manager"
                    className={`${styles.formInput} ${styles.secretTokenInput}`}
                    aria-labelledby="metaPixelApiTokenLabel"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {shouldShowPixelApiTokenAction && (
                    <Button
                      type="button"
                      variant="primary"
                      onClick={handleSavePixelApiToken}
                      disabled={isSavingPixelToken || !credentials.pixelApiToken}
                    >
                      <RefreshCw size={16} className={isSavingPixelToken ? styles.spinning : ''} />
                      {isSavingPixelToken ? 'Guardando...' : realPixelApiToken ? 'Actualizar' : 'Guardar'}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )
    }

    return (
      <>
        <div className={styles.stepIntro}>
          <span className={styles.stepEyebrow}>Paso 5</span>
          <h3 className={styles.stepTitle}>Guarda el Facebook Page ID</h3>
          <p className={styles.stepText}>
            Esta es la caja separada para Page ID dentro del wizard de Meta Ads. Es opcional para anuncios, pero necesaria para eventos personalizados ligados a Facebook Page.
          </p>
          <a href="https://business.facebook.com/latest/settings/pages" target="_blank" rel="noopener noreferrer" className={styles.inlineDocLink}>
            Abrir páginas en Meta Business
            <ExternalLink size={14} />
          </a>
        </div>

        {!hasAdAccount ? (
          <p className={styles.stepHint}>{getStepBlockMessage(4)}</p>
        ) : (
          <label className={`${styles.formGroup} ${styles.formGroupWide}`}>
            <span className={styles.formLabel}>Facebook Page ID</span>
            {savedPageId && credentials.pageId === savedPageId ? (
              <div className={styles.filterChip}>
                <span className={styles.chipText}>{credentials.pageId}</span>
                <button
                  onClick={() => handleRemoveCredential('pageId')}
                  className={styles.chipDeleteButton}
                  type="button"
                  aria-label="Eliminar Page ID"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ) : (
              <div className={styles.inputActionRow}>
                <input
                  type="text"
                  value={credentials.pageId}
                  onChange={(event) => handleInputChange('pageId', event.target.value)}
                  placeholder="1234567890123456"
                  className={styles.formInput}
                />
                <Button
                  type="button"
                  variant="primary"
                  onClick={handleSavePageId}
                  disabled={isSavingPageId || !credentials.pageId}
                >
                  <RefreshCw size={16} className={isSavingPageId ? styles.spinning : ''} />
                  {isSavingPageId ? 'Guardando...' : 'Guardar'}
                </Button>
              </div>
            )}
          </label>
        )}
      </>
    )
  }

  return (
    <div className={styles.container}>
      <Card className={styles.mainCard}>
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerLeft}>
              <span className={styles.logoMark} aria-hidden="true">
                <img
                  src={theme === 'light'
                    ? 'https://img.icons8.com/fluency/96/meta.png'
                    : 'https://img.icons8.com/ios-filled/150/FFFFFF/meta.png'
                  }
                  alt=""
                />
              </span>
              <div>
                <h2 className={styles.pageTitle}>Meta Ads</h2>
                <p className={styles.pageSubtitle}>
                  Sigue el wizard y conecta cuenta, pixel y Page ID sin mezclar campos.
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

        <div className={styles.workspace}>
          <div className={styles.primaryColumn}>
            <section className={`${styles.section} ${styles.wizardSection}`}>
              <div className={styles.sectionHeader}>
                <div>
                  <h3 className={styles.sectionTitle}>Wizard de configuración</h3>
                  <p className={styles.sectionDescription}>
                    Avanza por pasos. Los opcionales no bloquean el Page ID.
                  </p>
                </div>
                <span className={styles.stepCount}>{completedMetaSetupSteps}/5 listo</span>
              </div>

              <div className={styles.wizardShell}>
                <div className={styles.progressList} aria-label="Progreso de configuración de Meta">
                  {metaSetupSteps.map((step, index) => (
                    <button
                      key={step.title}
                      type="button"
                      className={[
                        styles.progressItem,
                        step.done ? styles.progressDone : '',
                        index === activeStep ? styles.progressActive : '',
                        !step.unlocked ? styles.progressLocked : ''
                      ].filter(Boolean).join(' ')}
                      onClick={() => handleSelectStep(index)}
                      disabled={!step.unlocked}
                    >
                      <span className={styles.progressDot}>
                        {step.done ? <CheckCircle size={13} /> : index + 1}
                      </span>
                      <span className={styles.progressCopy}>
                        <span className={styles.progressLabel}>{step.title}</span>
                        <span className={styles.progressDescription}>{step.description}</span>
                      </span>
                    </button>
                  ))}
                </div>

                <div className={styles.stepPanel}>
                  {isLoading ? (
                    <div className={styles.loadingState}>Cargando credenciales...</div>
                  ) : (
                    <>
                      {renderStepContent()}

                      <div className={styles.stepActions}>
                        <Button type="button" variant="secondary" onClick={handlePreviousStep} disabled={activeStep === 0}>
                          <ArrowLeft size={16} />
                          Atrás
                        </Button>
                        {activeStep < metaSetupSteps.length - 1 && (
                          <Button type="button" variant="secondary" onClick={handleNextStep}>
                            {activeStep === 2 && !hasPixel ? 'Saltar a Page ID' : 'Siguiente'}
                            <ArrowRight size={16} />
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </section>

            <section className={`${styles.section} ${styles.eventSection}`}>
              <div className={styles.sectionHeader}>
                <div>
                  <div className={styles.sectionTitleRow}>
                    <span className={`${styles.sectionIcon} ${styles.whatsappSectionIcon}`} aria-hidden="true">
                      <Icon name="whatsapp" size={18} />
                    </span>
                    <h3 className={styles.sectionTitle}>Eventos personalizados de WhatsApp</h3>
                  </div>
                  <p className={styles.sectionDescription}>
                    Envía conversiones server-side cuando entren eventos desde WhatsApp.
                  </p>
                </div>
              </div>

              <div className={styles.eventRows}>
                <div className={[
                  styles.eventRow,
                  !hasPageId ? styles.eventRowLocked : ''
                ].filter(Boolean).join(' ')}>
                  <div>
                    <span className={styles.railSwitchLabel}>Cita agendada</span>
                    <span className={styles.railSecondaryValue}>LeadSubmitted una sola vez por contacto.</span>
                    {!hasPageId && (
                      <span className={styles.requirementPill}>Requiere Page ID</span>
                    )}
                  </div>
                  <label className={styles.switchContainer}>
                    <input
                      type="checkbox"
                      checked={whatsappScheduleEventEnabled === true}
                      onChange={(event) => handleToggleWhatsappScheduleEvent(event.target.checked)}
                      disabled={savingWhatsappScheduleEvent}
                      className={styles.switchInput}
                    />
                    <span className={styles.switchSlider}></span>
                  </label>
                </div>

                <div className={[
                  styles.eventRow,
                  !hasPageId ? styles.eventRowLocked : ''
                ].filter(Boolean).join(' ')}>
                  <div>
                    <span className={styles.railSwitchLabel}>Pago recibido</span>
                    <span className={styles.railSecondaryValue}>Purchase una sola vez por contacto.</span>
                    {!hasPageId && (
                      <span className={styles.requirementPill}>Requiere Page ID</span>
                    )}
                  </div>
                  <label className={styles.switchContainer}>
                    <input
                      type="checkbox"
                      checked={whatsappPurchaseEventEnabled === true}
                      onChange={(event) => handleToggleWhatsappPurchaseEvent(event.target.checked)}
                      disabled={savingWhatsappPurchaseEvent}
                      className={styles.switchInput}
                    />
                    <span className={styles.switchSlider}></span>
                  </label>
                </div>
              </div>
            </section>
          </div>

          <aside className={styles.statusRail}>
            <div className={styles.railBlock}>
              <div className={styles.railHeader}>
                <CheckCircle size={18} />
                <span>Estado Meta</span>
              </div>
              <strong className={styles.railPrimaryValue}>
                {isMetaConfigured ? 'Configuración activa' : 'Configuración pendiente'}
              </strong>
              <span className={styles.railSecondaryValue}>
                {isMetaConfigured ? 'Cuenta lista para reportes y sincronización.' : 'Completa Access Token y cuenta de anuncios.'}
              </span>
              <div className={styles.railMeta}>
                <span>Token</span>
                <strong>{hasAccessToken ? 'Listo' : '-'}</strong>
                <span>Cuenta</span>
                <strong>{hasAdAccount ? getSelectedAdAccountLabel() : '-'}</strong>
                <span>Pixel</span>
                <strong>{hasPixel ? getSelectedPixelLabel() : '-'}</strong>
                <span>CAPI</span>
                <strong>{hasPixelApiToken ? 'Listo' : '-'}</strong>
                <span>Page ID</span>
                <strong>{hasPageId ? savedPageId : '-'}</strong>
              </div>
            </div>

            <div className={styles.railBlock}>
              <div className={styles.railHeader}>
                <RefreshCw size={18} />
                <span>Extras</span>
              </div>

              {credentials.pixelId && !isRenderDomain && (
                <div className={styles.railSwitchRow}>
                  <div>
                    <span className={styles.railSwitchLabel}>Incluir en snippet</span>
                    <span className={styles.railSecondaryValue}>Agrega el Meta Pixel al Web Tracking.</span>
                  </div>
                  <label className={styles.switchContainer}>
                    <input
                      type="checkbox"
                      checked={includeMetaPixel === true}
                      onChange={(event) => handleToggleMetaPixel(event.target.checked)}
                      disabled={isSyncingSnippet || savingPixelPref}
                      className={styles.switchInput}
                    />
                    <span className={styles.switchSlider}></span>
                  </label>
                </div>
              )}

              {isSyncingSnippet && (
                <div className={styles.inlineStatus}>
                  <RefreshCw size={16} className={styles.spinning} />
                  Sincronizando snippet...
                </div>
              )}

              {credentials.accessToken && credentials.adAccountId && (
                <button
                  type="button"
                  className={styles.railButton}
                  onClick={handleSyncMetaAds}
                  disabled={isSyncingMetaAds}
                >
                  <RefreshCw size={16} className={isSyncingMetaAds ? styles.spinning : ''} />
                  {isSyncingMetaAds ? 'Sincronizando' : 'Sincronizar Meta Ads'}
                </button>
              )}

              {!hasRailActions && (
                <span className={styles.railSecondaryValue}>
                  Completa el flujo principal para activar estas acciones.
                </span>
              )}
            </div>
          </aside>
        </div>
      </Card>
    </div>
  )
}
