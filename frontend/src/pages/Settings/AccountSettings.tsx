import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, CheckCircle, ChevronDown, Clock, Database, Loader2, Lock, Save, Upload, User, X } from 'lucide-react'
import { Button, Card } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAppConfig } from '@/hooks'
import apiClient from '@/services/apiClient'
import styles from './Settings.module.css'

const API_URL = import.meta.env.VITE_API_URL || ''
const PROFILE_PHOTO_KEY = 'admin_profile_photo'
const MAX_PROFILE_PHOTO_SIZE = 1.5 * 1024 * 1024
const CUSTOMER_LABEL_OPTIONS = ['Cliente', 'Paciente', 'Proyecto', 'Miembro', 'Alumno']
const LEAD_LABEL_OPTIONS = ['Interesado', 'Prospecto', 'Mensaje', 'Lead', 'Consulta']

interface StorageStatus {
  sizeGB: number
  sizePretty?: string
  limitGB: number
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

export const AccountSettings: React.FC = () => {
  const { user, logout } = useAuth()
  const { labels, updateLabels } = useLabels()
  const { showToast } = useNotification()
  const { timezone, updateTimezone } = useTimezone()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [profilePhoto, setProfilePhoto, savingProfilePhoto] = useAppConfig<string>(PROFILE_PHOTO_KEY, '')
  const [profilePhotoDraft, setProfilePhotoDraft] = useState('')
  const [isEditingPhoto, setIsEditingPhoto] = useState(false)

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
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null)
  const [storageStatusError, setStorageStatusError] = useState(false)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const customerTriggerRef = useRef<HTMLButtonElement>(null)
  const leadTriggerRef = useRef<HTMLButtonElement>(null)

  const currentUsername = user?.username || 'admin'
  const visibleProfilePhoto = isEditingPhoto ? profilePhotoDraft : profilePhoto
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

  useEffect(() => {
    setCustomLabels({
      customer: labels.customer,
      lead: labels.lead
    })
  }, [labels])

  useEffect(() => {
    setTimezoneDraft(timezone)
  }, [timezone])

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
        const data = await apiClient.get<StorageStatus>('/dashboard/storage-status')
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
      await setProfilePhoto(profilePhotoDraft)
      setIsEditingPhoto(false)
      showToast(
        'success',
        profilePhotoDraft ? 'Foto actualizada' : 'Foto eliminada',
        profilePhotoDraft ? 'La foto del administrador quedó guardada.' : 'Se quitó la foto del administrador.'
      )
    } catch (error: any) {
      showToast('error', 'Error', error?.message || 'No se pudo guardar la foto')
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
                    <div className={styles.dropdownMenu}>
                      {openDropdown === 'customer'
                        ? CUSTOMER_LABEL_OPTIONS.map((option) => (
                            <button
                              key={option}
                              type="button"
                              className={`${styles.dropdownItem} ${customLabels.customer === option ? styles.dropdownItemActive : ''}`}
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
                  <select
                    id="account-timezone"
                    className={styles.select}
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
                  </select>
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

            <section className={`${styles.accountSection} ${styles.accountSectionWide} ${styles.storageUsageSection}`}>
              <div className={styles.storageUsageHeader}>
                <div>
                  <h3 className={styles.accountSectionTitle}>
                    <Database size={16} /> Base de datos
                  </h3>
                  <p className={styles.accountSectionDescription}>Storage utilizado en Render.</p>
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
                aria-label="Uso de base de datos"
              >
                <span
                  className={`${styles.storageUsageBar} ${storageStatus?.needsAttention ? styles.storageUsageBarWarning : ''}`}
                  style={{ width: `${storagePercent}%` }}
                />
              </div>

              <div className={styles.storageUsageMeta}>
                <span>{storageStatus?.sizePretty || `${storageStatus?.sizeGB ?? 0} GB`} usados</span>
                <span>{storageStatus ? `${storageStatus.limitGB} GB disponibles` : 'Esperando lectura'}</span>
              </div>
            </section>
          </div>
        </div>
      </Card>
    </div>
  )
}
