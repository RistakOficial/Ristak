import React, { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Card, Button, Icon, Modal } from '@/components/common'
import { ArrowLeft, ArrowRight, CheckCircle, ExternalLink, Pencil, Power, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import { useTheme } from '@/contexts/ThemeContext'
import { useAppConfig, useIsRenderDomain } from '@/hooks'
import { campaignsService, type ConnectedSocialProfile } from '@/services/campaignsService'
import styles from './MetaAdsIntegration.module.css'

interface MetaCredentials {
  adAccountId: string
  accessToken: string
  pixelId: string
  pageId: string
  instagramAccountId: string
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
type MetaMessagingPlatform = 'messenger' | 'instagram'

const MASKED_SECRET_PREFIX = '***'
const SECRET_MASK_FILL = '*'.repeat(180)
const metaStepSlugs = ['token', 'ad-account', 'pixel', 'pages'] as const
const parseMetaStep = (pathname: string) => {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const metaIndex = segments.indexOf('meta-ads')
  const step = metaIndex >= 0 ? segments[metaIndex + 1] : ''
  const index = metaStepSlugs.indexOf(step as typeof metaStepSlugs[number])
  return index >= 0 ? index : 0
}
const buildMetaAdsSettingsPath = (stepIndex: number) => `/settings/meta-ads/${metaStepSlugs[Math.max(0, Math.min(stepIndex, metaStepSlugs.length - 1))]}`

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

const tokenSetupScopes = [
  'ads_management',
  'ads_read',
  'business_management',
  'pages_show_list',
  'pages_manage_metadata',
  'pages_messaging',
  'instagram_basic',
  'instagram_manage_messages'
]

export const MetaAdsIntegration: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const routeStep = parseMetaStep(location.pathname)
  const [isLoading, setIsLoading] = useState(true)
  const [credentials, setCredentials] = useState<MetaCredentials>({
    adAccountId: '',
    accessToken: '',
    pixelId: '',
    pageId: '',
    instagramAccountId: '',
    pixelApiToken: ''
  })
  const [adAccounts, setAdAccounts] = useState<AdAccount[]>([])
  const [pixels, setPixels] = useState<Pixel[]>([])
  const [pages, setPages] = useState<MetaPage[]>([])
  const [instagramAccounts, setInstagramAccounts] = useState<ConnectedSocialProfile[]>([])
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false)
  const [isLoadingPixels, setIsLoadingPixels] = useState(false)
  const [isLoadingPages, setIsLoadingPages] = useState(false)
  const [isLoadingInstagramAccounts, setIsLoadingInstagramAccounts] = useState(false)
  const [realAccessToken, setRealAccessToken] = useState('')
  const [isSavingToken, setIsSavingToken] = useState(false)
  const [isRevealingAccessToken, setIsRevealingAccessToken] = useState(false)
  const [isSavingPageId, setIsSavingPageId] = useState(false)
  const [isSavingInstagramAccountId, setIsSavingInstagramAccountId] = useState(false)
  const [savedPageId, setSavedPageId] = useState('')
  const [savedInstagramAccountId, setSavedInstagramAccountId] = useState('')
  const [isSyncingSnippet, setIsSyncingSnippet] = useState(false)
  const [isSyncingMetaAds, setIsSyncingMetaAds] = useState(false)
  const [isEditingMetaConfig, setIsEditingMetaConfig] = useState(false)
  const [isDisconnectModalOpen, setIsDisconnectModalOpen] = useState(false)
  const [isDisconnectingMeta, setIsDisconnectingMeta] = useState(false)
  const [activeStep, setActiveStep] = useState(routeStep)
  const accessTokenInputRef = useRef<HTMLInputElement>(null)

  const { showToast } = useNotification()
  const { theme } = useTheme()
  const isRenderDomain = useIsRenderDomain()
  const [includeMetaPixel, setIncludeMetaPixel, savingPixelPref] = useAppConfig('include_meta_pixel', true)
  const [whatsappScheduleEventEnabled, setWhatsappScheduleEventEnabled, savingWhatsappScheduleEvent] = useAppConfig('meta_whatsapp_schedule_enabled', false)
  const [whatsappPurchaseEventEnabled, setWhatsappPurchaseEventEnabled, savingWhatsappPurchaseEvent] = useAppConfig('meta_whatsapp_purchase_enabled', false)
  const [messengerMessagingEnabled, setMessengerMessagingEnabled, savingMessengerMessaging] = useAppConfig('meta_messenger_messaging_enabled', false)
  const [instagramMessagingEnabled, setInstagramMessagingEnabled, savingInstagramMessaging] = useAppConfig('meta_instagram_messaging_enabled', false)

  useEffect(() => {
    loadCredentials()
  }, [])

  useEffect(() => {
    setActiveStep(current => current === routeStep ? current : routeStep)
  }, [routeStep])

  const goToMetaStep = (stepIndex: number, options?: { replace?: boolean }) => {
    const nextStep = Math.max(0, Math.min(stepIndex, metaStepSlugs.length - 1))
    setActiveStep(nextStep)
    navigate(buildMetaAdsSettingsPath(nextStep), { replace: options?.replace })
  }

  const loadCredentials = async () => {
    setIsLoading(true)
    try {
      const response = await fetch('/api/meta/custom-values')
      const data = await response.json()

      if (data.success && data.data) {
        setCredentials(data.data)
        setSavedPageId(data.data.pageId || '')
        setSavedInstagramAccountId(data.data.instagramAccountId || '')

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
          await fetchInstagramAccounts(tokenToUse, data.data.instagramAccountId, { silent: true })

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

  const fetchInstagramAccounts = async (
    token: string,
    savedInstagramAccountId?: string,
    options: { silent?: boolean } = {}
  ): Promise<FetchCollectionResult> => {
    if (!token) {
      if (!options.silent) {
        showToast('error', 'Token requerido', 'Primero ingresa tu Access Token')
      }
      return { success: false, count: 0 }
    }

    setIsLoadingInstagramAccounts(true)
    try {
      const result = await campaignsService.getConnectedSocialProfiles({
        accessToken: token,
        pageId: credentials.pageId || savedPageId,
        instagramAccountId: savedInstagramAccountId
      })
      const accounts = result.profiles.filter(profile => profile.platform === 'instagram')

      if (result.success && accounts.length > 0) {
        setInstagramAccounts(accounts)

        if (savedInstagramAccountId) {
          const matchingAccount = accounts.find(account => account.sourceId === savedInstagramAccountId)
          if (matchingAccount) {
            setCredentials(prev => ({
              ...prev,
              instagramAccountId: matchingAccount.sourceId
            }))
          }
        }

        if (!options.silent) {
          showToast('success', 'Instagram cargado', `Se encontraron ${accounts.length} cuentas de Instagram`)
        }

        return { success: true, count: accounts.length }
      }

      setInstagramAccounts([])
      if (!options.silent) {
        showToast('info', 'Sin Instagram', 'No encontramos cuentas de Instagram conectadas a tus páginas de Meta')
      }
      return { success: result.success, count: 0 }
    } catch {
      setInstagramAccounts([])
      if (!options.silent) {
        showToast('error', 'Error', 'No se pudieron cargar las cuentas de Instagram')
      }
      return { success: false, count: 0 }
    } finally {
      setIsLoadingInstagramAccounts(false)
    }
  }

  const handleSelectAdAccount = (account: AdAccount) => {
    handleSelectAndSaveAccount(account)
  }

  const handleSelectPixel = (pixel: Pixel) => {
    handleSelectAndSavePixel(pixel)
  }

  const handleSelectInstagramAccount = (account: ConnectedSocialProfile) => {
    void saveInstagramAccountId(account.sourceId)
  }

  const handleRemoveCredential = (field: keyof MetaCredentials) => {
    if (field === 'accessToken') {
      setCredentials({
        adAccountId: '',
        accessToken: '',
        pixelId: '',
        pageId: '',
        instagramAccountId: '',
        pixelApiToken: ''
      })
      setRealAccessToken('')
      setAdAccounts([])
      setPixels([])
      setPages([])
      setInstagramAccounts([])
      setSavedPageId('')
      setSavedInstagramAccountId('')
      goToMetaStep(0, { replace: true })
    } else if (field === 'adAccountId') {
      setCredentials(prev => ({
        ...prev,
        adAccountId: '',
        pixelId: '',
        pixelApiToken: ''
      }))
      setPixels([])
      goToMetaStep(1, { replace: true })
    } else if (field === 'pixelId') {
      setCredentials(prev => ({
        ...prev,
        pixelId: '',
        pixelApiToken: ''
      }))
      goToMetaStep(2, { replace: true })
    } else if (field === 'pageId') {
      setCredentials(prev => ({ ...prev, pageId: '' }))
      setSavedPageId('')
      void setMessengerMessagingEnabled(false)
      void setInstagramMessagingEnabled(false)
    } else if (field === 'instagramAccountId') {
      setCredentials(prev => ({ ...prev, instagramAccountId: '' }))
      setSavedInstagramAccountId('')
      void setInstagramMessagingEnabled(false)
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
      instagramAccountId: '',
      pixelApiToken: ''
    })
    setAdAccounts([])
    setPixels([])
    setPages([])
    setInstagramAccounts([])
    setRealAccessToken('')
    setSavedPageId('')
    setSavedInstagramAccountId('')
    goToMetaStep(0, { replace: true })
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
      await fetchInstagramAccounts(credentials.accessToken, credentials.instagramAccountId, { silent: true })

      if (accountsResult.count > 0) {
        showToast('success', 'Token válido', 'Selecciona tu cuenta de anuncios')
      }

      goToMetaStep(1)
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
          instagramAccountId: credentials.instagramAccountId,
          pixelApiToken: ''
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Cuenta guardada', `${account.name} configurada`)
        goToMetaStep(2)
        const token = realAccessToken || credentials.accessToken
        if (token) {
          fetchPixels(account.id, token)
          fetchPages(token, credentials.pageId, { silent: true })
          fetchInstagramAccounts(token, credentials.instagramAccountId, { silent: true })
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
          instagramAccountId: credentials.instagramAccountId,
          pixelApiToken: ''
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Pixel guardado', `${pixel.name} configurado`)
        await loadCredentials()
        goToMetaStep(3)
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
          instagramAccountId: credentials.instagramAccountId || '',
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

  const saveInstagramAccountId = async (instagramAccountId: string) => {
    if (!instagramAccountId) {
      showToast('error', 'Instagram requerido', 'Selecciona una cuenta de Instagram primero')
      return
    }

    if (!credentials.adAccountId) {
      showToast('warning', 'Configura primero', 'Primero debes conectar tu cuenta de anuncios')
      return
    }

    setIsSavingInstagramAccountId(true)

    try {
      const response = await fetch('/api/meta/save-and-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adAccountId: credentials.adAccountId,
          accessToken: realAccessToken || credentials.accessToken,
          pixelId: credentials.pixelId || '',
          pageId: credentials.pageId || savedPageId || '',
          instagramAccountId,
          pixelApiToken: credentials.pixelApiToken || ''
        })
      })

      const data = await response.json()

      if (data.success) {
        showToast('success', 'Instagram conectado', 'La cuenta quedó guardada para recibir DMs')
        setSavedInstagramAccountId(instagramAccountId)
        setCredentials(prev => ({ ...prev, instagramAccountId }))
        await loadCredentials()
        void syncMetaAds({ automatic: true })
      } else {
        showToast('error', 'Error', data.error || 'No se pudo guardar Instagram')
      }
    } catch {
      showToast('error', 'Error', 'No se pudo guardar Instagram')
    } finally {
      setIsSavingInstagramAccountId(false)
    }
  }

  const handleFinishWizard = () => {
    if (!hasAdAccount) {
      showToast('warning', 'Falta cuenta de anuncios', 'Selecciona y guarda una cuenta de anuncios para terminar')
      return
    }

    setIsEditingMetaConfig(false)
    goToMetaStep(0, { replace: true })
  }

  const handleEditMetaConfig = () => {
    setIsEditingMetaConfig(true)
    goToMetaStep(0, { replace: true })
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
        setWhatsappPurchaseEventEnabled(false),
        setMessengerMessagingEnabled(false),
        setInstagramMessagingEnabled(false)
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

  const handleToggleMetaMessaging = async (platform: MetaMessagingPlatform, newValue: boolean) => {
    const isInstagram = platform === 'instagram'
    const platformLabel = isInstagram ? 'Instagram DM' : 'Messenger'

    if (newValue && !hasPageId) {
      showToast(
        'warning',
        'Facebook Page requerida',
        'Primero selecciona una Facebook Page para recibir y mandar mensajes de Meta'
      )
      return
    }

    if (newValue && isInstagram && !hasInstagramAccount) {
      showToast(
        'warning',
        'Instagram requerido',
        'Primero selecciona la cuenta de Instagram al final del wizard'
      )
      return
    }

    try {
      if (isInstagram) {
        await setInstagramMessagingEnabled(newValue)
      } else {
        await setMessengerMessagingEnabled(newValue)
      }

      showToast(
        'success',
        `${platformLabel} actualizado`,
        newValue
          ? `${platformLabel} ya puede recibir y mandar mensajes`
          : `${platformLabel} quedó apagado`
      )
    } catch {
      showToast('error', 'Error', `No se pudo actualizar ${platformLabel}`)
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
        : 'Iniciando sincronización de anuncios de Meta (últimos 35 meses)'
    )

    try {
      const result = await campaignsService.syncMetaAds()

      if (result.success) {
        showToast(
          'success',
          options.automatic ? 'Sincronización automática iniciada' : 'Sincronización iniciada',
          result.message || 'La sincronización de anuncios de Meta fue iniciada en segundo plano'
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
  const hasInstagramAccount = Boolean(savedInstagramAccountId || credentials.instagramAccountId)
  const isMetaConfigured = Boolean(hasAccessToken && hasAdAccount)
  const shouldShowWizard = !isMetaConfigured || isEditingMetaConfig || activeStep > 0
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
      title: 'Páginas de Meta',
      description: 'Facebook e Instagram',
      done: hasPageId || hasInstagramAccount,
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

  const getSelectedInstagramLabel = () => {
    if (!credentials.instagramAccountId && !savedInstagramAccountId) return 'Opcional'
    const instagramAccountId = credentials.instagramAccountId || savedInstagramAccountId
    const matchingAccount = instagramAccounts.find(account => account.sourceId === instagramAccountId)
    if (!matchingAccount) return instagramAccountId
    const username = matchingAccount.username ? `@${matchingAccount.username}` : matchingAccount.name
    return `${username} (${instagramAccountId})`
  }

  const getMetaMessagingStatus = (enabled: boolean, available: boolean) => {
    if (!available) return 'Pendiente'
    return enabled ? 'Activo' : 'Apagado'
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
      goToMetaStep(3)
      return
    }

    goToMetaStep(Math.min(activeStep + 1, metaSetupSteps.length - 1))
  }

  const handlePreviousStep = () => {
    goToMetaStep(activeStep === 3 && !hasPixel ? 2 : Math.max(activeStep - 1, 0))
  }

  const handleSelectStep = (stepIndex: number) => {
    const selectedStep = metaSetupSteps[stepIndex]

    if (!selectedStep?.unlocked) {
      showToast('warning', 'Paso bloqueado', getStepBlockMessage(stepIndex))
      return
    }

    goToMetaStep(stepIndex)
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
              Es opcional para reportes de anuncios, pero necesario si quieres incluir el pixel en el snippet o usar Conversions API.
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
                Si no necesitas pixel por ahora, puedes saltar directo a las páginas de Meta.
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
            <h3 className={styles.stepTitle}>Selecciona tus páginas de Meta</h3>
            <p className={styles.stepText}>
              Elige la Facebook Page para Messenger y la cuenta de Instagram para DMs. Las dos son opcionales; puedes terminar y volver a conectarlas después.
            </p>
            <div className={styles.guideLinks}>
              <a href="https://business.facebook.com/latest/settings/pages" target="_blank" rel="noopener noreferrer" className={styles.inlineDocLink}>
                Abrir páginas en Meta Business
                <ExternalLink size={14} />
              </a>
              <a href="https://business.facebook.com/latest/settings/instagram-account" target="_blank" rel="noopener noreferrer" className={styles.inlineDocLink}>
                Abrir Instagram en Meta Business
                <ExternalLink size={14} />
              </a>
            </div>
          </div>

          {!hasAdAccount ? (
            <p className={styles.stepHint}>{getStepBlockMessage(3)}</p>
          ) : (
            <>
              <div className={`${styles.formGroup} ${styles.formGroupWide}`}>
                <span className={styles.formLabel}>Facebook Page opcional</span>
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
                    <option value="">-- Sin Facebook Page por ahora --</option>
                    {pages.map((page) => (
                      <option key={page.id} value={page.id}>
                        {page.name} ({page.id}){page.category ? ` - ${page.category}` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className={styles.emptyPagesState}>
                    <p>
                      No encontramos páginas para este token. Puedes terminar y volver cuando la Página esté asignada al usuario del sistema.
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

              <div className={`${styles.formGroup} ${styles.formGroupWide}`}>
                <span className={styles.formLabel}>Cuenta de Instagram opcional</span>
                {savedInstagramAccountId && credentials.instagramAccountId === savedInstagramAccountId ? (
                  <div className={styles.filterChip}>
                    <span className={styles.chipText}>{getSelectedInstagramLabel()}</span>
                    <button
                      onClick={() => handleRemoveCredential('instagramAccountId')}
                      className={styles.chipDeleteButton}
                      type="button"
                      aria-label="Eliminar Instagram"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ) : isLoadingInstagramAccounts ? (
                  <div className={styles.inlineStatus}>
                    <RefreshCw size={14} className={styles.spinning} />
                    Cargando Instagram...
                  </div>
                ) : instagramAccounts.length > 0 ? (
                  <select
                    className={styles.formInput}
                    onChange={(event) => {
                      const account = instagramAccounts.find(item => item.sourceId === event.target.value)
                      if (account) handleSelectInstagramAccount(account)
                    }}
                    value={credentials.instagramAccountId || ''}
                    disabled={isSavingInstagramAccountId}
                  >
                    <option value="">-- Sin Instagram por ahora --</option>
                    {instagramAccounts.map((account) => (
                      <option key={account.sourceId} value={account.sourceId}>
                        {account.username ? `@${account.username}` : account.name} ({account.sourceId})
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className={styles.emptyPagesState}>
                    <p>
                      No encontramos Instagram conectado. Puedes terminar y volver cuando la cuenta esté ligada en Meta Business.
                    </p>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => fetchInstagramAccounts(realAccessToken || credentials.accessToken, credentials.instagramAccountId)}
                      disabled={isLoadingInstagramAccounts || !(realAccessToken || credentials.accessToken)}
                    >
                      <RefreshCw size={16} className={isLoadingInstagramAccounts ? styles.spinning : ''} />
                      Volver a cargar
                    </Button>
                  </div>
                )}
                {isSavingInstagramAccountId && (
                  <div className={styles.inlineStatus}>
                    <RefreshCw size={14} className={styles.spinning} />
                    Guardando Instagram...
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )
    }

    return null
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
                <h2 className={styles.pageTitle}>Meta</h2>
                <p className={styles.pageSubtitle}>
                  Conecta anuncios, Página, Messenger e Instagram DM desde un solo lugar.
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
                    <span className={styles.stepEyebrow}>Meta</span>
                    <h3 className={styles.connectedTitle}>Configuración activa</h3>
                    <p className={styles.connectedText}>
                      La cuenta está lista para reportes, eventos y mensajes nuevos de Meta.
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
                  <div className={styles.connectedMetaItem}>
                    <span>Instagram</span>
                    <strong>{hasInstagramAccount ? getSelectedInstagramLabel() : 'Sin Instagram'}</strong>
                  </div>
                </div>

                <div className={styles.connectedPagesPanel}>
                  <div className={styles.connectedPagesHeader}>
                    <div>
                      <h4 className={styles.connectedPagesTitle}>Páginas conectadas</h4>
                      <p className={styles.connectedPagesDescription}>
                        Activa cada canal solo cuando quieras que Ristak reciba y mande mensajes desde esa cuenta.
                      </p>
                    </div>
                  </div>

                  <div className={styles.connectedPagesList}>
                    <div className={[
                      styles.connectedPageCard,
                      !hasPageId ? styles.connectedPageCardLocked : ''
                    ].filter(Boolean).join(' ')}>
                      <span className={`${styles.connectedPageIcon} ${styles.connectedPageIconFacebook}`} aria-hidden="true">
                        <Icon name="facebook" size={19} />
                      </span>
                      <div className={styles.connectedPageMain}>
                        <strong>Messenger</strong>
                        <span>{hasPageId ? getSelectedPageLabel() : 'Selecciona una Facebook Page'}</span>
                      </div>
                      <div className={styles.connectedPageControl}>
                        <span className={[
                          styles.connectedPageStatus,
                          messengerMessagingEnabled && hasPageId ? styles.connectedPageStatusActive : ''
                        ].filter(Boolean).join(' ')}>
                          {getMetaMessagingStatus(messengerMessagingEnabled, hasPageId)}
                        </span>
                        <label className={styles.switchContainer} aria-label="Activar mensajes de Messenger">
                          <input
                            type="checkbox"
                            checked={messengerMessagingEnabled === true}
                            onChange={(event) => handleToggleMetaMessaging('messenger', event.target.checked)}
                            disabled={!hasPageId || savingMessengerMessaging}
                            className={styles.switchInput}
                          />
                          <span className={styles.switchSlider}></span>
                        </label>
                      </div>
                    </div>

                    <div className={[
                      styles.connectedPageCard,
                      !hasInstagramAccount ? styles.connectedPageCardLocked : ''
                    ].filter(Boolean).join(' ')}>
                      <span className={`${styles.connectedPageIcon} ${styles.connectedPageIconInstagram}`} aria-hidden="true">
                        <Icon name="instagram" size={19} />
                      </span>
                      <div className={styles.connectedPageMain}>
                        <strong>Instagram DM</strong>
                        <span>{hasInstagramAccount ? getSelectedInstagramLabel() : 'Selecciona una cuenta de Instagram'}</span>
                      </div>
                      <div className={styles.connectedPageControl}>
                        <span className={[
                          styles.connectedPageStatus,
                          instagramMessagingEnabled && hasInstagramAccount ? styles.connectedPageStatusActive : ''
                        ].filter(Boolean).join(' ')}>
                          {getMetaMessagingStatus(instagramMessagingEnabled, hasInstagramAccount)}
                        </span>
                        <label className={styles.switchContainer} aria-label="Activar mensajes de Instagram DM">
                          <input
                            type="checkbox"
                            checked={instagramMessagingEnabled === true}
                            onChange={(event) => handleToggleMetaMessaging('instagram', event.target.checked)}
                            disabled={!hasInstagramAccount || savingInstagramMessaging}
                            className={styles.switchInput}
                          />
                          <span className={styles.switchSlider}></span>
                        </label>
                      </div>
                    </div>
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
                    Crea el token correcto y después selecciona los activos que Meta devuelve.
                  </p>
                </div>
                <span className={styles.stepCount}>{completedMetaSetupSteps}/{metaSetupSteps.length} listo</span>
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
                            <Button
                              type="button"
                              variant="primary"
                              onClick={handleFinishWizard}
                              disabled={!hasAdAccount || isSavingPageId || isSavingInstagramAccountId}
                            >
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
                    {isSyncingMetaAds ? 'Sincronizando' : 'Sincronizar anuncios'}
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
                <span>Instagram</span>
                <strong>{hasInstagramAccount ? getSelectedInstagramLabel() : '-'}</strong>
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
                  {isSyncingMetaAds ? 'Sincronizando' : 'Sincronizar anuncios'}
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
