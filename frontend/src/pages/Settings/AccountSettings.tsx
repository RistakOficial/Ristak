import React, { useState } from 'react'
import { User, Lock, Save } from 'lucide-react'
import { Button, Card } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { useNotification } from '@/contexts/NotificationContext'
import styles from './Settings.module.css'

const API_URL = import.meta.env.VITE_API_URL || ''

export const AccountSettings: React.FC = () => {
  const { user, logout } = useAuth()
  const { showToast } = useNotification()

  // Estado para cambiar username
  const [newUsername, setNewUsername] = useState('')
  const [isChangingUsername, setIsChangingUsername] = useState(false)

  // Estado para cambiar contraseña
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isChangingPassword, setIsChangingPassword] = useState(false)

  const handleChangeUsername = async () => {
    if (!newUsername.trim()) {
      showToast('error', 'Error', 'El nuevo nombre de usuario no puede estar vacío')
      return
    }

    if (newUsername.trim() === user?.username) {
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

      // Cerrar sesión después de 2 segundos
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

  const handleChangePassword = async () => {
    // Validaciones
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

      // Limpiar campos
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (error: any) {
      showToast('error', 'Error', error.message || 'No se pudo cambiar la contraseña')
    } finally {
      setIsChangingPassword(false)
    }
  }

  return (
    <div className={styles.settingsContent}>
      <div className={styles.settingsSection}>
        <h2 className={styles.sectionTitle}>Información de la cuenta</h2>
        <p className={styles.sectionDescription}>
          Gestiona tu nombre de usuario y contraseña
        </p>

        <Card variant="glass" padding="lg" style={{ marginTop: '1.5rem' }}>
          {/* Información actual */}
          <div style={{ marginBottom: '2rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
              <div style={{
                width: '48px',
                height: '48px',
                borderRadius: '50%',
                background: 'linear-gradient(135deg, rgba(100, 116, 139, 0.15) 0%, rgba(30, 41, 59, 0.12) 100%)',
                border: '1px solid rgba(148, 163, 184, 0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-secondary)'
              }}>
                <User size={24} />
              </div>
              <div>
                <h3 style={{
                  fontSize: '1.125rem',
                  fontWeight: 600,
                  color: 'var(--color-text-primary)',
                  margin: 0
                }}>
                  {user?.name || 'Usuario'}
                </h3>
                <p style={{
                  fontSize: '0.875rem',
                  color: 'var(--color-text-tertiary)',
                  margin: '0.25rem 0 0 0'
                }}>
                  @{user?.username || 'admin'}
                </p>
              </div>
            </div>
            <div style={{
              padding: '0.75rem 1rem',
              background: 'rgba(148, 163, 184, 0.08)',
              borderRadius: '0.75rem',
              border: '1px solid rgba(148, 163, 184, 0.15)'
            }}>
              <p style={{
                fontSize: '0.875rem',
                color: 'var(--color-text-secondary)',
                margin: 0
              }}>
                <strong>Rol:</strong> Administrador
              </p>
            </div>
          </div>

          {/* Separador */}
          <div style={{
            height: '1px',
            background: 'linear-gradient(90deg, transparent, rgba(148, 163, 184, 0.2), transparent)',
            margin: '2rem 0'
          }} />

          {/* Cambiar nombre de usuario */}
          <div style={{ marginBottom: '2rem' }}>
            <div style={{ marginBottom: '1.25rem' }}>
              <h3 style={{
                fontSize: '1rem',
                fontWeight: 600,
                color: 'var(--color-text-primary)',
                margin: '0 0 0.5rem 0',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}>
                <User size={18} />
                Cambiar nombre de usuario
              </h3>
              <p style={{
                fontSize: '0.875rem',
                color: 'var(--color-text-tertiary)',
                margin: 0
              }}>
                Deberás volver a iniciar sesión después del cambio
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{
                  display: 'block',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  color: 'var(--color-text-secondary)',
                  marginBottom: '0.5rem'
                }}>
                  Nuevo nombre de usuario
                </label>
                <input
                  type="text"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder={user?.username || 'admin'}
                  disabled={isChangingUsername}
                  style={{
                    width: '100%',
                    height: '2.75rem',
                    padding: '0 1rem',
                    background: 'rgba(148, 163, 184, 0.06)',
                    border: '1px solid rgba(148, 163, 184, 0.18)',
                    borderRadius: '0.75rem',
                    color: 'var(--color-text-primary)',
                    fontSize: '0.9375rem',
                    transition: 'all 150ms ease'
                  }}
                />
              </div>

              <Button
                variant="primary"
                onClick={handleChangeUsername}
                loading={isChangingUsername}
                disabled={!newUsername.trim() || isChangingUsername}
                style={{ width: 'fit-content' }}
              >
                <Save size={18} />
                Guardar cambios
              </Button>
            </div>
          </div>

          {/* Separador */}
          <div style={{
            height: '1px',
            background: 'linear-gradient(90deg, transparent, rgba(148, 163, 184, 0.2), transparent)',
            margin: '2rem 0'
          }} />

          {/* Cambiar contraseña */}
          <div>
            <div style={{ marginBottom: '1.25rem' }}>
              <h3 style={{
                fontSize: '1rem',
                fontWeight: 600,
                color: 'var(--color-text-primary)',
                margin: '0 0 0.5rem 0',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}>
                <Lock size={18} />
                Cambiar contraseña
              </h3>
              <p style={{
                fontSize: '0.875rem',
                color: 'var(--color-text-tertiary)',
                margin: 0
              }}>
                La nueva contraseña debe tener al menos 6 caracteres
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{
                  display: 'block',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  color: 'var(--color-text-secondary)',
                  marginBottom: '0.5rem'
                }}>
                  Contraseña actual
                </label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="••••••••"
                  disabled={isChangingPassword}
                  autoComplete="current-password"
                  style={{
                    width: '100%',
                    height: '2.75rem',
                    padding: '0 1rem',
                    background: 'rgba(148, 163, 184, 0.06)',
                    border: '1px solid rgba(148, 163, 184, 0.18)',
                    borderRadius: '0.75rem',
                    color: 'var(--color-text-primary)',
                    fontSize: '0.9375rem',
                    transition: 'all 150ms ease'
                  }}
                />
              </div>

              <div>
                <label style={{
                  display: 'block',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  color: 'var(--color-text-secondary)',
                  marginBottom: '0.5rem'
                }}>
                  Nueva contraseña
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                  disabled={isChangingPassword}
                  autoComplete="new-password"
                  style={{
                    width: '100%',
                    height: '2.75rem',
                    padding: '0 1rem',
                    background: 'rgba(148, 163, 184, 0.06)',
                    border: '1px solid rgba(148, 163, 184, 0.18)',
                    borderRadius: '0.75rem',
                    color: 'var(--color-text-primary)',
                    fontSize: '0.9375rem',
                    transition: 'all 150ms ease'
                  }}
                />
              </div>

              <div>
                <label style={{
                  display: 'block',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  color: 'var(--color-text-secondary)',
                  marginBottom: '0.5rem'
                }}>
                  Confirmar nueva contraseña
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  disabled={isChangingPassword}
                  autoComplete="new-password"
                  style={{
                    width: '100%',
                    height: '2.75rem',
                    padding: '0 1rem',
                    background: 'rgba(148, 163, 184, 0.06)',
                    border: '1px solid rgba(148, 163, 184, 0.18)',
                    borderRadius: '0.75rem',
                    color: 'var(--color-text-primary)',
                    fontSize: '0.9375rem',
                    transition: 'all 150ms ease'
                  }}
                />
              </div>

              <Button
                variant="primary"
                onClick={handleChangePassword}
                loading={isChangingPassword}
                disabled={!currentPassword || !newPassword || !confirmPassword || isChangingPassword}
                style={{ width: 'fit-content' }}
              >
                <Lock size={18} />
                Cambiar contraseña
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
