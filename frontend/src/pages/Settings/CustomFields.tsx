import React, { useEffect, useMemo, useState } from 'react'
import {
  Archive,
  ChevronRight,
  Edit3,
  Folder,
  FolderPlus,
  Hash,
  Loader2,
  Plus,
  Save,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { Button } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import {
  customFieldsService,
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
  description: string
  dataType: CustomFieldDataType
  folderId: string
  optionsText: string
}

const fieldTypes: Array<{ value: CustomFieldDataType; label: string; detail: string }> = [
  { value: 'text', label: 'Texto corto', detail: 'Una linea de texto.' },
  { value: 'textarea', label: 'Parrafo', detail: 'Texto largo o notas.' },
  { value: 'radio', label: 'Radio buttons', detail: 'Una opcion visible.' },
  { value: 'dropdown', label: 'Dropdown', detail: 'Una opcion en lista.' },
  { value: 'checkboxes', label: 'Checkboxes', detail: 'Varias opciones.' },
  { value: 'number', label: 'Numero', detail: 'Solo cantidad numerica.' },
  { value: 'currency', label: 'Moneda', detail: 'Importe de dinero.' },
  { value: 'date', label: 'Fecha', detail: 'Dia o fecha.' },
  { value: 'email', label: 'Email', detail: 'Correo electronico.' },
  { value: 'phone', label: 'Telefono', detail: 'Numero de contacto.' }
]

const choiceTypes = new Set<CustomFieldDataType>(['radio', 'dropdown', 'checkboxes', 'select', 'multiselect'])

const emptyDraft = (folderId = ''): FieldDraft => ({
  label: '',
  fieldKey: '',
  description: '',
  dataType: 'text',
  folderId,
  optionsText: ''
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

const optionLinesToOptions = (value: string): CustomFieldOption[] => (
  value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => ({ label: line, value: normalizeFieldKey(line) }))
)

const optionsToText = (options: CustomFieldOption[] = []) => (
  options.map(option => option.label || option.value).filter(Boolean).join('\n')
)

const getTypeLabel = (type: string) => (
  fieldTypes.find(item => item.value === type)?.label ||
  (type === 'select' ? 'Dropdown' : type === 'multiselect' ? 'Checkboxes' : type || 'Texto corto')
)

const getFolderName = (folders: CustomFieldFolder[], folderId: string) => (
  folders.find(folder => folder.id === folderId)?.name || 'Sin carpeta'
)

const getSourceLabel = (sourceType: string) => {
  if (sourceType === 'manual') return 'Creado por ti'
  if (sourceType === 'native_site') return 'Formulario Ristak'
  if (sourceType === 'imported_html') return 'HTML importado'
  if (sourceType === 'highlevel') return 'HighLevel'
  return sourceType || 'Sistema'
}

export const CustomFields: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [folders, setFolders] = useState<CustomFieldFolder[]>([])
  const [fields, setFields] = useState<CustomFieldDefinition[]>([])
  const [activeFolder, setActiveFolder] = useState<FolderFilter>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingField, setEditingField] = useState<CustomFieldDefinition | null>(null)
  const [draft, setDraft] = useState<FieldDraft>(emptyDraft())
  const [keyTouched, setKeyTouched] = useState(false)

  const loadCatalog = async () => {
    setLoading(true)
    try {
      const catalog = await customFieldsService.listCatalog()
      setFolders(catalog.folders || [])
      setFields(catalog.fields || [])
    } catch (error) {
      showToast('error', 'No se pudieron cargar los campos', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadCatalog()
  }, [])

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
        field.description,
        field.folderName,
        getTypeLabel(field.dataType)
      ].some(value => String(value || '').toLowerCase().includes(query))
    })
  }, [activeFolder, fields, search])

  const openCreateEditor = () => {
    const folderId = activeFolder !== 'all' && activeFolder !== 'unfiled' ? activeFolder : ''
    setEditingField(null)
    setDraft(emptyDraft(folderId))
    setKeyTouched(false)
    setEditorOpen(true)
  }

  const openEditEditor = (field: CustomFieldDefinition) => {
    setEditingField(field)
    setDraft({
      label: field.label,
      fieldKey: field.fieldKey || field.key,
      description: field.description || '',
      dataType: field.dataType,
      folderId: field.folderId || '',
      optionsText: optionsToText(field.options)
    })
    setKeyTouched(true)
    setEditorOpen(true)
  }

  const closeEditor = () => {
    setEditorOpen(false)
    setEditingField(null)
    setDraft(emptyDraft())
    setKeyTouched(false)
  }

  const patchDraft = (patch: Partial<FieldDraft>) => {
    setDraft(current => ({ ...current, ...patch }))
  }

  const handleLabelChange = (value: string) => {
    setDraft(current => ({
      ...current,
      label: value,
      fieldKey: keyTouched ? current.fieldKey : normalizeFieldKey(value)
    }))
  }

  const buildPayload = (): SaveCustomFieldInput | null => {
    const label = draft.label.trim()
    const fieldKey = normalizeFieldKey(draft.fieldKey || draft.label)
    const options = choiceTypes.has(draft.dataType) ? optionLinesToOptions(draft.optionsText) : []

    if (!label) {
      showToast('warning', 'Falta nombre', 'Ponle un nombre al campo.')
      return null
    }

    if (!fieldKey) {
      showToast('warning', 'Falta ID', 'El ID sirve para guardar el dato dentro del contacto.')
      return null
    }

    if (choiceTypes.has(draft.dataType) && options.length === 0) {
      showToast('warning', 'Faltan opciones', 'Agrega al menos una opcion para este tipo de campo.')
      return null
    }

    return {
      label,
      fieldKey,
      dataType: draft.dataType,
      description: draft.description.trim(),
      folderId: draft.folderId || undefined,
      fieldGroup: draft.folderId ? getFolderName(folders, draft.folderId) : 'general',
      options,
      syncTarget: 'local'
    }
  }

  const handleSaveField = async () => {
    const payload = buildPayload()
    if (!payload) return

    setSaving(true)
    try {
      if (editingField) {
        await customFieldsService.updateField(editingField.definitionId, payload)
        showToast('success', 'Campo actualizado', 'Ya quedo guardado.')
      } else {
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
    const name = folderName.trim()
    if (!name) return

    setCreatingFolder(true)
    try {
      const folder = await customFieldsService.createFolder({ name })
      setFolders(current => [...current, folder])
      setFolderName('')
      setActiveFolder(folder.id)
      showToast('success', 'Carpeta creada', 'Ya puedes guardar campos ahi.')
    } catch (error) {
      showToast('error', 'No se pudo crear la carpeta', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setCreatingFolder(false)
    }
  }

  const handleArchiveFolder = (folder: CustomFieldFolder) => {
    showConfirm(
      'Archivar carpeta',
      `Los campos dentro de "${folder.name}" no se eliminan; solo quedan sin carpeta.`,
      () => {
        const archive = async () => {
          try {
            await customFieldsService.archiveFolder(folder.id)
            if (activeFolder === folder.id) setActiveFolder('all')
            await loadCatalog()
            showToast('success', 'Carpeta archivada', 'Los campos se conservaron.')
          } catch (error) {
            showToast('error', 'No se pudo archivar', error instanceof Error ? error.message : 'Intenta otra vez')
          }
        }
        void archive()
      },
      'Archivar',
      'Cancelar'
    )
  }

  const handleArchiveField = (field: CustomFieldDefinition) => {
    showConfirm(
      'Archivar campo',
      `El campo "${field.label}" dejara de aparecer como opcion nueva. Los datos ya guardados se conservan.`,
      () => {
        const archive = async () => {
          try {
            await customFieldsService.archiveField(field.definitionId)
            await loadCatalog()
            showToast('success', 'Campo archivado', 'Ya no aparece como opcion activa.')
          } catch (error) {
            showToast('error', 'No se pudo archivar', error instanceof Error ? error.message : 'Intenta otra vez')
          }
        }
        void archive()
      },
      'Archivar',
      'Cancelar'
    )
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Sistema</p>
          <h2>Campos personalizados</h2>
          <span>Define donde se guardan datos extra de formularios, embudos y contactos.</span>
        </div>
        <Button onClick={openCreateEditor} leftIcon={<Plus size={16} />}>
          Nuevo campo
        </Button>
      </header>

      <div className={styles.layout}>
        <aside className={styles.folders} aria-label="Carpetas de campos personalizados">
          <div className={styles.folderHeader}>
            <strong>Carpetas</strong>
            <span>{folders.length} activas</span>
          </div>

          <button
            type="button"
            className={`${styles.folderItem} ${activeFolder === 'all' ? styles.folderItemActive : ''}`}
            onClick={() => setActiveFolder('all')}
          >
            <Folder size={16} />
            <span>Todos los campos</span>
            <b>{fields.length}</b>
          </button>

          <button
            type="button"
            className={`${styles.folderItem} ${activeFolder === 'unfiled' ? styles.folderItemActive : ''}`}
            onClick={() => setActiveFolder('unfiled')}
          >
            <Hash size={16} />
            <span>Sin carpeta</span>
            <b>{folderCounts.get('unfiled') || 0}</b>
          </button>

          <div className={styles.folderList}>
            {folders.map(folder => (
              <div key={folder.id} className={`${styles.folderRow} ${activeFolder === folder.id ? styles.folderRowActive : ''}`}>
                <button type="button" onClick={() => setActiveFolder(folder.id)}>
                  <Folder size={16} />
                  <span>{folder.name}</span>
                  <b>{folderCounts.get(folder.id) || 0}</b>
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={`Archivar ${folder.name}`}
                  title="Archivar carpeta"
                  onClick={() => handleArchiveFolder(folder)}
                >
                  <Archive size={14} />
                </button>
              </div>
            ))}
          </div>

          <div className={styles.newFolder}>
            <input
              value={folderName}
              placeholder="Nueva carpeta"
              onChange={(event) => setFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleCreateFolder()
              }}
            />
            <button
              type="button"
              disabled={!folderName.trim() || creatingFolder}
              onClick={() => void handleCreateFolder()}
              aria-label="Crear carpeta"
              title="Crear carpeta"
            >
              {creatingFolder ? <Loader2 size={15} className={styles.spin} /> : <FolderPlus size={15} />}
            </button>
          </div>
        </aside>

        <main className={styles.tablePanel}>
          <div className={styles.toolbar}>
            <label className={styles.search}>
              <Search size={16} />
              <input value={search} placeholder="Buscar por nombre, ID o tipo" onChange={(event) => setSearch(event.target.value)} />
            </label>
            <span>{visibleFields.length} campos</span>
          </div>

          {loading ? (
            <div className={styles.loadingState}>
              <Loader2 className={styles.spin} size={22} />
              <span>Cargando campos...</span>
            </div>
          ) : visibleFields.length === 0 ? (
            <div className={styles.emptyState}>
              <Hash size={26} />
              <strong>No hay campos en esta vista</strong>
              <span>Crea un campo nuevo o cambia de carpeta.</span>
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Campo</th>
                    <th>ID</th>
                    <th>Tipo</th>
                    <th>Carpeta</th>
                    <th>Opciones</th>
                    <th>Origen</th>
                    <th aria-label="Acciones" />
                  </tr>
                </thead>
                <tbody>
                  {visibleFields.map(field => (
                    <tr key={field.definitionId}>
                      <td>
                        <strong>{field.label}</strong>
                        {field.description && <span>{field.description}</span>}
                      </td>
                      <td><code>{field.fieldKey || field.key}</code></td>
                      <td><span className={styles.typePill}>{getTypeLabel(field.dataType)}</span></td>
                      <td>{field.folderName || getFolderName(folders, field.folderId)}</td>
                      <td>{field.options?.length ? `${field.options.length} opciones` : '-'}</td>
                      <td>{getSourceLabel(field.sourceType)}</td>
                      <td>
                        <div className={styles.rowActions}>
                          <button type="button" onClick={() => openEditEditor(field)} aria-label={`Editar ${field.label}`} title="Editar">
                            <Edit3 size={15} />
                          </button>
                          <button type="button" onClick={() => handleArchiveField(field)} aria-label={`Archivar ${field.label}`} title="Archivar">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>
      </div>

      {editorOpen && (
        <div className={styles.editorOverlay} role="dialog" aria-modal="true" aria-labelledby="custom-field-editor-title">
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
              </label>

              <label className={styles.field}>
                <span>ID del campo</span>
                <input
                  value={draft.fieldKey}
                  placeholder="presupuesto_mensual"
                  onChange={(event) => {
                    setKeyTouched(true)
                    patchDraft({ fieldKey: normalizeFieldKey(event.target.value) })
                  }}
                />
                <small>Este ID es el nombre interno para guardar el valor.</small>
              </label>

              <label className={styles.field}>
                <span>Tipo</span>
                <select value={draft.dataType} onChange={(event) => patchDraft({ dataType: event.target.value as CustomFieldDataType })}>
                  {fieldTypes.map(type => (
                    <option key={type.value} value={type.value}>{type.label}</option>
                  ))}
                </select>
              </label>

              <div className={styles.typeHint}>
                <ChevronRight size={15} />
                <span>{fieldTypes.find(type => type.value === draft.dataType)?.detail}</span>
              </div>

              <label className={styles.field}>
                <span>Carpeta</span>
                <select value={draft.folderId} onChange={(event) => patchDraft({ folderId: event.target.value })}>
                  <option value="">Sin carpeta</option>
                  {folders.map(folder => (
                    <option key={folder.id} value={folder.id}>{folder.name}</option>
                  ))}
                </select>
              </label>

              <label className={styles.field}>
                <span>Descripcion opcional</span>
                <textarea
                  rows={3}
                  value={draft.description}
                  placeholder="Para que el equipo sepa cuando usarlo."
                  onChange={(event) => patchDraft({ description: event.target.value })}
                />
              </label>

              {choiceTypes.has(draft.dataType) && (
                <label className={styles.field}>
                  <span>Opciones</span>
                  <textarea
                    rows={5}
                    value={draft.optionsText}
                    placeholder={'Opcion 1\nOpcion 2\nOpcion 3'}
                    onChange={(event) => patchDraft({ optionsText: event.target.value })}
                  />
                  <small>Una opcion por linea.</small>
                </label>
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
    </div>
  )
}
