import React, { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Loader2, Mail, Phone, Save, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react'
import { Button, Card } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { useNotification } from '@/contexts/NotificationContext'
import { userAccessService, type SaveTeamUserInput, type TeamUser } from '@/services/userAccessService'
import {
  ACCESS_MODULES,
  ADMIN_ACCESS,
  DEFAULT_EMPLOYEE_ACCESS,
  normalizeAccessConfig,
  normalizeRole,
  type AccessConfig,
  type AccessLevel,
  type PermissionGroup,
  type PermissionKey,
  type UserRole
} from '@/utils/accessControl'
import styles from './UserAccessSettings.module.css'

type Draft = SaveTeamUserInput & { id?: string }

const accessOptions: Array<{ value: AccessLevel; label: string }> = [
  { value: 'none', label: 'Sin acceso' },
  { value: 'read', label: 'Solo ver' },
  { value: 'write', label: 'Ver y editar' }
]

const blankDraft = (role: UserRole = 'employee'): Draft => ({
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  password: '',
  role,
  accessConfig: role === 'admin' ? { ...ADMIN_ACCESS } : { ...DEFAULT_EMPLOYEE_ACCESS }
})

const getInitials = (member: Pick<TeamUser, 'fullName' | 'email' | 'phone'>) => {
  const source = member.fullName || member.email || member.phone || 'Usuario'
  return source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'U'
}

const toDraft = (member: TeamUser): Draft => ({
  id: member.id,
  firstName: member.firstName || '',
  lastName: member.lastName || '',
  email: member.email || '',
  phone: member.phone || '',
  password: '',
  role: member.role,
  accessConfig: normalizeAccessConfig(member.accessConfig, member.role)
})

const groupedModules = ACCESS_MODULES.reduce<Record<PermissionGroup, typeof ACCESS_MODULES[number][]>>((groups, module) => {
  groups[module.group] = groups[module.group] || []
  groups[module.group].push(module)
  return groups
}, {
  CRM: [],
  Operación: [],
  Configuración: []
})

function getDraftPayload(draft: Draft): SaveTeamUserInput {
  const role = normalizeRole(draft.role)
  return {
    firstName: draft.firstName.trim(),
    lastName: draft.lastName.trim(),
    email: draft.email.trim(),
    phone: draft.phone.trim(),
    role,
    password: draft.password?.trim() || undefined,
    accessConfig: normalizeAccessConfig(draft.accessConfig, role)
  }
}

interface AccessMatrixProps {
  role: UserRole
  accessConfig: AccessConfig
  disabled?: boolean
  onChange: (moduleKey: PermissionKey, level: AccessLevel) => void
}

const AccessMatrix: React.FC<AccessMatrixProps> = ({ role, accessConfig, disabled = false, onChange }) => {
  const isAdmin = role === 'admin'

  return (
    <div className={styles.permissionGroups}>
      {isAdmin && (
        <div className={styles.adminNote}>
          <ShieldCheck size={16} />
          <span>El administrador siempre puede ver, editar, crear y borrar dentro del CRM.</span>
        </div>
      )}

      {(Object.keys(groupedModules) as PermissionGroup[]).map((group) => (
        <div className={styles.permissionGroup} key={group}>
          <h4 className={styles.permissionGroupTitle}>{group}</h4>
          {groupedModules[group].map((module) => {
            const moduleKey = module.key
            const currentLevel = isAdmin ? 'write' : accessConfig[moduleKey]
            const moduleLocked = isAdmin || moduleKey === 'settings_account' || moduleKey === 'settings_users'

            return (
              <div className={styles.permissionRow} key={moduleKey}>
                <div className={styles.permissionText}>
                  <strong>{module.label}</strong>
                  <span>{module.description}</span>
                </div>
                <div className={styles.segmented} role="group" aria-label={`Permiso para ${module.label}`}>
                  {accessOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`${styles.segment} ${currentLevel === option.value ? styles.segmentActive : ''}`}
                      disabled={disabled || moduleLocked}
                      onClick={() => onChange(moduleKey, option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export const UserAccessSettings: React.FC = () => {
  const { user } = useAuth()
  const { showToast } = useNotification()
  const [members, setMembers] = useState<TeamUser[]>([])
  const [loading, setLoading] = useState(true)
  const [savingCreate, setSavingCreate] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [createDraft, setCreateDraft] = useState<Draft>(() => blankDraft())
  const [editDraft, setEditDraft] = useState<Draft | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selectedMember = useMemo(
    () => members.find((member) => member.id === selectedId) || members[0] || null,
    [members, selectedId]
  )
  const selectedIsSelf = selectedMember?.id === user?.id

  useEffect(() => {
    let cancelled = false

    const loadMembers = async () => {
      try {
        setLoading(true)
        const nextMembers = await userAccessService.listUsers()
        if (cancelled) return
        setMembers(nextMembers)
        setSelectedId((current) => current || nextMembers[0]?.id || null)
      } catch (error: any) {
        if (!cancelled) {
          showToast('error', 'No se cargaron los accesos', error?.message || 'Intenta otra vez.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadMembers()

    return () => {
      cancelled = true
    }
  }, [showToast])

  useEffect(() => {
    if (!selectedMember) {
      setEditDraft(null)
      return
    }
    setEditDraft(toDraft(selectedMember))
  }, [selectedMember])

  const updateCreateRole = (role: UserRole) => {
    setCreateDraft((current) => ({
      ...current,
      role,
      accessConfig: role === 'admin' ? { ...ADMIN_ACCESS } : normalizeAccessConfig(current.accessConfig, role)
    }))
  }

  const updateEditRole = (role: UserRole) => {
    setEditDraft((current) => current
      ? {
          ...current,
          role,
          accessConfig: role === 'admin' ? { ...ADMIN_ACCESS } : normalizeAccessConfig(current.accessConfig, role)
        }
      : current
    )
  }

  const updateCreateAccess = (moduleKey: PermissionKey, level: AccessLevel) => {
    setCreateDraft((current) => ({
      ...current,
      accessConfig: normalizeAccessConfig({
        ...current.accessConfig,
        [moduleKey]: level
      }, current.role)
    }))
  }

  const updateEditAccess = (moduleKey: PermissionKey, level: AccessLevel) => {
    setEditDraft((current) => current
      ? {
          ...current,
          accessConfig: normalizeAccessConfig({
            ...current.accessConfig,
            [moduleKey]: level
          }, current.role)
        }
      : current
    )
  }

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    const payload = getDraftPayload(createDraft)

    if (!payload.email && !payload.phone) {
      showToast('warning', 'Falta contacto', 'Agrega correo o teléfono para crear el acceso.')
      return
    }

    if (!payload.password) {
      showToast('warning', 'Falta contraseña', 'Agrega una contraseña temporal.')
      return
    }

    try {
      setSavingCreate(true)
      const created = await userAccessService.createUser(payload)
      setMembers((current) => [created, ...current])
      setSelectedId(created.id)
      setCreateDraft(blankDraft())
      showToast('success', 'Acceso creado', 'La persona ya puede entrar con sus datos.')
    } catch (error: any) {
      showToast('error', 'No se creó el acceso', error?.message || 'Revisa los datos e intenta otra vez.')
    } finally {
      setSavingCreate(false)
    }
  }

  const handleSaveEdit = async () => {
    if (!editDraft?.id) return
    const payload = getDraftPayload(editDraft)

    if (!payload.email && !payload.phone) {
      showToast('warning', 'Falta contacto', 'Debe quedar correo o teléfono.')
      return
    }

    try {
      setSavingEdit(true)
      const updated = await userAccessService.updateUser(editDraft.id, payload)
      setMembers((current) => current.map((member) => member.id === updated.id ? updated : member))
      showToast('success', 'Acceso actualizado', 'Los permisos quedaron guardados.')
    } catch (error: any) {
      showToast('error', 'No se guardó', error?.message || 'Intenta otra vez.')
    } finally {
      setSavingEdit(false)
    }
  }

  const handleDelete = async () => {
    if (!selectedMember) return

    if (!window.confirm(`¿Borrar el acceso de ${selectedMember.fullName || selectedMember.email || selectedMember.phone}?`)) {
      return
    }

    try {
      setDeleting(true)
      await userAccessService.deleteUser(selectedMember.id)
      setMembers((current) => current.filter((member) => member.id !== selectedMember.id))
      setSelectedId(null)
      showToast('success', 'Acceso borrado', 'Esa persona ya no podrá entrar al CRM.')
    } catch (error: any) {
      showToast('error', 'No se pudo borrar', error?.message || 'Intenta otra vez.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className={styles.page}>
      <Card>
        <div className={styles.panelHeader}>
          <div className={styles.panelHeaderLeft}>
            <div className={styles.iconBox}>
              <ShieldCheck size={22} />
            </div>
            <div>
              <h2 className={styles.panelTitle}>Usuarios y accesos</h2>
              <p className={styles.panelDescription}>
                Crea accesos internos, asigna administrador o empleado y define qué secciones pueden ver o editar.
              </p>
            </div>
          </div>
          <div className={styles.statusPill}>
            <CheckCircle2 size={15} />
            Solo administradores
          </div>
        </div>

        <form className={styles.section} onSubmit={handleCreate}>
          <div className={styles.sectionHeader}>
            <div>
              <h3 className={styles.sectionTitle}>Nuevo acceso</h3>
              <p className={styles.sectionDescription}>
                Para crear una persona se necesita correo o teléfono y una contraseña temporal.
              </p>
            </div>
            <Button type="submit" variant="primary" loading={savingCreate} leftIcon={<UserPlus size={16} />}>
              Crear acceso
            </Button>
          </div>

          <div className={styles.createGrid}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="access-first-name">Nombre</label>
              <input
                id="access-first-name"
                className={styles.input}
                value={createDraft.firstName}
                onChange={(event) => setCreateDraft((current) => ({ ...current, firstName: event.target.value }))}
                autoComplete="given-name"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="access-last-name">Apellido</label>
              <input
                id="access-last-name"
                className={styles.input}
                value={createDraft.lastName}
                onChange={(event) => setCreateDraft((current) => ({ ...current, lastName: event.target.value }))}
                autoComplete="family-name"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="access-email">Correo</label>
              <input
                id="access-email"
                className={styles.input}
                type="email"
                value={createDraft.email}
                onChange={(event) => setCreateDraft((current) => ({ ...current, email: event.target.value }))}
                autoComplete="email"
                placeholder="persona@negocio.com"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="access-phone">Teléfono</label>
              <input
                id="access-phone"
                className={styles.input}
                type="tel"
                value={createDraft.phone}
                onChange={(event) => setCreateDraft((current) => ({ ...current, phone: event.target.value }))}
                autoComplete="tel"
                placeholder="+52 656 000 0000"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="access-password">Contraseña temporal</label>
              <input
                id="access-password"
                className={styles.input}
                type="password"
                value={createDraft.password}
                onChange={(event) => setCreateDraft((current) => ({ ...current, password: event.target.value }))}
                autoComplete="new-password"
                minLength={6}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="access-role">Rol</label>
              <select
                id="access-role"
                className={styles.select}
                value={createDraft.role}
                onChange={(event) => updateCreateRole(event.target.value as UserRole)}
              >
                <option value="employee">Empleado</option>
                <option value="admin">Administrador</option>
              </select>
            </div>
            <div className={`${styles.field} ${styles.fieldWide}`}>
              <p className={styles.helperText}>
                El correo o teléfono también sirve como usuario para iniciar sesión.
              </p>
            </div>
          </div>

          <AccessMatrix
            role={createDraft.role}
            accessConfig={createDraft.accessConfig}
            disabled={savingCreate}
            onChange={updateCreateAccess}
          />
        </form>

        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h3 className={styles.sectionTitle}>Personas con acceso</h3>
              <p className={styles.sectionDescription}>
                Selecciona una persona para ajustar su rol, datos y permisos.
              </p>
            </div>
          </div>

          {loading ? (
            <div className={styles.emptyState}>
              <Loader2 size={20} className="animate-spin" />
              Cargando accesos...
            </div>
          ) : (
            <div className={styles.workspace}>
              <div className={styles.membersList}>
                {members.map((member) => (
                  <button
                    key={member.id}
                    type="button"
                    className={`${styles.memberRow} ${member.id === selectedMember?.id ? styles.memberRowActive : ''}`}
                    onClick={() => setSelectedId(member.id)}
                  >
                    <span className={styles.memberIdentity}>
                      <span className={styles.avatar}>{getInitials(member)}</span>
                      <span className={styles.memberText}>
                        <span className={styles.memberName}>{member.fullName || member.email || member.phone}</span>
                        <span className={styles.memberMeta}>
                          {member.email || member.phone || member.username}
                        </span>
                      </span>
                    </span>
                    <span className={member.isActive ? styles.rolePill : styles.inactivePill}>
                      {member.isActive ? (member.role === 'admin' ? 'Admin' : 'Empleado') : 'Sin acceso'}
                    </span>
                  </button>
                ))}
              </div>

              {editDraft && selectedMember ? (
                <div className={styles.editorPanel}>
                  <div className={styles.selectedSummary}>
                    <div>
                      <strong>{selectedMember.fullName || selectedMember.email || selectedMember.phone}</strong>
                      <span>{selectedMember.role === 'admin' ? 'Administrador' : 'Empleado'}</span>
                    </div>
                    <div className={styles.actions}>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={handleDelete}
                        loading={deleting}
                        disabled={selectedIsSelf || deleting}
                        leftIcon={<Trash2 size={15} />}
                      >
                        Borrar
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={handleSaveEdit}
                        loading={savingEdit}
                        leftIcon={<Save size={15} />}
                      >
                        Guardar
                      </Button>
                    </div>
                  </div>

                  <div className={styles.editorGrid}>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="edit-first-name">Nombre</label>
                      <input
                        id="edit-first-name"
                        className={styles.input}
                        value={editDraft.firstName}
                        onChange={(event) => setEditDraft((current) => current ? { ...current, firstName: event.target.value } : current)}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="edit-last-name">Apellido</label>
                      <input
                        id="edit-last-name"
                        className={styles.input}
                        value={editDraft.lastName}
                        onChange={(event) => setEditDraft((current) => current ? { ...current, lastName: event.target.value } : current)}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="edit-email">Correo</label>
                      <input
                        id="edit-email"
                        className={styles.input}
                        type="email"
                        value={editDraft.email}
                        onChange={(event) => setEditDraft((current) => current ? { ...current, email: event.target.value } : current)}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="edit-phone">Teléfono</label>
                      <input
                        id="edit-phone"
                        className={styles.input}
                        type="tel"
                        value={editDraft.phone}
                        onChange={(event) => setEditDraft((current) => current ? { ...current, phone: event.target.value } : current)}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="edit-password">Nueva contraseña</label>
                      <input
                        id="edit-password"
                        className={styles.input}
                        type="password"
                        value={editDraft.password || ''}
                        onChange={(event) => setEditDraft((current) => current ? { ...current, password: event.target.value } : current)}
                        placeholder="Opcional"
                        minLength={6}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="edit-role">Rol</label>
                      <select
                        id="edit-role"
                        className={styles.select}
                        value={editDraft.role}
                        disabled={selectedIsSelf}
                        onChange={(event) => updateEditRole(event.target.value as UserRole)}
                      >
                        <option value="employee">Empleado</option>
                        <option value="admin">Administrador</option>
                      </select>
                    </div>
                  </div>

                  <div className={styles.adminNote}>
                    {editDraft.email ? <Mail size={16} /> : <Phone size={16} />}
                    <span>La persona puede iniciar sesión con su correo o teléfono y la contraseña asignada.</span>
                  </div>

                  <AccessMatrix
                    role={editDraft.role}
                    accessConfig={editDraft.accessConfig}
                    disabled={savingEdit}
                    onChange={updateEditAccess}
                  />
                </div>
              ) : (
                <div className={styles.emptyState}>
                  <Users size={22} />
                  Todavía no hay personas para editar.
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
