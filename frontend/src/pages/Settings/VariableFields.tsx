import React, { useEffect, useMemo, useState } from 'react'
import {
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
import { useNotification } from '@/contexts/NotificationContext'
import {
  variableFieldsService,
  type SaveVariableFieldInput,
  type VariableField,
  type VariableFieldFolder
} from '@/services/variableFieldsService'
import { formatDateTime as formatBusinessDateTime } from '@/utils/format'
import styles from './CustomFields.module.css'

type FolderFilter = 'all' | 'unfiled' | string

type VariableFieldDraft = {
  label: string
  fieldKey: string
  value: string
  folderId: string
}

const emptyDraft = (folderId = ''): VariableFieldDraft => ({
  label: '',
  fieldKey: '',
  value: '',
  folderId
})

const normalizeFieldKey = (value: string) => {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  return normalized || 'campo_variable'
}

const formatDateTime = (value?: string | null) => {
  return formatBusinessDateTime(value, {
    fallback: '-',
    intlOptions: {
      dateStyle: 'medium',
      timeStyle: 'short'
    }
  })
}

const getFolderName = (folders: VariableFieldFolder[], folderId?: string | null) => (
  folders.find(folder => folder.id === folderId)?.name || 'Sin carpeta'
)

const variableParameter = (field: VariableField | Pick<VariableFieldDraft, 'fieldKey'>) => `{{variable.${field.fieldKey || 'campo_variable'}}}`

export const VariableFields: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [folders, setFolders] = useState<VariableFieldFolder[]>([])
  const [fields, setFields] = useState<VariableField[]>([])
  const [activeFolder, setActiveFolder] = useState<FolderFilter>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [movingFields, setMovingFields] = useState(false)
  const [deletingFields, setDeletingFields] = useState(false)
  const [folderManagerOpen, setFolderManagerOpen] = useState(false)
  const [moveSelectionAfterFolderCreate, setMoveSelectionAfterFolderCreate] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingField, setEditingField] = useState<VariableField | null>(null)
  const [draft, setDraft] = useState<VariableFieldDraft>(emptyDraft())
  const [selectedFieldIds, setSelectedFieldIds] = useState<Set<string>>(() => new Set())

  const loadCatalog = async () => {
    setLoading(true)
    try {
      const [nextFields, nextFolders] = await Promise.all([
        variableFieldsService.list(),
        variableFieldsService.listFolders()
      ])
      setFields(nextFields || [])
      setFolders(nextFolders || [])
    } catch (error) {
      showToast('error', 'No se pudieron cargar los campos', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadCatalog()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setSelectedFieldIds(current => {
      const activeIds = new Set(fields.map(field => field.id))
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

  const visibleFields = useMemo(() => {
    const query = search.trim().toLowerCase()
    return fields.filter(field => {
      if (activeFolder === 'unfiled' && field.folderId) return false
      if (activeFolder !== 'all' && activeFolder !== 'unfiled' && field.folderId !== activeFolder) return false

      if (!query) return true
      return [
        field.label,
        field.fieldKey,
        field.parameter,
        field.value,
        field.folderName
      ].some(value => String(value || '').toLowerCase().includes(query))
    })
  }, [activeFolder, fields, search])

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

  const selectedFields = useMemo(
    () => fields.filter(field => selectedFieldIds.has(field.id)),
    [fields, selectedFieldIds]
  )

  const selectedCount = selectedFields.length
  const selectionBusy = movingFields || deletingFields

  const patchDraft = (patch: Partial<VariableFieldDraft>) => {
    setDraft(current => ({ ...current, ...patch }))
  }

  const openCreateEditor = () => {
    const folderId = activeFolder !== 'all' && activeFolder !== 'unfiled' ? activeFolder : ''
    setEditingField(null)
    setDraft(emptyDraft(folderId))
    setEditorOpen(true)
  }

  const openEditEditor = (field: VariableField) => {
    setEditingField(field)
    setDraft({
      label: field.label,
      fieldKey: field.fieldKey,
      value: field.value || '',
      folderId: field.folderId || ''
    })
    setEditorOpen(true)
  }

  const closeEditor = () => {
    if (saving) return
    setEditorOpen(false)
    setEditingField(null)
    setDraft(emptyDraft())
  }

  const openFolderManager = (options: { moveSelected?: boolean } = {}) => {
    setMoveSelectionAfterFolderCreate(Boolean(options.moveSelected && selectedCount > 0))
    setFolderManagerOpen(true)
  }

  const closeFolderManager = () => {
    setMoveSelectionAfterFolderCreate(false)
    setFolderManagerOpen(false)
  }

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      showToast('success', 'Copiado', `${label} copiado.`)
    } catch {
      showToast('error', 'No se pudo copiar', 'Cópialo manualmente.')
    }
  }

  const clearSelection = () => {
    setSelectedFieldIds(new Set())
  }

  const handleLabelChange = (value: string) => {
    setDraft(current => ({
      ...current,
      label: value,
      fieldKey: editingField ? current.fieldKey : normalizeFieldKey(value)
    }))
  }

  const buildPayload = (): SaveVariableFieldInput | null => {
    const label = draft.label.trim()
    const fieldKey = editingField ? normalizeFieldKey(draft.fieldKey) : normalizeFieldKey(label)
    if (!label) {
      showToast('warning', 'Falta nombre', 'Ponle un nombre al campo variable.')
      return null
    }
    if (!fieldKey) {
      showToast('warning', 'Falta parámetro', 'Define el nombre interno del parámetro.')
      return null
    }
    return {
      label,
      fieldKey,
      value: draft.value,
      folderId: draft.folderId
    }
  }

  const handleSaveField = async () => {
    const payload = buildPayload()
    if (!payload) return

    setSaving(true)
    try {
      if (editingField) {
        await variableFieldsService.update(editingField.id, payload)
        showToast('success', 'Campo actualizado', 'El parámetro ya usa este valor y carpeta.')
      } else {
        await variableFieldsService.create(payload)
        showToast('success', 'Campo creado', 'Ya puedes copiar el parámetro y usarlo en mensajes.')
      }
      setEditorOpen(false)
      setEditingField(null)
      setDraft(emptyDraft())
      await loadCatalog()
    } catch (error) {
      showToast('error', 'No se pudo guardar', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setSaving(false)
    }
  }

  const moveFieldsToFolder = async (fieldIds: string[], folderId: string, targetLabel?: string) => {
    const uniqueIds = Array.from(new Set(fieldIds)).filter(Boolean)
    if (!uniqueIds.length || movingFields) return

    const targetFolderId = folderId || ''
    const fieldsToMove = fields.filter(field => uniqueIds.includes(field.id) && (field.folderId || '') !== targetFolderId)
    if (!fieldsToMove.length) return

    setMovingFields(true)
    try {
      await Promise.all(fieldsToMove.map(field => variableFieldsService.update(field.id, { folderId: targetFolderId })))
      setSelectedFieldIds(current => {
        const next = new Set(current)
        fieldsToMove.forEach(field => next.delete(field.id))
        return next
      })
      await loadCatalog()
      const targetName = targetLabel || (targetFolderId ? getFolderName(folders, targetFolderId) : 'Sin carpeta')
      showToast('success', 'Campos movidos', `${fieldsToMove.length} campo${fieldsToMove.length === 1 ? '' : 's'} ahora ${fieldsToMove.length === 1 ? 'está' : 'están'} en ${targetName}.`)
    } catch (error) {
      showToast('error', 'No se pudieron mover', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setMovingFields(false)
    }
  }

  const handleCreateFolder = async (input: { name: string; description?: string }) => {
    const selectedIds = Array.from(selectedFieldIds)
    const shouldMoveSelection = moveSelectionAfterFolderCreate && selectedIds.length > 0

    try {
      const folder = await variableFieldsService.createFolder(input)
      setFolders(current => [...current, folder])
      setActiveFolder(folder.id)
      if (shouldMoveSelection) {
        setFolderManagerOpen(false)
        await moveFieldsToFolder(selectedIds, folder.id, folder.name)
      } else {
        showToast('success', 'Carpeta creada', 'Ya puedes guardar campos variables ahí.')
      }
      setMoveSelectionAfterFolderCreate(false)
      return true
    } catch (error) {
      showToast('error', 'No se pudo crear la carpeta', error instanceof Error ? error.message : 'Intenta otra vez')
      return false
    }
  }

  const handleArchiveFolder = (folder: { id: string; name: string }) => {
    showConfirm(
      'Eliminar carpeta',
      `Los campos dentro de "${folder.name}" no se eliminan; se quedan guardados sin carpeta.`,
      () => {
        const archive = async () => {
          try {
            await variableFieldsService.archiveFolder(folder.id)
            if (activeFolder === folder.id) setActiveFolder('all')
            await loadCatalog()
            showToast('success', 'Carpeta eliminada', 'Los campos variables se conservaron.')
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

  const handleDeleteField = (field: VariableField) => {
    showConfirm(
      'Eliminar campo variable',
      `El parámetro ${field.parameter} dejará de resolverse en mensajes nuevos. Esta acción no se puede deshacer.`,
      () => {
        const archive = async () => {
          try {
            await variableFieldsService.delete(field.id)
            await loadCatalog()
            showToast('success', 'Campo eliminado', 'El parámetro ya no está activo.')
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

  const handleDeleteSelectedFields = () => {
    if (!selectedFields.length || deletingFields) return

    const fieldsToDelete = selectedFields
    const total = fieldsToDelete.length
    showConfirm(
      'Eliminar campos variables seleccionados',
      `Se eliminarán ${total} campo${total === 1 ? '' : 's'} variable${total === 1 ? '' : 's'}. Sus parámetros dejarán de resolverse en mensajes nuevos. Esta acción no se puede deshacer.`,
      () => {
        const archive = async () => {
          setDeletingFields(true)
          try {
            await Promise.all(fieldsToDelete.map(field => variableFieldsService.delete(field.id)))
            clearSelection()
            await loadCatalog()
            showToast('success', 'Campos eliminados', `${total} campo${total === 1 ? '' : 's'} variable${total === 1 ? '' : 's'} ya no están activos.`)
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

  const handleMoveSelectedChange = (value: string) => {
    if (value === '__new_folder') {
      openFolderManager({ moveSelected: true })
      return
    }
    if (!value) return
    void moveFieldsToFolder(Array.from(selectedFieldIds), value === 'unfiled' ? '' : value)
  }

  const fieldSelectionToolbar = selectedCount > 0 ? (
    <TableSelectionToolbar count={selectedCount} onClearSelection={clearSelection}>
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

  const fieldColumns: Column<VariableField>[] = [
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
      key: 'parameter',
      header: 'Parámetro',
      render: (_value, field) => <code>{field.parameter || variableParameter(field)}</code>
    },
    {
      key: 'value',
      header: 'Valor',
      render: (_value, field) => <code>{field.value || '-'}</code>
    },
    {
      key: 'folderName',
      header: 'Carpeta',
      render: (_value, field) => field.folderName || 'Sin carpeta'
    },
    {
      key: 'updatedAt',
      header: 'Última actualización',
      render: (_value, field) => formatDateTime(field.updatedAt)
    },
    {
      key: 'actions',
      header: '',
      searchable: false,
      sortable: false,
      render: (_value, field) => (
        <div className={styles.rowActions}>
          <button type="button" onClick={() => copyText(field.parameter || variableParameter(field), 'Parámetro')} aria-label={`Copiar ${field.label}`} title="Copiar parámetro">
            <Copy size={15} />
          </button>
          <button type="button" onClick={() => openEditEditor(field)} aria-label={`Editar ${field.label}`} title="Editar">
            <Edit3 size={15} />
          </button>
          <button type="button" onClick={() => handleDeleteField(field)} aria-label={`Eliminar ${field.label}`} title="Eliminar">
            <Trash2 size={15} />
          </button>
        </div>
      )
    }
  ]

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Sistema"
        title="Campos variables"
        subtitle="Define parámetros del negocio que no dependen de un contacto."
        actions={
          <Button onClick={openCreateEditor} leftIcon={<Plus size={16} />}>
            Nuevo campo
          </Button>
        }
      />

      <main className={styles.tablePanel}>
        <Table<VariableField>
          initialColumns={fieldColumns}
          data={visibleFields}
          keyExtractor={(field) => field.id}
          loading={loading}
          emptyMessage="No hay campos en esta vista"
          searchable
          searchPlaceholder="Buscar por nombre, parámetro, valor o carpeta"
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
                ariaLabel="Abrir filtros de campos variables"
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
          aria-labelledby="variable-field-editor-title"
          data-overlay
        >
          <section className={styles.editorPanel}>
            <div className={styles.editorHeader}>
              <div>
                <p className={styles.eyebrow}>{editingField ? 'Editar campo' : 'Nuevo campo'}</p>
                <h3 id="variable-field-editor-title">{editingField ? editingField.label : 'Crear campo variable'}</h3>
              </div>
              <button type="button" className={styles.iconButton} onClick={closeEditor} aria-label="Cerrar editor">
                <X size={18} />
              </button>
            </div>

            <div className={styles.editorBody}>
              <label className={styles.field}>
                <span>Nombre visible</span>
                <input value={draft.label} placeholder="Ej. Nombre del negocio" onChange={(event) => handleLabelChange(event.target.value)} />
                <small className={styles.parameterPreview}>Parámetro: <code>{variableParameter({ fieldKey: draft.fieldKey || normalizeFieldKey(draft.label) })}</code></small>
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

              <label className={styles.field}>
                <span>Valor</span>
                <textarea
                  rows={4}
                  value={draft.value}
                  placeholder="Lo que se enviará cuando uses este parámetro."
                  onChange={(event) => patchDraft({ value: event.target.value })}
                />
              </label>
            </div>

            <div className={styles.editorActions}>
              <Button type="button" variant="ghost" onClick={closeEditor} disabled={saving}>
                Cancelar
              </Button>
              <Button type="button" onClick={() => void handleSaveField()} loading={saving} leftIcon={<Save size={16} />}>
                {editingField ? 'Guardar campo' : 'Crear campo'}
              </Button>
            </div>
          </section>
        </div>
      )}

      <FolderManagerModal
        isOpen={folderManagerOpen}
        onClose={closeFolderManager}
        title="Carpetas de campos variables"
        subtitle="Crea carpetas para ordenar parámetros del negocio sin cambiar cómo se usan."
        folders={managedFolders}
        itemLabel="campo"
        onCreate={handleCreateFolder}
        onDelete={handleArchiveFolder}
      />
    </div>
  )
}
