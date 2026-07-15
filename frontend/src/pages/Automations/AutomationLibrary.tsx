import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  AlertTriangle,
  Check,
  Copy,
  Folder,
  FolderInput,
  FolderPlus,
  Loader2,
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
Modal,
DropdownMenu,
DropdownMenuContent,
DropdownMenuItem,
DropdownMenuSeparator,
DropdownMenuTrigger
} from '@/components/common'
import { CustomSelect as BaseCustomSelect } from '@/components/common'

const CustomSelect: React.FC<React.ComponentProps<typeof BaseCustomSelect>> = (props) => (
  <BaseCustomSelect portal size="large" {...props} />
)
import { useNotification } from '@/contexts/NotificationContext'
import automationsService, {
  AUTOMATION_REVIEW_LABEL,
  AUTOMATION_STATUS_LABELS,
  automationToSummary,
  automationsCache,
  subscribeAutomationsOverview,
  type AutomationFolder,
  type AutomationSummary
} from '@/services/automationsService'
import styles from './editor/AutomationEditor.module.css'

/**
 * Librería de automatizaciones tipo explorador de archivos (Finder):
 * lista unificada de carpetas y flujos, navegación con ruta y flecha atrás,
 * arrastrar filas a carpetas para moverlas, checkboxes siempre visibles para
 * acciones en bloque y menú contextual por fila.
 */

interface AutomationLibraryProps {
  /** Automatización abierta en el editor (se resalta) */
  currentAutomationId?: string
  /** Resumen fresco de la automatización abierta; mantiene la lista al día sin recargar. */
  currentAutomation?: AutomationSummary
  onOpenAutomation?: (automationId: string) => void
  onAutomationUpdated?: (automation: AutomationSummary) => void
}

interface NameModal {
  kind: 'rename-automation' | 'rename-folder' | 'create-folder'
  targetId?: string
  value: string
}

const AUTOMATIONS_LIBRARY_PAGE_SIZE = 50

export const AutomationLibrary: React.FC<AutomationLibraryProps> = ({
  currentAutomationId,
  currentAutomation,
  onOpenAutomation,
  onAutomationUpdated
}) => {
  const navigate = useNavigate()
  const { showToast, showConfirm } = useNotification()

  const [folders, setFolders] = useState<AutomationFolder[]>([])
  const [automations, setAutomations] = useState<AutomationSummary[]>([])
  const [pageInfo, setPageInfo] = useState({
    limit: AUTOMATIONS_LIBRARY_PAGE_SIZE,
    hasMore: false,
    nextCursor: null as string | null
  })
  const [folderId, setFolderId] = useState<string | null>(null)
  const [initialFolderSynced, setInitialFolderSynced] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [nameModal, setNameModal] = useState<NameModal | null>(null)
  const [moveModal, setMoveModal] = useState<{ ids: string[]; folderId: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const prefetchTimerRef = useRef<number | null>(null)
  const listRequestRef = useRef(0)
  const listAbortRef = useRef<AbortController | null>(null)
  const reviewGenerationRef = useRef(0)
  const reviewAbortControllersRef = useRef(new Set<AbortController>())

  const openAutomation = (automationId: string) => {
    if (automationId !== currentAutomationId) {
      void automationsService.prefetchAutomation(automationId)
    }
    if (onOpenAutomation) {
      onOpenAutomation(automationId)
      return
    }
    navigate(`/automations/${automationId}`)
  }

  const prefetchAutomation = (automationId: string) => {
    if (automationId === currentAutomationId) return
    void automationsService.prefetchAutomation(automationId)
  }

  const clearQueuedPrefetch = () => {
    if (prefetchTimerRef.current === null) return
    window.clearTimeout(prefetchTimerRef.current)
    prefetchTimerRef.current = null
  }

  const queuePrefetchAutomation = (automationId: string) => {
    clearQueuedPrefetch()
    if (automationId === currentAutomationId) return

    prefetchTimerRef.current = window.setTimeout(() => {
      prefetchTimerRef.current = null
      prefetchAutomation(automationId)
    }, 120)
  }

  const reload = useCallback(async (options: {
    silent?: boolean
    append?: boolean
    cursor?: string | null
    force?: boolean
  } = {}) => {
    const append = options.append === true
    if (!append) {
      reviewGenerationRef.current += 1
      reviewAbortControllersRef.current.forEach((controller) => controller.abort())
      reviewAbortControllersRef.current.clear()
    }
    const reviewGeneration = reviewGenerationRef.current
    const requestId = ++listRequestRef.current
    listAbortRef.current?.abort()
    const controller = new AbortController()
    listAbortRef.current = controller
    if (append) setLoadingMore(true)
    else if (!options.silent) setLoading(true)

    try {
      const overview = await automationsService.getOverview({
        limit: AUTOMATIONS_LIBRARY_PAGE_SIZE,
        cursor: append ? options.cursor : null,
        search: debouncedQuery || undefined,
        folderId: debouncedQuery ? undefined : (folderId || 'root'),
        includeReview: false,
        force: options.force,
        // El store compartido fusiona únicamente páginas de esta misma
        // consulta. Así una mutación conserva todo lo que ya se cargó.
        publishSnapshot: true,
        signal: controller.signal
      })
      if (requestId !== listRequestRef.current) return null

      setFolders(overview.folders)
      setAutomations((current) => {
        if (!append) return overview.automations
        const merged = new Map(current.map((automation) => [automation.id, automation]))
        overview.automations.forEach((automation) => merged.set(automation.id, automation))
        return [...merged.values()]
      })
      setPageInfo(overview.pageInfo)

      // Las alertas de referencias rotas requieren revisar el grafo. Se
      // revalidan después del primer paint para que esa auditoría no vuelva a
      // bloquear la apertura de la librería.
      const reviewController = new AbortController()
      reviewAbortControllersRef.current.add(reviewController)
      void automationsService.getOverview({
        limit: AUTOMATIONS_LIBRARY_PAGE_SIZE,
        cursor: append ? options.cursor : null,
        search: debouncedQuery || undefined,
        folderId: debouncedQuery ? undefined : (folderId || 'root'),
        includeReview: true,
        force: options.force,
        signal: reviewController.signal
      }).then((reviewedOverview) => {
        if (
          reviewController.signal.aborted ||
          reviewGeneration !== reviewGenerationRef.current
        ) return
        const reviewedById = new Map(reviewedOverview.automations.map((automation) => [automation.id, automation]))
        setAutomations((current) => current.map((automation) => {
          const reviewed = reviewedById.get(automation.id)
          return reviewed
            ? {
                ...automation,
                reviewStatus: reviewed.reviewStatus,
                hasUnpublishedChanges: reviewed.hasUnpublishedChanges
              }
            : automation
        }))
      }).catch(() => {
        // El summary ligero ya es utilizable; una auditoría tardía no debe
        // tumbar ni vaciar la librería.
      }).finally(() => {
        reviewAbortControllersRef.current.delete(reviewController)
      })
      return overview
    } catch {
      if (controller.signal.aborted) return null
      if (requestId === listRequestRef.current && !options.silent) {
        showToast('error', 'No se pudo cargar la librería')
      }
      return null
    } finally {
      if (requestId === listRequestRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
      if (listAbortRef.current === controller) listAbortRef.current = null
    }
  }, [debouncedQuery, folderId, showToast])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => subscribeAutomationsOverview((applyMutation) => {
    const normalizedQuery = debouncedQuery.trim().toLowerCase()
    const emptyPageInfo = {
      limit: AUTOMATIONS_LIBRARY_PAGE_SIZE,
      hasMore: false,
      nextCursor: null
    }
    setFolders(current => applyMutation({
      folders: current,
      automations: [],
      pageInfo: emptyPageInfo
    }).folders)
    setAutomations(current => {
      const next = applyMutation({
        folders: [],
        automations: current,
        pageInfo: emptyPageInfo
      })
      return next.automations.filter((automation) => {
        if (normalizedQuery) {
          return `${automation.id} ${automation.name} ${automation.description || ''}`
            .toLowerCase()
            .includes(normalizedQuery)
        }
        return folderId ? automation.folderId === folderId : !automation.folderId
      })
    })
  }), [debouncedQuery, folderId])

  useEffect(() => {
    setSelected(new Set())
    if (currentAutomationId && !initialFolderSynced) {
      setLoading(true)
      return
    }
    void reload()
  }, [currentAutomationId, initialFolderSynced, reload])

  useEffect(() => {
    return () => {
      listRequestRef.current += 1
      listAbortRef.current?.abort()
      listAbortRef.current = null
      reviewGenerationRef.current += 1
      reviewAbortControllersRef.current.forEach((controller) => controller.abort())
      reviewAbortControllersRef.current.clear()
      clearQueuedPrefetch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (initialFolderSynced || !currentAutomationId) return

    const current = currentAutomation || automationsCache.automations.get(currentAutomationId)
    if (current) {
      setFolderId(current.folderId || null)
      setInitialFolderSynced(true)
      return
    }

    const controller = new AbortController()
    void automationsService.getAutomation(currentAutomationId, { signal: controller.signal })
      .then((automation) => {
        if (controller.signal.aborted) return
        setFolderId(automation.folderId || null)
        setInitialFolderSynced(true)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        // El editor mostrará el error de detalle. La librería puede seguir
        // abriendo la raíz para no dejar toda la navegación lateral bloqueada.
        setInitialFolderSynced(true)
      })

    return () => {
      controller.abort()
    }
  }, [currentAutomation, currentAutomationId, initialFolderSynced])

  useEffect(() => {
    if (!currentAutomation) return
    const normalizedQuery = debouncedQuery.toLocaleLowerCase()
    const belongsToCurrentView = normalizedQuery
      ? `${currentAutomation.name} ${currentAutomation.description} ${currentAutomation.id}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      : (currentAutomation.folderId || null) === folderId
    if (!belongsToCurrentView) return

    setAutomations((current) => {
      const exists = current.some((automation) => automation.id === currentAutomation.id)
      return exists
        ? current.map((automation) =>
            automation.id === currentAutomation.id ? { ...automation, ...currentAutomation } : automation
          )
        : [currentAutomation, ...current]
    })
  }, [currentAutomation, debouncedQuery, folderId])

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
    return automations
  }, [automations])

  // ------------------------------------------------------------------
  // Acciones
  // ------------------------------------------------------------------
  const moveAutomations = async (ids: string[], targetFolderId: string | null) => {
    try {
      await Promise.all(
        ids.map((id) => automationsService.updateAutomation(id, { folderId: targetFolderId }))
      )
      setSelected(new Set())
      void reload({ silent: true })
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
      `Vas a eliminar ${names}. Esta acción no se puede deshacer.`,
      () => {
        void Promise.all(ids.map((id) => automationsService.deleteAutomation(id)))
          .then(() => {
            setSelected(new Set())
            void reload({ silent: true })
            showToast('success', ids.length > 1 ? 'Automatizaciones eliminadas' : 'Automatización eliminada')
            if (currentAutomationId && ids.includes(currentAutomationId)) navigate('/automations')
          })
          .catch(() => showToast('error', 'No se pudo eliminar'))
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const deleteFolder = (folder: AutomationFolder) => {
    showConfirm(
      'Eliminar carpeta',
      `Las automatizaciones de "${folder.name}" no se eliminan: vuelven a la lista principal.`,
      () => {
        void automationsService
          .deleteFolder(folder.id)
          .then(() => {
            if (folderId === folder.id) setFolderId(null)
            void reload({ silent: true })
            showToast('success', 'Carpeta eliminada')
          })
          .catch(() => showToast('error', 'No se pudo eliminar la carpeta'))
      },
      'Eliminar',
      'Cancelar'
    )
  }

  const duplicateAutomation = async (id: string) => {
    try {
      const copy = await automationsService.duplicateAutomation(id)
      void reload({ silent: true })
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
      openAutomation(automation.id)
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
        const updated = await automationsService.updateAutomation(nameModal.targetId, { name: value })
        const summary = automationToSummary(updated)
        setAutomations((current) =>
          current.map((automation) => (automation.id === summary.id ? { ...automation, ...summary } : automation))
        )
        onAutomationUpdated?.(summary)
      }
      void reload({ silent: true })
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
  const selectionActive = selected.size > 0

  return (
    <div
      className={styles.leftNav}
      data-automation-interactive="true"
    >
      {/* Ruta de navegación (tipo Finder) */}
      <div className={styles.libPath} {...(currentFolder ? dropHandlers(null) : {})}>
        {currentFolder ? (
          <button type="button" className={styles.libPathBack} title="Volver" onClick={() => setFolderId(null)}>
            <ArrowLeft size={13} />
          </button>
        ) : (
          <Workflow size={16} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
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
              <Plus size={16} />
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
      </div>

      {/* Acciones en bloque (encima del buscador) */}
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

      {/* Búsqueda */}
      <div className={styles.leftNavSearch}>
        <Search size={15} />
        <input
          data-ristak-unstyled
          value={query}
          placeholder="Buscar…"
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Buscar automatización"
        />
      </div>

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
              <Folder size={16} style={{ color: 'rgb(217, 156, 16)' }} />
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
                  <MoreHorizontal size={16} />
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
          const requiresReview = automation.reviewStatus?.state === 'requires_review'
          const reviewSummary = automation.reviewStatus?.summary || ''
          const reviewIssueCount = automation.reviewStatus?.issueCount || 1
          return (
            <div
              key={automation.id}
              className={cn(
                styles.libRow,
                isCurrent && styles.libRowActive,
                isChecked && styles.libRowChecked,
                requiresReview && styles.libRowRequiresReview
              )}
              role="button"
              draggable
              onPointerEnter={() => queuePrefetchAutomation(automation.id)}
              onPointerLeave={clearQueuedPrefetch}
              onFocus={() => prefetchAutomation(automation.id)}
              onPointerDown={() => {
                clearQueuedPrefetch()
                if (!selectionActive && !isCurrent) prefetchAutomation(automation.id)
              }}
              onDragStart={(event) => handleDragStart(event, automation.id)}
              onClick={() => {
                if (selectionActive) {
                  toggleSelected(automation.id)
                } else if (!isCurrent) {
                  openAutomation(automation.id)
                }
              }}
            >
              {/* Checkbox siempre visible para selección rápida */}
              <span className={styles.libRowLead}>
                <button
                  type="button"
                  className={cn(styles.libCheckbox, isChecked && styles.libCheckboxOn)}
                  title={isChecked ? 'Quitar de la selección' : 'Seleccionar'}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleSelected(automation.id)
                  }}
                >
                  {isChecked && <Check size={12} />}
                </button>
              </span>
              <span className={styles.libRowText}>
                <span className={styles.libRowTitleLine}>
                  <span className={styles.libRowName} title={automation.name}>
                    {automation.name}
                  </span>
                  <span
                    className={styles.libStatusPill}
                    data-status={requiresReview ? 'requires_review' : automation.status}
                    title={requiresReview ? reviewSummary : undefined}
                  >
                    {requiresReview ? AUTOMATION_REVIEW_LABEL : AUTOMATION_STATUS_LABELS[automation.status]}
                  </span>
                </span>
                {requiresReview && (
                  <span className={styles.libReviewHint} title={reviewSummary}>
                    <AlertTriangle size={12} />
                    {reviewIssueCount === 1 ? '1 pendiente' : `${reviewIssueCount} pendientes`}
                  </span>
                )}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={styles.libRowMenu}
                    title="Opciones"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top">
                  <DropdownMenuItem onSelect={() => openAutomation(automation.id)}>
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

        {loading && visibleFolders.length === 0 && visibleAutomations.length === 0 && (
          <p className={styles.leftNavEmpty} role="status" aria-live="polite">
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            Cargando automatizaciones…
          </p>
        )}

        {!loading && pageInfo.hasMore && pageInfo.nextCursor && (
          <div className={styles.leftNavEmpty}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              fullWidth
              loading={loadingMore}
              onClick={() => void reload({ append: true, cursor: pageInfo.nextCursor })}
            >
              Cargar más
            </Button>
          </div>
        )}

        {!loading && visibleFolders.length === 0 && visibleAutomations.length === 0 && (
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
