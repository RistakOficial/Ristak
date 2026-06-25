import React, { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  Eye,
  Info,
  Loader2,
  LockKeyhole,
  Mail,
  Phone,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserPlus,
  UserRound,
  Users,
  Zap
} from 'lucide-react'
import { Badge, Button, Card, Modal, TabList } from '@/components/common'
import { UserNotificationPreferencesAdmin } from './UserNotificationPreferencesAdmin' // (MOB-006)
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
type AccessModule = typeof ACCESS_MODULES[number]

interface PermissionSection {
  title: string
  description: string
  keys: PermissionKey[]
}

interface PermissionCategory {
  group: PermissionGroup
  title: string
  description: string
  sections: PermissionSection[]
}

const accessOptions: Array<{ value: AccessLevel; label: string }> = [
  { value: 'none', label: 'Sin acceso' },
  { value: 'read', label: 'Solo ver' },
  { value: 'write', label: 'Ver y editar' }
]

const roleOptions: Array<{
  value: UserRole
  title: string
  description: string
  badge: string
}> = [
  {
    value: 'employee',
    title: 'Empleado',
    description: 'Solo entra a lo que le actives y puede quedarse en modo lectura.',
    badge: 'Controlado'
  },
  {
    value: 'admin',
    title: 'Administrador',
    description: 'Tiene acceso completo y puede gestionar otras personas del CRM.',
    badge: 'Completo'
  }
]

const moduleByKey = new Map<PermissionKey, AccessModule>(
  ACCESS_MODULES.map((module) => [module.key, module] as [PermissionKey, AccessModule])
)

const permissionCategories: PermissionCategory[] = [
  {
    group: 'CRM',
    title: 'CRM diario',
    description: 'Lo que usa el equipo para atender contactos, citas y cobros.',
    sections: [
      {
        title: 'Vista general',
        description: 'Resumen del negocio.',
        keys: ['dashboard']
      },
      {
        title: 'Personas y conversaciones',
        description: 'Contactos, chat y calendario operativo.',
        keys: ['contacts', 'chat', 'appointments']
      },
      {
        title: 'Cobros',
        description: 'Pagos, ventas y transacciones.',
        keys: ['payments']
      }
    ]
  },
  {
    group: 'Operación',
    title: 'Operación y crecimiento',
    description: 'Reportes, marketing, sitios, automatizaciones y Ristak AI.',
    sections: [
      {
        title: 'Reportes y análisis',
        description: 'Métricas, tablas y sesiones web.',
        keys: ['reports', 'analytics']
      },
      {
        title: 'Marketing y presencia',
        description: 'Publicidad Meta y sitios públicos.',
        keys: ['campaigns', 'sites']
      },
      {
        title: 'Automatización',
        description: 'Flujos y agentes internos.',
        keys: ['automations', 'ai_agent']
      }
    ]
  },
  {
    group: 'Configuración',
    title: 'Configuración',
    description: 'Ajustes sensibles del negocio, canales, datos y conexiones.',
    sections: [
      {
        title: 'Cuenta y equipo',
        description: 'Perfil propio y administración de personas.',
        keys: ['settings_account', 'settings_users']
      },
      {
        title: 'Agenda y cobro',
        description: 'Calendarios, pasarelas y costos.',
        keys: ['settings_calendars', 'settings_payments', 'settings_costs']
      },
      {
        title: 'Canales',
        description: 'HighLevel, WhatsApp y correo.',
        keys: ['settings_integrations', 'settings_whatsapp', 'settings_email']
      },
      {
        title: 'Sitios y datos',
        description: 'Tracking, dominios, media, campos, API y app móvil.',
        keys: ['settings_tracking', 'settings_domains', 'settings_media', 'settings_custom_fields', 'settings_api_access', 'settings_mobile']
      }
    ]
  }
]

const permissionModuleKeys = permissionCategories.flatMap((category) =>
  category.sections.flatMap((section) => section.keys)
)

type AccessPreset = 'default' | 'read' | 'full' | 'custom'

const accessPresets: Array<{ id: AccessPreset; title: string; description: string; icon: React.ReactNode }> = [
  { id: 'default', title: 'Predeterminado', description: 'Solo lo esencial. Tú activas lo demás.', icon: <Sparkles size={14} /> },
  { id: 'read', title: 'Solo lectura', description: 'Ve todo el CRM, sin editar.', icon: <Eye size={14} /> },
  { id: 'full', title: 'Acceso total', description: 'Ve y edita todo (sin gestionar usuarios).', icon: <Zap size={14} /> },
  { id: 'custom', title: 'Personalizado', description: 'Ajusta módulo por módulo.', icon: <SlidersHorizontal size={14} /> }
]

const buildPresetAccess = (preset: AccessPreset, current: AccessConfig): AccessConfig => {
  if (preset === 'full') {
    return normalizeAccessConfig(
      Object.fromEntries(ACCESS_MODULES.map((module) => [module.key, 'write'])) as Partial<Record<PermissionKey, AccessLevel>>,
      'employee'
    )
  }
  if (preset === 'read') {
    return normalizeAccessConfig(
      Object.fromEntries(ACCESS_MODULES.map((module) => [module.key, 'read'])) as Partial<Record<PermissionKey, AccessLevel>>,
      'employee'
    )
  }
  if (preset === 'default') {
    return { ...DEFAULT_EMPLOYEE_ACCESS }
  }
  return current
}

interface AccessPresetsProps {
  value: AccessPreset
  disabled?: boolean
  onSelect: (preset: AccessPreset) => void
}

const AccessPresets: React.FC<AccessPresetsProps> = ({ value, disabled = false, onSelect }) => (
  <div className={styles.presetRow} role="radiogroup" aria-label="Plantilla de permisos">
    {accessPresets.map((preset) => {
      const selected = value === preset.id
      return (
        <button
          key={preset.id}
          type="button"
          role="radio"
          aria-checked={selected}
          className={`${styles.presetChip} ${selected ? styles.presetChipActive : ''}`}
          disabled={disabled}
          onClick={() => onSelect(preset.id)}
        >
          <span className={styles.presetChipTitle}>
            {preset.icon}
            {preset.title}
          </span>
          <span className={styles.presetChipDesc}>{preset.description}</span>
        </button>
      )
    })}
  </div>
)

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

const getDefaultOpenGroups = (): Record<PermissionGroup, boolean> => ({
  CRM: true,
  Operación: false,
  Configuración: false
})

const getRoleLabel = (role: UserRole) => role === 'admin' ? 'Administrador' : 'Empleado'

const getAccessStats = (role: UserRole, accessConfig: AccessConfig, keys: PermissionKey[] = permissionModuleKeys) => {
  const effectiveAccess = normalizeAccessConfig(accessConfig, role)
  return keys.reduce((stats, moduleKey) => {
    const level = role === 'admin' ? 'write' : effectiveAccess[moduleKey]
    if (level === 'write') stats.write += 1
    if (level === 'read') stats.read += 1
    if (level === 'none') stats.none += 1
    return stats
  }, {
    total: keys.length,
    read: 0,
    write: 0,
    none: 0
  })
}

const getAccessSummaryLabel = (role: UserRole, accessConfig: AccessConfig) => {
  if (role === 'admin') return 'Acceso completo'
  const stats = getAccessStats(role, accessConfig)
  const active = stats.read + stats.write
  if (active === 0) return 'Sin módulos activos'
  return `${active}/${stats.total} activos · ${stats.write} editar`
}

const getCategorySummaryLabel = (role: UserRole, accessConfig: AccessConfig, keys: PermissionKey[]) => {
  if (role === 'admin') return `${keys.length}/${keys.length} con edición`
  const stats = getAccessStats(role, accessConfig, keys)
  const active = stats.read + stats.write
  if (active === 0) return 'Sin acceso'
  return `${active}/${stats.total} activos · ${stats.write} editar`
}

const getLevelLabel = (level: AccessLevel) => {
  if (level === 'write') return 'Ver y editar'
  if (level === 'read') return 'Solo ver'
  return 'Sin acceso'
}

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

interface RoleSelectorProps {
  value: UserRole
  disabled?: boolean
  onChange: (role: UserRole) => void
}

const RoleSelector: React.FC<RoleSelectorProps> = ({ value, disabled = false, onChange }) => (
  <div className={styles.roleList} role="radiogroup" aria-label="Rol del usuario">
    {roleOptions.map((option) => {
      const selected = value === option.value
      const Icon = option.value === 'admin' ? ShieldCheck : UserRound

      return (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={selected}
          className={`${styles.roleOption} ${selected ? styles.roleOptionActive : ''}`}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          <span className={styles.roleIcon}>
            <Icon size={17} />
          </span>
          <span className={styles.roleOptionText}>
            <span className={styles.roleOptionTitle}>{option.title}</span>
            <span className={styles.roleOptionDescription}>{option.description}</span>
          </span>
          <Badge variant={option.value === 'admin' ? 'primary' : 'neutral'}>
            {option.badge}
          </Badge>
        </button>
      )
    })}
  </div>
)

interface AccessMatrixProps {
  role: UserRole
  accessConfig: AccessConfig
  disabled?: boolean
  onChange: (moduleKey: PermissionKey, level: AccessLevel) => void
}

const AccessMatrix: React.FC<AccessMatrixProps> = ({ role, accessConfig, disabled = false, onChange }) => {
  const [openGroups, setOpenGroups] = useState<Record<PermissionGroup, boolean>>(() => getDefaultOpenGroups())
  const isAdmin = role === 'admin'

  if (isAdmin) {
    return (
      <div className={styles.adminAccessSummary}>
        <div className={styles.adminNote}>
          <ShieldCheck size={16} />
          <span>El administrador siempre puede ver, editar, crear y borrar dentro del CRM.</span>
        </div>
        <div className={styles.roleCapabilityList}>
          <div className={styles.roleCapabilityRow}>
            <ShieldCheck size={15} />
            <span>Control completo de módulos, ajustes y reportes.</span>
          </div>
          <div className={styles.roleCapabilityRow}>
            <Users size={15} />
            <span>Puede crear, editar o borrar accesos de otras personas.</span>
          </div>
          <div className={styles.roleCapabilityRow}>
            <LockKeyhole size={15} />
            <span>Su acceso no se limita por categorías individuales.</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.permissionAccordionList}>
      {permissionCategories.map((category) => {
        const categoryKeys = category.sections.flatMap((section) => section.keys)
        const isOpen = openGroups[category.group]

        return (
          <section className={styles.permissionCategory} key={category.group}>
            <button
              type="button"
              className={styles.permissionCategoryHeader}
              aria-expanded={isOpen}
              onClick={() => setOpenGroups((current) => ({
                ...current,
                [category.group]: !current[category.group]
              }))}
            >
              <span className={styles.categoryTitleBlock}>
                <span className={styles.categoryTitle}>{category.title}</span>
                <span className={styles.categoryDescription}>{category.description}</span>
              </span>
              <span className={styles.categoryMeta}>
                <span>{getCategorySummaryLabel(role, accessConfig, categoryKeys)}</span>
                <ChevronDown size={17} className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`} />
              </span>
            </button>

            {isOpen && (
              <div className={styles.permissionCategoryBody}>
                {category.sections.map((section) => (
                  <div className={styles.permissionSubsection} key={section.title}>
                    <div className={styles.permissionSubsectionHeader}>
                      <div>
                        <strong>{section.title}</strong>
                        <span>{section.description}</span>
                      </div>
                      <span>{section.keys.length} {section.keys.length === 1 ? 'módulo' : 'módulos'}</span>
                    </div>

                    <div className={styles.permissionRows}>
                      {section.keys.map((moduleKey) => {
                        const module = moduleByKey.get(moduleKey)
                        if (!module) return null

                        const currentLevel = accessConfig[moduleKey] || 'none'
                        const moduleLocked = moduleKey === 'settings_account' || moduleKey === 'settings_users'

                        return (
                          <div className={styles.permissionRow} key={moduleKey}>
                            <div className={styles.permissionText}>
                              <strong>{module.label}</strong>
                              <span>{module.description}</span>
                            </div>

                            <div className={styles.permissionControls}>
                              <Badge variant="info">
                                {currentLevel === 'none' ? <LockKeyhole size={12} /> : <Eye size={12} />}
                                {getLevelLabel(currentLevel)}
                              </Badge>
                              {moduleLocked && (
                                <span className={styles.lockHint}>
                                  <LockKeyhole size={12} />
                                  Fijo
                                </span>
                              )}
                              <div className={styles.segmented} role="group" aria-label={`Permiso para ${module.label}`}>
                                {accessOptions.map((option) => (
                                  <button
                                    key={option.value}
                                    type="button"
                                    className={`${styles.segment} ${currentLevel === option.value ? styles.segmentActive : ''}`}
                                    aria-pressed={currentLevel === option.value}
                                    disabled={disabled || moduleLocked}
                                    onClick={() => onChange(moduleKey, option.value)}
                                  >
                                    {option.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )
      })}
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
  const [createExpanded, setCreateExpanded] = useState(false)
  const [createPreset, setCreatePreset] = useState<AccessPreset>('default')
  const [createDraft, setCreateDraft] = useState<Draft>(() => blankDraft())
  const [editDraft, setEditDraft] = useState<Draft | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // (MOB-006) Pestañas: 'access' = gestión de accesos (lo de siempre); 'notifications'
  // = preferencias de notificación del celular de todo el equipo (vista admin nueva).
  const [activeTab, setActiveTab] = useState<'access' | 'notifications'>('access')

  const selectedMember = useMemo(
    () => members.find((member) => member.id === selectedId) || members[0] || null,
    [members, selectedId]
  )
  const selectedIsSelf = selectedMember?.id === user?.id
  const teamSummary = useMemo(() => ({
    total: members.length,
    admins: members.filter((member) => member.role === 'admin' && member.isActive).length,
    employees: members.filter((member) => member.role !== 'admin' && member.isActive).length
  }), [members])

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
    setCreatePreset('custom')
    setCreateDraft((current) => ({
      ...current,
      accessConfig: normalizeAccessConfig({
        ...current.accessConfig,
        [moduleKey]: level
      }, current.role)
    }))
  }

  const handleCreatePreset = (preset: AccessPreset) => {
    setCreatePreset(preset)
    setCreateDraft((current) => ({
      ...current,
      accessConfig: buildPresetAccess(preset, current.accessConfig)
    }))
  }

  const openCreate = () => {
    setCreateDraft(blankDraft())
    setCreatePreset('default')
    setCreateExpanded(true)
  }

  const closeCreate = () => {
    setCreateExpanded(false)
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
      setCreateExpanded(false)
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
      {/* (MOB-006) Pestañas: Accesos (intacto) + Notificaciones del equipo (nuevo). */}
      <TabList
        tabs={[
          { value: 'access', label: 'Accesos' },
          { value: 'notifications', label: 'Notificaciones del equipo' }
        ]}
        activeTab={activeTab}
        onTabChange={(value) => setActiveTab(value as 'access' | 'notifications')}
      />

      {activeTab === 'notifications' ? (
        <Card>
          <UserNotificationPreferencesAdmin />
        </Card>
      ) : (
      <Card>
        <div className={styles.panelHeader}>
          <div className={styles.panelHeaderLeft}>
            <div className={styles.iconBox}>
              <ShieldCheck size={22} />
            </div>
            <div>
              <h2 className={styles.panelTitle}>Usuarios</h2>
              <p className={styles.panelDescription}>
                Administra personas, roles y permisos sin abrirle todo el CRM a quien no lo necesita.
              </p>
            </div>
          </div>
          <Badge variant="success">
            <CheckCircle2 size={15} />
            Solo administradores
          </Badge>
        </div>

        <section className={styles.section}>
          <div className={styles.addRow}>
            <div className={styles.addRowText}>
              <span className={styles.sectionTitle}>Nuevo acceso</span>
              <span className={styles.sectionDescription}>
                Crea el acceso de una persona en tres pasos: datos, rol y permisos.
              </span>
            </div>
            <Button type="button" variant="primary" onClick={openCreate} leftIcon={<UserPlus size={16} />}>
              Agregar persona
            </Button>
          </div>
        </section>

        <Modal
          isOpen={createExpanded}
          onClose={closeCreate}
          title="Agregar persona"
          type="custom"
          size="lg"
          showCloseButton
        >
          <form className={styles.modalForm} onSubmit={handleCreate}>
            <div className={styles.formBlock}>
              <div className={styles.blockHeader}>
                <div>
                  <h4 className={styles.blockTitle}>1 · Datos de la persona</h4>
                  <p className={styles.blockDescription}>El correo o teléfono será su usuario para iniciar sesión.</p>
                </div>
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
                <div className={`${styles.field} ${styles.fieldWide}`}>
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
                  <p className={styles.helperText}>
                    Necesitas al menos correo o teléfono y una contraseña temporal.
                  </p>
                </div>
              </div>
            </div>

            <div className={styles.formBlock}>
              <div className={styles.blockHeader}>
                <div>
                  <h4 className={styles.blockTitle}>2 · Rol</h4>
                  <p className={styles.blockDescription}>Define si tiene control total o un acceso limitado.</p>
                </div>
              </div>
              <RoleSelector value={createDraft.role} onChange={updateCreateRole} />
            </div>

            <div className={styles.formBlock}>
              <div className={styles.blockHeader}>
                <div>
                  <h4 className={styles.blockTitle}>3 · Permisos</h4>
                  <p className={styles.blockDescription}>
                    {createDraft.role === 'admin'
                      ? 'El administrador tiene acceso completo al CRM.'
                      : 'Empieza con una plantilla y ajusta solo si lo necesitas.'}
                  </p>
                </div>
              </div>

              {createDraft.role === 'admin' ? (
                <AccessMatrix
                  role={createDraft.role}
                  accessConfig={createDraft.accessConfig}
                  disabled={savingCreate}
                  onChange={updateCreateAccess}
                />
              ) : (
                <>
                  <AccessPresets value={createPreset} disabled={savingCreate} onSelect={handleCreatePreset} />
                  {createPreset === 'custom' ? (
                    <AccessMatrix
                      role={createDraft.role}
                      accessConfig={createDraft.accessConfig}
                      disabled={savingCreate}
                      onChange={updateCreateAccess}
                    />
                  ) : (
                    <div className={styles.permissionsHint}>
                      <Info size={15} />
                      <span>Esta plantilla se aplica a todos los módulos. Elige «Personalizado» para ajustar cada uno por separado.</span>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className={styles.modalFooter}>
              <Button type="button" variant="secondary" onClick={closeCreate} disabled={savingCreate}>
                Cancelar
              </Button>
              <Button type="submit" variant="primary" loading={savingCreate} leftIcon={<UserPlus size={16} />}>
                Crear acceso
              </Button>
            </div>
          </form>
        </Modal>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h3 className={styles.sectionTitle}>Personas con acceso</h3>
              <p className={styles.sectionDescription}>
                Selecciona una fila para editar datos, rol y permisos.
              </p>
            </div>
            <div className={styles.teamStats}>
              <span>{teamSummary.total} personas</span>
              <span>{teamSummary.admins} admins</span>
              <span>{teamSummary.employees} empleados</span>
            </div>
          </div>

          {loading ? (
            <div className={styles.emptyState} role="status" aria-live="polite" aria-label="Cargando accesos">
              <Loader2 size={20} className="animate-spin" aria-hidden="true" />
            </div>
          ) : (
            <div className={styles.workspace}>
              <div className={styles.membersPanel}>
                <div className={styles.membersHeaderRow}>
                  <span>Persona</span>
                  <span>Rol</span>
                  <span>Permisos</span>
                </div>
                <div className={styles.membersList}>
                  {members.map((member) => {
                    const memberAccess = normalizeAccessConfig(member.accessConfig, member.role)
                    return (
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
                        <span className={styles.memberRoleCell}>
                          <Badge variant={member.isActive ? (member.role === 'admin' ? 'primary' : 'neutral') : 'neutral'}>
                            {member.isActive ? getRoleLabel(member.role) : 'Sin acceso'}
                          </Badge>
                        </span>
                        <span className={styles.memberAccessCell}>
                          {member.isActive ? getAccessSummaryLabel(member.role, memberAccess) : 'Desactivado'}
                        </span>
                      </button>
                    )
                  })}
                  {members.length === 0 && (
                    <div className={styles.emptyStateCompact}>
                      <Users size={18} />
                      Todavía no hay personas creadas.
                    </div>
                  )}
                </div>
              </div>

              {editDraft && selectedMember ? (
                <div className={styles.editorPanel}>
                  <div className={styles.selectedSummary}>
                    <div className={styles.selectedIdentity}>
                      <span className={styles.avatar}>{getInitials(selectedMember)}</span>
                      <div>
                        <strong>{selectedMember.fullName || selectedMember.email || selectedMember.phone}</strong>
                        <span>{getRoleLabel(editDraft.role)} · {getAccessSummaryLabel(editDraft.role, editDraft.accessConfig)}</span>
                      </div>
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

                  <div className={styles.editorBlock}>
                    <div className={styles.blockHeader}>
                      <div>
                        <h4 className={styles.blockTitle}>Datos básicos</h4>
                        <p className={styles.blockDescription}>Nombre, contacto y contraseña opcional.</p>
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
                    </div>
                  </div>

                  <div className={styles.editorBlock}>
                    <div className={styles.blockHeader}>
                      <div>
                        <h4 className={styles.blockTitle}>Rol</h4>
                        <p className={styles.blockDescription}>
                          {selectedIsSelf ? 'No puedes cambiar tu propio rol desde aquí.' : 'Cambia entre empleado limitado y administrador completo.'}
                        </p>
                      </div>
                    </div>
                    <RoleSelector value={editDraft.role} disabled={selectedIsSelf} onChange={updateEditRole} />
                  </div>

                  <div className={styles.adminNote}>
                    {editDraft.email ? <Mail size={16} /> : <Phone size={16} />}
                    <span>La persona puede iniciar sesión con su correo o teléfono y la contraseña asignada.</span>
                  </div>

                  <div className={styles.editorBlock}>
                    <div className={styles.blockHeader}>
                      <div>
                        <h4 className={styles.blockTitle}>Permisos por categoría</h4>
                        <p className={styles.blockDescription}>Abre solo la categoría que quieras ajustar.</p>
                      </div>
                    </div>
                    <AccessMatrix
                      role={editDraft.role}
                      accessConfig={editDraft.accessConfig}
                      disabled={savingEdit}
                      onChange={updateEditAccess}
                    />
                  </div>
                </div>
              ) : (
                <div className={styles.emptyState}>
                  <Users size={22} />
                  Todavía no hay personas para editar.
                </div>
              )}
            </div>
          )}
        </section>
      </Card>
      )}
    </div>
  )
}
