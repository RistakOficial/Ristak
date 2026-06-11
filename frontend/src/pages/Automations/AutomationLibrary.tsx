import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Folder,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
  Workflow
} from 'lucide-react'
import { cn } from '@/utils/cn'
import {
  Button,
  CustomSelect,
  Modal,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import automationsService, {
  AUTOMATION_STATUS_LABELS,
  type AutomationFolder,
  type AutomationStatus,
  type AutomationSummary
} from '@/services/automationsService'
import styles from './editor/AutomationEditor.module.css'

/**
 * Librería de automatizaciones tipo explorador de archivos (Finder):
 * lista unificada de carpetas y flujos, navegación con ruta y flecha atrás,
 * arrastrar filas a carpetas para moverlas, checkboxes al hover para
 * acciones en bloque y menú contextual por fila.
 */

interface AutomationLibraryProps {
  /** Automatización abierta en el editor (se resalta) */
  currentAutomationId?: string
}

const STATUS_DOT: Record<AutomationStatus, string> = {
  draft: 'incomplete',
  published: 'ok',
  paused: 'incomplete',
  archived: 'error'
}

interface NameModal {
  kind: 'rename-automation' | 'rename-folder' | 'create-folder'
  targetId?: string
  value: string
}

export const AutomationLibrary: React.FC<AutomationLibraryProps> = ({ currentAutomationId }) => {
  const navigate = useNavigate()
  const { showToast, showConfirm } = useNotification()

  const [collapsed, setCollapsed] = useState(false)
  const [folders, setFolders] = useState<AutomationFolder[]>([])
  const [automations, setAutomations] = useState<AutomationSummary[]>([])
  const [folderId, setFolderId] = useState<string | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [nameModal, setNameModal] = useState<NameModal | null>(null)
  const [moveModal, setMoveModal] = useState<{ ids: string[]; folderId: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const reload = async () => {
    try {
      const overview = await automationsService.getOverview()
      setFolders(overview.folders)
      setAutomations(overview.automations)
      return overview
    } catch {
      showToast('error', 'No se pudo cargar la librería')
      return null
    }
  }

  useEffect(() => {
    void reload().then((overview) => {
      // Abre la librería en la carpeta del flujo actual
      if (!initialized && overview && currentAutomationId) {
        const current = overview.automations.find((automation) => automation.id === currentAutomationId)
        if (current?.folderId) setFolderId(current.folderId)
      }
      setInitialized(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentAutomationId])

  const currentFolder = folderId ? folders.find((folder) => folder.id === folderId) || null : null

  // ------------------------------------------------------------------
  // Contenido de la ubicación actual (carpetas + flujos, como Finder)
  // ------------------------------------------------------------------
  const visibleFolders = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (normalized) return [] // al buscar solo se listan automatizaciones
    return folderId ? [] : folders
  }, [folders, folderId, query])

  const visibleAutomations = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (normalized) {
      return automations.filter((automation) => automation.name.toLowerCase().includes(normalized))
    }
    return automations.filter((automation) => (automation.folderId || null) === folderId)
  }, [automations, folderId, query])

  // ------------------------------------------------------------------
  // Acciones
  // ------------------------------------------------------------------
  const moveAutomations = async (ids: string[], targetFolderId: string | null) => {
    try {
      await Promise.all(
        ids.map((id) => automationsService.updateAutomation(id, { folderId: targetFolderId }))
      )
      setSelected(new Set())
      await reload()
      showToast(
        'success',
        ids.length > 1 ? `${ids.length} automatizaciones movidas` : 'Automatización movida'
      )
    } catch {
      showToast('error', 'No se pudo mover')
    }
  }

  const deleteAutomations = (ids: string[]) => {
    const names = automations
      .filter((automation) => ids.includes(automation.id))
      .map((automation) => `"${automation.name}"`)
      .join(', ')
    showConfirm(
      ids.length > 1 ? `Eliminar ${ids.length} automatizaciones` : 'Eliminar automatización',
      `Vas a eliminar ${names}. Esta acción no se puede deshacer. Escribe "eliminar" para confirmar.`,
      () => {
        void Promise.all(ids.map((id) => automationsService.deleteAutomation(id)))
          .then(async () => {
            setSelected(new Set())
            await reload()
            showToast('success', ids.length > 1 ? 'Automatizaciones eliminadas' : 'Automatización eliminada')
            if (currentAutomationId && ids.includes(currentAutomationId)) navigate('/automations')
          })
          .catch(() => showToast('error', 'No se pudo eliminar'))
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'eliminar' }
    )
  }

  const deleteFolder = (folder: AutomationFolder) => {
    showConfirm(
      'Eliminar carpeta',
      `Las automatizaciones de "${folder.name}" no se eliminan: vuelven a la lista principal. Escribe "eliminar" para confirmar.`,
      () => {
        void automationsService
          .deleteFolder(folder.id)
          .then(async () => {
            if (folderId === folder.id) setFolderId(null)
            await reload()
            showToast('success', 'Carpeta eliminada')
          })
          .catch(() => showToast('error', 'No se pudo eliminar la carpeta'))
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'eliminar' }
    )
  }

  const duplicateAutomation = async (id: string) => {
    try {
      const copy = await automationsService.duplicateAutomation(id)
      await reload()
      showToast('success', 'Automatización duplicada', copy.name)
    } catch {
      showToast('error', 'No se pudo duplicar')
    }
  }

  const createAutomation = async () => {
    try {
      const automation = await automationsService.createAutomation({
        name: 'Automatización sin título',
        folderId
      })
      navigate(`/automations/${automation.id}`)
    } catch {
      showToast('error', 'No se pudo crear la automatización')
    }
  }

  const submitNameModal = async () => {
    if (!nameModal) return
    const value = nameModal.value.trim()
    if (!value) {
      showToast('warning', 'Escribe un nombre')
      return
    }
    setSaving(true)
    try {
      if (nameModal.kind === 'create-folder') {
        await automationsService.createFolder({ name: value })
      } else if (nameModal.kind === 'rename-folder' && nameModal.targetId) {
        await automationsService.updateFolder(nameModal.targetId, { name: value })
      } else if (nameModal.kind === 'rename-automation' && nameModal.targetId) {
        await automationsService.updateAutomation(nameModal.targetId, { name: value })
      }
      await reload()
      setNameModal(null)
    } catch (error) {
      showToast('error', 'No se pudo guardar', error instanceof Error ? error.message : '')
    } finally {
      setSaving(false)
    }
  }

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ------------------------------------------------------------------
  // Drag & drop de filas hacia carpetas (o a la raíz vía la ruta)
  // ------------------------------------------------------------------
  const handleDragStart = (event: React.DragEvent, automationId: string) => {
    const ids = selected.has(automationId) && selected.size > 0 ? [...selected] : [automationId]
    event.dataTransfer.setData('application/x-automation-ids', JSON.stringify(ids))
    event.dataTransfer.effectAllowed = 'move'
  }

  const handleDrop = (event: React.DragEvent, targetFolderId: string | null) => {
    event.preventDefault()
    setDropTarget(null)
    try {
      const ids = JSON.parse(event.dataTransfer.getData('application/x-automation-ids') || '[]')
      if (Array.isArray(ids) && ids.length > 0) {
        void moveAutomations(ids, targetFolderId)
      }
    } catch {
      // dato de arrastre inválido: se ignora
    }
  }

  const dropHandlers = (targetId: string | null) => ({
    onDragOver: (event: React.DragEvent) => {
      if (event.dataTransfer.types.includes('application/x-automation-ids')) {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDropTarget(targetId ?? 'root')
      }
    },
    onDragLeave: () => setDropTarget((current) => (current === (targetId ?? 'root') ? null : current)),
    onDrop: (event: React.DragEvent) => handleDrop(event, targetId)
  })

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  if (collapsed) {
    return (
      <div className={cn(styles.leftNav, styles.leftNavCollapsed)} data-automation-interactive="true">
        <button type="button" className={styles.leftNavToggle} title="Expandir librería" onClick={() => setCollapsed(false)}>
          <ChevronRight size={14} />
        </button>
      </div>
    )
  }

  const selectionActive = selected.size > 0

  return (
    <div className={styles.leftNav} data-automation-interactive="true">
      {/* Ruta de navegación (tipo Finder) */}
      <div className={styles.libPath} {...(currentFolder ? dropHandlers(null) : {})}>
        {currentFolder ? (
          <button type="button" className={styles.libPathBack} title="Volver" onClick={() => setFolderId(null)}>
            <ArrowLeft size={13} />
          </button>
        ) : (
          <Workflow size={13} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
        )}
        <span
          className={cn(styles.libPathText, currentFolder && dropTarget === 'root' && styles.libDropTarget)}
          role={currentFolder ? 'button' : undefined}
          onClick={() => currentFolder && setFolderId(null)}
        >
          Automatizaciones{currentFolder ? ` / ${currentFolder.name}` : ''}
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={styles.leftNavToggle} title="Crear nuevo">
              <Plus size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void createAutomation()}>
              <Workflow size={13} style={{ marginRight: 8 }} />
              Nueva automatización
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setNameModal({ kind: 'create-folder', value: '' })}>
              <FolderPlus size={13} style={{ marginRight: 8 }} />
              Nueva carpeta
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button type="button" className={styles.leftNavToggle} title="Contraer librería" onClick={() => setCollapsed(true)}>
          <ChevronLeft size={14} />
        </button>
      </div>

      {/* Búsqueda */}
      <div className={styles.leftNavSearch}>
        <Search size={12} />
        <input
          data-ristak-unstyled
          value={query}
          placeholder="Buscar…"
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Buscar automatización"
        />
      </div>

      {/* Acciones en bloque (aparecen arriba de la lista al seleccionar) */}
      {selectionActive && (
        <div className={styles.libBulkBar}>
          <span className={styles.libBulkCount}>{selected.size} seleccionadas</span>
          <button
            type="button"
            className={styles.libBulkButton}
            title="Mover a carpeta"
            onClick={() => setMoveModal({ ids: [...selected], folderId: '' })}
          >
            <FolderInput size={13} />
          </button>
          <button
            type="button"
            className={cn(styles.libBulkButton, styles.libBulkDanger)}
            title="Eliminar seleccionadas"
            onClick={() => deleteAutomations([...selected])}
          >
            <Trash2 size={13} />
          </button>
          <button type="button" className={styles.libBulkButton} title="Cancelar" onClick={() => setSelected(new Set())}>
            ×
          </button>
        </div>
      )}

      {/* Lista unificada */}
      <div className={styles.leftNavList}>
        {visibleFolders.map((folder) => (
          <div
            key={folder.id}
            className={cn(styles.libRow, dropTarget === folder.id && styles.libDropTarget)}
            role="button"
            onClick={() => setFolderId(folder.id)}
            {...dropHandlers(folder.id)}
          >
            <span className={styles.libRowLead}>
              <Folder size={14} style={{ color: 'rgb(217, 156, 16)' }} />
            </span>
            <span className={styles.libRowName}>{folder.name}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={styles.libRowMenu}
                  title="Opciones"
                  onClick={(event) => event.stopPropagation()}
                >
                  <MoreHorizontal size={14} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top">
                <DropdownMenuItem
                  onSelect={() => setNameModal({ kind: 'rename-folder', targetId: folder.id, value: folder.name })}
                >
                  <Pencil size={13} style={{ marginRight: 8 }} />
                  Renombrar
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => deleteFolder(folder)}>
                  <Trash2 size={13} style={{ marginRight: 8 }} />
                  Eliminar
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}

        {visibleAutomations.map((automation) => {
          const isCurrent = automation.id === currentAutomationId
          const isChecked = selected.has(automation.id)
          return (
            <div
              key={automation.id}
              className={cn(
                styles.libRow,
                isCurrent && styles.libRowActive,
                isChecked && styles.libRowChecked
              )}
              role="button"
              draggable
              onDragStart={(event) => handleDragStart(event, automation.id)}
              onClick={() => {
                if (selectionActive) {
                  toggleSelected(automation.id)
                } else if (!isCurrent) {
                  navigate(`/automations/${automation.id}`)
                }
              }}
            >
              {/* Checkbox al hover (como en Contactos/Pagos) */}
              <span className={styles.libRowLead}>
                <Workflow size={14} className={styles.libRowIcon} />
                <button
                  type="button"
                  className={cn(styles.libCheckbox, isChecked && styles.libCheckboxOn)}
                  title={isChecked ? 'Quitar de la selección' : 'Seleccionar'}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleSelected(automation.id)
                  }}
                >
                  {isChecked && <Check size={10} />}
                </button>
              </span>
              <span className={styles.libRowName} title={automation.name}>
                {automation.name}
              </span>
              <span
                className={styles.nodeStatusDot}
                data-state={STATUS_DOT[automation.status]}
                title={AUTOMATION_STATUS_LABELS[automation.status]}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={styles.libRowMenu}
                    title="Opciones"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top">
                  <DropdownMenuItem onSelect={() => navigate(`/automations/${automation.id}`)}>
                    <Settings2 size={13} style={{ marginRight: 8 }} />
                    Configuración
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      setNameModal({ kind: 'rename-automation', targetId: automation.id, value: automation.name })
                    }
                  >
                    <Pencil size={13} style={{ marginRight: 8 }} />
                    Renombrar
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setMoveModal({ ids: [automation.id], folderId: automation.folderId || '' })}>
                    <FolderInput size={13} style={{ marginRight: 8 }} />
                    Mover
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void duplicateAutomation(automation.id)}>
                    <Copy size={13} style={{ marginRight: 8 }} />
                    Duplicar
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => deleteAutomations([automation.id])}>
                    <Trash2 size={13} style={{ marginRight: 8 }} />
                    Eliminar
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        })}

        {visibleFolders.length === 0 && visibleAutomations.length === 0 && (
          <p className={styles.leftNavEmpty}>
            {query.trim() ? 'Sin resultados' : 'Carpeta vacía'}
          </p>
        )}
      </div>

      {/* Modal: crear carpeta / renombrar */}
      <Modal
        isOpen={Boolean(nameModal)}
        onClose={() => setNameModal(null)}
        title={
          nameModal?.kind === 'create-folder'
            ? 'Nueva carpeta'
            : nameModal?.kind === 'rename-folder'
              ? 'Renombrar carpeta'
              : 'Renombrar automatización'
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
            <input
              className={styles.configInput}
              value={nameModal.value}
              autoFocus
              maxLength={120}
              placeholder="Nombre"
              onChange={(event) => setNameModal({ ...nameModal, value: event.target.value })}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <Button variant="secondary" type="button" onClick={() => setNameModal(null)}>
                Cancelar
              </Button>
              <Button variant="primary" type="submit" loading={saving}>
                Guardar
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* Modal: mover a carpeta */}
      <Modal isOpen={Boolean(moveModal)} onClose={() => setMoveModal(null)} title="Mover a carpeta" size="sm">
        {moveModal && (
          <>
            <CustomSelect
              options={[
                { value: '', label: 'Sin carpeta (raíz)' },
                ...folders.map((folder) => ({ value: folder.id, label: folder.name }))
              ]}
              value={moveModal.folderId}
              onValueChange={(value) => setMoveModal({ ...moveModal, folderId: value })}
              aria-label="Carpeta destino"
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <Button variant="secondary" onClick={() => setMoveModal(null)}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  void moveAutomations(moveModal.ids, moveModal.folderId || null)
                  setMoveModal(null)
                }}
              >
                Mover
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}
