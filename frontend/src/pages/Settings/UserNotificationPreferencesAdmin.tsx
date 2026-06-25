// (MOB-006) Vista admin: preferencias de notificación del celular de TODO el equipo.
// Cada fila es un usuario; cada columna una de las preferencias. El switch refleja el
// valor EFECTIVO (override propio o global heredado) y un badge dice si es "Personal"
// (override) o "Heredado" (toma el default del tenant). Cambiar un switch hace PATCH
// /api/user-config/admin/:userId con el override; no se borra desde aquí (eso vuelve a
// heredar) — para volver a heredar el admin usa el botón "Heredar global" por fila.
import React, { useEffect, useMemo, useState } from 'react'
import { BellRing, RefreshCw, Users } from 'lucide-react'
import { Badge, Button, Switch, Table, type Column } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import {
  userConfigService,
  type AdminUserConfig,
  type UserConfigEntry
} from '@/services/userConfigService'
import styles from './UserNotificationPreferencesAdmin.module.css'

// Las 6 preferencias on/off que se editan con un Switch. calendar_ids (lista) se muestra
// aparte como resumen de cuántos calendarios filtra, sin editar (la lista vive en el
// dispositivo y se ajusta desde el celular).
const TOGGLE_PREFERENCES: Array<{ key: string; label: string }> = [
  { key: 'chat_push_notifications_enabled', label: 'Chats' },
  { key: 'payment_push_notifications_enabled', label: 'Pagos' },
  { key: 'appointment_confirmation_push_notifications_enabled', label: 'Citas confirmadas' },
  { key: 'calendar_push_notifications_enabled', label: 'Calendario' },
  { key: 'push_notification_sound_enabled', label: 'Sonido' },
  { key: 'push_notification_vibration_enabled', label: 'Vibración' }
]

const CALENDAR_IDS_KEY = 'calendar_push_notification_calendar_ids'

type ConfigMap = Record<string, UserConfigEntry>

interface UserRow extends AdminUserConfig {
  id: string
}

function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return ['1', 'true', 'yes', 'on'].includes(normalized)
  }
  return false
}

function getInitials(name: string, email: string) {
  const source = name || email || 'Usuario'
  return source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'U'
}

export const UserNotificationPreferencesAdmin: React.FC = () => {
  const { showToast } = useNotification()
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [savingCell, setSavingCell] = useState<string | null>(null)

  const loadTeam = async (silent = false) => {
    try {
      if (!silent) setLoading(true)
      const { users: teamUsers } = await userConfigService.getTeamConfig()
      setUsers(teamUsers.map((u) => ({ ...u, id: u.userId })))
    } catch (error: any) {
      showToast('error', 'No se cargaron las preferencias', error?.message || 'Intenta otra vez.')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    void loadTeam()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleToggle = async (userId: string, key: string, nextValue: boolean) => {
    const cellId = `${userId}:${key}`
    // Actualización optimista: el switch responde al instante y se confirma en PATCH.
    setUsers((current) => current.map((row) => row.id === userId
      ? { ...row, config: { ...row.config, [key]: { value: nextValue, isOverride: true } } }
      : row
    ))
    setSavingCell(cellId)
    try {
      const resultConfig = await userConfigService.patchUserConfig(userId, { [key]: nextValue })
      setUsers((current) => current.map((row) => row.id === userId
        ? { ...row, config: resultConfig as ConfigMap }
        : row
      ))
    } catch (error: any) {
      showToast('error', 'No se guardó la preferencia', error?.message || 'Intenta otra vez.')
      void loadTeam(true)
    } finally {
      setSavingCell(null)
    }
  }

  const handleInheritAll = async (userId: string) => {
    // Borra TODOS los overrides del usuario (value=null) para volver a heredar el global.
    const clearAll = Object.fromEntries(TOGGLE_PREFERENCES.map(({ key }) => [key, null]))
    setSavingCell(`${userId}:inherit`)
    try {
      const resultConfig = await userConfigService.patchUserConfig(userId, clearAll)
      setUsers((current) => current.map((row) => row.id === userId
        ? { ...row, config: resultConfig as ConfigMap }
        : row
      ))
      showToast('success', 'Listo', 'Esta persona vuelve a usar la configuración del negocio.')
    } catch (error: any) {
      showToast('error', 'No se pudo restablecer', error?.message || 'Intenta otra vez.')
    } finally {
      setSavingCell(null)
    }
  }

  const columns = useMemo<Column<UserRow>[]>(() => {
    const personCol: Column<UserRow> = {
      key: 'person',
      header: 'Persona',
      fixed: true,
      searchValue: (_value, item) => [item.fullName, item.email, item.username],
      render: (_value, item) => (
        <span className={styles.identity}>
          <span className={styles.avatar}>{getInitials(item.fullName, item.email)}</span>
          <span className={styles.identityText}>
            <span className={styles.name}>{item.fullName || item.email || item.username}</span>
            <span className={styles.meta}>
              <Badge variant={item.role === 'admin' ? 'primary' : 'neutral'}>
                {item.role === 'admin' ? 'Administrador' : 'Empleado'}
              </Badge>
            </span>
          </span>
        </span>
      )
    }

    const toggleCols: Column<UserRow>[] = TOGGLE_PREFERENCES.map(({ key, label }) => ({
      key,
      header: label,
      searchable: false,
      render: (_value, item) => {
        const entry = item.config?.[key]
        const checked = toBool(entry?.value)
        const isOverride = Boolean(entry?.isOverride)
        const cellId = `${item.id}:${key}`
        return (
          <span className={styles.toggleCell}>
            <Switch
              checked={checked}
              disabled={savingCell === cellId}
              aria-label={`${label} para ${item.fullName || item.email || item.username}`}
              onChange={(next) => handleToggle(item.id, key, next)}
            />
            <Badge variant={isOverride ? 'info' : 'neutral'}>
              {isOverride ? 'Personal' : 'Heredado'}
            </Badge>
          </span>
        )
      }
    }))

    const calendarCol: Column<UserRow> = {
      key: CALENDAR_IDS_KEY,
      header: 'Calendarios',
      searchable: false,
      render: (_value, item) => {
        const entry = item.config?.[CALENDAR_IDS_KEY]
        const list = Array.isArray(entry?.value) ? entry?.value as unknown[] : []
        const isOverride = Boolean(entry?.isOverride)
        return (
          <span className={styles.toggleCell}>
            <Badge variant="neutral">
              {list.length === 0 ? 'Todos' : `${list.length} elegidos`}
            </Badge>
            <Badge variant={isOverride ? 'info' : 'neutral'}>
              {isOverride ? 'Personal' : 'Heredado'}
            </Badge>
          </span>
        )
      }
    }

    const actionsCol: Column<UserRow> = {
      key: 'actions',
      header: '',
      searchable: false,
      render: (_value, item) => {
        const hasAnyOverride = TOGGLE_PREFERENCES.some(({ key }) => item.config?.[key]?.isOverride)
        return (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!hasAnyOverride || savingCell === `${item.id}:inherit`}
            onClick={() => handleInheritAll(item.id)}
          >
            Heredar global
          </Button>
        )
      }
    }

    return [personCol, ...toggleCols, calendarCol, actionsCol]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savingCell])

  return (
    <section className={styles.wrapper}>
      <div className={styles.intro}>
        <div className={styles.introText}>
          <span className={styles.introTitle}>
            <BellRing size={16} />
            Notificaciones del equipo
          </span>
          <span className={styles.introDescription}>
            Cada persona puede personalizar sus avisos en el celular. Aquí ves qué recibe cada
            quien: «Personal» es un ajuste propio y «Heredado» usa la configuración del negocio.
          </span>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => loadTeam()}
          leftIcon={<RefreshCw size={15} />}
          disabled={loading}
        >
          Actualizar
        </Button>
      </div>

      <Table<UserRow>
        columns={columns}
        data={users}
        keyExtractor={(item) => item.id}
        loading={loading}
        searchable
        searchPlaceholder="Buscar persona..."
        paginated
        pageSize={25}
        emptyMessage="Todavía no hay personas con acceso."
      />

      {!loading && users.length === 0 && (
        <div className={styles.empty}>
          <Users size={18} />
          Todavía no hay personas con acceso.
        </div>
      )}
    </section>
  )
}
