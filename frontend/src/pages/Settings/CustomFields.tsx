import React, { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  Copy,
  Edit3,
  FolderPlus,
  Plus,
  Save,
  Trash2,
  X
} from 'lucide-react'
import {
  Button,
  CustomSelect,
  FolderFilterMenu,
  FolderManagerModal,
  PageHeader,
  Table,
  TableSelectionToolbar,
  type Column
} from '@/components/common'
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
  options: CustomFieldOption[]
}

const fieldTypes: Array<{ value: CustomFieldDataType; label: string; detail: string }> = [
  { value: 'text', label: 'Texto corto', detail: 'Una línea de texto.' },
  { value: 'textarea', label: 'Párrafo', detail: 'Texto largo o notas.' },
  { value: 'radio', label: 'Radio buttons', detail: 'Varias opciones visibles; se elige una.' },
  { value: 'dropdown', label: 'Dropdown', detail: 'Varias opciones en lista; se elige una.' },
  { value: 'multiselect', label: 'Dropdown múltiple', detail: 'Varias opciones en lista; se pueden elegir varias.' },
  { value: 'checkboxes', label: 'Checkboxes', detail: 'Varias opciones visibles; se pueden elegir varias.' },
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

const shouldSyncOptionValue = (option: CustomFieldOption) => {
  const label = option.label.trim()
  const value = option.value.trim()
  return !value || value === label || value === normalizeFieldKey(label)
}

const draftOptionsToPayloadOptions = (options: CustomFieldOption[]): CustomFieldOption[] => (
  options
    .map(option => ({
      label: option.label.trim(),
      value: (option.value || option.label).trim()
    }))
    .filter(option => option.label || option.value)
    .map(option => ({
      label: option.label || option.value,
      value: option.value || option.label
    }))
)

const optionsToDraftOptions = (options: CustomFieldOption[] = []) => (
  options
    .map(option => ({
      label: (option.label || option.value || '').trim(),
      value: (option.value || option.label || '').trim()
    }))
    .filter(option => option.label || option.value)
)

const getTypeLabel = (type: string) => (
  fieldTypes.find(item => item.value === type)?.label ||
  (type === 'select' ? 'Dropdown' : type || 'Texto corto')
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

const customFieldParameter = (field: Pick<CustomFieldDefinition, 'fieldKey' | 'key'>) => `{{custom.${field.fieldKey || field.key}}}`

export const CustomFields: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [folders, setFolders] = useState<CustomFieldFolder[]>([])
  const [fields, setFields] = useState<CustomFieldDefinition[]>([])
  const [activeFolder, setActiveFolder] = useState<FolderFilter>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [folderManagerOpen, setFolderManagerOpen] = useState(false)
  const [moveSelectionAfterFolderCreate, setMoveSelectionAfterFolderCreate] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingField, setEditingField] = useState<CustomFieldDefinition | null>(null)
  const [draft, setDraft] = useState<FieldDraft>(emptyDraft())
  const [selectedFieldIds, setSelectedFieldIds] = useState<Set<string>>(() => new Set())
  const [movingFields, setMovingFields] = useState(false)
  const [deletingFields, setDeletingFields] = useState(false)

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

  useEffect(() => {
    if (activeFolder === 'all' || activeFolder === 'unfiled') return
    if (!folders.some(folder => folder.id === activeFolder)) setActiveFolder('all')
  }, [activeFolder, folders])

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>()
    fields.forEach(field => {
      const folderId = field.folderId || 'unfiled'
      counts.set(folderId, (counts.get(folderId) || 0) + 1)
    })
    return counts
  }, [fields])

  const folderFilterOptions = useMemo(() => folders.map(folder => ({
    id: folder.id,
    name: folder.name,
    count: folderCounts.get(folder.id) || 0
  })), [folderCounts, folders])

  const managedFolders = useMemo(() => folders.map(folder => ({
    id: folder.id,
    name: folder.name,
    description: folder.description,
    count: folderCounts.get(folder.id) || 0
  })), [folderCounts, folders])

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

  const selectedCount = selectedFields.length
  const selectionBusy = movingFields || deletingFields

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
      options: optionsToDraftOptions(field.options)
    })
    setEditorOpen(true)
  }

  const closeEditor = () => {
    setEditorOpen(false)
    setEditingField(null)
    setDraft(emptyDraft())
  }

  const openFolderManager = (options: { moveSelected?: boolean } = {}) => {
    setMoveSelectionAfterFolderCreate(Boolean(options.moveSelected && selectedCount > 0))
    setFolderManagerOpen(true)
  }

  const closeFolderManager = () => {
    setFolderManagerOpen(false)
    setMoveSelectionAfterFolderCreate(false)
  }

  const patchDraft = (patch: Partial<FieldDraft>) => {
    setDraft(current => ({ ...current, ...patch }))
  }

  const addDraftOption = () => {
    setDraft(current => ({ ...current, options: [...current.options, { label: '', value: '' }] }))
  }

  const updateDraftOption = (index: number, patch: Partial<CustomFieldOption>) => {
    setDraft(current => ({
      ...current,
      options: current.options.map((option, optionIndex) => {
        if (optionIndex !== index) return option
        if (patch.label === undefined) return { ...option, ...patch }
        const nextLabel = patch.label
        return {
          ...option,
          ...patch,
          value: shouldSyncOptionValue(option) ? normalizeFieldKey(nextLabel) : option.value
        }
      })
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
    const options = choiceTypes.has(draft.dataType) ? draftOptionsToPayloadOptions(draft.options) : []

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
        const patch: Partial<SaveCustomFieldInput> = {
          label,
          folderId: draft.folderId
        }
        if (choiceTypes.has(draft.dataType)) {
          const options = draftOptionsToPayloadOptions(draft.options)
          if (options.length === 0) {
            showToast('warning', 'Faltan opciones', 'Agrega al menos una opción para este tipo de campo.')
            return
          }
          patch.options = options
        }
        await customFieldsService.updateField(editingField.definitionId, patch)
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

  const handleCreateFolder = async (input: { name: string; description?: string }) => {
    const selectedIds = Array.from(selectedFieldIds)
    const shouldMoveSelection = moveSelectionAfterFolderCreate && selectedIds.length > 0

    try {
      const folder = await customFieldsService.createFolder(input)
      setFolders(current => [...current, folder])
      setActiveFolder(folder.id)
      if (shouldMoveSelection) {
        setFolderManagerOpen(false)
        await moveFieldsToFolder(selectedIds, folder.id, folder.name)
      } else {
        showToast('success', 'Carpeta creada', 'Ya puedes guardar campos ahí.')
      }
      setMoveSelectionAfterFolderCreate(false)
      return true
    } catch (error) {
      showToast('error', 'No se pudo crear la carpeta', error instanceof Error ? error.message : 'Intenta otra vez')
      return false
    }
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
    if (!fieldsToMove.length) return

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
    }
  }

  const handleMoveSelectedChange = (value: string) => {
    if (value === '__new_folder') {
      openFolderManager({ moveSelected: true })
      return
    }

    if (!value) return
    void moveFieldsToFolder(Array.from(selectedFieldIds), value === 'unfiled' ? '' : value)
  }

  const handleArchiveFolder = (folder: { id: string; name: string }) => {
    showConfirm(
      'Eliminar carpeta',
      `Los campos dentro de "${folder.name}" no se eliminan; se quedan guardados sin carpeta.`,
      () => {
        const archive = async () => {
          try {
            await customFieldsService.archiveFolder(folder.id)
            if (activeFolder === folder.id) setActiveFolder('all')
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

  const fieldSelectionToolbar = selectedCount > 0 ? (
    <TableSelectionToolbar
      count={selectedCount}
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
        onClick={handleDeleteSelectedFields}
        loading={deletingFields}
        disabled={selectionBusy}
        leftIcon={<Trash2 size={15} />}
      >
        Eliminar
      </Button>
    </TableSelectionToolbar>
  ) : null

  const fieldColumns: Column<CustomFieldDefinition>[] = [
    {
      key: 'label',
      header: 'Campo',
      render: (_value, field) => (
        <span className={styles.primaryCell}>
          <strong>{field.label}</strong>
        </span>
      )
    },
    {
      key: 'fieldKey',
      header: 'Parámetro',
      render: (_value, field) => <code>{customFieldParameter(field)}</code>
    },
    {
      key: 'dataType',
      header: 'Tipo',
      render: (_value, field) => <Badge variant="neutral">{getTypeLabel(field.dataType)}</Badge>
    },
    {
      key: 'folderName',
      header: 'Carpeta',
      render: (_value, field) => field.folderName || getFolderName(folders, field.folderId)
    },
    {
      key: 'options',
      header: 'Opciones',
      render: (_value, field) => field.options?.length ? `${field.options.length} opciones` : '-'
    },
    {
      key: 'sourceType',
      header: 'Origen',
      render: (_value, field) => getSourceLabel(field.sourceType)
    },
    {
      key: 'actions',
      header: '',
      searchable: false,
      sortable: false,
      render: (_value, field) => {
        const systemField = isSystemCustomFieldDefinition(field)
        if (systemField) return <span className={styles.lockedAction}>Protegido</span>

        return (
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
        )
      }
    }
  ]

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Sistema"
        title="Campos personalizados"
        subtitle="Define donde se guardan datos extra de formularios, embudos y contactos."
        actions={
          <Button onClick={openCreateEditor} leftIcon={<Plus size={16} />}>
            Nuevo campo
          </Button>
        }
      />

      <main className={styles.tablePanel}>
        <Table<CustomFieldDefinition>
          initialColumns={fieldColumns}
          data={visibleFields}
          keyExtractor={(field) => field.definitionId}
          loading={loading}
          emptyMessage="No hay campos en esta vista"
          searchable
          searchPlaceholder="Buscar por nombre, parámetro, tipo o carpeta"
          searchTerm={search}
          onSearchTermChange={setSearch}
          paginated={false}
          showColumnEditor={false}
          toolbarStart={(
            <div className={styles.catalogToolbar}>
              <FolderFilterMenu
                value={activeFolder}
                folders={folderFilterOptions}
                totalCount={fields.length}
                unfiledCount={folderCounts.get('unfiled') || 0}
                onChange={setActiveFolder}
                ariaLabel="Abrir filtros de campos personalizados"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => openFolderManager()}
                leftIcon={<FolderPlus size={16} />}
              >
                Carpetas
              </Button>
              <span className={styles.catalogResultCount}>{visibleFields.length} de {fields.length}</span>
            </div>
          )}
          selectionActions={fieldSelectionToolbar}
          rowSelection={{
            selectedKeys: Array.from(selectedFieldIds),
            onChange: (nextSelectedIds) => setSelectedFieldIds(new Set(nextSelectedIds)),
            isRowDisabled: isSystemCustomFieldDefinition,
            getRowLabel: (field) => field.label,
            selectAllLabel: 'Seleccionar todos los campos'
          }}
        />
      </main>

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
                      options: choiceTypes.has(dataType) && draft.options.length === 0 ? [{ label: '', value: '' }] : draft.options
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
                <span>{editingField ? 'El tipo no se puede cambiar después de crear el campo.' : fieldTypes.find(type => type.value === draft.dataType)?.detail}</span>
              </div>

              <label className={styles.field}>
                <span>Carpeta</span>
                <CustomSelect portal value={draft.folderId} onChange={(event) => patchDraft({ folderId: event.target.value })}>
                  <option value="">Sin carpeta</option>
                  {folders.map(folder => (
                    <option key={folder.id} value={folder.id}>{folder.name}</option>
                  ))}
                </CustomSelect>
              </label>

              {choiceTypes.has(draft.dataType) && (
                <div className={styles.field}>
                  <span>Opciones</span>
                  <div className={styles.optionList}>
                    {draft.options.map((option, index) => (
                      <div key={index} className={styles.optionRow}>
                        <label className={styles.optionInput}>
                          <span>Texto visible</span>
                          <input
                            value={option.label}
                            placeholder={`Opción ${index + 1}`}
                            onChange={(event) => updateDraftOption(index, { label: event.target.value })}
                          />
                        </label>
                        <label className={styles.optionInput}>
                          <span>Valor interno</span>
                          <input
                            value={option.value}
                            placeholder="Ej. 3000"
                            onChange={(event) => updateDraftOption(index, { value: event.target.value })}
                          />
                        </label>
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
                  <small>El contacto ve el texto visible. El valor interno es lo que se guarda y se puede mapear en Meta o automatizaciones.</small>
                </div>
              )}
            </div>

            <div className={styles.editorActions}>
              <Button type="button" variant="ghost" onClick={closeEditor}>
                Cancelar
              </Button>
              <Button type="button" onClick={() => void handleSaveField()} loading={saving} leftIcon={<Save size={16} />}>
                Guardar campo
              </Button>
            </div>
          </section>
        </div>
      )}

      <FolderManagerModal
        isOpen={folderManagerOpen}
        onClose={closeFolderManager}
        title="Carpetas de campos personalizados"
        subtitle="Organiza los datos extra del contacto sin cambiar sus parámetros."
        folders={managedFolders}
        itemLabel="campo"
        onCreate={handleCreateFolder}
        onDelete={handleArchiveFolder}
      />
    </div>
  )
}
