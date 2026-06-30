import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Building2, Check, CheckCircle, ChevronDown, Clock, Database, Download, Gift, Globe2, Image, ImageUp, Loader2, Lock, Save, Trash2, Upload, User, X } from 'lucide-react'
import { Button, Card, CustomSelect, Modal } from '@/components/common'
import { Badge } from '@/components/common/Badge'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAppConfig } from '@/hooks'
import { contactTagsService } from '@/services/contactTagsService'
import { apiUrl } from '@/services/apiBaseUrl'
import apiClient from '@/services/apiClient'
import {
  ACCOUNT_BUSINESS_PROFILE_CONFIG_KEY,
  defaultAccountBusinessProfile,
  hasAccountBusinessProfileDetails,
  normalizeAccountBusinessProfile,
  type AccountBusinessProfile
} from '@/services/accountBusinessProfile'
import {
  accountCancellationService,
  type AccountCancellationResult,
  type AccountCancellationStatus
} from '@/services/accountCancellationService'
import mediaService from '@/services/mediaService'
import {
  ACCOUNT_COUNTRY_CONFIG_KEY,
  ACCOUNT_CURRENCY_CONFIG_KEY,
  ACCOUNT_DIAL_CODE_CONFIG_KEY,
  COUNTRY_OPTIONS,
  CURRENCY_OPTIONS,
  getCountryDefaults,
  getDetectedAccountLocaleDefaults
} from '@/utils/accountLocale'
import { formatDate } from '@/utils/format'
import styles from './Settings.module.css'

const PROFILE_PHOTO_KEY = 'admin_profile_photo'
const MAX_PROFILE_PHOTO_SIZE = 1.5 * 1024 * 1024
const MAX_BUSINESS_LOGO_SIZE = 2 * 1024 * 1024
const CUSTOMER_LABEL_OPTIONS = ['Cliente', 'Paciente', 'Proyecto', 'Miembro', 'Alumno']
const LEAD_LABEL_OPTIONS = ['Interesado', 'Prospecto', 'Mensaje', 'Lead', 'Consulta']
const STORAGE_GB = 1024 * 1024 * 1024

const formatStorageBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const gb = bytes / STORAGE_GB
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`
}

interface StorageStatus {
  sizeGB: number
  sizePretty?: string
  limitGB: number
  availablePretty?: string
  percentUsed: number
  warningThreshold: number
  needsAttention: boolean
}

const ALL_TIMEZONES: string[] =
  typeof (Intl as any).supportedValuesOf === 'function'
    ? (Intl as any).supportedValuesOf('timeZone')
    : [
        'UTC',
        'America/Mexico_City',
        'America/Monterrey',
        'America/Tijuana',
        'America/Bogota',
        'America/Lima',
        'America/Chicago',
        'America/New_York',
        'America/Los_Angeles',
        'Europe/Madrid'
      ]

interface TimezoneDisplayInfo {
  value: string
  offset: string
  currentTime: string
  optionLabel: string
}

const getTimezoneParts = (date: Date, timeZone: string): Record<string, number> => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })

  return formatter.formatToParts(date).reduce<Record<string, number>>((parts, part) => {
    if (part.type !== 'literal') {
      parts[part.type] = part.type === 'hour' && part.value === '24' ? 0 : Number(part.value)
    }
    return parts
  }, {})
}

const formatTimezoneOffset = (timeZone: string, atDate: Date): string => {
  try {
    const parts = getTimezoneParts(atDate, timeZone)
    const zoneWallAsUtc = Date.UTC(
      parts.year,
      (parts.month ?? 1) - 1,
      parts.day,
      parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0
    )
    const offsetMinutes = Math.round((zoneWallAsUtc - atDate.getTime()) / 60000)
    const sign = offsetMinutes >= 0 ? '+' : '-'
    const absoluteMinutes = Math.abs(offsetMinutes)
    const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, '0')
    const minutes = String(absoluteMinutes % 60).padStart(2, '0')
    return `UTC${sign}${hours}:${minutes}`
  } catch {
    return 'UTC'
  }
}

const formatTimezoneTime = (timeZone: string, atDate: Date): string => {
  try {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(atDate)
  } catch {
    return 'Hora no disponible'
  }
}

const buildTimezoneDisplayInfo = (timeZone: string, atDate: Date): TimezoneDisplayInfo => {
  const offset = formatTimezoneOffset(timeZone, atDate)
  const currentTime = formatTimezoneTime(timeZone, atDate)

  return {
    value: timeZone,
    offset,
    currentTime,
    optionLabel: `${timeZone} (${offset}) - ${currentTime}`
  }
}

const splitFallbackName = (value = '') => {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return { firstName: '', lastName: '' }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' ')
  }
}

export const AccountSettings: React.FC = () => {
  const { user, logout, updateProfile } = useAuth()
  const { labels, updateLabels } = useLabels()
  const { showToast } = useNotification()
  const { timezone, updateTimezone } = useTimezone()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const detectedLocaleDefaults = useMemo(getDetectedAccountLocaleDefaults, [])

  const [profilePhoto, setProfilePhoto, savingProfilePhoto] = useAppConfig<string>(PROFILE_PHOTO_KEY, '')
  const [businessProfile, setBusinessProfile, savingBusinessProfileConfig] = useAppConfig<AccountBusinessProfile>(
    ACCOUNT_BUSINESS_PROFILE_CONFIG_KEY,
    defaultAccountBusinessProfile
  )
  const [accountCountry, setAccountCountry, savingAccountCountry] = useAppConfig<string>(ACCOUNT_COUNTRY_CONFIG_KEY, detectedLocaleDefaults.countryCode)
  const [accountCurrency, setAccountCurrency, savingAccountCurrency] = useAppConfig<string>(ACCOUNT_CURRENCY_CONFIG_KEY, detectedLocaleDefaults.currency)
  const [accountDialCode, setAccountDialCode, savingAccountDialCode] = useAppConfig<string>(ACCOUNT_DIAL_CODE_CONFIG_KEY, detectedLocaleDefaults.dialCode)
  const [profilePhotoDraft, setProfilePhotoDraft] = useState('')
  const [isEditingPhoto, setIsEditingPhoto] = useState(false)
  const [profileDraft, setProfileDraft] = useState({
    firstName: '',
    lastName: '',
    phone: ''
  })
  const [savingProfileDetails, setSavingProfileDetails] = useState(false)
  const [businessProfileDraft, setBusinessProfileDraft] = useState<AccountBusinessProfile>(defaultAccountBusinessProfile)
  const [savingBusinessProfile, setSavingBusinessProfile] = useState(false)

  const [newUsername, setNewUsername] = useState('')
  const [isEditingUsername, setIsEditingUsername] = useState(false)
  const [isChangingUsername, setIsChangingUsername] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isEditingPassword, setIsEditingPassword] = useState(false)
  const [isChangingPassword, setIsChangingPassword] = useState(false)

  const [customLabels, setCustomLabels] = useState({
    customer: labels.customer,
    lead: labels.lead
  })
  const [openDropdown, setOpenDropdown] = useState<'customer' | 'lead' | null>(null)
  const [savingLabels, setSavingLabels] = useState(false)
  const [timezoneDraft, setTimezoneDraft] = useState(timezone)
  const [savingTimezone, setSavingTimezone] = useState(false)
  const [timezoneClock, setTimezoneClock] = useState(() => new Date())
  const [accountLocaleDraft, setAccountLocaleDraft] = useState({
    countryCode: detectedLocaleDefaults.countryCode,
    currency: detectedLocaleDefaults.currency,
    dialCode: detectedLocaleDefaults.dialCode
  })
  const [savingAccountLocale, setSavingAccountLocale] = useState(false)
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null)
  const [storageStatusError, setStorageStatusError] = useState(false)
  const [cancellationStatus, setCancellationStatus] = useState<AccountCancellationStatus | null>(null)
  const [cancellationStatusError, setCancellationStatusError] = useState(false)
  const [isCancellationModalOpen, setIsCancellationModalOpen] = useState(false)
  const [cancellationStep, setCancellationStep] = useState<'offer' | 'reasons' | 'done'>('offer')
  const [selectedCancellationReason, setSelectedCancellationReason] = useState('')
  const [cancellationReasonDetails, setCancellationReasonDetails] = useState('')
  const [cancellationResult, setCancellationResult] = useState<AccountCancellationResult | null>(null)
  const [savingRetentionOffer, setSavingRetentionOffer] = useState(false)
  const [cancellingAccount, setCancellingAccount] = useState(false)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const customerTriggerRef = useRef<HTMLButtonElement>(null)
  const leadTriggerRef = useRef<HTMLButtonElement>(null)
  const businessLogoInputRef = useRef<HTMLInputElement | null>(null)
  const localeBootstrappedRef = useRef(false)

  const currentUsername = user?.username || 'admin'
  const currentRoleLabel = user?.role === 'admin' ? 'Administrador' : 'Empleado'
  const accountEmail = user?.email || (currentUsername.includes('@') ? currentUsername : '')
  const visibleProfilePhoto = isEditingPhoto ? profilePhotoDraft : profilePhoto
  const profileNameFallback = user?.name && user.name !== user.username ? user.name : ''
  const fallbackNameParts = useMemo(() => splitFallbackName(profileNameFallback), [profileNameFallback])
  const normalizedBusinessProfile = useMemo(() => {
    const normalized = normalizeAccountBusinessProfile(businessProfile)
    return normalized.name || !user?.businessName
      ? normalized
      : { ...normalized, name: user.businessName }
  }, [businessProfile, user?.businessName])
  const hasStoredBusinessProfile = useMemo(
    () => hasAccountBusinessProfileDetails(businessProfile),
    [businessProfile]
  )
  const normalizedUserProfile = useMemo(() => ({
    firstName: user?.firstName || fallbackNameParts.firstName,
    lastName: user?.lastName || fallbackNameParts.lastName,
    phone: user?.phone || ''
  }), [fallbackNameParts, user?.firstName, user?.lastName, user?.phone])
  const profileDetailsChanged =
    profileDraft.firstName !== normalizedUserProfile.firstName ||
    profileDraft.lastName !== normalizedUserProfile.lastName ||
    profileDraft.phone !== normalizedUserProfile.phone
  const businessProfileChanged =
    JSON.stringify(businessProfileDraft) !== JSON.stringify(normalizedBusinessProfile) ||
    (!hasStoredBusinessProfile && Boolean(user?.businessName))
  const businessProfileSaving = savingBusinessProfile || savingBusinessProfileConfig
  const usernameChanged = newUsername.trim() && newUsername.trim() !== currentUsername
  const storagePercent = Math.max(0, Math.min(100, storageStatus?.percentUsed ?? 0))
  const timezoneOptions = useMemo(
    () => ALL_TIMEZONES.map((tz) => buildTimezoneDisplayInfo(tz, timezoneClock)),
    [timezoneClock]
  )
  const selectedTimezoneInfo = useMemo(
    () => buildTimezoneDisplayInfo(timezoneDraft || timezone || 'UTC', timezoneClock),
    [timezoneDraft, timezone, timezoneClock]
  )
  const accountLocaleChanged =
    accountLocaleDraft.countryCode !== accountCountry ||
    accountLocaleDraft.currency !== accountCurrency ||
    accountLocaleDraft.dialCode !== accountDialCode
  const accountLocaleSaving = savingAccountLocale || savingAccountCountry || savingAccountCurrency || savingAccountDialCode
  const canManageAccountCancellation = user?.role === 'admin' && user?.licenseEnforced
  const cancellationReasons = cancellationStatus?.reasons || []
  const selectedReasonRequiresDetails = selectedCancellationReason === 'other'

  useEffect(() => {
    setCustomLabels({
      customer: labels.customer,
      lead: labels.lead
    })
  }, [labels])

  useEffect(() => {
    setProfileDraft(normalizedUserProfile)
  }, [normalizedUserProfile])

  useEffect(() => {
    setBusinessProfileDraft(normalizedBusinessProfile)
  }, [normalizedBusinessProfile])

  useEffect(() => {
    setTimezoneDraft(timezone)
  }, [timezone])

  useEffect(() => {
    setAccountLocaleDraft({
      countryCode: accountCountry || detectedLocaleDefaults.countryCode,
      currency: accountCurrency || detectedLocaleDefaults.currency,
      dialCode: accountDialCode || detectedLocaleDefaults.dialCode
    })
  }, [accountCountry, accountCurrency, accountDialCode, detectedLocaleDefaults])

  useEffect(() => {
    if (localeBootstrappedRef.current) return
    localeBootstrappedRef.current = true

    let cancelled = false

    const bootstrapDetectedLocale = async () => {
      try {
        const keys = [
          ACCOUNT_COUNTRY_CONFIG_KEY,
          ACCOUNT_CURRENCY_CONFIG_KEY,
          ACCOUNT_DIAL_CODE_CONFIG_KEY
        ].join(',')
        const response = await apiClient.get<{ config?: Record<string, string | null> }>('/config', {
          params: { keys }
        })
        if (cancelled) return

        const stored = response.config || {}
        const storedCountry = stored[ACCOUNT_COUNTRY_CONFIG_KEY]
        const countryDefaults = getCountryDefaults(storedCountry || detectedLocaleDefaults.countryCode)
        const nextCountry = storedCountry || detectedLocaleDefaults.countryCode
        const nextCurrency = stored[ACCOUNT_CURRENCY_CONFIG_KEY] || countryDefaults.currency
        const nextDialCode = stored[ACCOUNT_DIAL_CODE_CONFIG_KEY] || countryDefaults.dialCode
        const saves: Array<Promise<void>> = []

        if (!stored[ACCOUNT_COUNTRY_CONFIG_KEY]) saves.push(setAccountCountry(nextCountry))
        if (!stored[ACCOUNT_CURRENCY_CONFIG_KEY]) saves.push(setAccountCurrency(nextCurrency))
        if (!stored[ACCOUNT_DIAL_CODE_CONFIG_KEY]) saves.push(setAccountDialCode(nextDialCode))
        if (saves.length) await Promise.all(saves)
      } catch {
        // La pantalla ya muestra defaults locales; si no se puede guardar ahora, el usuario puede tocar Guardar.
      }
    }

    bootstrapDetectedLocale()

    return () => {
      cancelled = true
    }
  }, [detectedLocaleDefaults, setAccountCountry, setAccountCurrency, setAccountDialCode])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setTimezoneClock(new Date())
    }, 60000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadStorageStatus = async () => {
      try {
        const usage = await mediaService.getStorageUsage() as {
          used_bytes?: number
          quota_bytes?: number
          available_bytes?: number
          usage_percent?: number
        }
        const usedBytes = Number(usage.used_bytes || 0)
        const quotaBytes = Number(usage.quota_bytes || 0)
        const percentUsed = Math.max(0, Math.min(100, Number(usage.usage_percent || 0)))
        const data: StorageStatus = {
          sizeGB: usedBytes / STORAGE_GB,
          sizePretty: formatStorageBytes(usedBytes),
          limitGB: quotaBytes / STORAGE_GB,
          availablePretty: formatStorageBytes(Number(usage.available_bytes || 0)),
          percentUsed,
          warningThreshold: 80,
          needsAttention: percentUsed >= 80
        }
        if (!cancelled) {
          setStorageStatus(data)
          setStorageStatusError(false)
        }
      } catch {
        if (!cancelled) {
          setStorageStatusError(true)
        }
      }
    }

    loadStorageStatus()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!canManageAccountCancellation) {
      setCancellationStatus(null)
      setCancellationStatusError(false)
      return
    }

    let cancelled = false

    const loadCancellationStatus = async () => {
      try {
        const status = await accountCancellationService.getStatus()
        if (!cancelled) {
          setCancellationStatus(status)
          setCancellationStatusError(false)
        }
      } catch {
        if (!cancelled) {
          setCancellationStatusError(true)
        }
      }
    }

    loadCancellationStatus()

    return () => {
      cancelled = true
    }
  }, [canManageAccountCancellation])

  const handleSaveTimezone = async () => {
    if (!timezoneDraft || timezoneDraft === timezone) return

    setSavingTimezone(true)
    try {
      const resolved = await updateTimezone(timezoneDraft)
      showToast('success', 'Zona horaria actualizada', `Toda la cuenta usará ${resolved}.`)
    } catch (error: any) {
      showToast('error', 'Error', error?.message || 'No se pudo guardar la zona horaria')
      setTimezoneDraft(timezone)
    } finally {
      setSavingTimezone(false)
    }
  }

  const handleCountryChange = (countryCode: string) => {
    const country = getCountryDefaults(countryCode)
    setAccountLocaleDraft({
      countryCode: country.value,
      currency: country.currency,
      dialCode: country.dialCode
    })
  }

  const handleSaveAccountLocale = async () => {
    if (!accountLocaleChanged) return

    setSavingAccountLocale(true)
    try {
      await Promise.all([
        setAccountCountry(accountLocaleDraft.countryCode),
        setAccountCurrency(accountLocaleDraft.currency),
        setAccountDialCode(accountLocaleDraft.dialCode)
      ])
      showToast('success', 'Configuración guardada', 'Ristak usará ese país, lada y moneda como default.')
    } catch (error: any) {
      setAccountLocaleDraft({
        countryCode: accountCountry || detectedLocaleDefaults.countryCode,
        currency: accountCurrency || detectedLocaleDefaults.currency,
        dialCode: accountDialCode || detectedLocaleDefaults.dialCode
      })
      showToast('error', 'No se guardó', error?.message || 'Intenta guardar la configuración otra vez.')
    } finally {
      setSavingAccountLocale(false)
    }
  }

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Element && !target.closest('[data-labels-dropdown]')) {
        setOpenDropdown(null)
      }
    }
    const handleClose = () => setOpenDropdown(null)

    if (openDropdown) {
      document.addEventListener('click', handleClickOutside)
      window.addEventListener('scroll', handleClose, true)
      window.addEventListener('resize', handleClose)
      return () => {
        document.removeEventListener('click', handleClickOutside)
        window.removeEventListener('scroll', handleClose, true)
        window.removeEventListener('resize', handleClose)
      }
    }
  }, [openDropdown])

  const handleOpenDropdown = (type: 'customer' | 'lead') => {
    if (openDropdown === type) {
      setOpenDropdown(null)
      return
    }
    const ref = type === 'customer' ? customerTriggerRef : leadTriggerRef
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width })
    }
    setOpenDropdown(type)
  }

  const handleStartPhotoEdit = () => {
    setProfilePhotoDraft(profilePhoto || '')
    setIsEditingPhoto(true)
  }

  const handleCancelPhotoEdit = () => {
    setProfilePhotoDraft(profilePhoto || '')
    setIsEditingPhoto(false)
  }

  const handleProfilePhotoChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) return

    if (!file.type.startsWith('image/')) {
      showToast('error', 'Archivo inválido', 'Sube una imagen en formato JPG, PNG o WebP.')
      return
    }

    if (file.size > MAX_PROFILE_PHOTO_SIZE) {
      showToast('error', 'Imagen muy pesada', 'La foto debe pesar máximo 1.5 MB.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setProfilePhotoDraft(reader.result)
      }
    }
    reader.onerror = () => {
      showToast('error', 'No se pudo leer', 'Intenta subir la foto otra vez.')
    }
    reader.readAsDataURL(file)
  }

  const handleSaveProfilePhoto = async () => {
    try {
      let nextProfilePhoto = profilePhotoDraft
      if (/^data:image\//i.test(profilePhotoDraft)) {
        const uploaded = await mediaService.uploadDataUrl({
          fileBase64: profilePhotoDraft,
          filename: 'admin-profile-photo',
          module: 'business_settings',
          isPublic: true
        })
        nextProfilePhoto = uploaded.publicUrl
      }
      await setProfilePhoto(nextProfilePhoto)
      setProfilePhotoDraft(nextProfilePhoto)
      setIsEditingPhoto(false)
      showToast(
        'success',
        nextProfilePhoto ? 'Foto actualizada' : 'Foto eliminada',
        nextProfilePhoto ? 'La foto del administrador quedó guardada.' : 'Se quitó la foto del administrador.'
      )
    } catch (error: any) {
      showToast('error', 'Error', error?.message || 'No se pudo guardar la foto')
    }
  }

  const handleSaveProfileDetails = async () => {
    if (!profileDetailsChanged) return

    setSavingProfileDetails(true)
    try {
      await updateProfile({
        firstName: profileDraft.firstName.trim(),
        lastName: profileDraft.lastName.trim(),
        phone: profileDraft.phone.trim()
      })
      showToast('success', 'Datos guardados', 'Tu nombre y teléfono quedaron actualizados.')
    } catch (error: any) {
      setProfileDraft(normalizedUserProfile)
      showToast('error', 'No se guardó', error?.message || 'Intenta guardar tus datos otra vez.')
    } finally {
      setSavingProfileDetails(false)
    }
  }

  const handleBusinessProfileDraftChange = <K extends keyof AccountBusinessProfile>(
    key: K,
    value: AccountBusinessProfile[K]
  ) => {
    setBusinessProfileDraft((current) => ({ ...current, [key]: value }))
  }

  const handleBusinessLogoChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) return

    if (!file.type.startsWith('image/')) {
      showToast('error', 'Archivo inválido', 'Sube una imagen en formato JPG, PNG o WebP.')
      return
    }

    if (file.size > MAX_BUSINESS_LOGO_SIZE) {
      showToast('error', 'Logo muy pesado', 'El logo debe pesar máximo 2 MB.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        handleBusinessProfileDraftChange('logoUrl', reader.result)
      }
    }
    reader.onerror = () => {
      showToast('error', 'No se pudo leer', 'Intenta subir el logo otra vez.')
    }
    reader.readAsDataURL(file)
  }

  const handleSaveBusinessProfile = async () => {
    if (!businessProfileChanged) return

    setSavingBusinessProfile(true)
    try {
      let nextBusinessProfile = normalizeAccountBusinessProfile(businessProfileDraft)
      if (/^data:image\//i.test(nextBusinessProfile.logoUrl)) {
        const uploaded = await mediaService.uploadDataUrl({
          fileBase64: nextBusinessProfile.logoUrl,
          filename: 'business-logo',
          module: 'business_settings',
          moduleEntityId: 'account-business-profile',
          isPublic: true
        })
        nextBusinessProfile = {
          ...nextBusinessProfile,
          logoUrl: uploaded.publicUrl || `/api/media/assets/${encodeURIComponent(uploaded.id)}/file`
        }
      }

      await setBusinessProfile(nextBusinessProfile)
      let profileSyncFailed = false
      if (nextBusinessProfile.name !== (user?.businessName || '')) {
        try {
          await updateProfile({ businessName: nextBusinessProfile.name })
        } catch {
          profileSyncFailed = true
        }
      }
      setBusinessProfileDraft(nextBusinessProfile)
      if (profileSyncFailed) {
        showToast(
          'warning',
          'Negocio guardado',
          'Los comprobantes ya usan estos datos, pero no se pudo sincronizar el nombre del perfil.'
        )
      } else {
        showToast('success', 'Negocio guardado', 'Página de cobro y comprobantes usarán estos datos por default.')
      }
    } catch (error: any) {
      setBusinessProfileDraft(normalizedBusinessProfile)
      showToast('error', 'No se guardó', error?.message || 'Intenta guardar los datos del negocio otra vez.')
    } finally {
      setSavingBusinessProfile(false)
    }
  }

  const handleStartUsernameEdit = () => {
    setNewUsername(currentUsername)
    setIsEditingUsername(true)
  }

  const handleCancelUsernameEdit = () => {
    setNewUsername('')
    setIsEditingUsername(false)
  }

  const handleChangeUsername = async () => {
    if (!newUsername.trim()) {
      showToast('error', 'Error', 'El identificador interno no puede estar vacío')
      return
    }

    if (newUsername.trim() === currentUsername) {
      showToast('warning', 'Atención', 'El identificador interno es igual al actual')
      return
    }

    setIsChangingUsername(true)

    try {
      const token = localStorage.getItem('auth_token')
      const response = await fetch(apiUrl('/api/auth/change-username'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ token, newUsername: newUsername.trim() })
      })

      const data = await response.json()

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Error al cambiar el identificador interno')
      }

      showToast('success', 'Identificador actualizado', 'Vuelve a iniciar sesión con tu correo de login para refrescar la cuenta.')

      setTimeout(() => {
        logout()
        window.location.href = '/login'
      }, 2000)
    } catch (error: any) {
      showToast('error', 'Error', error.message || 'No se pudo cambiar el identificador interno')
    } finally {
      setIsChangingUsername(false)
    }
  }

  const handleStartPasswordEdit = () => {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setIsEditingPassword(true)
  }

  const handleCancelPasswordEdit = () => {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setIsEditingPassword(false)
  }

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      showToast('error', 'Error', 'Todos los campos son requeridos')
      return
    }

    if (newPassword.length < 6) {
      showToast('error', 'Error', 'La nueva contraseña debe tener al menos 6 caracteres')
      return
    }

    if (newPassword !== confirmPassword) {
      showToast('error', 'Error', 'Las contraseñas no coinciden')
      return
    }

    if (currentPassword === newPassword) {
      showToast('warning', 'Atención', 'La nueva contraseña debe ser diferente a la actual')
      return
    }

    setIsChangingPassword(true)

    try {
      const token = localStorage.getItem('auth_token')
      const response = await fetch(apiUrl('/api/auth/change-password'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ token, currentPassword, newPassword })
      })

      const data = await response.json()

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Error al cambiar la contraseña')
      }

      showToast('success', 'Contraseña actualizada', 'Tu contraseña ha sido cambiada exitosamente')
      handleCancelPasswordEdit()
    } catch (error: any) {
      showToast('error', 'Error', error.message || 'No se pudo cambiar la contraseña')
    } finally {
      setIsChangingPassword(false)
    }
  }

  const handleSaveLabels = async (customer: string, lead: string) => {
    const nextCustomer = customer || labels.customer
    const nextLead = lead || labels.lead

    setSavingLabels(true)
    setCustomLabels({
      customer: nextCustomer,
      lead: nextLead
    })

    try {
      await updateLabels({
        customer: nextCustomer,
        customers: `${nextCustomer}s`,
        lead: nextLead,
        leads: `${nextLead}s`
      })
      await contactTagsService.getTags({ forceRefresh: true, includeSystem: true })
      showToast('success', 'Guardado', 'Nombres actualizados')
    } catch (error) {
      setCustomLabels({
        customer: labels.customer,
        lead: labels.lead
      })
      showToast('error', 'Error', 'No se pudieron guardar los nombres')
    } finally {
      setSavingLabels(false)
    }
  }

  const openCancellationModal = () => {
    setCancellationStep(cancellationStatus?.has_stripe_subscription === false ? 'reasons' : 'offer')
    setCancellationResult(null)
    setSelectedCancellationReason(cancellationReasons[0]?.key || '')
    setCancellationReasonDetails('')
    setIsCancellationModalOpen(true)
  }

  const handleAcceptRetentionOffer = async () => {
    setSavingRetentionOffer(true)
    try {
      const result = await accountCancellationService.acceptRetentionOffer()
      showToast('success', 'Descuento aplicado', `Tu siguiente mes queda con ${result.percent_off}% de descuento.`)
      setIsCancellationModalOpen(false)
      const status = await accountCancellationService.getStatus().catch(() => null)
      if (status) setCancellationStatus(status)
    } catch (error: any) {
      showToast('error', 'No se aplicó el descuento', error?.message || 'Intenta otra vez.')
      return false
    } finally {
      setSavingRetentionOffer(false)
    }
  }

  const handleCancelAccount = async () => {
    if (!selectedCancellationReason) {
      showToast('warning', 'Selecciona un motivo', 'Necesitamos guardar por qué cancelas para mejorar Ristak.')
      return false
    }

    if (selectedReasonRequiresDetails && !cancellationReasonDetails.trim()) {
      showToast('warning', 'Cuéntanos un poco más', 'Escribe el motivo para poder continuar.')
      return false
    }

    setCancellingAccount(true)
    try {
      const result = await accountCancellationService.cancelAccount({
        reasonKey: selectedCancellationReason,
        reasonDetails: cancellationReasonDetails
      })
      setCancellationResult(result)
      setCancellationStep('done')
      showToast('success', 'Cuenta cancelada', 'Tu suscripción quedó cancelada y el respaldo está listo para descargar.')
      return false
    } catch (error: any) {
      showToast('error', 'No se canceló la cuenta', error?.message || 'Intenta otra vez.')
      return false
    } finally {
      setCancellingAccount(false)
    }
  }

  return (
    <div className={styles.settingsContent}>
      <Card>
        <div className={styles.panelHeader}>
          <div className={styles.panelHeaderLeft}>
            <div className={styles.iconBox}>
              <User size={22} />
            </div>
            <div>
              <h2 className={styles.panelTitle}>Cuenta</h2>
              <p className={styles.panelDescription}>
                Administra correo de login, contraseña, perfil y datos del negocio.
              </p>
            </div>
          </div>
          <div className={styles.panelHeaderActions}>
            <Badge variant="success">
              <CheckCircle size={15} />
              {currentRoleLabel}
            </Badge>
          </div>
        </div>

        <div className={styles.panelSection}>
          <div className={styles.accountGrid}>
            <section className={`${styles.accountSection} ${styles.accountSectionWide}`}>
              <div className={styles.accountSectionHeader}>
                <div>
                  <h3 className={styles.accountSectionTitle}>Acceso de login</h3>
                  <p className={styles.accountSectionDescription}>
                    Lo primero: la entrada a Ristak usa el correo de login y la contraseña. El identificador interno no es la llave principal de acceso.
                  </p>
                </div>
              </div>

              <div className={styles.loginAccessStack}>
                <div className={styles.loginAccessItem}>
                  <div className={styles.loginAccessText}>
                    <strong>Correo de login</strong>
                    <span>Este es el correo que se usa para iniciar sesión y recuperar el acceso de la cuenta.</span>
                  </div>
                  <div className={styles.loginAccessControl}>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="account-login-email">Correo electrónico</label>
                      <input
                        id="account-login-email"
                        className={`${styles.input} ${styles.inputReadOnly}`}
                        type="email"
                        value={accountEmail || 'Sin correo de login guardado'}
                        readOnly
                        autoComplete="email"
                      />
                    </div>
                  </div>
                </div>

                <div className={styles.loginAccessItem}>
                  <div className={styles.loginAccessText}>
                    <strong>Identificador interno</strong>
                    <span>Sirve para referencias internas. No tiene que ser el correo y no es la credencial principal de login.</span>
                  </div>
                  <div className={styles.loginAccessControl}>
                    <div className={styles.lockedFieldRow}>
                      <div className={styles.field}>
                        <label className={styles.label}>Nombre de usuario interno</label>
                        <input
                          className={`${styles.input} ${!isEditingUsername ? styles.inputReadOnly : ''}`}
                          type="text"
                          value={isEditingUsername ? newUsername : currentUsername}
                          onChange={(event) => {
                            if (isEditingUsername) {
                              setNewUsername(event.target.value)
                            }
                          }}
                          readOnly={!isEditingUsername}
                          disabled={isChangingUsername}
                          autoComplete="username"
                        />
                      </div>
                      {!isEditingUsername ? (
                        <Button variant="secondary" onClick={handleStartUsernameEdit}>
                          Cambiar
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          onClick={handleChangeUsername}
                          loading={isChangingUsername}
                          disabled={!usernameChanged || isChangingUsername}
                        >
                          <Save size={16} />
                          Guardar
                        </Button>
                      )}
                    </div>

                    {isEditingUsername && (
                      <div className={styles.sectionActions}>
                        <Button variant="ghost" onClick={handleCancelUsernameEdit} disabled={isChangingUsername}>
                          Cancelar
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                <div className={styles.loginAccessItem}>
                  <div className={styles.loginAccessText}>
                    <strong>Contraseña</strong>
                    <span>Actualízala aquí. La nueva contraseña debe tener al menos 6 caracteres.</span>
                  </div>
                  <div className={styles.loginAccessControl}>
                    {!isEditingPassword ? (
                      <div className={styles.lockedFieldRow}>
                        <div className={styles.field}>
                          <label className={styles.label}>Contraseña actual</label>
                          <input
                            className={`${styles.input} ${styles.inputReadOnly}`}
                            type="password"
                            value="password-guardado"
                            readOnly
                            autoComplete="current-password"
                          />
                        </div>
                        <Button variant="secondary" onClick={handleStartPasswordEdit}>
                          <Lock size={16} />
                          Cambiar
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className={styles.passwordGrid}>
                          <div className={styles.field}>
                            <label className={styles.label}>Contraseña actual</label>
                            <input
                              className={styles.input}
                              type="password"
                              value={currentPassword}
                              onChange={(event) => setCurrentPassword(event.target.value)}
                              disabled={isChangingPassword}
                              autoComplete="current-password"
                            />
                          </div>

                          <div className={styles.field}>
                            <label className={styles.label}>Nueva contraseña</label>
                            <input
                              className={styles.input}
                              type="password"
                              value={newPassword}
                              onChange={(event) => setNewPassword(event.target.value)}
                              disabled={isChangingPassword}
                              autoComplete="new-password"
                            />
                          </div>

                          <div className={styles.field}>
                            <label className={styles.label}>Confirmar nueva contraseña</label>
                            <input
                              className={styles.input}
                              type="password"
                              value={confirmPassword}
                              onChange={(event) => setConfirmPassword(event.target.value)}
                              disabled={isChangingPassword}
                              autoComplete="new-password"
                            />
                          </div>
                        </div>

                        <div className={styles.sectionActions}>
                          <Button
                            variant="primary"
                            onClick={handleChangePassword}
                            loading={isChangingPassword}
                            disabled={!currentPassword || !newPassword || !confirmPassword || isChangingPassword}
                          >
                            <Save size={16} />
                            Guardar
                          </Button>
                          <Button variant="ghost" onClick={handleCancelPasswordEdit} disabled={isChangingPassword}>
                            Cancelar
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section className={styles.accountSection}>
              <div className={styles.accountSectionHeader}>
                <div>
                  <h3 className={styles.accountSectionTitle}>Perfil administrador</h3>
                  <p className={styles.accountSectionDescription}>
                    Foto visible para identificar la cuenta interna.
                  </p>
                </div>
              </div>

              <div className={styles.profileSummary}>
                <div className={styles.profileIdentity}>
                  <div className={styles.profileAvatar}>
                    {visibleProfilePhoto ? (
                      <img
                        src={visibleProfilePhoto}
                        alt="Foto del administrador"
                        className={styles.profileAvatarImage}
                      />
                    ) : (
                      <User size={26} />
                    )}
                  </div>
                  <div className={styles.profileText}>
                    <strong>{user?.name || 'Usuario'}</strong>
                    <span>@{currentUsername}</span>
                  </div>
                </div>
                <span className={styles.adminRole}>{currentRoleLabel}</span>
              </div>

              <input
                ref={fileInputRef}
                className={styles.hiddenFileInput}
                type="file"
                accept="image/*"
                onChange={handleProfilePhotoChange}
              />

              <div className={styles.sectionActions}>
                {!isEditingPhoto ? (
                  <Button variant="secondary" onClick={handleStartPhotoEdit}>
                    <Upload size={16} />
                    Cambiar
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={savingProfilePhoto}
                    >
                      <Upload size={16} />
                      Subir foto
                    </Button>
                    {profilePhotoDraft && (
                      <Button
                        variant="ghost"
                        onClick={() => setProfilePhotoDraft('')}
                        disabled={savingProfilePhoto}
                      >
                        <X size={16} />
                        Quitar
                      </Button>
                    )}
                    <Button
                      variant="primary"
                      onClick={handleSaveProfilePhoto}
                      loading={savingProfilePhoto}
                    >
                      <Save size={16} />
                      Guardar
                    </Button>
                    <Button variant="ghost" onClick={handleCancelPhotoEdit} disabled={savingProfilePhoto}>
                      Cancelar
                    </Button>
                  </>
                )}
              </div>
            </section>

            <section className={`${styles.accountSection} ${styles.accountSectionWide}`}>
              <div className={styles.accountSectionHeader}>
                <div>
                  <h3 className={styles.accountSectionTitle}>Datos de cuenta</h3>
                  <p className={styles.accountSectionDescription}>
                    Datos visibles del administrador dentro de Ristak.
                  </p>
                </div>
              </div>

              <div className={styles.profileDetailsGrid}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="account-first-name">Nombre</label>
                  <input
                    id="account-first-name"
                    className={styles.input}
                    type="text"
                    value={profileDraft.firstName}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, firstName: event.target.value }))}
                    disabled={savingProfileDetails}
                    autoComplete="given-name"
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="account-last-name">Apellido</label>
                  <input
                    id="account-last-name"
                    className={styles.input}
                    type="text"
                    value={profileDraft.lastName}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, lastName: event.target.value }))}
                    disabled={savingProfileDetails}
                    autoComplete="family-name"
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="account-phone">Teléfono</label>
                  <input
                    id="account-phone"
                    className={styles.input}
                    type="tel"
                    value={profileDraft.phone}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, phone: event.target.value }))}
                    disabled={savingProfileDetails}
                    autoComplete="tel"
                    placeholder="+52 656 000 0000"
                  />
                </div>

              </div>

              <div className={styles.sectionActions}>
                <Button
                  variant="primary"
                  onClick={handleSaveProfileDetails}
                  loading={savingProfileDetails}
                  disabled={savingProfileDetails || !profileDetailsChanged}
                >
                  <Save size={16} />
                  Guardar
                </Button>
              </div>
            </section>

            <section className={`${styles.accountSection} ${styles.accountSectionWide}`}>
              <div className={styles.accountSectionHeader}>
                <div>
                  <h3 className={styles.accountSectionTitle}>
                    <Building2 size={16} /> Datos del negocio
                  </h3>
                  <p className={styles.accountSectionDescription}>
                    Estos datos alimentan automáticamente la página de cobro y el comprobante. Pagos sólo los cambia si activas una personalización.
                  </p>
                </div>
              </div>

              <div className={styles.businessProfileLayout}>
                <div className={styles.businessLogoControl}>
                  <div className={styles.businessLogoPreview}>
                    {businessProfileDraft.logoUrl ? (
                      <img src={businessProfileDraft.logoUrl} alt="Logo del negocio" />
                    ) : (
                      <Image size={24} />
                    )}
                  </div>
                  <div className={styles.businessLogoContent}>
                    <strong>Logo del negocio</strong>
                    <span>Se usará como identidad visual en links de cobro y comprobantes.</span>
                    <div className={styles.businessLogoActions}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => businessLogoInputRef.current?.click()}
                        disabled={businessProfileSaving}
                      >
                        <ImageUp size={15} />
                        Subir logo
                      </Button>
                      {businessProfileDraft.logoUrl && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleBusinessProfileDraftChange('logoUrl', '')}
                          disabled={businessProfileSaving}
                        >
                          <Trash2 size={15} />
                          Quitar
                        </Button>
                      )}
                    </div>
                    <input
                      ref={businessLogoInputRef}
                      className={styles.hiddenFileInput}
                      type="file"
                      accept="image/*"
                      onChange={handleBusinessLogoChange}
                    />
                  </div>
                </div>

                <div className={styles.businessProfileGrid}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="business-profile-name">Nombre del negocio</label>
                    <input
                      id="business-profile-name"
                      className={styles.input}
                      type="text"
                      value={businessProfileDraft.name}
                      onChange={(event) => handleBusinessProfileDraftChange('name', event.target.value)}
                      disabled={businessProfileSaving}
                      autoComplete="organization"
                      placeholder="Tu negocio"
                    />
                  </div>

                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="business-profile-email">Email del negocio</label>
                    <input
                      id="business-profile-email"
                      className={styles.input}
                      type="email"
                      value={businessProfileDraft.email}
                      onChange={(event) => handleBusinessProfileDraftChange('email', event.target.value)}
                      disabled={businessProfileSaving}
                      autoComplete="email"
                      placeholder="pagos@tu-negocio.com"
                    />
                  </div>

                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="business-profile-phone">Teléfono del negocio</label>
                    <input
                      id="business-profile-phone"
                      className={styles.input}
                      type="tel"
                      value={businessProfileDraft.phone}
                      onChange={(event) => handleBusinessProfileDraftChange('phone', event.target.value)}
                      disabled={businessProfileSaving}
                      autoComplete="tel"
                      placeholder="+52 656 000 0000"
                    />
                  </div>

                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="business-profile-website">Sitio web</label>
                    <input
                      id="business-profile-website"
                      className={styles.input}
                      type="url"
                      value={businessProfileDraft.website}
                      onChange={(event) => handleBusinessProfileDraftChange('website', event.target.value)}
                      disabled={businessProfileSaving}
                      autoComplete="url"
                      placeholder="https://tu-negocio.com"
                    />
                  </div>

                  <div className={`${styles.field} ${styles.profileDetailsWide}`}>
                    <label className={styles.label} htmlFor="business-profile-address">Dirección fiscal o comercial</label>
                    <textarea
                      id="business-profile-address"
                      className={styles.textarea}
                      value={businessProfileDraft.address}
                      onChange={(event) => handleBusinessProfileDraftChange('address', event.target.value)}
                      disabled={businessProfileSaving}
                      placeholder="Calle, ciudad, estado, país"
                    />
                  </div>

                  <div className={`${styles.field} ${styles.profileDetailsWide}`}>
                    <label className={styles.label} htmlFor="business-profile-terms">Términos predeterminados para pagos</label>
                    <textarea
                      id="business-profile-terms"
                      className={styles.textarea}
                      value={businessProfileDraft.terms}
                      onChange={(event) => handleBusinessProfileDraftChange('terms', event.target.value)}
                      disabled={businessProfileSaving}
                      placeholder="Políticas de pago, reembolso, emisión de comprobantes o condiciones del servicio."
                    />
                  </div>
                </div>
              </div>

              <div className={styles.sectionActions}>
                <Button
                  variant="primary"
                  onClick={handleSaveBusinessProfile}
                  loading={businessProfileSaving}
                  disabled={businessProfileSaving || !businessProfileChanged}
                >
                  <Save size={16} />
                  Guardar datos del negocio
                </Button>
              </div>
            </section>

            <section className={`${styles.accountSection} ${styles.accountSectionWide}`}>
              <div className={styles.accountSectionHeader}>
                <div>
                  <h3 className={styles.accountSectionTitle}>Nombres de contactos</h3>
                  <p className={styles.accountSectionDescription}>
                    Define cómo se nombran tus clientes y prospectos en toda la cuenta.
                  </p>
                </div>
              </div>

              <div className={styles.labelsGrid}>
                <div className={styles.labelField}>
                  <label className={styles.label}>Clientes</label>
                  <div className={styles.customDropdown} data-labels-dropdown>
                    <button
                      ref={customerTriggerRef}
                      type="button"
                      className={styles.dropdownTrigger}
                      onClick={() => handleOpenDropdown('customer')}
                      disabled={savingLabels}
                      aria-expanded={openDropdown === 'customer'}
                      data-ristak-dropdown-trigger
                    >
                      <span>{customLabels.customer || 'Seleccionar...'}</span>
                      <ChevronDown size={18} className={openDropdown === 'customer' ? styles.iconRotated : ''} />
                    </button>
                  </div>
                </div>

                <div className={styles.labelField}>
                  <label className={styles.label}>Prospectos</label>
                  <div className={styles.customDropdown} data-labels-dropdown>
                    <button
                      ref={leadTriggerRef}
                      type="button"
                      className={styles.dropdownTrigger}
                      onClick={() => handleOpenDropdown('lead')}
                      disabled={savingLabels}
                      aria-expanded={openDropdown === 'lead'}
                      data-ristak-dropdown-trigger
                    >
                      <span>{customLabels.lead || 'Seleccionar...'}</span>
                      <ChevronDown size={18} className={openDropdown === 'lead' ? styles.iconRotated : ''} />
                    </button>
                  </div>
                </div>

                {openDropdown && dropdownPos && createPortal(
                  <div
                    data-labels-dropdown
                    style={{
                      position: 'fixed',
                      top: dropdownPos.top,
                      left: dropdownPos.left,
                      width: dropdownPos.width,
                      zIndex: 'var(--z-index-dropdown)'
                    }}
                  >
                    <div className={styles.dropdownMenu} data-ristak-dropdown-panel>
                      {openDropdown === 'customer'
                        ? CUSTOMER_LABEL_OPTIONS.map((option) => (
                            <button
                              key={option}
                              type="button"
                              className={`${styles.dropdownItem} ${customLabels.customer === option ? styles.dropdownItemActive : ''}`}
                              data-ristak-dropdown-item
                              data-selected={customLabels.customer === option ? 'true' : undefined}
                              onClick={() => {
                                setOpenDropdown(null)
                                handleSaveLabels(option, customLabels.lead)
                              }}
                            >
                              <span>{option}</span>
                              {customLabels.customer === option && <Check size={16} />}
                            </button>
                          ))
                        : LEAD_LABEL_OPTIONS.map((option) => (
                            <button
                              key={option}
                              type="button"
                              className={`${styles.dropdownItem} ${customLabels.lead === option ? styles.dropdownItemActive : ''}`}
                              data-ristak-dropdown-item
                              data-selected={customLabels.lead === option ? 'true' : undefined}
                              onClick={() => {
                                setOpenDropdown(null)
                                handleSaveLabels(customLabels.customer, option)
                              }}
                            >
                              <span>{option}</span>
                              {customLabels.lead === option && <Check size={16} />}
                            </button>
                          ))
                      }
                    </div>
                  </div>,
                  document.body
                )}
              </div>

              {savingLabels && (
                <div className={styles.savingIndicator}>
                  <Loader2 size={14} className={styles.spinIcon} />
                  <span>Guardando...</span>
                </div>
              )}
            </section>

            <section className={`${styles.accountSection} ${styles.accountSectionWide}`}>
              <div className={styles.accountSectionHeader}>
                <div>
                  <h3 className={styles.accountSectionTitle}>
                    <Clock size={16} /> Zona horaria
                  </h3>
                  <p className={styles.accountSectionDescription}>
                    Zona horaria de toda la cuenta: se usa para mostrar fechas, horas, reportes y
                    el calendario. Es la fuente de verdad sobre HighLevel y no altera los datos
                    guardados, solo cómo los ves.
                  </p>
                </div>
              </div>

              <div className={styles.lockedFieldRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="account-timezone">Zona horaria</label>
                  <CustomSelect
                    id="account-timezone"
                    value={timezoneDraft}
                    onChange={(event) => setTimezoneDraft(event.target.value)}
                    disabled={savingTimezone}
                  >
                    {!ALL_TIMEZONES.includes(timezoneDraft) && (
                      <option value={timezoneDraft}>{selectedTimezoneInfo.optionLabel}</option>
                    )}
                    {timezoneOptions.map((tz) => (
                      <option key={tz.value} value={tz.value}>{tz.optionLabel}</option>
                    ))}
                  </CustomSelect>
                </div>
                <Button
                  variant="primary"
                  onClick={handleSaveTimezone}
                  loading={savingTimezone}
                  disabled={savingTimezone || timezoneDraft === timezone}
                >
                  <Save size={16} />
                  Guardar
                </Button>
              </div>

            </section>

            <section className={`${styles.accountSection} ${styles.accountSectionWide}`}>
              <div className={styles.accountSectionHeader}>
                <div>
                  <h3 className={styles.accountSectionTitle}>
                    <Globe2 size={16} /> País y cobros
                  </h3>
                  <p className={styles.accountSectionDescription}>
                    Ristak usa esto para poner la lada en teléfonos sin + y para dejar lista la moneda de nuevos cobros.
                  </p>
                </div>
              </div>

              <div className={styles.accountLocaleGrid}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="account-country">País de la cuenta</label>
                  <CustomSelect
                    id="account-country"
                    value={accountLocaleDraft.countryCode}
                    onChange={(event) => handleCountryChange(event.target.value)}
                    disabled={accountLocaleSaving}
                  >
                    {COUNTRY_OPTIONS.map((country) => (
                      <option key={country.value} value={country.value}>
                        {country.label} (+{country.dialCode})
                      </option>
                    ))}
                  </CustomSelect>
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="account-currency">Moneda de cobro</label>
                  <CustomSelect
                    id="account-currency"
                    value={accountLocaleDraft.currency}
                    onChange={(event) => setAccountLocaleDraft((current) => ({ ...current, currency: event.target.value }))}
                    disabled={accountLocaleSaving}
                  >
                    {CURRENCY_OPTIONS.map((currencyOption) => (
                      <option key={currencyOption.value} value={currencyOption.value}>
                        {currencyOption.label}
                      </option>
                    ))}
                  </CustomSelect>
                </div>

                <div className={styles.localePreview}>
                  <span>Teléfonos sin lada se guardan con +{accountLocaleDraft.dialCode}</span>
                  <span>Cobros nuevos salen en {accountLocaleDraft.currency}</span>
                </div>

                <Button
                  variant="primary"
                  onClick={handleSaveAccountLocale}
                  loading={accountLocaleSaving}
                  disabled={accountLocaleSaving || !accountLocaleChanged}
                >
                  <Save size={16} />
                  Guardar
                </Button>
              </div>
            </section>

            <section className={`${styles.accountSection} ${styles.accountSectionWide} ${styles.storageUsageSection}`}>
              <div className={styles.storageUsageHeader}>
                <div>
                  <h3 className={styles.accountSectionTitle}>
                    <Database size={16} /> Almacenamiento multimedia
                  </h3>
                  <p className={styles.accountSectionDescription}>Imágenes, videos, audios y documentos subidos a Ristak.</p>
                </div>
                <strong className={styles.storageUsageValue}>
                  {storageStatus
                    ? `${storageStatus.percentUsed}%`
                    : storageStatusError
                      ? 'No disponible'
                      : ''}
                </strong>
              </div>

              <div
                className={styles.storageUsageTrack}
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(storagePercent)}
                aria-label="Uso de almacenamiento multimedia"
              >
                <span
                  className={`${styles.storageUsageBar} ${storageStatus?.needsAttention ? styles.storageUsageBarWarning : ''}`}
                  style={{ width: `${storagePercent}%` }}
                />
              </div>

              <div className={styles.storageUsageMeta}>
                <span>{storageStatus?.sizePretty || `${storageStatus?.sizeGB ?? 0} GB`} usados</span>
                <span>{storageStatus ? `${storageStatus.availablePretty || '0 MB'} libres de ${storageStatus.limitGB.toFixed(storageStatus.limitGB >= 10 ? 0 : 1)} GB` : 'Esperando lectura'}</span>
              </div>
            </section>

            {user?.role === 'admin' && (
              <section className={`${styles.accountSection} ${styles.accountSectionWide} ${styles.cancelAccountSection}`}>
                <div className={styles.accountSectionHeader}>
                  <div>
                    <h3 className={styles.accountSectionTitle}>
                      <AlertTriangle size={16} /> Cancelar cuenta
                    </h3>
                    <p className={styles.accountSectionDescription}>
                      Cancela la suscripción, prepara un respaldo descargable por 30 días y elimina los recursos de Render para detener futuros cobros de infraestructura.
                    </p>
                  </div>
                </div>

                <div className={styles.cancelAccountPanel}>
                  <div className={styles.cancelAccountCopy}>
                    <strong>Esta acción apaga tu Ristak.</strong>
                    <span>
                      Primero generamos un respaldo completo de la base de datos. Después se cancela Stripe y se eliminan el servicio web, la base de datos y archivos externos de esta instalación.
                    </span>
                    {cancellationStatusError && (
                      <span className={styles.cancelAccountWarning}>
                        No pudimos leer el estado de cancelación del portal central. Intenta de nuevo en unos minutos.
                      </span>
                    )}
                  </div>
                  <Button
                    variant="danger"
                    onClick={openCancellationModal}
                    disabled={!canManageAccountCancellation || cancellationStatusError || !cancellationStatus}
                  >
                    <AlertTriangle size={16} />
                    Cancelar cuenta
                  </Button>
                </div>
              </section>
            )}
          </div>
        </div>
      </Card>

      <Modal
        isOpen={isCancellationModalOpen}
        onClose={() => setIsCancellationModalOpen(false)}
        title={cancellationStep === 'done' ? 'Cuenta cancelada' : cancellationStep === 'offer' ? 'Antes de cancelar' : 'Cancelar cuenta'}
        message={cancellationStep === 'reasons'
          ? 'Vas a cancelar tu suscripción, generar un respaldo y eliminar los recursos de Render. Esta acción no se puede deshacer.'
          : undefined}
        type={cancellationStep === 'reasons' ? 'confirm' : 'custom'}
        size="lg"
        confirmText={cancellationStep === 'reasons' ? 'Cancelar cuenta' : undefined}
        cancelText="Volver"
        onConfirm={cancellationStep === 'reasons' ? handleCancelAccount : undefined}
        closeOnBackdropClick={!cancellingAccount && !savingRetentionOffer}
        closeOnEscape={!cancellingAccount && !savingRetentionOffer}
      >
        {cancellationStep === 'offer' && (
          <div className={styles.cancelModalStack}>
            <div className={styles.retentionOfferPanel}>
              <span className={styles.retentionOfferIcon}>
                <Gift size={22} />
              </span>
              <div>
                <h3>Quédate un mes más con 80% de descuento</h3>
                <p>
                  Aplicamos el descuento al siguiente mes de tu suscripción. Tu cuenta sigue activa y no se borra nada.
                </p>
              </div>
            </div>
            <div className={styles.cancelModalActions}>
              <Button
                variant="primary"
                onClick={handleAcceptRetentionOffer}
                loading={savingRetentionOffer}
                disabled={savingRetentionOffer}
              >
                <Gift size={16} />
                Aceptar 80%
              </Button>
              <Button
                variant="secondary"
                onClick={() => setCancellationStep('reasons')}
                disabled={savingRetentionOffer}
              >
                No, cancelar
              </Button>
            </div>
          </div>
        )}

        {cancellationStep === 'reasons' && (
          <div className={styles.cancelModalStack}>
            <div className={styles.cancelReasonList} role="radiogroup" aria-label="Motivo de cancelación">
              {cancellationReasons.map((reason) => (
                <label key={reason.key} className={styles.cancelReasonOption}>
                  <input
                    type="radio"
                    name="account-cancellation-reason"
                    value={reason.key}
                    checked={selectedCancellationReason === reason.key}
                    onChange={(event) => setSelectedCancellationReason(event.target.value)}
                    disabled={cancellingAccount}
                  />
                  <span>{reason.label}</span>
                </label>
              ))}
            </div>
            {selectedReasonRequiresDetails && (
              <div className={styles.field}>
                <label className={styles.label} htmlFor="account-cancellation-details">Motivo</label>
                <textarea
                  id="account-cancellation-details"
                  className={styles.textarea}
                  value={cancellationReasonDetails}
                  onChange={(event) => setCancellationReasonDetails(event.target.value)}
                  disabled={cancellingAccount}
                  placeholder="Cuéntanos qué faltó o qué te hizo cancelar."
                />
              </div>
            )}
            <div className={styles.cancelDangerNote}>
              <AlertTriangle size={16} />
              <span>El respaldo se genera antes de apagar tu app. El enlace dura 30 días.</span>
            </div>
          </div>
        )}

        {cancellationStep === 'done' && cancellationResult && (
          <div className={styles.cancelModalStack}>
            <div className={styles.cancelCompletePanel}>
              <CheckCircle size={24} />
              <div>
                <h3>Tu respaldo está listo</h3>
                <p>
                  Tienes 30 días para descargar todos los datos exportados. La limpieza de Render ya quedó en cola para detener cobros futuros de infraestructura.
                </p>
              </div>
            </div>
            <div className={styles.exportSummaryGrid}>
              <span>{cancellationResult.export.table_count} tablas</span>
              <span>{cancellationResult.export.row_count} filas</span>
              <span>Vence {formatDate(cancellationResult.export.expires_at, { timezone, includeYear: true })}</span>
            </div>
            <div className={styles.cancelModalActions}>
              <a
                data-btn=""
                data-v="primary"
                className={styles.exportDownloadButton}
                href={cancellationResult.export.download_url}
                target="_blank"
                rel="noreferrer"
              >
                <Download size={16} />
                Descargar respaldo
              </a>
              <Button variant="secondary" onClick={() => setIsCancellationModalOpen(false)}>
                Cerrar
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
