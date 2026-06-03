import React, { useEffect, useRef, useState } from 'react'
import { Check, CheckCircle, ChevronDown, Loader2, Lock, Save, Upload, User, X } from 'lucide-react'
import { Button, Card } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useAppConfig } from '@/hooks'
import styles from './Settings.module.css'

const API_URL = import.meta.env.VITE_API_URL || ''
const PROFILE_PHOTO_KEY = 'admin_profile_photo'
const MAX_PROFILE_PHOTO_SIZE = 1.5 * 1024 * 1024
const CUSTOMER_LABEL_OPTIONS = ['Cliente', 'Paciente', 'Proyecto', 'Miembro', 'Alumno']
const LEAD_LABEL_OPTIONS = ['Interesado', 'Prospecto', 'Mensaje', 'Lead', 'Consulta']

export const AccountSettings: React.FC = () => {
  const { user, logout } = useAuth()
  const { labels, updateLabels } = useLabels()
  const { showToast } = useNotification()
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

  const currentUsername = user?.username || 'admin'
  const visibleProfilePhoto = isEditingPhoto ? profilePhotoDraft : profilePhoto
  const usernameChanged = newUsername.trim() && newUsername.trim() !== currentUsername

  useEffect(() => {
    setCustomLabels({
      customer: labels.customer,
      lead: labels.lead
    })
  }, [labels])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Element && !target.closest('[data-labels-dropdown]')) {
        setOpenDropdown(null)
      }
    }

    if (openDropdown) {
      document.addEventListener('click', handleClickOutside)
      return () => document.removeEventListener('click', handleClickOutside)
    }
  }, [openDropdown])

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
                      type="button"
                      className={styles.dropdownTrigger}
                      onClick={() => setOpenDropdown(openDropdown === 'customer' ? null : 'customer')}
                      disabled={savingLabels}
                    >
                      <span>{customLabels.customer || 'Seleccionar...'}</span>
                      <ChevronDown size={18} className={openDropdown === 'customer' ? styles.iconRotated : ''} />
                    </button>
                    {openDropdown === 'customer' && (
                      <div className={styles.dropdownMenuWrapper}>
                        <div className={styles.dropdownMenu}>
                          {CUSTOMER_LABEL_OPTIONS.map((option) => (
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
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className={styles.labelField}>
                  <label className={styles.label}>Prospectos</label>
                  <div className={styles.customDropdown} data-labels-dropdown>
                    <button
                      type="button"
                      className={styles.dropdownTrigger}
                      onClick={() => setOpenDropdown(openDropdown === 'lead' ? null : 'lead')}
                      disabled={savingLabels}
                    >
                      <span>{customLabels.lead || 'Seleccionar...'}</span>
                      <ChevronDown size={18} className={openDropdown === 'lead' ? styles.iconRotated : ''} />
                    </button>
                    {openDropdown === 'lead' && (
                      <div className={styles.dropdownMenuWrapper}>
                        <div className={styles.dropdownMenu}>
                          {LEAD_LABEL_OPTIONS.map((option) => (
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
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {savingLabels && (
                <div className={styles.savingIndicator}>
                  <Loader2 size={14} className={styles.spinIcon} />
                  <span>Guardando...</span>
                </div>
              )}
            </section>
          </div>
        </div>
      </Card>
    </div>
  )
}
