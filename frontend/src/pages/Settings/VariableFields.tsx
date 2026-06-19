import React, { useEffect, useMemo, useState } from 'react'
import {
  Copy,
  Edit3,
  Hash as HashIcon,
  Loader2,
  Plus,
  Save,
  Trash2,
  X
} from 'lucide-react'
import { Button, PageHeader, SearchField } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import {
  variableFieldsService,
  type SaveVariableFieldInput,
  type VariableField
} from '@/services/variableFieldsService'
import styles from './CustomFields.module.css'

type VariableFieldDraft = {
  label: string
  fieldKey: string
  value: string
}

const emptyDraft = (): VariableFieldDraft => ({
  label: '',
  fieldKey: '',
  value: ''
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
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}

const variableParameter = (field: VariableField | Pick<VariableFieldDraft, 'fieldKey'>) => `{{variable.${field.fieldKey || 'campo_variable'}}}`

export const VariableFields: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [fields, setFields] = useState<VariableField[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deletingFields, setDeletingFields] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingField, setEditingField] = useState<VariableField | null>(null)
  const [draft, setDraft] = useState<VariableFieldDraft>(emptyDraft())
  const [selectedFieldIds, setSelectedFieldIds] = useState<Set<string>>(() => new Set())

  const loadFields = async () => {
    setLoading(true)
    try {
      const nextFields = await variableFieldsService.list()
      setFields(nextFields || [])
    } catch (error) {
      showToast('error', 'No se pudieron cargar los campos', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadFields()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setSelectedFieldIds(current => {
      const activeIds = new Set(fields.map(field => field.id))
      const next = new Set([...current].filter(id => activeIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [fields])

  const visibleFields = useMemo(() => {
    const query = search.trim().toLowerCase()
    return fields.filter(field => {
      if (!query) return true
      return [
        field.label,
        field.fieldKey,
        field.parameter,
        field.value
      ].some(value => String(value || '').toLowerCase().includes(query))
    })
  }, [fields, search])

  const selectedFields = useMemo(
    () => fields.filter(field => selectedFieldIds.has(field.id)),
    [fields, selectedFieldIds]
  )

  const selectedCount = selectedFields.length
  const visibleSelectedCount = visibleFields.filter(field => selectedFieldIds.has(field.id)).length
  const allVisibleSelected = visibleFields.length > 0 && visibleSelectedCount === visibleFields.length

  const patchDraft = (patch: Partial<VariableFieldDraft>) => {
    setDraft(current => ({ ...current, ...patch }))
  }

  const openCreateEditor = () => {
    setEditingField(null)
    setDraft(emptyDraft())
    setEditorOpen(true)
  }

  const openEditEditor = (field: VariableField) => {
    setEditingField(field)
    setDraft({
      label: field.label,
      fieldKey: field.fieldKey,
      value: field.value || ''
    })
    setEditorOpen(true)
  }

  const closeEditor = () => {
    if (saving) return
    setEditorOpen(false)
    setEditingField(null)
    setDraft(emptyDraft())
  }

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      showToast('success', 'Copiado', `${label} copiado.`)
    } catch {
      showToast('error', 'No se pudo copiar', 'Cópialo manualmente.')
    }
  }

  const toggleFieldSelection = (fieldId: string) => {
    setSelectedFieldIds(current => {
      const next = new Set(current)
      if (next.has(fieldId)) next.delete(fieldId)
      else next.add(fieldId)
      return next
    })
  }

  const toggleVisibleSelection = () => {
    setSelectedFieldIds(current => {
      const next = new Set(current)
      if (allVisibleSelected) {
        visibleFields.forEach(field => next.delete(field.id))
      } else {
        visibleFields.forEach(field => next.add(field.id))
      }
      return next
    })
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
      value: draft.value
    }
  }

  const handleSaveField = async () => {
    const payload = buildPayload()
    if (!payload) return

    setSaving(true)
    try {
      if (editingField) {
        await variableFieldsService.update(editingField.id, payload)
        showToast('success', 'Campo actualizado', 'El parámetro ya usa este valor.')
      } else {
        await variableFieldsService.create(payload)
        showToast('success', 'Campo creado', 'Ya puedes copiar el parámetro y usarlo en mensajes.')
      }
      closeEditor()
      await loadFields()
    } catch (error) {
      showToast('error', 'No se pudo guardar', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteField = (field: VariableField) => {
    showConfirm(
      'Eliminar campo variable',
      `El parámetro ${field.parameter} dejará de resolverse en mensajes nuevos.`,
      () => {
        const archive = async () => {
          try {
            await variableFieldsService.delete(field.id)
            await loadFields()
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
      `Se eliminarán ${total} campo${total === 1 ? '' : 's'} variable${total === 1 ? '' : 's'}. Sus parámetros dejarán de resolverse en mensajes nuevos.`,
      () => {
        const archive = async () => {
          setDeletingFields(true)
          try {
            await Promise.all(fieldsToDelete.map(field => variableFieldsService.delete(field.id)))
            clearSelection()
            await loadFields()
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

      <div className={styles.layout}>
        <aside className={styles.folders} aria-label="Filtros de campos variables">
          <div className={styles.folderHeader}>
            <strong>Filtros</strong>
            <span>{fields.length} campos</span>
          </div>
          <div className={`${styles.folderRow} ${styles.folderSystemRow} ${styles.folderSystemRowActive}`}>
            <button type="button" aria-current="true">
              <HashIcon size={16} />
              <span>Todos los campos</span>
              <b>{fields.length}</b>
            </button>
            <span className={styles.folderActionSpacer} aria-hidden="true" />
          </div>
        </aside>

        <main className={styles.tablePanel}>
          <div className={styles.toolbar}>
            <SearchField
              className={styles.toolbarSearch}
              value={search}
              placeholder="Buscar por nombre, parámetro o valor"
              onChange={(nextSearch) => setSearch(nextSearch)}
              onClear={() => setSearch('')}
            />
            <span>{visibleFields.length} campos</span>
          </div>

          {selectedCount > 0 && (
            <div className={styles.selectionBar}>
              <strong>{selectedCount} seleccionado{selectedCount === 1 ? '' : 's'}</strong>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={handleDeleteSelectedFields}
                loading={deletingFields}
                leftIcon={<Trash2 size={15} />}
              >
                Eliminar
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={clearSelection} disabled={deletingFields} leftIcon={<X size={15} />}>
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
              <span>Crea un campo nuevo o ajusta la búsqueda.</span>
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={`${styles.table} ${styles.plainTable}`} data-ristak-table data-ristak-table-element>
                <thead>
                  <tr>
                    <th className={styles.selectionHead}>
                      <input
                        type="checkbox"
                        aria-label="Seleccionar campos visibles"
                        checked={allVisibleSelected}
                        disabled={visibleFields.length === 0 || deletingFields}
                        onChange={toggleVisibleSelection}
                      />
                    </th>
                    <th>Campo</th>
                    <th>Parámetro</th>
                    <th>Valor</th>
                    <th>Última actualización</th>
                    <th aria-label="Acciones" />
                  </tr>
                </thead>
                <tbody>
                  {visibleFields.map(field => {
                    const selected = selectedFieldIds.has(field.id)
                    return (
                    <tr key={field.id} className={selected ? styles.rowSelected : ''}>
                      <td className={styles.selectionCell}>
                        <input
                          type="checkbox"
                          aria-label={`Seleccionar ${field.label}`}
                          checked={selected}
                          disabled={deletingFields}
                          onChange={() => toggleFieldSelection(field.id)}
                          onClick={(event) => event.stopPropagation()}
                        />
                      </td>
                      <td className={styles.primaryCell}>
                        <strong>{field.label}</strong>
                      </td>
                      <td><code>{field.parameter || variableParameter(field)}</code></td>
                      <td><code>{field.value || '-'}</code></td>
                      <td>{formatDateTime(field.updatedAt)}</td>
                      <td>
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
        <div className={styles.editorOverlay} role="dialog" aria-modal="true" aria-labelledby="variable-field-editor-title">
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
    </div>
  )
}
