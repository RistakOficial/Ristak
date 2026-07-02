import React, { useEffect, useMemo, useState } from 'react'
import {
  Edit3,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Plus,
  Save,
  Tag as TagIcon,
  Trash2,
  X
} from 'lucide-react'
import { Button, CustomSelect, PageHeader, SearchField, Table, TableSelectionToolbar, type Column } from '@/components/common'
import { Badge } from '@/components/common/Badge'
import { useNotification } from '@/contexts/NotificationContext'
import { useUrlStringState } from '@/hooks'
import {
  contactTagsService,
  type ContactTag,
  type ContactTagFolder
} from '@/services/contactTagsService'
import styles from './CustomFields.module.css'

/**
 * Configuración → Etiquetas. Mismo diseño que Campos personalizados:
 * sidebar de carpetas (con drag & drop), tabla con selección múltiple,
 * buscador, panel editor y modal de carpeta.
 *
 * Las etiquetas internas (Cliente, Cita agendada, Prospecto) las asigna el
 * sistema según la actividad del contacto: aparecen protegidas y no se pueden
 * editar, mover ni borrar. Las del usuario se renombran sin cambiar su ID,
 * así no se rompen automatizaciones ni filtros.
 */

type FolderFilter = 'all' | 'unfiled' | string
const isFolderFilterParam = (value?: string | null): value is FolderFilter => typeof value === 'string' && value.length > 0
const isSearchParam = (value?: string | null): value is string => typeof value === 'string'

type TagDraft = {
  name: string
  folderId: string
}

type FolderDraft = {
  name: string
  description: string
}

const emptyDraft = (folderId = ''): TagDraft => ({
  name: '',
  folderId
})

const getFolderName = (folders: ContactTagFolder[], folderId?: string | null) => (
  folders.find(folder => folder.id === folderId)?.name || 'Sin carpeta'
)

const getSourceLabel = (tag: ContactTag) => (tag.isSystem ? 'Sistema' : 'Creada por ti')

const getFolderTargetId = (folderId: FolderFilter) => (
  folderId === 'unfiled' || folderId === 'all' ? '' : folderId
)

export const TagsSettings: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [folders, setFolders] = useState<ContactTagFolder[]>([])
  const [tags, setTags] = useState<ContactTag[]>([])
  const [activeFolder, setActiveFolder] = useUrlStringState<FolderFilter>('folder', 'all', isFolderFilterParam)
  const [search, setSearch] = useUrlStringState<string>('q', '', isSearchParam)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderModalOpen, setFolderModalOpen] = useState(false)
  const [folderDraft, setFolderDraft] = useState<FolderDraft>({ name: '', description: '' })
  const [moveSelectionAfterFolderCreate, setMoveSelectionAfterFolderCreate] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingTag, setEditingTag] = useState<ContactTag | null>(null)
  const [draft, setDraft] = useState<TagDraft>(emptyDraft())
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(() => new Set())
  const [movingTags, setMovingTags] = useState(false)
  const [deletingTags, setDeletingTags] = useState(false)
  const [draggingTagIds, setDraggingTagIds] = useState<string[]>([])
  const [dropTarget, setDropTarget] = useState<FolderFilter | null>(null)
  const [openFolderMenuId, setOpenFolderMenuId] = useState<string | null>(null)

  const loadCatalog = async () => {
    setLoading(true)
    try {
      const catalog = await contactTagsService.getCatalog()
      setFolders(catalog.folders)
      setTags(catalog.tags)
    } catch (error) {
      showToast('error', 'No se pudieron cargar las etiquetas', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadCatalog()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setSelectedTagIds(current => {
      const activeIds = new Set(tags.filter(tag => !tag.isSystem).map(tag => tag.id))
      const next = new Set([...current].filter(id => activeIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [tags])

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>()
    tags.forEach(tag => {
      const folderId = tag.folderId || 'unfiled'
      counts.set(folderId, (counts.get(folderId) || 0) + 1)
    })
    return counts
  }, [tags])

  const visibleTags = useMemo(() => {
    const query = search.trim().toLowerCase()
    return tags.filter(tag => {
      if (activeFolder !== 'all') {
        // Las internas no viven en carpetas: solo aparecen en "Todas"
        if (tag.isSystem) return false
        if (activeFolder === 'unfiled' && tag.folderId) return false
        if (activeFolder !== 'unfiled' && tag.folderId !== activeFolder) return false
      }

      if (!query) return true
      return [
        tag.name,
        getFolderName(folders, tag.folderId),
        getSourceLabel(tag)
      ].some(value => String(value || '').toLowerCase().includes(query))
    })
  }, [activeFolder, folders, search, tags])

  const selectedTags = useMemo(
    () => tags.filter(tag => !tag.isSystem && selectedTagIds.has(tag.id)),
    [selectedTagIds, tags]
  )

  const selectedCount = selectedTags.length
  const selectionBusy = movingTags || deletingTags
  const isDraggingTags = draggingTagIds.length > 0

  const openCreateEditor = () => {
    const folderId = activeFolder !== 'all' && activeFolder !== 'unfiled' ? activeFolder : ''
    setEditingTag(null)
    setDraft(emptyDraft(folderId))
    setEditorOpen(true)
  }

  const openEditEditor = (tag: ContactTag) => {
    if (tag.isSystem) {
      showToast('info', 'Etiqueta protegida', 'Ristak asigna esta etiqueta según la actividad del contacto.')
      return
    }

    setEditingTag(tag)
    setDraft({
      name: tag.name,
      folderId: tag.folderId || ''
    })
    setEditorOpen(true)
  }

  const closeEditor = () => {
    setEditorOpen(false)
    setEditingTag(null)
    setDraft(emptyDraft())
  }

  const openFolderCreator = (options: { moveSelected?: boolean } = {}) => {
    setFolderDraft({ name: '', description: '' })
    setMoveSelectionAfterFolderCreate(Boolean(options.moveSelected && selectedCount > 0))
    setFolderModalOpen(true)
  }

  const closeFolderCreator = () => {
    if (creatingFolder) return
    setFolderModalOpen(false)
    setFolderDraft({ name: '', description: '' })
    setMoveSelectionAfterFolderCreate(false)
  }

  const patchDraft = (patch: Partial<TagDraft>) => {
    setDraft(current => ({ ...current, ...patch }))
  }

  const handleSaveTag = async () => {
    const name = draft.name.trim()
    if (!name) {
      showToast('warning', 'Falta nombre', 'Ponle un nombre a la etiqueta.')
      return
    }

    setSaving(true)
    try {
      if (editingTag) {
        await contactTagsService.updateTag(editingTag.id, {
          name,
          folderId: draft.folderId
        })
        showToast('success', 'Etiqueta actualizada', 'Los contactos y automatizaciones que la usan no se ven afectados.')
      } else {
        await contactTagsService.createTag(name, draft.folderId || undefined)
        showToast('success', 'Etiqueta creada', 'Ya puedes usarla en contactos y automatizaciones.')
      }
      closeEditor()
      await loadCatalog()
    } catch (error) {
      showToast('error', 'No se pudo guardar', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setSaving(false)
    }
  }

  const handleCreateFolder = async () => {
    const name = folderDraft.name.trim()
    if (!name) return

    const selectedIds = Array.from(selectedTagIds)
    const shouldMoveSelection = moveSelectionAfterFolderCreate && selectedIds.length > 0

    setCreatingFolder(true)
    try {
      const folder = await contactTagsService.createFolder({
        name,
        description: folderDraft.description.trim() || undefined
      })
      setFolders(current => [...current, folder])
      setActiveFolder(folder.id)
      setFolderModalOpen(false)
      setFolderDraft({ name: '', description: '' })
      setMoveSelectionAfterFolderCreate(false)
      if (shouldMoveSelection) {
        await moveTagsToFolder(selectedIds, folder.id, folder.name)
      } else {
        showToast('success', 'Carpeta creada', 'Ya puedes guardar etiquetas ahí.')
      }
    } catch (error) {
      showToast('error', 'No se pudo crear la carpeta', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setCreatingFolder(false)
    }
  }

  const clearSelection = () => {
    setSelectedTagIds(new Set())
  }

  const handleDeleteSelectedTags = () => {
    if (!selectedTags.length || deletingTags) return

    const tagsToDelete = selectedTags
    const total = tagsToDelete.length
    showConfirm(
      'Eliminar etiquetas seleccionadas',
      `Se eliminarán ${total} etiqueta${total === 1 ? '' : 's'} del sistema y también se quitarán de todos los contactos que las tienen. Esta acción no se puede deshacer.`,
      () => {
        const remove = async () => {
          setDeletingTags(true)
          try {
            await Promise.all(tagsToDelete.map(tag => contactTagsService.deleteTag(tag.id)))
            clearSelection()
            await loadCatalog()
            showToast('success', 'Etiquetas eliminadas', `${total} etiqueta${total === 1 ? '' : 's'} se quitaron de todos los contactos que las tenían.`)
          } catch (error) {
            showToast('error', 'No se pudieron eliminar', error instanceof Error ? error.message : 'Intenta otra vez')
          } finally {
            setDeletingTags(false)
          }
        }
        void remove()
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const moveTagsToFolder = async (tagIds: string[], folderId: string, targetLabel?: string) => {
    const uniqueIds = Array.from(new Set(tagIds)).filter(Boolean)
    if (!uniqueIds.length || movingTags) return

    const targetFolderId = folderId || ''
    const tagsToMove = tags.filter(tag => !tag.isSystem && uniqueIds.includes(tag.id) && (tag.folderId || '') !== targetFolderId)
    if (!tagsToMove.length) {
      setDraggingTagIds([])
      setDropTarget(null)
      return
    }

    setMovingTags(true)
    try {
      await Promise.all(tagsToMove.map(tag => (
        contactTagsService.updateTag(tag.id, { folderId: targetFolderId })
      )))
      setSelectedTagIds(current => {
        const next = new Set(current)
        tagsToMove.forEach(tag => next.delete(tag.id))
        return next
      })
      await loadCatalog()
      const targetName = targetLabel || (targetFolderId ? getFolderName(folders, targetFolderId) : 'Sin carpeta')
      showToast('success', 'Etiquetas movidas', `${tagsToMove.length} etiqueta${tagsToMove.length === 1 ? '' : 's'} ahora están en ${targetName}.`)
    } catch (error) {
      showToast('error', 'No se pudieron mover', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setMovingTags(false)
      setDraggingTagIds([])
      setDropTarget(null)
    }
  }

  const handleMoveSelectedChange = (value: string) => {
    if (value === '__new_folder') {
      openFolderCreator({ moveSelected: true })
      return
    }

    if (!value) return
    void moveTagsToFolder(Array.from(selectedTagIds), value === 'unfiled' ? '' : value)
  }

  const handleTagDragStart = (tag: ContactTag, event: React.DragEvent<HTMLTableRowElement>) => {
    if (tag.isSystem) {
      event.preventDefault()
      setDraggingTagIds([])
      return
    }

    const ids = (selectedTagIds.has(tag.id) ? Array.from(selectedTagIds) : [tag.id])
      .filter(id => {
        const selectedTag = tags.find(item => item.id === id)
        return selectedTag && !selectedTag.isSystem
      })
    if (!ids.length) {
      event.preventDefault()
      return
    }
    setDraggingTagIds(ids)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', ids.join(','))
  }

  const handleDragEnd = () => {
    setDraggingTagIds([])
    setDropTarget(null)
  }

  const getDraggedIds = (event: React.DragEvent<HTMLElement>) => {
    const rawIds = event.dataTransfer.getData('text/plain')
    return rawIds ? rawIds.split(',').filter(Boolean) : draggingTagIds
  }

  const handleFolderDragOver = (folderId: FolderFilter, event: React.DragEvent<HTMLElement>) => {
    if (!isDraggingTags) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget(folderId)
  }

  const handleFolderDrop = (folderId: FolderFilter, event: React.DragEvent<HTMLElement>) => {
    if (!isDraggingTags) return
    event.preventDefault()
    void moveTagsToFolder(getDraggedIds(event), getFolderTargetId(folderId))
  }

  const handleFolderDragLeave = (folderId: FolderFilter, event: React.DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDropTarget(current => (current === folderId ? null : current))
  }

  const handleArchiveFolder = (folder: ContactTagFolder) => {
    showConfirm(
      'Eliminar carpeta',
      `Las etiquetas dentro de "${folder.name}" no se eliminan; se quedan guardadas sin carpeta.`,
      () => {
        const archive = async () => {
          try {
            await contactTagsService.deleteFolder(folder.id)
            if (activeFolder === folder.id) setActiveFolder('all')
            setOpenFolderMenuId(null)
            await loadCatalog()
            showToast('success', 'Carpeta eliminada', 'Las etiquetas se conservaron.')
          } catch (error) {
            showToast('error', 'No se pudo eliminar', error instanceof Error ? error.message : 'Intenta otra vez')
          }
        }
        void archive()
      },
      'Eliminar',
      'Cancelar'
    )
  }

  const handleDeleteTag = (tag: ContactTag) => {
    showConfirm(
      'Eliminar etiqueta',
      `La etiqueta "${tag.name}" se eliminará del sistema y también se quitará de todos los contactos que la tienen. Esta acción no se puede deshacer.`,
      () => {
        const remove = async () => {
          try {
            await contactTagsService.deleteTag(tag.id)
            await loadCatalog()
            showToast('success', 'Etiqueta eliminada', 'Se quitó de todos los contactos que la tenían.')
          } catch (error) {
            showToast('error', 'No se pudo eliminar', error instanceof Error ? error.message : 'Intenta otra vez')
          }
        }
        void remove()
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const tagSelectionToolbar = selectedCount > 0 ? (
    <TableSelectionToolbar
      count={selectedCount}
      singularLabel="seleccionada"
      pluralLabel="seleccionadas"
      onClearSelection={clearSelection}
    >
      <CustomSelect
        defaultValue=""
        disabled={selectionBusy}
        onChange={(event) => {
          handleMoveSelectedChange(event.target.value)
          event.currentTarget.value = ''
        }}
      >
        <option value="" disabled>Mover a carpeta</option>
        <option value="unfiled">Sin carpeta</option>
        {folders.map(folder => (
          <option key={folder.id} value={folder.id}>{folder.name}</option>
        ))}
        <option value="__new_folder">Crear carpeta...</option>
      </CustomSelect>
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={handleDeleteSelectedTags}
        loading={deletingTags}
        disabled={selectionBusy}
        leftIcon={<Trash2 size={15} />}
      >
        Eliminar
      </Button>
    </TableSelectionToolbar>
  ) : null

  const tagColumns: Column<ContactTag>[] = [
    {
      key: 'name',
      header: 'Etiqueta',
      render: (_value, tag) => (
        <span className={styles.primaryCell}>
          <strong>{tag.name}</strong>
          {tag.isSystem && <span>Se asigna sola según la actividad del contacto.</span>}
        </span>
      )
    },
    {
      key: 'usageCount',
      header: 'Contactos',
      render: (_value, tag) => (
        tag.isSystem
          ? <Badge variant="info">Automática</Badge>
          : (tag.usageCount === 1 ? '1 contacto' : `${tag.usageCount || 0} contactos`)
      )
    },
    {
      key: 'folderId',
      header: 'Carpeta',
      render: (_value, tag) => tag.isSystem ? '-' : getFolderName(folders, tag.folderId)
    },
    {
      key: 'source',
      header: 'Origen',
      render: (_value, tag) => getSourceLabel(tag)
    },
    {
      key: 'actions',
      header: '',
      searchable: false,
      sortable: false,
      render: (_value, tag) => {
        if (tag.isSystem) return <span className={styles.lockedAction}>Protegida</span>

        return (
          <div className={styles.rowActions}>
            <button type="button" onClick={() => openEditEditor(tag)} aria-label={`Editar ${tag.name}`} title="Editar">
              <Edit3 size={15} />
            </button>
            <button type="button" onClick={() => handleDeleteTag(tag)} aria-label={`Eliminar ${tag.name}`} title="Eliminar">
              <Trash2 size={15} />
            </button>
          </div>
        )
      }
    }
  ]

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Sistema"
        title="Etiquetas"
        subtitle="Organiza tus contactos con etiquetas. Renombrarlas no rompe filtros ni automatizaciones."
        actions={
          <>
            <Button variant="secondary" onClick={() => openFolderCreator()} leftIcon={<FolderPlus size={16} />}>
              Crear carpeta
            </Button>
            <Button onClick={openCreateEditor} leftIcon={<Plus size={16} />}>
              Nueva etiqueta
            </Button>
          </>
        }
      />

      <div className={styles.layout}>
        <aside className={styles.folders} aria-label="Carpetas de etiquetas">
          <div className={styles.folderHeader}>
            <strong>Carpetas</strong>
            <span>{folders.length} activas</span>
          </div>

          <div className={`${styles.folderRow} ${styles.folderSystemRow} ${activeFolder === 'all' ? styles.folderSystemRowActive : ''}`}>
            <button type="button" onClick={() => setActiveFolder('all')}>
              <TagIcon size={16} />
              <span>Todas las etiquetas</span>
              <b>{tags.length}</b>
            </button>
            <span className={styles.folderActionSpacer} aria-hidden="true" />
          </div>

          <div
            className={`${styles.folderRow} ${styles.folderSystemRow} ${activeFolder === 'unfiled' ? styles.folderSystemRowActive : ''} ${dropTarget === 'unfiled' ? styles.folderDropActive : ''}`}
            onDragOver={(event) => handleFolderDragOver('unfiled', event)}
            onDragLeave={(event) => handleFolderDragLeave('unfiled', event)}
            onDrop={(event) => handleFolderDrop('unfiled', event)}
          >
            <button type="button" onClick={() => setActiveFolder('unfiled')}>
              <Folder size={16} />
              <span>Sin carpeta</span>
              <b>{(folderCounts.get('unfiled') || 0) - tags.filter(tag => tag.isSystem).length}</b>
            </button>
            <span className={styles.folderActionSpacer} aria-hidden="true" />
          </div>

          <div className={styles.folderList}>
            {folders.map(folder => (
              <div
                key={folder.id}
                className={`${styles.folderRow} ${activeFolder === folder.id ? styles.folderRowActive : ''} ${dropTarget === folder.id ? styles.folderDropActive : ''}`}
                onDragOver={(event) => handleFolderDragOver(folder.id, event)}
                onDragLeave={(event) => handleFolderDragLeave(folder.id, event)}
                onDrop={(event) => handleFolderDrop(folder.id, event)}
              >
                <button type="button" onClick={() => setActiveFolder(folder.id)}>
                  <Folder size={16} />
                  <span>{folder.name}</span>
                  <b>{folderCounts.get(folder.id) || 0}</b>
                </button>
                <button
                  type="button"
                  className={styles.folderMenuButton}
                  aria-label={`Opciones de ${folder.name}`}
                  aria-expanded={openFolderMenuId === folder.id}
                  title="Opciones"
                  onClick={(event) => {
                    event.stopPropagation()
                    setOpenFolderMenuId(current => current === folder.id ? null : folder.id)
                  }}
                >
                  <MoreHorizontal size={16} />
                </button>
                {openFolderMenuId === folder.id && (
                  <div className={styles.folderMenu} role="menu">
                    <button type="button" role="menuitem" onClick={() => handleArchiveFolder(folder)}>
                      <Trash2 size={14} />
                      <span>Eliminar carpeta</span>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </aside>

        <main className={styles.tablePanel}>
          <div className={styles.toolbar}>
            <SearchField
              className={styles.toolbarSearch}
              value={search}
              placeholder="Buscar por nombre o carpeta"
              onChange={(nextSearch) => setSearch(nextSearch)}
              onClear={() => setSearch('')}
            />
            <span>{visibleTags.length} etiquetas</span>
          </div>

          <Table<ContactTag>
            initialColumns={tagColumns}
            data={visibleTags}
            keyExtractor={(tag) => tag.id}
            loading={loading}
            emptyMessage="No hay etiquetas en esta vista"
            searchable={false}
            paginated={false}
            showColumnEditor={false}
            selectionActions={tagSelectionToolbar}
            rowSelection={{
              selectedKeys: Array.from(selectedTagIds),
              onChange: (nextSelectedIds) => setSelectedTagIds(new Set(nextSelectedIds)),
              isRowDisabled: (tag) => tag.isSystem,
              getRowLabel: (tag) => tag.name,
              selectVisibleLabel: 'Seleccionar etiquetas visibles'
            }}
            getRowProps={(tag) => {
              const dragging = draggingTagIds.includes(tag.id)
              return {
                className: `${tag.isSystem ? styles.lockedRow : styles.draggableRow} ${dragging ? styles.rowDragging : ''}`,
                draggable: !selectionBusy && !tag.isSystem,
                onDragStart: (event) => handleTagDragStart(tag, event),
                onDragEnd: handleDragEnd
              }
            }}
          />
        </main>
      </div>

      {editorOpen && (
        <div
          className={styles.editorOverlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="contact-tag-editor-title"
          data-overlay
        >
          <section className={styles.editorPanel}>
            <div className={styles.editorHeader}>
              <div>
                <p className={styles.eyebrow}>{editingTag ? 'Editar etiqueta' : 'Nueva etiqueta'}</p>
                <h3 id="contact-tag-editor-title">{editingTag ? editingTag.name : 'Crear etiqueta'}</h3>
              </div>
              <button type="button" className={styles.iconButton} onClick={closeEditor} aria-label="Cerrar editor">
                <X size={18} />
              </button>
            </div>

            <div className={styles.editorBody}>
              <label className={styles.field}>
                <span>Nombre</span>
                <input
                  value={draft.name}
                  placeholder="Ej. Cliente VIP"
                  onChange={(event) => patchDraft({ name: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleSaveTag()
                  }}
                />
                {editingTag && <small>Renombrar no afecta a los contactos ni automatizaciones que ya la usan.</small>}
              </label>

              <label className={styles.field}>
                <span>Carpeta</span>
                <CustomSelect portal value={draft.folderId} onChange={(event) => patchDraft({ folderId: event.target.value })}>
                  <option value="">Sin carpeta</option>
                  {folders.map(folder => (
                    <option key={folder.id} value={folder.id}>{folder.name}</option>
                  ))}
                </CustomSelect>
              </label>
            </div>

            <div className={styles.editorActions}>
              <Button type="button" variant="ghost" onClick={closeEditor}>
                Cancelar
              </Button>
              <Button type="button" onClick={() => void handleSaveTag()} loading={saving} leftIcon={<Save size={16} />}>
                {editingTag ? 'Guardar cambios' : 'Guardar etiqueta'}
              </Button>
            </div>
          </section>
        </div>
      )}

      {folderModalOpen && (
        <div
          className={styles.editorOverlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="contact-tag-folder-title"
          data-overlay
        >
          <section className={`${styles.editorPanel} ${styles.folderEditorPanel}`}>
            <div className={styles.editorHeader}>
              <div>
                <p className={styles.eyebrow}>Nueva carpeta</p>
                <h3 id="contact-tag-folder-title">Crear carpeta</h3>
              </div>
              <button type="button" className={styles.iconButton} onClick={closeFolderCreator} aria-label="Cerrar carpeta">
                <X size={18} />
              </button>
            </div>

            <div className={styles.editorBody}>
              <label className={styles.field}>
                <span>Nombre</span>
                <input
                  value={folderDraft.name}
                  placeholder="Ej. Campañas"
                  onChange={(event) => setFolderDraft(current => ({ ...current, name: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleCreateFolder()
                  }}
                />
              </label>

              <label className={styles.field}>
                <span>Descripción opcional</span>
                <textarea
                  rows={3}
                  value={folderDraft.description}
                  placeholder="Para que el equipo sepa qué guardar aquí."
                  onChange={(event) => setFolderDraft(current => ({ ...current, description: event.target.value }))}
                />
              </label>
            </div>

            <div className={styles.editorActions}>
              <Button type="button" variant="ghost" onClick={closeFolderCreator} disabled={creatingFolder}>
                Cancelar
              </Button>
              <Button
                type="button"
                onClick={() => void handleCreateFolder()}
                loading={creatingFolder}
                disabled={!folderDraft.name.trim()}
                leftIcon={<FolderPlus size={16} />}
              >
                Crear carpeta
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
