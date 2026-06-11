import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  Copy,
  Folder,
  FolderInput,
  FolderPlus,
  GripVertical,
  MoreVertical,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Workflow,
  Archive
} from 'lucide-react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/utils/cn'
import {
  Badge,
  Button,
  CustomSelect,
  Loading,
  Modal,
  PageContainer,
  PageHeader,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { formatDate } from '@/utils/format'
import automationsService, {
  AUTOMATION_STATUS_LABELS,
  type AutomationFolder,
  type AutomationStatus,
  type AutomationSummary
} from '@/services/automationsService'
import styles from './Automations.module.css'

type StatusFilter = 'all' | AutomationStatus

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'Todas' },
  { id: 'draft', label: 'Borradores' },
  { id: 'published', label: 'Publicadas' },
  { id: 'paused', label: 'Pausadas' },
  { id: 'archived', label: 'Archivadas' }
]

const STATUS_BADGE_VARIANT: Record<AutomationStatus, 'neutral' | 'success' | 'warning' | 'default'> = {
  draft: 'neutral',
  published: 'success',
  paused: 'warning',
  archived: 'default'
}

interface NameModalState {
  mode: 'create-automation' | 'rename-automation' | 'create-folder' | 'rename-folder'
  targetId?: string
  value: string
}

interface MoveModalState {
  automation: AutomationSummary
  folderId: string
}

// ---------------------------------------------------------------------------
// Carpeta ordenable (drag & drop con dnd-kit, mismo patrón que el sidebar)
// ---------------------------------------------------------------------------

interface FolderCardProps {
  folder: AutomationFolder
  count: number
  onOpen: (folder: AutomationFolder) => void
  onRename: (folder: AutomationFolder) => void
  onDelete: (folder: AutomationFolder) => void
}

const SortableFolderCard: React.FC<FolderCardProps> = ({ folder, count, onOpen, onRename, onDelete }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: folder.id
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(styles.folderCard, isDragging && styles.folderCardDragging)}
      onClick={() => onOpen(folder)}
    >
      <span
        className={styles.dragHandle}
        title="Arrastra para reordenar"
        onClick={(event) => event.stopPropagation()}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </span>
      <span className={styles.folderIcon}>
        <Folder size={16} />
      </span>
      <span className={styles.folderInfo}>
        <span className={styles.folderName}>{folder.name}</span>
        <span className={styles.folderCount}>
          {count} {count === 1 ? 'automatización' : 'automatizaciones'}
        </span>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={styles.rowMenuButton}
            title="Opciones de carpeta"
            onClick={(event) => event.stopPropagation()}
          >
            <MoreVertical size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onRename(folder)}>
            <Pencil size={13} style={{ marginRight: 8 }} />
            Renombrar
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onDelete(folder)}>
            <Trash2 size={13} style={{ marginRight: 8 }} />
            Eliminar carpeta
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Página principal
// ---------------------------------------------------------------------------

export const AutomationsHome: React.FC = () => {
  const navigate = useNavigate()
  const { showToast, showConfirm } = useNotification()
  const [searchParams, setSearchParams] = useSearchParams()

  const [folders, setFolders] = useState<AutomationFolder[]>([])
  const [automations, setAutomations] = useState<AutomationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [nameModal, setNameModal] = useState<NameModalState | null>(null)
  const [moveModal, setMoveModal] = useState<MoveModalState | null>(null)
  const [savingModal, setSavingModal] = useState(false)

  const activeFolderId = searchParams.get('carpeta')
  const activeFolder = folders.find((folder) => folder.id === activeFolderId) || null

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const loadOverview = async () => {
    try {
      const overview = await automationsService.getOverview()
      setFolders(overview.folders)
      setAutomations(overview.automations)
    } catch {
      showToast('error', 'No se pudieron cargar las automatizaciones')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadOverview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const countsByFolder = useMemo(() => {
    const counts = new Map<string, number>()
    automations.forEach((automation) => {
      if (!automation.folderId) return
      counts.set(automation.folderId, (counts.get(automation.folderId) || 0) + 1)
    })
    return counts
  }, [automations])

  const visibleAutomations = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    return automations.filter((automation) => {
      // Dentro de una carpeta se muestra solo su contenido; en la raíz, todo
      if (activeFolderId && automation.folderId !== activeFolderId) return false
      if (statusFilter === 'all' && automation.status === 'archived') return false
      if (statusFilter !== 'all' && automation.status !== statusFilter) return false
      if (
        normalizedSearch &&
        !automation.name.toLowerCase().includes(normalizedSearch) &&
        !(automation.description || '').toLowerCase().includes(normalizedSearch)
      ) {
        return false
      }
      return true
    })
  }, [activeFolderId, automations, search, statusFilter])

  // ---------------------------------------------------------------- acciones

  const openFolder = (folder: AutomationFolder | null) => {
    if (folder) {
      setSearchParams({ carpeta: folder.id })
    } else {
      setSearchParams({})
    }
  }

  const handleFolderDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = folders.findIndex((folder) => folder.id === active.id)
    const newIndex = folders.findIndex((folder) => folder.id === over.id)
    const reordered = arrayMove(folders, oldIndex, newIndex)
    setFolders(reordered)
    void automationsService
      .reorderFolders(reordered.map((folder) => folder.id))
      .catch(() => showToast('error', 'No se pudo guardar el orden de carpetas'))
  }

  const submitNameModal = async () => {
    if (!nameModal) return
    const value = nameModal.value.trim()
    if (!value) {
      showToast('warning', 'Escribe un nombre')
      return
    }
    setSavingModal(true)
    try {
      if (nameModal.mode === 'create-automation') {
        const automation = await automationsService.createAutomation({
          name: value,
          folderId: activeFolderId || null
        })
        showToast('success', 'Automatización creada', 'Abriendo el editor…')
        navigate(`/automations/${automation.id}`)
        return
      }
      if (nameModal.mode === 'rename-automation' && nameModal.targetId) {
        const updated = await automationsService.updateAutomation(nameModal.targetId, { name: value })
        setAutomations((current) =>
          current.map((automation) => (automation.id === updated.id ? { ...automation, name: updated.name } : automation))
        )
      }
      if (nameModal.mode === 'create-folder') {
        const folder = await automationsService.createFolder({ name: value })
        setFolders((current) => [...current, folder])
      }
      if (nameModal.mode === 'rename-folder' && nameModal.targetId) {
        const updated = await automationsService.updateFolder(nameModal.targetId, { name: value })
        setFolders((current) => current.map((folder) => (folder.id === updated.id ? updated : folder)))
      }
      setNameModal(null)
    } catch (error) {
      showToast('error', 'No se pudo guardar', error instanceof Error ? error.message : '')
    } finally {
      setSavingModal(false)
    }
  }

  const handleDeleteFolder = (folder: AutomationFolder) => {
    showConfirm(
      'Eliminar carpeta',
      `Las automatizaciones de "${folder.name}" no se eliminan: vuelven a la lista principal.`,
      () => {
        void automationsService
          .deleteFolder(folder.id)
          .then(() => {
            if (activeFolderId === folder.id) openFolder(null)
            void loadOverview()
            showToast('success', 'Carpeta eliminada')
          })
          .catch(() => showToast('error', 'No se pudo eliminar la carpeta'))
      },
      'Eliminar',
      'Cancelar'
    )
  }

  const handleDuplicate = async (automation: AutomationSummary) => {
    try {
      const copy = await automationsService.duplicateAutomation(automation.id)
      setAutomations((current) => [copy, ...current])
      showToast('success', 'Automatización duplicada', copy.name)
    } catch {
      showToast('error', 'No se pudo duplicar la automatización')
    }
  }

  const handleArchiveToggle = async (automation: AutomationSummary) => {
    const archived = automation.status === 'archived'
    try {
      const updated = await automationsService.updateAutomation(automation.id, {
        status: archived ? 'draft' : 'archived'
      })
      setAutomations((current) =>
        current.map((candidate) => (candidate.id === updated.id ? { ...candidate, status: updated.status } : candidate))
      )
      showToast('success', archived ? 'Automatización restaurada' : 'Automatización archivada')
    } catch {
      showToast('error', 'No se pudo actualizar la automatización')
    }
  }

  const handleDelete = (automation: AutomationSummary) => {
    showConfirm(
      'Eliminar automatización',
      `¿Seguro que quieres eliminar "${automation.name}"? Esta acción no se puede deshacer.`,
      () => {
        void automationsService
          .deleteAutomation(automation.id)
          .then(() => {
            setAutomations((current) => current.filter((candidate) => candidate.id !== automation.id))
            showToast('success', 'Automatización eliminada')
          })
          .catch(() => showToast('error', 'No se pudo eliminar la automatización'))
      },
      'Eliminar',
      'Cancelar'
    )
  }

  const submitMove = async () => {
    if (!moveModal) return
    setSavingModal(true)
    try {
      const folderId = moveModal.folderId || null
      const updated = await automationsService.updateAutomation(moveModal.automation.id, { folderId })
      setAutomations((current) =>
        current.map((candidate) =>
          candidate.id === updated.id ? { ...candidate, folderId: updated.folderId } : candidate
        )
      )
      setMoveModal(null)
      showToast('success', 'Automatización movida')
    } catch {
      showToast('error', 'No se pudo mover la automatización')
    } finally {
      setSavingModal(false)
    }
  }

  // ------------------------------------------------------------------ render

  if (loading) {
    return (
      <PageContainer>
        <Loading variant="spinner" message="Cargando automatizaciones" />
      </PageContainer>
    )
  }

  const showFolders = !activeFolderId && folders.length > 0

  return (
    <PageContainer>
      <PageHeader
        title="Automatizaciones"
        subtitle="Crea flujos que responden y dan seguimiento a tus contactos por ti"
        actions={
          <>
            <Button
              variant="secondary"
              leftIcon={<FolderPlus size={14} />}
              onClick={() => setNameModal({ mode: 'create-folder', value: '' })}
            >
              Nueva carpeta
            </Button>
            <Button
              variant="primary"
              leftIcon={<Plus size={14} />}
              onClick={() => setNameModal({ mode: 'create-automation', value: '' })}
            >
              Nueva automatización
            </Button>
          </>
        }
      />

      {/* Migas dentro de carpeta */}
      {activeFolder && (
        <div className={styles.breadcrumb}>
          <button type="button" className={styles.breadcrumbButton} onClick={() => openFolder(null)}>
            <ArrowLeft size={13} />
            Todas las automatizaciones
          </button>
          <span style={{ color: 'var(--color-text-tertiary)' }}>/</span>
          <span className={styles.breadcrumbCurrent}>{activeFolder.name}</span>
        </div>
      )}

      {/* Buscador + filtros */}
      <div className={styles.toolbar}>
        <div className={styles.searchBox}>
          <Search size={14} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            placeholder="Buscar automatización…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Buscar automatización"
          />
        </div>
        <div className={styles.filterChips} role="tablist" aria-label="Filtrar por estado">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={cn(styles.filterChip, statusFilter === filter.id && styles.filterChipActive)}
              onClick={() => setStatusFilter(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {/* Carpetas */}
      {showFolders && (
        <>
          <p className={styles.sectionTitle}>Carpetas</p>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleFolderDragEnd}>
            <SortableContext items={folders.map((folder) => folder.id)} strategy={rectSortingStrategy}>
              <div className={styles.folderGrid}>
                {folders.map((folder) => (
                  <SortableFolderCard
                    key={folder.id}
                    folder={folder}
                    count={countsByFolder.get(folder.id) || 0}
                    onOpen={openFolder}
                    onRename={(target) =>
                      setNameModal({ mode: 'rename-folder', targetId: target.id, value: target.name })
                    }
                    onDelete={handleDeleteFolder}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </>
      )}

      {/* Listado */}
      {showFolders && <p className={styles.sectionTitle}>Automatizaciones</p>}

      {visibleAutomations.length === 0 ? (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}>
            <Workflow size={22} />
          </span>
          <span className={styles.emptyTitle}>
            {automations.length === 0 ? 'Crea tu primera automatización' : 'No hay resultados'}
          </span>
          <span className={styles.emptyText}>
            {automations.length === 0
              ? 'Una automatización conecta disparadores (como un anuncio o una etiqueta) con acciones (como enviar un mensaje) en un flujo visual.'
              : 'Prueba con otra búsqueda o cambia el filtro de estado.'}
          </span>
          {automations.length === 0 && (
            <Button
              variant="primary"
              leftIcon={<Plus size={14} />}
              onClick={() => setNameModal({ mode: 'create-automation', value: '' })}
            >
              Nueva automatización
            </Button>
          )}
        </div>
      ) : (
        <div className={styles.list}>
          <div className={styles.listHeader}>
            <span>Nombre</span>
            <span>Estado</span>
            <span>Creada</span>
            <span>Última edición</span>
            <span />
          </div>
          {visibleAutomations.map((automation) => (
            <div
              key={automation.id}
              className={styles.row}
              onClick={() => navigate(`/automations/${automation.id}`)}
            >
              <div className={styles.rowName}>
                <span className={styles.rowIcon}>
                  <Workflow size={15} />
                </span>
                <span className={styles.rowText}>
                  <span className={styles.rowTitle}>{automation.name}</span>
                  {automation.description && (
                    <span className={styles.rowDescription}>{automation.description}</span>
                  )}
                </span>
              </div>
              <span>
                <Badge variant={STATUS_BADGE_VARIANT[automation.status]}>
                  {AUTOMATION_STATUS_LABELS[automation.status]}
                </Badge>
              </span>
              <span className={styles.rowDate}>{formatDate(automation.createdAt, { includeYear: true })}</span>
              <span className={styles.rowDate}>{formatDate(automation.updatedAt, { includeYear: true })}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={styles.rowMenuButton}
                    title="Opciones"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <MoreVertical size={14} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => navigate(`/automations/${automation.id}`)}>
                    <Pencil size={13} style={{ marginRight: 8 }} />
                    Abrir en el editor
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      setNameModal({ mode: 'rename-automation', targetId: automation.id, value: automation.name })
                    }
                  >
                    <Pencil size={13} style={{ marginRight: 8 }} />
                    Renombrar
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleDuplicate(automation)}>
                    <Copy size={13} style={{ marginRight: 8 }} />
                    Duplicar
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => setMoveModal({ automation, folderId: automation.folderId || '' })}
                  >
                    <FolderInput size={13} style={{ marginRight: 8 }} />
                    Mover a carpeta…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void handleArchiveToggle(automation)}>
                    {automation.status === 'archived' ? (
                      <>
                        <RotateCcw size={13} style={{ marginRight: 8 }} />
                        Restaurar
                      </>
                    ) : (
                      <>
                        <Archive size={13} style={{ marginRight: 8 }} />
                        Archivar
                      </>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => handleDelete(automation)}>
                    <Trash2 size={13} style={{ marginRight: 8 }} />
                    Eliminar
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      )}

      {/* Modal: crear/renombrar */}
      <Modal
        isOpen={Boolean(nameModal)}
        onClose={() => setNameModal(null)}
        title={
          nameModal?.mode === 'create-automation'
            ? 'Nueva automatización'
            : nameModal?.mode === 'rename-automation'
              ? 'Renombrar automatización'
              : nameModal?.mode === 'create-folder'
                ? 'Nueva carpeta'
                : 'Renombrar carpeta'
        }
        size="sm"
      >
        {nameModal && (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submitNameModal()
            }}
          >
            <div className={styles.field}>
              <label className={styles.label} htmlFor="automation-name-input">
                Nombre
              </label>
              <input
                id="automation-name-input"
                className={styles.input}
                value={nameModal.value}
                autoFocus
                maxLength={120}
                placeholder={
                  nameModal.mode === 'create-folder' || nameModal.mode === 'rename-folder'
                    ? 'Ej. Campañas de bienvenida'
                    : 'Ej. Seguimiento de anuncios'
                }
                onChange={(event) => setNameModal({ ...nameModal, value: event.target.value })}
              />
            </div>
            <div className={styles.modalActions}>
              <Button variant="secondary" type="button" onClick={() => setNameModal(null)}>
                Cancelar
              </Button>
              <Button variant="primary" type="submit" loading={savingModal}>
                {nameModal.mode.startsWith('create') ? 'Crear' : 'Guardar'}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* Modal: mover a carpeta */}
      <Modal
        isOpen={Boolean(moveModal)}
        onClose={() => setMoveModal(null)}
        title="Mover a carpeta"
        size="sm"
      >
        {moveModal && (
          <>
            <div className={styles.field}>
              <label className={styles.label}>Carpeta destino</label>
              <CustomSelect
                options={[
                  { value: '', label: 'Sin carpeta (lista principal)' },
                  ...folders.map((folder) => ({ value: folder.id, label: folder.name }))
                ]}
                value={moveModal.folderId}
                onValueChange={(value) => setMoveModal({ ...moveModal, folderId: value })}
                aria-label="Carpeta destino"
              />
            </div>
            <div className={styles.modalActions}>
              <Button variant="secondary" onClick={() => setMoveModal(null)}>
                Cancelar
              </Button>
              <Button variant="primary" loading={savingModal} onClick={() => void submitMove()}>
                Mover
              </Button>
            </div>
          </>
        )}
      </Modal>
    </PageContainer>
  )
}
