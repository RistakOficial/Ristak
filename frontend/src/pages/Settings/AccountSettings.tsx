import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bell, CalendarDays, Check, CheckCircle, ChevronDown, Clock, CreditCard, Database, Globe2, Loader2, Lock, MessageCircle, Save, Smartphone, Upload, User, X } from 'lucide-react'
import { Button, Card, CustomSelect } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAppConfig } from '@/hooks'
import apiClient from '@/services/apiClient'
import mediaService from '@/services/mediaService'
import { pushNotificationsService } from '@/services/pushNotificationsService'
import {
  ACCOUNT_COUNTRY_CONFIG_KEY,
  ACCOUNT_CURRENCY_CONFIG_KEY,
  ACCOUNT_DIAL_CODE_CONFIG_KEY,
  COUNTRY_OPTIONS,
  CURRENCY_OPTIONS,
  getCountryDefaults,
  getDetectedAccountLocaleDefaults
} from '@/utils/accountLocale'
import styles from './Settings.module.css'

const API_URL = import.meta.env.VITE_API_URL || ''
const PROFILE_PHOTO_KEY = 'admin_profile_photo'
const MAX_PROFILE_PHOTO_SIZE = 1.5 * 1024 * 1024
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

const getNotificationPermissionLabel = () => {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'Este celular no permite notificaciones de la app.'
  }
  if (Notification.permission === 'granted') return 'Este celular ya puede recibir notificaciones.'
  if (Notification.permission === 'denied') return 'El celular bloqueó las notificaciones. Actívalas desde los ajustes del navegador.'
  return 'Toca Activar para permitir notificaciones en este celular.'
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
  const [accountCountry, setAccountCountry, savingAccountCountry] = useAppConfig<string>(ACCOUNT_COUNTRY_CONFIG_KEY, detectedLocaleDefaults.countryCode)
  const [accountCurrency, setAccountCurrency, savingAccountCurrency] = useAppConfig<string>(ACCOUNT_CURRENCY_CONFIG_KEY, detectedLocaleDefaults.currency)
  const [accountDialCode, setAccountDialCode, savingAccountDialCode] = useAppConfig<string>(ACCOUNT_DIAL_CODE_CONFIG_KEY, detectedLocaleDefaults.dialCode)
  const [calendarPushEnabled, setCalendarPushEnabled, savingCalendarPush] = useAppConfig<boolean>('calendar_push_notifications_enabled', false)
  const [chatPushEnabled, setChatPushEnabled, savingChatPush] = useAppConfig<boolean>('chat_push_notifications_enabled', true)
  const [paymentPushEnabled, setPaymentPushEnabled, savingPaymentPush] = useAppConfig<boolean>('payment_push_notifications_enabled', true)
  const [pushCalendarIds] = useAppConfig<string[]>('calendar_push_notification_calendar_ids', [])
  const [profilePhotoDraft, setProfilePhotoDraft] = useState('')
  const [isEditingPhoto, setIsEditingPhoto] = useState(false)
  const [profileDraft, setProfileDraft] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    businessName: ''
  })
  const [savingProfileDetails, setSavingProfileDetails] = useState(false)

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
  const [requestingPush, setRequestingPush] = useState(false)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const customerTriggerRef = useRef<HTMLButtonElement>(null)
  const leadTriggerRef = useRef<HTMLButtonElement>(null)
  const localeBootstrappedRef = useRef(false)

  const currentUsername = user?.username || 'admin'
  const accountEmail = user?.email || (currentUsername.includes('@') ? currentUsername : '')
  const visibleProfilePhoto = isEditingPhoto ? profilePhotoDraft : profilePhoto
  const profileNameFallback = user?.name && user.name !== user.username ? user.name : ''
  const fallbackNameParts = useMemo(() => splitFallbackName(profileNameFallback), [profileNameFallback])
  const normalizedUserProfile = useMemo(() => ({
    firstName: user?.firstName || fallbackNameParts.firstName,
    lastName: user?.lastName || fallbackNameParts.lastName,
    phone: user?.phone || '',
    businessName: user?.businessName || ''
  }), [fallbackNameParts, user?.businessName, user?.firstName, user?.lastName, user?.phone])
  const profileDetailsChanged =
    profileDraft.firstName !== normalizedUserProfile.firstName ||
    profileDraft.lastName !== normalizedUserProfile.lastName ||
    profileDraft.phone !== normalizedUserProfile.phone ||
    profileDraft.businessName !== normalizedUserProfile.businessName
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
        phone: profileDraft.phone.trim(),
        businessName: profileDraft.businessName.trim()
      })
      showToast('success', 'Datos guardados', 'Tu nombre, teléfono y negocio quedaron actualizados.')
    } catch (error: any) {
      setProfileDraft(normalizedUserProfile)
      showToast('error', 'No se guardó', error?.message || 'Intenta guardar tus datos otra vez.')
    } finally {
      setSavingProfileDetails(false)
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
      showToast('error', 'Error', 'El nuevo nombre de usuario no puede estar vacío')
      return
    }

    if (newUsername.trim() === currentUsername) {
      showToast('warning', 'Atención', 'El nuevo nombre de usuario es igual al actual')
      return
    }

    setIsChangingUsername(true)

    try {
      const token = localStorage.getItem('auth_token')
      const response = await fetch(`${API_URL}/api/auth/change-username`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ token, newUsername: newUsername.trim() })
      })

      const data = await response.json()

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Error al cambiar el nombre de usuario')
      }

      showToast('success', 'Usuario actualizado', 'Debes volver a iniciar sesión con tu nuevo nombre de usuario')

      setTimeout(() => {
        logout()
        window.location.href = '/login'
      }, 2000)
    } catch (error: any) {
      showToast('error', 'Error', error.message || 'No se pudo cambiar el nombre de usuario')
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
      const response = await fetch(`${API_URL}/api/auth/change-password`, {
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

  const handleRequestPushNotifications = async () => {
    setRequestingPush(true)
    try {
      const result = await pushNotificationsService.subscribeToAppNotifications({
        calendarIds: pushCalendarIds
      })

      if (result.status === 'subscribed') {
        showToast('success', 'Notificaciones activadas', 'Este celular ya puede recibir notificaciones de Ristak.')
      } else {
        showToast('warning', 'No se activaron', result.reason)
      }
    } catch (error: any) {
      showToast('error', 'No se activaron', error?.message || 'Intenta nuevamente.')
    } finally {
      setRequestingPush(false)
    }
  }

  const handleToggleNotification = async (
    enabled: boolean,
    save: (value: boolean) => Promise<void>,
    titleOn: string,
    titleOff: string
  ) => {
    const nextValue = !enabled
    try {
      await save(nextValue)
      showToast('success', nextValue ? titleOn : titleOff)
    } catch (error: any) {
      showToast('error', 'No se guardó', error?.message || 'Intenta nuevamente.')
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
                Administra perfil, usuario y contraseña con cambios explícitos.
              </p>
            </div>
          </div>
          <div className={styles.panelHeaderActions}>
            <div className={styles.statusConnected}>
              <CheckCircle size={15} />
              Administrador
            </div>
          </div>
        </div>

        <div className={styles.panelSection}>
          <div className={styles.accountGrid}>
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
                <span className={styles.adminRole}>Administrador</span>
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
                    El nombre del negocio aparece en el menú lateral. Si lo dejas vacío, se mostrará el correo.
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
                  <label className={styles.label} htmlFor="account-email">Correo</label>
                  <input
                    id="account-email"
                    className={`${styles.input} ${styles.inputReadOnly}`}
                    type="text"
                    value={accountEmail || 'Sin correo guardado'}
                    readOnly
                    autoComplete="email"
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

                <div className={`${styles.field} ${styles.profileDetailsWide}`}>
                  <label className={styles.label} htmlFor="account-business-name">Nombre del negocio</label>
                  <input
                    id="account-business-name"
                    className={styles.input}
                    type="text"
                    value={profileDraft.businessName}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, businessName: event.target.value }))}
                    disabled={savingProfileDetails}
                    autoComplete="organization"
                    placeholder="Tu negocio"
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

            <section className={styles.accountSection}>
              <div className={styles.accountSectionHeader}>
                <div>
                  <h3 className={styles.accountSectionTitle}>Nombre de usuario</h3>
                  <p className={styles.accountSectionDescription}>
                    Al cambiarlo tendrás que iniciar sesión otra vez.
                  </p>
                </div>
              </div>

              <div className={styles.lockedFieldRow}>
                <div className={styles.field}>
                  <label className={styles.label}>Usuario</label>
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
            </section>

            <section className={`${styles.accountSection} ${styles.accountSectionWide}`}>
              <div className={styles.accountSectionHeader}>
                <div>
                  <h3 className={styles.accountSectionTitle}>Contraseña</h3>
                  <p className={styles.accountSectionDescription}>
                    La nueva contraseña debe tener al menos 6 caracteres.
                  </p>
                </div>
              </div>

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
                      zIndex: 9999
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

            <section className={`${styles.accountSection} ${styles.accountSectionWide}`}>
              <div className={styles.accountSectionHeader}>
                <div>
                  <h3 className={styles.accountSectionTitle}>
                    <Bell size={16} /> Notificaciones
                  </h3>
                  <p className={styles.accountSectionDescription}>
                    Elige qué notificaciones quieres recibir en los celulares donde abras Ristak desde el icono de inicio.
                  </p>
                </div>
              </div>

              <div className={styles.notificationDeviceCard}>
                <span className={styles.notificationDeviceIcon}>
                  <Smartphone size={18} />
                </span>
                <div>
                  <strong>Este celular</strong>
                  <small>{getNotificationPermissionLabel()}</small>
                </div>
                <Button
                  variant="secondary"
                  onClick={handleRequestPushNotifications}
                  loading={requestingPush}
                  disabled={requestingPush}
                >
                  <Bell size={16} />
                  Activar
                </Button>
              </div>

              <div className={styles.notificationSettingsGrid}>
                <button
                  type="button"
                  className={`${styles.notificationSettingCard} ${chatPushEnabled ? styles.notificationSettingCardActive : ''}`}
                  onClick={() => handleToggleNotification(chatPushEnabled, setChatPushEnabled, 'Notificaciones de chat encendidas', 'Notificaciones de chat apagadas')}
                  disabled={savingChatPush}
                  aria-pressed={chatPushEnabled}
                >
                  <span className={styles.notificationSettingIcon}>
                    <MessageCircle size={18} />
                  </span>
                  <span>
                    <strong>Chat</strong>
                    <small>Mensajes nuevos de WhatsApp.</small>
                  </span>
                  <i>{chatPushEnabled ? 'Activo' : 'Apagado'}</i>
                </button>

                <button
                  type="button"
                  className={`${styles.notificationSettingCard} ${calendarPushEnabled ? styles.notificationSettingCardActive : ''}`}
                  onClick={() => handleToggleNotification(calendarPushEnabled, setCalendarPushEnabled, 'Notificaciones de citas encendidas', 'Notificaciones de citas apagadas')}
                  disabled={savingCalendarPush}
                  aria-pressed={calendarPushEnabled}
                >
                  <span className={styles.notificationSettingIcon}>
                    <CalendarDays size={18} />
                  </span>
                  <span>
                    <strong>Citas</strong>
                    <small>Cuando alguien agenda una cita.</small>
                  </span>
                  <i>{calendarPushEnabled ? 'Activo' : 'Apagado'}</i>
                </button>

                <button
                  type="button"
                  className={`${styles.notificationSettingCard} ${paymentPushEnabled ? styles.notificationSettingCardActive : ''}`}
                  onClick={() => handleToggleNotification(paymentPushEnabled, setPaymentPushEnabled, 'Notificaciones de pagos encendidas', 'Notificaciones de pagos apagadas')}
                  disabled={savingPaymentPush}
                  aria-pressed={paymentPushEnabled}
                >
                  <span className={styles.notificationSettingIcon}>
                    <CreditCard size={18} />
                  </span>
                  <span>
                    <strong>Pagos</strong>
                    <small>Cuando se registre un pago.</small>
                  </span>
                  <i>{paymentPushEnabled ? 'Activo' : 'Apagado'}</i>
                </button>
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
                      : 'Cargando...'}
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
          </div>
        </div>
      </Card>
    </div>
  )
}
