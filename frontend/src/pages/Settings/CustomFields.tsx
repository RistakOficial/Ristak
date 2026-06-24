import React, { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  Copy,
  Edit3,
  Folder,
  FolderPlus,
  Hash as HashIcon,
  Loader2,
  MoreHorizontal,
  Plus,
  Save,
  Trash2,
  X
} from 'lucide-react'
import { Button, CustomSelect, PageHeader, SearchField } from '@/components/common'
import { Badge } from '@/components/common/Badge'
import { useNotification } from '@/contexts/NotificationContext'
import {
  customFieldsService,
  isSystemCustomFieldDefinition,
  type CustomFieldDataType,
  type CustomFieldDefinition,
  type CustomFieldFolder,
  type CustomFieldOption,
  type SaveCustomFieldInput
} from '@/services/customFieldsService'
import styles from './CustomFields.module.css'

type FolderFilter = 'all' | 'unfiled' | string

type FieldDraft = {
  label: string
  fieldKey: string
  dataType: CustomFieldDataType
  folderId: string
  options: string[]
}

type FolderDraft = {
  name: string
  description: string
}

const fieldTypes: Array<{ value: CustomFieldDataType; label: string; detail: string }> = [
  { value: 'text', label: 'Texto corto', detail: 'Una línea de texto.' },
  { value: 'textarea', label: 'Párrafo', detail: 'Texto largo o notas.' },
  { value: 'radio', label: 'Radio buttons', detail: 'Una opción visible.' },
  { value: 'dropdown', label: 'Dropdown', detail: 'Una opción en lista.' },
  { value: 'checkboxes', label: 'Checkboxes', detail: 'Varias opciones.' },
  { value: 'number', label: 'Número', detail: 'Solo cantidad numérica.' },
  { value: 'currency', label: 'Moneda', detail: 'Importe de dinero.' },
  { value: 'date', label: 'Fecha', detail: 'Día o fecha.' },
  { value: 'email', label: 'Email', detail: 'Correo electrónico.' },
  { value: 'phone', label: 'Teléfono', detail: 'Número de contacto.' }
]

const choiceTypes = new Set<CustomFieldDataType>(['radio', 'dropdown', 'checkboxes', 'select', 'multiselect'])

const emptyDraft = (folderId = ''): FieldDraft => ({
  label: '',
  fieldKey: '',
  dataType: 'text',
  folderId,
  options: []
})

const normalizeFieldKey = (value: string) => {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  return normalized || 'campo_personalizado'
}

const labelsToOptions = (labels: string[]): CustomFieldOption[] => (
  labels
    .map(label => label.trim())
    .filter(Boolean)
    .map(label => ({ label, value: normalizeFieldKey(label) }))
)

const optionsToLabels = (options: CustomFieldOption[] = []) => (
  options.map(option => option.label || option.value).filter(Boolean)
)

const getTypeLabel = (type: string) => (
  fieldTypes.find(item => item.value === type)?.label ||
  (type === 'select' ? 'Dropdown' : type === 'multiselect' ? 'Checkboxes' : type || 'Texto corto')
)

const getFolderName = (folders: CustomFieldFolder[], folderId: string) => (
  folders.find(folder => folder.id === folderId)?.name || 'Sin carpeta'
)

const getSourceLabel = (sourceType: string) => {
  if (sourceType === 'system') return 'Sistema'
  if (sourceType === 'manual') return 'Creado por ti'
  if (sourceType === 'native_site') return 'Formulario Ristak'
  if (sourceType === 'imported_html') return 'HTML importado'
  if (sourceType === 'highlevel') return 'HighLevel'
  return sourceType || 'Sistema'
}

const getFolderTargetId = (folderId: FolderFilter) => (
  folderId === 'unfiled' || folderId === 'all' ? '' : folderId
)

const customFieldParameter = (field: Pick<CustomFieldDefinition, 'fieldKey' | 'key'>) => `{{custom.${field.fieldKey || field.key}}}`

export const CustomFields: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [folders, setFolders] = useState<CustomFieldFolder[]>([])
  const [fields, setFields] = useState<CustomFieldDefinition[]>([])
  const [activeFolder, setActiveFolder] = useState<FolderFilter>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderModalOpen, setFolderModalOpen] = useState(false)
  const [folderDraft, setFolderDraft] = useState<FolderDraft>({ name: '', description: '' })
  const [moveSelectionAfterFolderCreate, setMoveSelectionAfterFolderCreate] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingField, setEditingField] = useState<CustomFieldDefinition | null>(null)
  const [draft, setDraft] = useState<FieldDraft>(emptyDraft())
  const [selectedFieldIds, setSelectedFieldIds] = useState<Set<string>>(() => new Set())
  const [movingFields, setMovingFields] = useState(false)
  const [deletingFields, setDeletingFields] = useState(false)
  const [draggingFieldIds, setDraggingFieldIds] = useState<string[]>([])
  const [dropTarget, setDropTarget] = useState<FolderFilter | null>(null)
  const [openFolderMenuId, setOpenFolderMenuId] = useState<string | null>(null)

  const loadCatalog = async () => {
    setLoading(true)
    try {
      const catalog = await customFieldsService.listCatalog()
      setFolders(catalog.folders || [])
      setFields((catalog.fields || []).filter(field => !isSystemCustomFieldDefinition(field)))
    } catch (error) {
      showToast('error', 'No se pudieron cargar los campos', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadCatalog()
  }, [])

  useEffect(() => {
    setSelectedFieldIds(current => {
      const activeIds = new Set(fields.filter(field => !isSystemCustomFieldDefinition(field)).map(field => field.definitionId))
      const next = new Set([...current].filter(id => activeIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [fields])

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>()
    fields.forEach(field => {
      const folderId = field.folderId || 'unfiled'
      counts.set(folderId, (counts.get(folderId) || 0) + 1)
    })
    return counts
  }, [fields])

  const visibleFields = useMemo(() => {
    const query = search.trim().toLowerCase()
    return fields.filter(field => {
      if (activeFolder !== 'all') {
        if (activeFolder === 'unfiled' && field.folderId) return false
        if (activeFolder !== 'unfiled' && field.folderId !== activeFolder) return false
      }

      if (!query) return true
      return [
        field.label,
        field.fieldKey,
        customFieldParameter(field),
        field.folderName,
        getTypeLabel(field.dataType)
      ].some(value => String(value || '').toLowerCase().includes(query))
    })
  }, [activeFolder, fields, search])

  const selectedFields = useMemo(
    () => fields.filter(field => !isSystemCustomFieldDefinition(field) && selectedFieldIds.has(field.definitionId)),
    [fields, selectedFieldIds]
  )

  const visibleSelectableFields = useMemo(
    () => visibleFields.filter(field => !isSystemCustomFieldDefinition(field)),
    [visibleFields]
  )
  const selectedCount = selectedFields.length
  const visibleSelectedCount = visibleSelectableFields.filter(field => selectedFieldIds.has(field.definitionId)).length
  const allVisibleSelected = visibleSelectableFields.length > 0 && visibleSelectedCount === visibleSelectableFields.length
  const selectionBusy = movingFields || deletingFields
  const isDraggingFields = draggingFieldIds.length > 0

  const openCreateEditor = () => {
    const folderId = activeFolder !== 'all' && activeFolder !== 'unfiled' ? activeFolder : ''
    setEditingField(null)
    setDraft(emptyDraft(folderId))
    setEditorOpen(true)
  }

  const openEditEditor = (field: CustomFieldDefinition) => {
    if (isSystemCustomFieldDefinition(field)) {
      showToast('info', 'Campo protegido', 'Ristak crea este campo para datos internos del sistema.')
      return
    }

    setEditingField(field)
    setDraft({
      label: field.label,
      fieldKey: field.fieldKey || field.key,
      dataType: field.dataType,
      folderId: field.folderId || '',
      options: optionsToLabels(field.options)
    })
    setEditorOpen(true)
  }

  const closeEditor = () => {
    setEditorOpen(false)
    setEditingField(null)
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

  const patchDraft = (patch: Partial<FieldDraft>) => {
    setDraft(current => ({ ...current, ...patch }))
  }

  const addDraftOption = () => {
    setDraft(current => ({ ...current, options: [...current.options, ''] }))
  }

  const updateDraftOption = (index: number, value: string) => {
    setDraft(current => ({
      ...current,
      options: current.options.map((option, optionIndex) => optionIndex === index ? value : option)
    }))
  }

  const removeDraftOption = (index: number) => {
    setDraft(current => ({
      ...current,
      options: current.options.filter((_, optionIndex) => optionIndex !== index)
    }))
  }

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      showToast('success', 'Copiado', `${label} copiado.`)
    } catch {
      showToast('error', 'No se pudo copiar', 'Cópialo manualmente.')
    }
  }

  const handleLabelChange = (value: string) => {
    setDraft(current => ({
      ...current,
      label: value,
      fieldKey: editingField ? current.fieldKey : normalizeFieldKey(value)
    }))
  }

  const buildPayload = (): SaveCustomFieldInput | null => {
    const label = draft.label.trim()
    const fieldKey = editingField ? normalizeFieldKey(draft.fieldKey) : normalizeFieldKey(label)
    const options = choiceTypes.has(draft.dataType) ? labelsToOptions(draft.options) : []

    if (!label) {
      showToast('warning', 'Falta nombre', 'Ponle un nombre al campo.')
      return null
    }

    if (!fieldKey) {
      showToast('warning', 'Falta parámetro', 'El parámetro sirve para guardar y usar el dato del contacto.')
      return null
    }

    if (choiceTypes.has(draft.dataType) && options.length === 0) {
      showToast('warning', 'Faltan opciones', 'Agrega al menos una opción para este tipo de campo.')
      return null
    }

    return {
      label,
      fieldKey,
      dataType: draft.dataType,
      folderId: draft.folderId || undefined,
      fieldGroup: draft.folderId ? getFolderName(folders, draft.folderId) : 'general',
      options,
      syncTarget: 'local'
    }
  }

  const handleSaveField = async () => {
    setSaving(true)
    try {
      if (editingField) {
        const label = draft.label.trim()
        if (!label) {
          showToast('warning', 'Falta nombre', 'Ponle un nombre al campo.')
          return
        }
        await customFieldsService.updateField(editingField.definitionId, { label })
        showToast('success', 'Campo actualizado', 'Ya quedo guardado.')
      } else {
        const payload = buildPayload()
        if (!payload) return
        await customFieldsService.createField(payload)
        showToast('success', 'Campo creado', 'Ya puedes usarlo en formularios.')
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

    const selectedIds = Array.from(selectedFieldIds)
    const shouldMoveSelection = moveSelectionAfterFolderCreate && selectedIds.length > 0

    setCreatingFolder(true)
    try {
      const folder = await customFieldsService.createFolder({
        name,
        description: folderDraft.description.trim() || undefined
      })
      setFolders(current => [...current, folder])
      setActiveFolder(folder.id)
      setFolderModalOpen(false)
      setFolderDraft({ name: '', description: '' })
      setMoveSelectionAfterFolderCreate(false)
      if (shouldMoveSelection) {
        await moveFieldsToFolder(selectedIds, folder.id, folder.name)
      } else {
        showToast('success', 'Carpeta creada', 'Ya puedes guardar campos ahi.')
      }
    } catch (error) {
      showToast('error', 'No se pudo crear la carpeta', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setCreatingFolder(false)
    }
  }

  const toggleFieldSelection = (definitionId: string) => {
    const field = fields.find(item => item.definitionId === definitionId)
    if (!field || isSystemCustomFieldDefinition(field)) return

    setSelectedFieldIds(current => {
      const next = new Set(current)
      if (next.has(definitionId)) next.delete(definitionId)
      else next.add(definitionId)
      return next
    })
  }

  const toggleVisibleSelection = () => {
    setSelectedFieldIds(current => {
      const next = new Set(current)
      if (allVisibleSelected) {
        visibleSelectableFields.forEach(field => next.delete(field.definitionId))
      } else {
        visibleSelectableFields.forEach(field => next.add(field.definitionId))
      }
      return next
    })
  }

  const clearSelection = () => {
    setSelectedFieldIds(new Set())
  }

  const handleDeleteSelectedFields = () => {
    if (!selectedFields.length || deletingFields) return

    const fieldsToDelete = selectedFields
    const total = fieldsToDelete.length
    showConfirm(
      'Eliminar campos seleccionados',
      `Se eliminarán ${total} campo${total === 1 ? '' : 's'} personalizado${total === 1 ? '' : 's'} y también se borrarán sus valores guardados en todos los contactos. Esta acción no se puede deshacer.`,
      () => {
        const archive = async () => {
          setDeletingFields(true)
          try {
            await Promise.all(fieldsToDelete.map(field => customFieldsService.deleteField(field.definitionId)))
            clearSelection()
            await loadCatalog()
            showToast('success', 'Campos eliminados', `${total} campo${total === 1 ? '' : 's'} personalizado${total === 1 ? '' : 's'} se eliminaron.`)
          } catch (error) {
            showToast('error', 'No se pudieron eliminar', error instanceof Error ? error.message : 'Intenta otra vez')
          } finally {
            setDeletingFields(false)
          }
        }
        void archive()
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const moveFieldsToFolder = async (fieldIds: string[], folderId: string, targetLabel?: string) => {
    const uniqueIds = Array.from(new Set(fieldIds)).filter(Boolean)
    if (!uniqueIds.length || movingFields) return

    const targetFolderId = folderId || ''
    const fieldsToMove = fields.filter(field => !isSystemCustomFieldDefinition(field) && uniqueIds.includes(field.definitionId) && (field.folderId || '') !== targetFolderId)
    if (!fieldsToMove.length) {
      setDraggingFieldIds([])
      setDropTarget(null)
      return
    }

    setMovingFields(true)
    try {
      await Promise.all(fieldsToMove.map(field => (
        customFieldsService.updateField(field.definitionId, { folderId: targetFolderId })
      )))
      setSelectedFieldIds(current => {
        const next = new Set(current)
        fieldsToMove.forEach(field => next.delete(field.definitionId))
        return next
      })
      await loadCatalog()
      const targetName = targetLabel || (targetFolderId ? getFolderName(folders, targetFolderId) : 'Sin carpeta')
      showToast('success', 'Campos movidos', `${fieldsToMove.length} campo${fieldsToMove.length === 1 ? '' : 's'} ahora estan en ${targetName}.`)
    } catch (error) {
      showToast('error', 'No se pudieron mover', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setMovingFields(false)
      setDraggingFieldIds([])
      setDropTarget(null)
    }
  }

  const handleMoveSelectedChange = (value: string) => {
    if (value === '__new_folder') {
      openFolderCreator({ moveSelected: true })
      return
    }

    if (!value) return
    void moveFieldsToFolder(Array.from(selectedFieldIds), value === 'unfiled' ? '' : value)
  }

  const handleFieldDragStart = (field: CustomFieldDefinition, event: React.DragEvent<HTMLTableRowElement>) => {
    if (isSystemCustomFieldDefinition(field)) {
      event.preventDefault()
      setDraggingFieldIds([])
      return
    }

    const ids = (selectedFieldIds.has(field.definitionId) ? Array.from(selectedFieldIds) : [field.definitionId])
      .filter(id => {
        const selectedField = fields.find(item => item.definitionId === id)
        return selectedField && !isSystemCustomFieldDefinition(selectedField)
      })
    if (!ids.length) {
      event.preventDefault()
      return
    }
    setDraggingFieldIds(ids)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', ids.join(','))
  }

  const handleDragEnd = () => {
    setDraggingFieldIds([])
    setDropTarget(null)
  }

  const getDraggedIds = (event: React.DragEvent<HTMLElement>) => {
    const rawIds = event.dataTransfer.getData('text/plain')
    return rawIds ? rawIds.split(',').filter(Boolean) : draggingFieldIds
  }

  const handleFolderDragOver = (folderId: FolderFilter, event: React.DragEvent<HTMLElement>) => {
    if (!isDraggingFields) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget(folderId)
  }

  const handleFolderDrop = (folderId: FolderFilter, event: React.DragEvent<HTMLElement>) => {
    if (!isDraggingFields) return
    event.preventDefault()
    void moveFieldsToFolder(getDraggedIds(event), getFolderTargetId(folderId))
  }

  const handleFolderDragLeave = (folderId: FolderFilter, event: React.DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDropTarget(current => (current === folderId ? null : current))
  }

  const handleArchiveFolder = (folder: CustomFieldFolder) => {
    showConfirm(
      'Eliminar carpeta',
      `Los campos dentro de "${folder.name}" no se eliminan; se quedan guardados sin carpeta.`,
      () => {
        const archive = async () => {
          try {
            await customFieldsService.archiveFolder(folder.id)
            if (activeFolder === folder.id) setActiveFolder('all')
            setOpenFolderMenuId(null)
            await loadCatalog()
            showToast('success', 'Carpeta eliminada', 'Los campos se conservaron.')
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

  const handleArchiveField = (field: CustomFieldDefinition) => {
    showConfirm(
      'Eliminar campo',
      `El campo "${field.label}" se eliminará del sistema y también se borrarán sus valores guardados en todos los contactos. Esta acción no se puede deshacer.`,
      () => {
        const archive = async () => {
          try {
            await customFieldsService.deleteField(field.definitionId)
            await loadCatalog()
            showToast('success', 'Campo eliminado', 'Ese ID ya puede usarse de nuevo.')
          } catch (error) {
            showToast('error', 'No se pudo eliminar', error instanceof Error ? error.message : 'Intenta otra vez')
          }
        }
        void archive()
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Sistema"
        title="Campos personalizados"
        subtitle="Define donde se guardan datos extra de formularios, embudos y contactos."
        actions={
          <>
            <Button variant="secondary" onClick={() => openFolderCreator()} leftIcon={<FolderPlus size={16} />}>
              Crear carpeta
            </Button>
            <Button onClick={openCreateEditor} leftIcon={<Plus size={16} />}>
              Nuevo campo
            </Button>
          </>
        }
      />

      <div className={styles.layout}>
        <aside className={styles.folders} aria-label="Carpetas de campos personalizados">
          <div className={styles.folderHeader}>
            <strong>Carpetas</strong>
            <span>{folders.length} activas</span>
          </div>

          <div className={`${styles.folderRow} ${styles.folderSystemRow} ${activeFolder === 'all' ? styles.folderSystemRowActive : ''}`}>
            <button type="button" onClick={() => setActiveFolder('all')}>
              <HashIcon size={16} />
              <span>Todos los campos</span>
              <b>{fields.length}</b>
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
              placeholder="Buscar por nombre, parámetro o tipo"
              onChange={(nextSearch) => setSearch(nextSearch)}
              onClear={() => setSearch('')}
            />
            <span>{visibleFields.length} campos</span>
          </div>

          {selectedCount > 0 && (
            <div className={styles.selectionBar}>
              <strong>{selectedCount} seleccionado{selectedCount === 1 ? '' : 's'}</strong>
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
                onClick={handleDeleteSelectedFields}
                loading={deletingFields}
                disabled={selectionBusy}
                leftIcon={<Trash2 size={15} />}
              >
                Eliminar
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={clearSelection} disabled={selectionBusy} leftIcon={<X size={15} />}>
                Limpiar
              </Button>
            </div>
          )}

          {loading ? (
            <div className={styles.loadingState} role="status" aria-live="polite" aria-label="Cargando campos">
              <Loader2 className={styles.spin} size={22} aria-hidden="true" />
            </div>
          ) : visibleFields.length === 0 ? (
            <div className={styles.emptyState}>
              <HashIcon size={26} />
              <strong>No hay campos en esta vista</strong>
              <span>Crea un campo nuevo o cambia de carpeta.</span>
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table} data-ristak-table data-ristak-table-element>
                <thead>
                  <tr>
                    <th className={styles.selectionHead}>
                      <input
                        type="checkbox"
                        aria-label="Seleccionar campos visibles"
                        checked={allVisibleSelected}
                        disabled={visibleSelectableFields.length === 0}
                        onChange={toggleVisibleSelection}
                      />
                    </th>
                    <th>Campo</th>
                    <th>Parámetro</th>
                    <th>Tipo</th>
                    <th>Carpeta</th>
                    <th>Opciones</th>
                    <th>Origen</th>
                    <th aria-label="Acciones" />
                  </tr>
                </thead>
                <tbody>
                  {visibleFields.map(field => {
                    const systemField = isSystemCustomFieldDefinition(field)
                    const selected = !systemField && selectedFieldIds.has(field.definitionId)
                    const dragging = draggingFieldIds.includes(field.definitionId)
                    return (
                    <tr
                      key={field.definitionId}
                      className={`${systemField ? styles.lockedRow : styles.draggableRow} ${selected ? styles.rowSelected : ''} ${dragging ? styles.rowDragging : ''}`}
                      draggable={!selectionBusy && !systemField}
                      onDragStart={(event) => handleFieldDragStart(field, event)}
                      onDragEnd={handleDragEnd}
                    >
                      <td className={styles.selectionCell}>
                        <input
                          type="checkbox"
                          aria-label={systemField ? `${field.label} protegido por el sistema` : `Seleccionar ${field.label}`}
                          checked={selected}
                          disabled={systemField || selectionBusy}
                          onChange={() => toggleFieldSelection(field.definitionId)}
                          onClick={(event) => event.stopPropagation()}
                        />
                      </td>
                      <td>
                        <strong>{field.label}</strong>
                      </td>
                      <td><code>{customFieldParameter(field)}</code></td>
                      <td><Badge variant="neutral">{getTypeLabel(field.dataType)}</Badge></td>
                      <td>{field.folderName || getFolderName(folders, field.folderId)}</td>
                      <td>{field.options?.length ? `${field.options.length} opciones` : '-'}</td>
                      <td>{getSourceLabel(field.sourceType)}</td>
                      <td>
                        {systemField ? (
                          <span className={styles.lockedAction}>Protegido</span>
                        ) : (
                          <div className={styles.rowActions}>
                            <button type="button" onClick={() => copyText(customFieldParameter(field), 'Parámetro')} aria-label={`Copiar ${field.label}`} title="Copiar parámetro">
                              <Copy size={15} />
                            </button>
                            <button type="button" onClick={() => openEditEditor(field)} aria-label={`Editar ${field.label}`} title="Editar">
                              <Edit3 size={15} />
                            </button>
                            <button type="button" onClick={() => handleArchiveField(field)} aria-label={`Eliminar ${field.label}`} title="Eliminar">
                              <Trash2 size={15} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </main>
      </div>

      {editorOpen && (
        <div
          className={styles.editorOverlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="custom-field-editor-title"
          data-overlay
        >
          <section className={styles.editorPanel}>
            <div className={styles.editorHeader}>
              <div>
                <p className={styles.eyebrow}>{editingField ? 'Editar campo' : 'Nuevo campo'}</p>
                <h3 id="custom-field-editor-title">{editingField ? editingField.label : 'Crear campo personalizado'}</h3>
              </div>
              <button type="button" className={styles.iconButton} onClick={closeEditor} aria-label="Cerrar editor">
                <X size={18} />
              </button>
            </div>

            <div className={styles.editorBody}>
              <label className={styles.field}>
                <span>Nombre visible</span>
                <input value={draft.label} placeholder="Ej. Presupuesto mensual" onChange={(event) => handleLabelChange(event.target.value)} />
                <small className={styles.parameterPreview}>Parámetro: <code>{customFieldParameter({ fieldKey: draft.fieldKey || normalizeFieldKey(draft.label), key: draft.fieldKey || normalizeFieldKey(draft.label) })}</code></small>
              </label>

              <label className={styles.field}>
                <span>Tipo</span>
                <CustomSelect
                  portal
                  value={draft.dataType}
                  disabled={Boolean(editingField)}
                  onChange={(event) => {
                    const dataType = event.target.value as CustomFieldDataType
                    patchDraft({
                      dataType,
                      options: choiceTypes.has(dataType) && draft.options.length === 0 ? [''] : draft.options
                    })
                  }}
                >
                  {fieldTypes.map(type => (
                    <option key={type.value} value={type.value}>{type.label}</option>
                  ))}
                </CustomSelect>
              </label>

              <div className={styles.typeHint}>
                <ChevronRight size={15} />
                <span>{editingField ? 'El tipo y sus opciones no se pueden cambiar después de crear el campo.' : fieldTypes.find(type => type.value === draft.dataType)?.detail}</span>
              </div>

              {!editingField && (
                <label className={styles.field}>
                  <span>Carpeta</span>
                  <CustomSelect portal value={draft.folderId} onChange={(event) => patchDraft({ folderId: event.target.value })}>
                    <option value="">Sin carpeta</option>
                    {folders.map(folder => (
                      <option key={folder.id} value={folder.id}>{folder.name}</option>
                    ))}
                  </CustomSelect>
                </label>
              )}

              {!editingField && choiceTypes.has(draft.dataType) && (
                <div className={styles.field}>
                  <span>Opciones</span>
                  <div className={styles.optionList}>
                    {draft.options.map((option, index) => (
                      <div key={index} className={styles.optionRow}>
                        <input
                          value={option}
                          placeholder={`Opción ${index + 1}`}
                          onChange={(event) => updateDraftOption(index, event.target.value)}
                        />
                        <button
                          type="button"
                          className={styles.optionRemove}
                          onClick={() => removeDraftOption(index)}
                          aria-label={`Quitar opción ${index + 1}`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <Button type="button" variant="secondary" size="sm" leftIcon={<Plus size={14} />} onClick={addDraftOption}>
                    Agregar opción
                  </Button>
                  <small>Cada opción es una respuesta que el contacto podrá elegir.</small>
                </div>
              )}
            </div>

            <div className={styles.editorActions}>
              <Button type="button" variant="ghost" onClick={closeEditor}>
                Cancelar
              </Button>
              <Button type="button" onClick={() => void handleSaveField()} loading={saving} leftIcon={<Save size={16} />}>
                {editingField ? 'Guardar nombre' : 'Guardar campo'}
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
          aria-labelledby="custom-field-folder-title"
          data-overlay
        >
          <section className={`${styles.editorPanel} ${styles.folderEditorPanel}`}>
            <div className={styles.editorHeader}>
              <div>
                <p className={styles.eyebrow}>Nueva carpeta</p>
                <h3 id="custom-field-folder-title">Crear carpeta</h3>
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
                  placeholder="Ej. Datos financieros"
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
