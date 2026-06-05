import React, { useEffect, useRef, useState } from 'react'
import { Card, Button, Icon, Modal } from '@/components/common'
import { ArrowLeft, ArrowRight, CheckCircle, ExternalLink, Pencil, Power, RefreshCw, Trash2, XCircle } from 'lucide-react'
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

interface MetaPage {
  id: string
  name: string
  category: string | null
  pictureUrl: string | null
}

interface FetchCollectionResult {
  success: boolean
  count: number
}

type SecretTokenField = 'accessToken'

const MASKED_SECRET_PREFIX = '***'
const SECRET_MASK_FILL = '*'.repeat(180)

const isMaskedSecretValue = (value = '') => value.trim().startsWith(MASKED_SECRET_PREFIX)

const getMaskedSecretTail = (value = '') => (
  isMaskedSecretValue(value)
    ? value.trim().slice(MASKED_SECRET_PREFIX.length)
    : value.trim()
)

const tokenSetupGuideSteps = [
  {
    title: 'Entra al portafolio comercial',
    body: 'Abre Configuración del negocio en Meta, entra al portafolio comercial correcto y ve a Apps. Desde ahí crea una aplicación nueva.'
  },
  {
    title: 'Crea la app en Meta Developers',
    body: 'Cuando Meta te mande a Developers, elige la opción de Meta API para anuncios, llena el formulario básico y deja la app asociada al mismo portafolio comercial.'
  },
  {
    title: 'Crea el usuario del sistema',
    body: 'Regresa a Configuración del negocio, entra a Usuarios del sistema y crea uno llamado Ristak. Déjalo sin rol si Meta muestra esa opción; los accesos reales se dan en activos.'
  },
  {
    title: 'Asigna activos',
    body: 'En Añadir activos agrega la Página que hará publicidad, la cuenta publicitaria, la app recién creada, el conjunto de datos o pixel, Instagram si aplica, y concede acceso de administración donde Meta lo pida.'
  },
  {
    title: 'Genera el token',
    body: 'En Generar token elige la app nueva, selecciona expiración Nunca y marca los permisos necesarios. Copia el token completo y pégalo abajo.'
  }
]

const tokenSetupScopes = ['ads_management', 'ads_read', 'business_management', 'pages_show_list']

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
  const [pages, setPages] = useState<MetaPage[]>([])
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false)
  const [isLoadingPixels, setIsLoadingPixels] = useState(false)
  const [isLoadingPages, setIsLoadingPages] = useState(false)
  const [realAccessToken, setRealAccessToken] = useState('')
  const [isSavingToken, setIsSavingToken] = useState(false)
  const [isRevealingAccessToken, setIsRevealingAccessToken] = useState(false)
  const [isSavingPageId, setIsSavingPageId] = useState(false)
  const [savedPageId, setSavedPageId] = useState('')
  const [isSyncingSnippet, setIsSyncingSnippet] = useState(false)
  const [isSyncingMetaAds, setIsSyncingMetaAds] = useState(false)
  const [isEditingMetaConfig, setIsEditingMetaConfig] = useState(false)
  const [isDisconnectModalOpen, setIsDisconnectModalOpen] = useState(false)
  const [isDisconnectingMeta, setIsDisconnectingMeta] = useState(false)
  const [activeStep, setActiveStep] = useState(0)
  const accessTokenInputRef = useRef<HTMLInputElement>(null)

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
          await fetchPages(tokenToUse, data.data.pageId, { silent: true })

          if (data.data.adAccountId) {
            const accountIdWithPrefix = data.data.adAccountId.startsWith('act_')
              ? data.data.adAccountId
              : `act_${data.data.adAccountId}`
            await fetchPixels(accountIdWithPrefix, tokenToUse, data.data.pixelId, { silent: true })
          }
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

  const fetchPages = async (
    token: string,
    savedPageId?: string,
    options: { silent?: boolean } = {}
  ): Promise<FetchCollectionResult> => {
    if (!token) {
      if (!options.silent) {
        showToast('error', 'Token requerido', 'Primero ingresa tu Access Token')
      }
      return { success: false, count: 0 }
    }

    setIsLoadingPages(true)
    try {
      const result = await campaignsService.fetchPages(token)

      if (result.success && result.pages.length > 0) {
        setPages(result.pages)

        if (savedPageId) {
          const matchingPage = result.pages.find(page => page.id === savedPageId)
          if (matchingPage) {
            setCredentials(prev => ({
              ...prev,
              pageId: matchingPage.id
            }))
          }
        }

        if (!options.silent) {
          showToast('success', 'Páginas cargadas', `Se encontraron ${result.pages.length} páginas`)
        }

        return { success: true, count: result.pages.length }
      }

      setPages([])
      if (!options.silent) {
        showToast('warning', 'Sin páginas', 'Revisa que el token tenga pages_show_list y la Página asignada al usuario del sistema')
      }
      return { success: result.success, count: 0 }
    } catch {
      setPages([])
      if (!options.silent) {
        showToast('error', 'Error', 'No se pudieron cargar las páginas')
      }
      return { success: false, count: 0 }
    } finally {
      setIsLoadingPages(false)
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
      setAdAccounts([])
      setPixels([])
      setPages([])
      setSavedPageId('')
      setActiveStep(0)
    } else if (field === 'adAccountId') {
      setCredentials(prev => ({
        ...prev,
        adAccountId: '',
        pixelId: '',
        pixelApiToken: ''
      }))
      setPixels([])
      setActiveStep(1)
    } else if (field === 'pixelId') {
      setCredentials(prev => ({
        ...prev,
        pixelId: '',
        pixelApiToken: ''
      }))
      setActiveStep(2)
    } else if (field === 'pageId') {
      setCredentials(prev => ({ ...prev, pageId: '' }))
      setSavedPageId('')
    } else if (field === 'pixelApiToken') {
      setCredentials(prev => ({ ...prev, pixelApiToken: '' }))
    } else {
      setCredentials(prev => ({ ...prev, [field]: '' }))
    }
  }

  const handleInputChange = (field: keyof MetaCredentials, value: string) => {
    setCredentials(prev => ({ ...prev, [field]: value }))
  }

  const focusSecretInput = (field: SecretTokenField) => {
    const focusAndSelect = () => {
      const input = accessTokenInputRef.current

      input?.focus()
      input?.select()
    }

    window.setTimeout(focusAndSelect, 0)
    window.setTimeout(focusAndSelect, 80)
  }

  const handleEditStoredSecret = async (field: SecretTokenField) => {
    let revealedToken = realAccessToken

    if (!revealedToken) {
      setIsRevealingAccessToken(true)

      try {
        const response = await fetch('/api/meta/config/reveal/access_token')
        const data = await response.json()

        revealedToken = data.accessToken

        if (!data.success || !revealedToken) {
          throw new Error(data.error || 'Token no disponible')
        }
      } catch {
        showToast(
          'error',
          'No se pudo revelar',
          'No se pudo cargar el Access Token original'
        )
        return
      } finally {
        setIsRevealingAccessToken(false)
      }
    }

    setRealAccessToken(revealedToken)

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

  const resetLocalMetaState = () => {
    setCredentials({
      adAccountId: '',
      accessToken: '',
      pixelId: '',
      pageId: '',
      pixelApiToken: ''
    })
    setAdAccounts([])
    setPixels([])
    setPages([])
    setRealAccessToken('')
    setSavedPageId('')
    setActiveStep(0)
    setIsEditingMetaConfig(false)
  }

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

      await fetchPages(credentials.accessToken, credentials.pageId, { silent: true })

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
        const token = realAccessToken || credentials.accessToken
        if (token) {
          fetchPixels(account.id, token)
          fetchPages(token, credentials.pageId, { silent: true })
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
        await loadCredentials()
        setActiveStep(3)
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar el pixel')
      }
    } catch {
      showToast('error', 'Error', 'No se pudo guardar el pixel')
    }
  }

  const savePageId = async (pageId: string) => {
    if (!pageId) {
      showToast('error', 'Facebook Page requerida', 'Selecciona una Página primero')
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
          pageId,
          pixelApiToken: credentials.pixelApiToken || ''
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Meta conectado', 'La configuración quedó guardada')
        setSavedPageId(pageId)
        setCredentials(prev => ({ ...prev, pageId }))
        await loadCredentials()
        setIsEditingMetaConfig(false)
        void syncMetaAds({ automatic: true })
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar el Page ID')
      }
    } catch {
      showToast('error', 'Error', 'No se pudo guardar el Page ID')
    } finally {
      setIsSavingPageId(false)
    }
  }

  const handleSelectAndSavePage = async (page: MetaPage) => {
    setCredentials(prev => ({ ...prev, pageId: page.id }))
    await savePageId(page.id)
  }

  const handleFinishWizard = () => {
    if (!hasPageId) {
      showToast('warning', 'Falta Facebook Page', 'Selecciona y guarda una Página para terminar')
      return
    }

    setIsEditingMetaConfig(false)
  }

  const handleEditMetaConfig = () => {
    setIsEditingMetaConfig(true)
    setActiveStep(0)
  }

  const handleDisconnectMetaConfig = async () => {
    setIsDisconnectingMeta(true)

    try {
      const response = await fetch('/api/meta/config', {
        method: 'DELETE'
      })
      const data = await response.json()

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'No se pudo eliminar la configuración')
      }

      await Promise.all([
        setWhatsappScheduleEventEnabled(false),
        setWhatsappPurchaseEventEnabled(false)
      ])

      resetLocalMetaState()
      setIsDisconnectModalOpen(false)
      showToast('success', 'Meta desconectado', 'La configuración actual fue eliminada')
    } catch (error) {
      showToast('error', 'Error', error instanceof Error ? error.message : 'No se pudo desconectar Meta')
    } finally {
      setIsDisconnectingMeta(false)
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
        'Facebook Page requerida',
        'Primero selecciona la Facebook Page en el paso 4 para activar eventos personalizados de WhatsApp'
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
        'Facebook Page requerida',
        'Primero selecciona la Facebook Page en el paso 4 para activar eventos personalizados de WhatsApp'
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

  const syncMetaAds = async (options: { automatic?: boolean } = {}) => {
    if (isSyncingMetaAds) return

    setIsSyncingMetaAds(true)
    showToast(
      'info',
      options.automatic ? 'Sincronizando Meta' : 'Sincronizando...',
      options.automatic
        ? 'Ya quedó conectado; estamos trayendo los datos de Meta automáticamente'
        : 'Iniciando sincronización de Meta Ads (últimos 35 meses)'
    )

    try {
      const result = await campaignsService.syncMetaAds()

      if (result.success) {
        showToast(
          'success',
          options.automatic ? 'Sincronización automática iniciada' : 'Sincronización iniciada',
          result.message || 'La sincronización de Meta Ads fue iniciada en segundo plano'
        )
      } else {
        showToast(
          'error',
          options.automatic ? 'Meta conectado, pero falta sincronizar' : 'Error al sincronizar',
          result.error || 'No se pudo completar la sincronización'
        )
      }
    } catch {
      showToast('error', 'Error', 'No se pudo conectar con el servidor')
    } finally {
      setIsSyncingMetaAds(false)
    }
  }

  const handleSyncMetaAds = () => {
    void syncMetaAds()
  }

  const hasAccessToken = Boolean(realAccessToken || isMaskedSecretValue(credentials.accessToken))
  const hasAdAccount = Boolean(credentials.adAccountId)
  const hasPixel = Boolean(credentials.pixelId)
  const hasPageId = Boolean(savedPageId)
  const isMetaConfigured = Boolean(hasAccessToken && hasAdAccount && hasPageId)
  const shouldShowWizard = !isMetaConfigured || isEditingMetaConfig
  const shouldShowAccessTokenAction = Boolean(
    credentials.accessToken &&
    !isMaskedSecretValue(credentials.accessToken) &&
    (!realAccessToken || credentials.accessToken !== realAccessToken)
  )
  const metaSetupSteps = [
    {
      title: 'Token',
      description: 'App y System User',
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
      title: 'Facebook Page',
      description: 'Selector automático',
      done: hasPageId,
      required: false,
      unlocked: hasAdAccount
    }
  ]
  const completedMetaSetupSteps = metaSetupSteps.filter(step => step.done).length
  const hasRailActions = Boolean((credentials.pixelId && !isRenderDomain) || (credentials.accessToken && credentials.adAccountId))
  const shouldShowStepActions = activeStep > 0 || (
    activeStep === 0 &&
    hasAccessToken &&
    !shouldShowAccessTokenAction &&
    !isSavingToken &&
    !isLoadingAccounts
  )

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

  const getSelectedPageLabel = () => {
    if (!credentials.pageId && !savedPageId) return 'Opcional'
    const pageId = credentials.pageId || savedPageId
    const matchingPage = pages.find(page => page.id === pageId)
    return matchingPage ? `${matchingPage.name} (${pageId})` : pageId
  }

  const getStepBlockMessage = (stepIndex = activeStep) => {
    if (stepIndex === 1 && !hasAccessToken) {
      return 'Primero valida el Access Token para cargar tus cuentas de anuncios'
    }

    if ((stepIndex === 2 || stepIndex === 3) && !hasAdAccount) {
      return 'Primero selecciona y guarda una cuenta de anuncios'
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
      setActiveStep(3)
      return
    }

    setActiveStep(step => Math.min(step + 1, metaSetupSteps.length - 1))
  }

  const handlePreviousStep = () => {
    setActiveStep(step => step === 3 && !hasPixel ? 2 : Math.max(step - 1, 0))
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
            <h3 className={styles.stepTitle}>Crea la app y pega el token</h3>
            <p className={styles.stepText}>
              El token debe salir de un usuario del sistema dentro del mismo portafolio comercial. Si ese usuario tiene la cuenta publicitaria, la Página y el dataset asignados, este único token sirve para reportes y Conversions API.
            </p>
          </div>

          <div className={styles.setupGuide}>
            <div className={styles.guideLinks}>
              <a href="https://business.facebook.com/settings/apps" target="_blank" rel="noopener noreferrer" className={styles.inlineDocLink}>
                Apps del portafolio
                <ExternalLink size={14} />
              </a>
              <a href="https://business.facebook.com/settings/system-users" target="_blank" rel="noopener noreferrer" className={styles.inlineDocLink}>
                Usuarios del sistema
                <ExternalLink size={14} />
              </a>
            </div>

            <ol className={styles.guideList}>
              {tokenSetupGuideSteps.map((step, index) => (
                <li key={step.title} className={styles.guideItem}>
                  <span className={styles.guideNumber}>{index + 1}</span>
                  <div className={styles.guideCopy}>
                    <strong>{step.title}</strong>
                    <span>{step.body}</span>
                  </div>
                </li>
              ))}
            </ol>

            <div className={styles.scopeBlock}>
              <span className={styles.scopeBlockLabel}>Permisos del token</span>
              <div className={styles.scopeList}>
                {tokenSetupScopes.map(scope => (
                  <code key={scope} className={styles.scopeChip}>{scope}</code>
                ))}
              </div>
            </div>
          </div>

          <div className={`${styles.formGroup} ${styles.formGroupWide}`}>
            <span id="metaAccessTokenLabel" className={styles.formLabel}>System User Access Token</span>
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
                Si no necesitas pixel por ahora, puedes saltar directo a la Facebook Page.
              </p>
            </>
          )}
        </>
      )
    }

    return (
      <>
        <div className={styles.stepIntro}>
          <span className={styles.stepEyebrow}>Paso 4</span>
          <h3 className={styles.stepTitle}>Selecciona la Facebook Page</h3>
          <p className={styles.stepText}>
            La Página se obtiene desde Meta con el permiso pages_show_list. Así los eventos de WhatsApp quedan ligados a la Página correcta sin copiar IDs a mano.
          </p>
          <a href="https://business.facebook.com/latest/settings/pages" target="_blank" rel="noopener noreferrer" className={styles.inlineDocLink}>
            Abrir páginas en Meta Business
            <ExternalLink size={14} />
          </a>
        </div>

        {!hasAdAccount ? (
          <p className={styles.stepHint}>{getStepBlockMessage(4)}</p>
        ) : (
          <div className={`${styles.formGroup} ${styles.formGroupWide}`}>
            <span className={styles.formLabel}>Facebook Page</span>
            {savedPageId && credentials.pageId === savedPageId ? (
              <div className={styles.filterChip}>
                <span className={styles.chipText}>{getSelectedPageLabel()}</span>
                <button
                  onClick={() => handleRemoveCredential('pageId')}
                  className={styles.chipDeleteButton}
                  type="button"
                  aria-label="Eliminar Page ID"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ) : isLoadingPages ? (
              <div className={styles.inlineStatus}>
                <RefreshCw size={14} className={styles.spinning} />
                Cargando páginas...
              </div>
            ) : pages.length > 0 ? (
              <select
                className={styles.formInput}
                onChange={(event) => {
                  const page = pages.find(item => item.id === event.target.value)
                  if (page) handleSelectAndSavePage(page)
                }}
                value={credentials.pageId || ''}
                disabled={isSavingPageId}
              >
                <option value="">-- Selecciona una Página --</option>
                {pages.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.name} ({page.id}){page.category ? ` - ${page.category}` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div className={styles.emptyPagesState}>
                <p>
                  No encontramos páginas para este token. Revisa que el usuario del sistema tenga asignada la Página y que el token incluya pages_show_list.
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => fetchPages(realAccessToken || credentials.accessToken)}
                  disabled={isLoadingPages || !(realAccessToken || credentials.accessToken)}
                >
                  <RefreshCw size={16} className={isLoadingPages ? styles.spinning : ''} />
                  Volver a cargar
                </Button>
              </div>
            )}
            {isSavingPageId && (
              <div className={styles.inlineStatus}>
                <RefreshCw size={14} className={styles.spinning} />
                Guardando página...
              </div>
            )}
          </div>
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
                  Sigue el wizard y conecta token, cuenta, pixel y Página sin copiar IDs a mano.
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

        <div className={[
          styles.workspace,
          !shouldShowWizard ? styles.connectedWorkspace : ''
        ].filter(Boolean).join(' ')}>
          <div className={styles.primaryColumn}>
            {!shouldShowWizard && (
              <section className={`${styles.section} ${styles.connectedSection}`}>
                <div className={styles.connectedHeader}>
                  <span className={styles.connectedIcon} aria-hidden="true">
                    <CheckCircle size={28} />
                  </span>
                  <div className={styles.connectedCopy}>
                    <span className={styles.stepEyebrow}>Meta Ads</span>
                    <h3 className={styles.connectedTitle}>Configuración activa</h3>
                    <p className={styles.connectedText}>
                      La cuenta está lista para reportes, sincronización y eventos server-side.
                    </p>
                  </div>
                  <div className={styles.connectedActions}>
                    <Button type="button" variant="secondary" onClick={handleEditMetaConfig}>
                      <Pencil size={16} />
                      Editar
                    </Button>
                    <Button type="button" variant="danger" onClick={() => setIsDisconnectModalOpen(true)}>
                      <Power size={16} />
                      Desconectar
                    </Button>
                  </div>
                </div>

                <div className={styles.connectedMetaGrid}>
                  <div className={styles.connectedMetaItem}>
                    <span>Cuenta publicitaria</span>
                    <strong>{getSelectedAdAccountLabel()}</strong>
                  </div>
                  <div className={styles.connectedMetaItem}>
                    <span>Facebook Page</span>
                    <strong>{getSelectedPageLabel()}</strong>
                  </div>
                  <div className={styles.connectedMetaItem}>
                    <span>Meta Pixel</span>
                    <strong>{hasPixel ? getSelectedPixelLabel() : 'Sin pixel'}</strong>
                  </div>
                </div>
              </section>
            )}

            {shouldShowWizard && (
            <section className={`${styles.section} ${styles.wizardSection}`}>
              <div className={styles.sectionHeader}>
                <div>
                  <h3 className={styles.sectionTitle}>Wizard de configuración</h3>
                  <p className={styles.sectionDescription}>
                    Crea el token correcto y después selecciona los activos que Meta devuelve por API.
                  </p>
                </div>
                <span className={styles.stepCount}>{completedMetaSetupSteps}/4 listo</span>
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

                      {shouldShowStepActions && (
                        <div className={[
                          styles.stepActions,
                          activeStep === 0 ? styles.stepActionsEnd : ''
                        ].filter(Boolean).join(' ')}>
                          {activeStep > 0 && (
                            <Button type="button" variant="secondary" onClick={handlePreviousStep}>
                              <ArrowLeft size={16} />
                              Atrás
                            </Button>
                          )}
                          {activeStep < metaSetupSteps.length - 1 && (
                            <Button type="button" variant="secondary" onClick={handleNextStep}>
                              {activeStep === 2 && !hasPixel ? 'Saltar a Page' : 'Siguiente'}
                              <ArrowRight size={16} />
                            </Button>
                          )}
                          {activeStep === metaSetupSteps.length - 1 && (
                            <Button type="button" variant="primary" onClick={handleFinishWizard} disabled={!hasPageId || isSavingPageId}>
                              Terminar
                              <CheckCircle size={16} />
                            </Button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </section>
            )}

            {!shouldShowWizard && (
              <section className={`${styles.section} ${styles.connectedExtrasSection}`}>
                <div className={styles.sectionHeader}>
                  <div>
                    <h3 className={styles.sectionTitle}>Acciones de Meta</h3>
                    <p className={styles.sectionDescription}>
                      Controles operativos para snippet y sincronización.
                    </p>
                  </div>
                </div>

                <div className={styles.connectedExtrasRows}>
                  {credentials.pixelId && !isRenderDomain ? (
                    <div className={styles.connectedExtraRow}>
                      <div>
                        <span className={styles.railSwitchLabel}>Incluir Meta Pixel en snippet</span>
                        <span className={styles.railSecondaryValue}>Agrega el pixel al Web Tracking.</span>
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
                  ) : (
                    <div className={styles.connectedExtraRow}>
                      <div>
                        <span className={styles.railSwitchLabel}>Snippet</span>
                        <span className={styles.railSecondaryValue}>Configura un Meta Pixel para activar esta opción.</span>
                      </div>
                    </div>
                  )}

                  {isSyncingSnippet && (
                    <div className={styles.inlineStatus}>
                      <RefreshCw size={16} className={styles.spinning} />
                      Sincronizando snippet...
                    </div>
                  )}

                  <button
                    type="button"
                    className={styles.railButton}
                    onClick={handleSyncMetaAds}
                    disabled={isSyncingMetaAds}
                  >
                    <RefreshCw size={16} className={isSyncingMetaAds ? styles.spinning : ''} />
                    {isSyncingMetaAds ? 'Sincronizando' : 'Sincronizar Meta Ads'}
                  </button>
                </div>
              </section>
            )}

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
                      <span className={styles.requirementPill}>Requiere Page</span>
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
                      <span className={styles.requirementPill}>Requiere Page</span>
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

          {shouldShowWizard && (
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
                <span>Page</span>
                <strong>{hasPageId ? getSelectedPageLabel() : '-'}</strong>
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
          )}
        </div>
      </Card>

      <Modal
        isOpen={isDisconnectModalOpen}
        onClose={() => {
          if (!isDisconnectingMeta) {
            setIsDisconnectModalOpen(false)
          }
        }}
        title="Eliminar configuración de Meta"
        message="¿Estás seguro que quieres eliminar la configuración actual de Meta?"
        type="confirm"
        confirmText={isDisconnectingMeta ? 'Eliminando...' : 'Eliminar'}
        cancelText="Cancelar"
        onConfirm={() => {
          void handleDisconnectMetaConfig()
        }}
      />
    </div>
  )
}
