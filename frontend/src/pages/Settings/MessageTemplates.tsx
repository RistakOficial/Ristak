import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Check,
  Copy,
  Edit3,
  Eye,
  File,
  FileText,
  Folder,
  FolderPlus,
  Globe2,
  Image,
  ListTree,
  MapPin,
  MessageSquare,
  MousePointerClick,
  Phone,
  Plus,
  Save,
  Search,
  Tags,
  Trash2,
  Type,
  Video,
  X
} from 'lucide-react'
import { Button, Loading } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import {
  messageTemplatesService,
  type MessageTemplate,
  type MessageTemplateBundle,
  type MessageTemplateButton,
  type MessageTemplateButtonType,
  type MessageTemplateCategory,
  type MessageTemplateHeaderType,
  type MessageTemplatePayload,
  type MessageTemplateStatus,
  type MessageTemplateVariable
} from '@/services/messageTemplatesService'
import styles from './MessageTemplates.module.css'

const ROOT_FOLDER_KEY = '__root__'
const VARIABLE_PATTERN = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g

const emptyLocation = {
  latitude: '',
  longitude: '',
  name: '',
  address: ''
}

const categoryOptions: Array<{ value: MessageTemplateCategory; label: string }> = [
  { value: 'utility', label: 'Utilidad' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'authentication', label: 'Autenticación' },
  { value: 'service', label: 'Servicio' }
]

const languageOptions = [
  { value: 'es_MX', label: 'Español México' },
  { value: 'es', label: 'Español' },
  { value: 'en_US', label: 'Inglés Estados Unidos' }
]

const statusOptions: Array<{ value: MessageTemplateStatus; label: string }> = [
  { value: 'draft', label: 'Borrador' },
  { value: 'active', label: 'Lista' },
  { value: 'archived', label: 'Archivada' }
]

const headerTypeOptions: Array<{ value: MessageTemplateHeaderType; label: string; icon: React.ReactNode }> = [
  { value: 'text', label: 'Texto', icon: <Type size={18} /> },
  { value: 'image', label: 'Imagen', icon: <Image size={18} /> },
  { value: 'video', label: 'Video', icon: <Video size={18} /> },
  { value: 'document', label: 'Documento', icon: <File size={18} /> },
  { value: 'location', label: 'Ubicación', icon: <MapPin size={18} /> }
]

const buttonTypeOptions: Array<{ value: MessageTemplateButtonType; label: string; icon: React.ReactNode }> = [
  { value: 'quick_reply', label: 'Respuesta', icon: <MousePointerClick size={15} /> },
  { value: 'website', label: 'Sitio web', icon: <Globe2 size={15} /> },
  { value: 'phone', label: 'Teléfono', icon: <Phone size={15} /> },
  { value: 'whatsapp_call', label: 'WhatsApp call', icon: <MessageSquare size={15} /> }
]

function createEmptyDraft(folderId: string | null): MessageTemplatePayload {
  return {
    folderId,
    name: '',
    description: '',
    category: 'utility',
    language: 'es_MX',
    status: 'draft',
    headerEnabled: false,
    headerType: 'none',
    headerText: '',
    headerMediaUrl: '',
    headerLocation: { ...emptyLocation },
    bodyText: '',
    footerText: '',
    buttons: [],
    variableExamples: {},
    ycloudTemplateId: null,
    ycloudStatus: null
  }
}

function templateToDraft(template: MessageTemplate): MessageTemplatePayload {
  return {
    folderId: template.folderId || null,
    name: template.name,
    description: template.description || '',
    category: template.category,
    language: template.language,
    status: template.status,
    headerEnabled: template.headerEnabled,
    headerType: template.headerType,
    headerText: template.headerText || '',
    headerMediaUrl: template.headerMediaUrl || '',
    headerLocation: template.headerLocation || { ...emptyLocation },
    bodyText: template.bodyText,
    footerText: template.footerText || '',
    buttons: template.buttons || [],
    variableExamples: template.variableExamples || {},
    ycloudTemplateId: template.ycloudTemplateId || null,
    ycloudStatus: template.ycloudStatus || null
  }
}

function normalizeTemplateNameInput(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
}

function normalizeFieldKeyInput(value: string) {
  return normalizeTemplateNameInput(value).slice(0, 80)
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function appendVariable(text: string | undefined, mergeField: string) {
  const current = text || ''
  return current ? `${current} ${mergeField}` : mergeField
}

function extractVariablesFromText(text: string | undefined, targetSet: Set<string>) {
  if (!text) return
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const key = match[1]?.trim()
    if (key) targetSet.add(`{{${key}}}`)
  }
}

function getStatusLabel(status: MessageTemplateStatus) {
  return statusOptions.find((option) => option.value === status)?.label || status
}

function getCategoryLabel(category: MessageTemplateCategory) {
  return categoryOptions.find((option) => option.value === category)?.label || category
}

export const MessageTemplates: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [bundle, setBundle] = useState<MessageTemplateBundle>({
    folders: [],
    templates: [],
    customFields: [],
    variables: []
  })
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'list' | 'editor'>('list')
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [draft, setDraft] = useState<MessageTemplatePayload>(() => createEmptyDraft(null))
  const [searchTerm, setSearchTerm] = useState('')
  const [saving, setSaving] = useState(false)
  const [showFolderForm, setShowFolderForm] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [showCustomFieldForm, setShowCustomFieldForm] = useState(false)
  const [customFieldDraft, setCustomFieldDraft] = useState({ name: '', fieldKey: '', example: '' })
  const [creatingCustomField, setCreatingCustomField] = useState(false)
  const [activeTextTarget, setActiveTextTarget] = useState<'headerText' | 'bodyText' | 'footerText'>('bodyText')

  useEffect(() => {
    loadBundle()
  }, [])

  const loadBundle = async () => {
    setLoading(true)
    try {
      const data = await messageTemplatesService.getBundle()
      setBundle(data)
    } catch (error) {
      showToast('error', 'Error', getErrorMessage(error, 'No se pudieron cargar las plantillas'))
    } finally {
      setLoading(false)
    }
  }

  const folderMap = useMemo(() => (
    new Map(bundle.folders.map((folder) => [folder.id, folder]))
  ), [bundle.folders])

  const folderOptions = useMemo(() => {
    const byParent = new Map<string, typeof bundle.folders>()
    for (const folder of bundle.folders) {
      const parentKey = folder.parentId || ROOT_FOLDER_KEY
      byParent.set(parentKey, [...(byParent.get(parentKey) || []), folder])
    }

    const rows: Array<{ id: string; label: string }> = []
    const walk = (parentId: string, depth: number) => {
      const children = byParent.get(parentId) || []
      for (const child of children) {
        rows.push({ id: child.id, label: `${'  '.repeat(depth)}${depth ? '↳ ' : ''}${child.name}` })
        walk(child.id, depth + 1)
      }
    }

    walk(ROOT_FOLDER_KEY, 0)
    return rows
  }, [bundle.folders])

  const activeTrail = useMemo(() => {
    const trail = []
    const visited = new Set<string>()
    let cursor = activeFolderId

    while (cursor && !visited.has(cursor)) {
      visited.add(cursor)
      const folder = folderMap.get(cursor)
      if (!folder) break
      trail.unshift(folder)
      cursor = folder.parentId || null
    }

    return trail
  }, [activeFolderId, folderMap])

  const currentFolders = useMemo(() => {
    const query = searchTerm.trim().toLowerCase()
    if (query) {
      return bundle.folders.filter((folder) => folder.name.toLowerCase().includes(query))
    }
    return bundle.folders.filter((folder) => (folder.parentId || null) === activeFolderId)
  }, [activeFolderId, bundle.folders, searchTerm])

  const visibleTemplates = useMemo(() => {
    const query = searchTerm.trim().toLowerCase()
    return bundle.templates.filter((template) => {
      if (!query) return (template.folderId || null) === activeFolderId
      return [
        template.name,
        template.bodyText,
        template.headerText || '',
        template.footerText || ''
      ].some((value) => value.toLowerCase().includes(query))
    })
  }, [activeFolderId, bundle.templates, searchTerm])

  const templateCountsByFolder = useMemo(() => {
    const counts = new Map<string, number>()
    for (const template of bundle.templates) {
      if (!template.folderId) continue
      counts.set(template.folderId, (counts.get(template.folderId) || 0) + 1)
    }
    return counts
  }, [bundle.templates])

  const variableByMergeField = useMemo(() => (
    new Map(bundle.variables.map((variable) => [variable.mergeField, variable]))
  ), [bundle.variables])

  const variableGroups = useMemo(() => {
    const groups = new Map<string, MessageTemplateVariable[]>()
    for (const variable of bundle.variables) {
      groups.set(variable.group, [...(groups.get(variable.group) || []), variable])
    }
    return Array.from(groups.entries())
  }, [bundle.variables])

  const usedVariables = useMemo(() => {
    const variables = new Set<string>()
    extractVariablesFromText(draft.headerText, variables)
    extractVariablesFromText(draft.bodyText, variables)
    extractVariablesFromText(draft.footerText, variables)
    for (const button of draft.buttons || []) {
      extractVariablesFromText(button.label, variables)
      extractVariablesFromText(button.value, variables)
    }
    return Array.from(variables).sort((a, b) => a.localeCompare(b))
  }, [draft])

  const preview = useMemo(() => {
    const resolveText = (text?: string) => {
      if (!text) return ''
      return text.replace(VARIABLE_PATTERN, (fullMatch, key) => {
        const mergeField = `{{${key}}}`
        return draft.variableExamples?.[mergeField] ||
          draft.variableExamples?.[key] ||
          variableByMergeField.get(mergeField)?.example ||
          fullMatch
      })
    }

    return {
      headerText: resolveText(draft.headerText),
      bodyText: resolveText(draft.bodyText),
      footerText: resolveText(draft.footerText),
      buttons: (draft.buttons || []).map((button) => ({
        ...button,
        label: resolveText(button.label),
        value: resolveText(button.value)
      }))
    }
  }, [draft, variableByMergeField])

  const updateDraft = <K extends keyof MessageTemplatePayload>(key: K, value: MessageTemplatePayload[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const startNewTemplate = () => {
    setSelectedTemplateId(null)
    setDraft(createEmptyDraft(activeFolderId))
    setActiveTextTarget('bodyText')
    setView('editor')
  }

  const editTemplate = (template: MessageTemplate) => {
    setSelectedTemplateId(template.id)
    setDraft(templateToDraft(template))
    setActiveTextTarget('bodyText')
    setView('editor')
  }

  const saveTemplate = async () => {
    if (!draft.name.trim()) {
      showToast('warning', 'Nombre requerido', 'Escribe un nombre para la plantilla')
      return
    }
    if (!draft.bodyText.trim()) {
      showToast('warning', 'Cuerpo requerido', 'Escribe el mensaje principal')
      return
    }

    setSaving(true)
    try {
      const payload: MessageTemplatePayload = {
        ...draft,
        name: normalizeTemplateNameInput(draft.name),
        folderId: draft.folderId || null,
        headerType: draft.headerEnabled ? draft.headerType : 'none',
        headerText: draft.headerEnabled && draft.headerType === 'text' ? draft.headerText : '',
        headerMediaUrl: draft.headerEnabled ? draft.headerMediaUrl : '',
        headerLocation: draft.headerEnabled ? draft.headerLocation : { ...emptyLocation },
        buttons: (draft.buttons || []).map((button) => ({
          ...button,
          label: button.label.trim(),
          value: button.value?.trim() || ''
        })).filter((button) => button.label)
      }

      const saved = selectedTemplateId
        ? await messageTemplatesService.updateTemplate(selectedTemplateId, payload)
        : await messageTemplatesService.createTemplate(payload)

      setSelectedTemplateId(saved.id)
      setDraft(templateToDraft(saved))
      setActiveFolderId(saved.folderId || null)
      await loadBundle()
      showToast('success', 'Plantilla guardada', `${saved.name} quedó lista`)
    } catch (error) {
      showToast('error', 'No se pudo guardar', getErrorMessage(error, 'Revisa la plantilla'))
    } finally {
      setSaving(false)
    }
  }

  const confirmDeleteTemplate = (template: MessageTemplate) => {
    showConfirm(
      'Eliminar plantilla',
      `Se eliminará ${template.name}.`,
      async () => {
        try {
          await messageTemplatesService.deleteTemplate(template.id)
          await loadBundle()
          showToast('success', 'Plantilla eliminada', template.name)
        } catch (error) {
          showToast('error', 'No se pudo eliminar', getErrorMessage(error, 'Intenta nuevamente'))
        }
      },
      'Eliminar',
      'Cancelar'
    )
  }

  const submitFolder = async () => {
    if (!folderName.trim()) {
      showToast('warning', 'Nombre requerido', 'Escribe un nombre para la carpeta')
      return
    }

    setCreatingFolder(true)
    try {
      await messageTemplatesService.createFolder({
        name: folderName.trim(),
        parentId: activeFolderId
      })
      setFolderName('')
      setShowFolderForm(false)
      await loadBundle()
      showToast('success', activeFolderId ? 'Subcarpeta creada' : 'Carpeta creada', folderName.trim())
    } catch (error) {
      showToast('error', 'No se pudo crear', getErrorMessage(error, 'Intenta nuevamente'))
    } finally {
      setCreatingFolder(false)
    }
  }

  const confirmDeleteFolder = (folderId: string) => {
    const folder = folderMap.get(folderId)
    if (!folder) return

    showConfirm(
      'Eliminar carpeta',
      `Las plantillas dentro de ${folder.name} quedarán sueltas.`,
      async () => {
        try {
          await messageTemplatesService.deleteFolder(folder.id)
          if (activeFolderId === folder.id) setActiveFolderId(folder.parentId || null)
          await loadBundle()
          showToast('success', 'Carpeta eliminada', folder.name)
        } catch (error) {
          showToast('error', 'No se pudo eliminar', getErrorMessage(error, 'Intenta nuevamente'))
        }
      },
      'Eliminar',
      'Cancelar'
    )
  }

  const submitCustomField = async () => {
    if (!customFieldDraft.name.trim()) {
      showToast('warning', 'Nombre requerido', 'Escribe un nombre para el campo')
      return
    }

    setCreatingCustomField(true)
    try {
      await messageTemplatesService.createCustomField({
        name: customFieldDraft.name.trim(),
        fieldKey: customFieldDraft.fieldKey.trim(),
        example: customFieldDraft.example.trim(),
        dataType: 'text'
      })
      setCustomFieldDraft({ name: '', fieldKey: '', example: '' })
      setShowCustomFieldForm(false)
      await loadBundle()
      showToast('success', 'Variable creada', customFieldDraft.name.trim())
    } catch (error) {
      showToast('error', 'No se pudo crear', getErrorMessage(error, 'Intenta nuevamente'))
    } finally {
      setCreatingCustomField(false)
    }
  }

  const confirmDeleteCustomField = (id: string) => {
    const field = bundle.customFields.find((item) => item.id === id)
    if (!field) return

    showConfirm(
      'Eliminar variable',
      `Se eliminará ${field.name} del catálogo.`,
      async () => {
        try {
          await messageTemplatesService.deleteCustomField(id)
          await loadBundle()
          showToast('success', 'Variable eliminada', field.name)
        } catch (error) {
          showToast('error', 'No se pudo eliminar', getErrorMessage(error, 'Intenta nuevamente'))
        }
      },
      'Eliminar',
      'Cancelar'
    )
  }

  const insertVariable = (variable: MessageTemplateVariable) => {
    setDraft((current) => ({
      ...current,
      [activeTextTarget]: appendVariable(String(current[activeTextTarget] || ''), variable.mergeField)
    }))
  }

  const copyMergeField = async (variable: MessageTemplateVariable) => {
    try {
      await navigator.clipboard.writeText(variable.mergeField)
      showToast('success', 'Copiado', variable.mergeField)
    } catch {
      showToast('error', 'No se pudo copiar', variable.mergeField)
    }
  }

  const addButton = () => {
    if ((draft.buttons || []).length >= 10) {
      showToast('warning', 'Límite de botones', 'Puedes agregar hasta 10 botones')
      return
    }

    updateDraft('buttons', [
      ...(draft.buttons || []),
      {
        id: `local_${Date.now()}`,
        type: 'quick_reply',
        label: 'Confirmar',
        value: ''
      }
    ])
  }

  const updateButton = (index: number, nextButton: Partial<MessageTemplateButton>) => {
    updateDraft('buttons', (draft.buttons || []).map((button, buttonIndex) => (
      buttonIndex === index ? { ...button, ...nextButton } : button
    )))
  }

  const removeButton = (index: number) => {
    updateDraft('buttons', (draft.buttons || []).filter((_, buttonIndex) => buttonIndex !== index))
  }

  const renderVariablesPanel = () => (
    <aside className={styles.variablesPanel}>
      <div className={styles.panelTitle}>
        <Tags size={17} />
        <span>Variables</span>
      </div>

      {showCustomFieldForm ? (
        <div className={styles.inlineForm}>
          <label>
            <span>Nombre</span>
            <input
              value={customFieldDraft.name}
              onChange={(event) => {
                const name = event.target.value
                setCustomFieldDraft((current) => ({
                  ...current,
                  name,
                  fieldKey: current.fieldKey ? current.fieldKey : normalizeFieldKeyInput(name)
                }))
              }}
              placeholder="Fecha de cita"
            />
          </label>
          <label>
            <span>Llave</span>
            <input
              value={customFieldDraft.fieldKey}
              onChange={(event) => setCustomFieldDraft((current) => ({
                ...current,
                fieldKey: normalizeFieldKeyInput(event.target.value)
              }))}
              placeholder="fecha_de_cita"
            />
          </label>
          <label>
            <span>Ejemplo</span>
            <input
              value={customFieldDraft.example}
              onChange={(event) => setCustomFieldDraft((current) => ({
                ...current,
                example: event.target.value
              }))}
              placeholder="11 de marzo"
            />
          </label>
          <div className={styles.inlineActions}>
            <Button variant="ghost" size="sm" onClick={() => setShowCustomFieldForm(false)} disabled={creatingCustomField}>
              <X size={15} />
              Cancelar
            </Button>
            <Button size="sm" onClick={submitCustomField} loading={creatingCustomField}>
              <Check size={15} />
              Crear
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setShowCustomFieldForm(true)}>
          <Plus size={15} />
          Campo personalizado
        </Button>
      )}

      <div className={styles.variableGroups}>
        {variableGroups.map(([group, variables]) => (
          <div key={group} className={styles.variableGroup}>
            <strong>{group}</strong>
            {variables.map((variable) => (
              <div key={variable.mergeField} className={styles.variableRow}>
                <button type="button" onClick={() => insertVariable(variable)}>
                  <span>{variable.label}</span>
                  <code>{variable.mergeField}</code>
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => copyMergeField(variable)}
                  aria-label={`Copiar ${variable.mergeField}`}
                  title="Copiar"
                >
                  <Copy size={14} />
                </button>
                {variable.source === 'custom' && variable.fieldKey && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    onClick={() => {
                      const field = bundle.customFields.find((item) => item.fieldKey === variable.fieldKey)
                      if (field) confirmDeleteCustomField(field.id)
                    }}
                    aria-label={`Eliminar ${variable.mergeField}`}
                    title="Eliminar"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  )

  const renderPreviewHeader = () => {
    if (!draft.headerEnabled || draft.headerType === 'none') return null

    if (draft.headerType === 'text') {
      return preview.headerText ? <strong className={styles.previewHeaderText}>{preview.headerText}</strong> : null
    }

    if (draft.headerType === 'location') {
      return (
        <div className={styles.previewLocation}>
          <MapPin size={30} />
          <span>{draft.headerLocation.name || 'Ubicación'}</span>
          <small>{draft.headerLocation.address || `${draft.headerLocation.latitude || '0'}, ${draft.headerLocation.longitude || '0'}`}</small>
        </div>
      )
    }

    const icon = draft.headerType === 'image'
      ? <Image size={28} />
      : draft.headerType === 'video'
        ? <Video size={28} />
        : <File size={28} />

    return (
      <div className={styles.previewMedia}>
        {icon}
        <span>{draft.headerMediaUrl || draft.headerType}</span>
      </div>
    )
  }

  const renderPreview = () => (
    <aside className={styles.previewPanel}>
      <div className={styles.previewTitle}>
        <Eye size={17} />
        <span>Preview</span>
      </div>
      <div className={styles.phonePreview}>
        <div className={styles.chatBubble}>
          {renderPreviewHeader()}
          <p className={styles.previewBody}>{preview.bodyText || 'El mensaje aparecerá aquí'}</p>
          {preview.footerText && <small className={styles.previewFooter}>{preview.footerText}</small>}
          <span className={styles.previewTime}>11:48</span>
        </div>
        {preview.buttons.length > 0 && (
          <div className={styles.previewButtons}>
            {preview.buttons.map((button, index) => (
              <span key={`${button.id || index}-${button.label}`}>
                {button.type === 'website' ? <Globe2 size={14} /> : button.type === 'phone' ? <Phone size={14} /> : <MousePointerClick size={14} />}
                {button.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </aside>
  )

  const renderList = () => (
    <div className={styles.managerGrid}>
      <section className={styles.listPanel}>
        <div className={styles.toolbar}>
          <div className={styles.searchBox}>
            <Search size={16} />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Buscar plantilla o carpeta"
            />
          </div>
          <Button variant="outline" onClick={() => {
            setFolderName('')
            setShowFolderForm((current) => !current)
          }}>
            <FolderPlus size={16} />
            {activeFolderId ? 'Subcarpeta' : 'Carpeta'}
          </Button>
          <Button onClick={startNewTemplate}>
            <Plus size={16} />
            Plantilla
          </Button>
        </div>

        <div className={styles.breadcrumbs}>
          <button type="button" onClick={() => setActiveFolderId(null)}>Inicio</button>
          {activeTrail.map((folder) => (
            <React.Fragment key={folder.id}>
              <span>/</span>
              <button type="button" onClick={() => setActiveFolderId(folder.id)}>{folder.name}</button>
            </React.Fragment>
          ))}
        </div>

        {showFolderForm && (
          <div className={styles.folderForm}>
            <FolderPlus size={18} />
            <input
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              placeholder={activeFolderId ? 'Nombre de la subcarpeta' : 'Nombre de la carpeta'}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitFolder()
              }}
            />
            <Button variant="ghost" size="sm" onClick={() => setShowFolderForm(false)} disabled={creatingFolder}>
              <X size={15} />
            </Button>
            <Button size="sm" onClick={submitFolder} loading={creatingFolder}>
              <Check size={15} />
              Crear
            </Button>
          </div>
        )}

        <div className={styles.collectionList}>
          {currentFolders.map((folder) => (
            <article key={folder.id} className={styles.collectionItem}>
              <button type="button" className={styles.itemMain} onClick={() => {
                setActiveFolderId(folder.id)
                setSearchTerm('')
              }}>
                <span className={styles.folderIcon}><Folder size={18} /></span>
                <span>
                  <strong>{folder.name}</strong>
                  <small>{templateCountsByFolder.get(folder.id) || 0} plantillas</small>
                </span>
              </button>
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => confirmDeleteFolder(folder.id)}
                aria-label={`Eliminar ${folder.name}`}
                title="Eliminar"
              >
                <Trash2 size={15} />
              </button>
            </article>
          ))}

          {visibleTemplates.map((template) => (
            <article key={template.id} className={styles.collectionItem}>
              <button type="button" className={styles.itemMain} onClick={() => editTemplate(template)}>
                <span className={styles.templateIcon}><FileText size={18} /></span>
                <span>
                  <strong>{template.name}</strong>
                  <small>{getCategoryLabel(template.category)} · {template.language} · {getStatusLabel(template.status)}</small>
                </span>
              </button>
              <div className={styles.itemActions}>
                <button type="button" className={styles.iconButton} onClick={() => editTemplate(template)} aria-label={`Editar ${template.name}`} title="Editar">
                  <Edit3 size={15} />
                </button>
                <button type="button" className={styles.iconButton} onClick={() => confirmDeleteTemplate(template)} aria-label={`Eliminar ${template.name}`} title="Eliminar">
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))}

          {!currentFolders.length && !visibleTemplates.length && (
            <div className={styles.emptyState}>
              <ListTree size={28} />
              <strong>Sin plantillas</strong>
            </div>
          )}
        </div>
      </section>

      {renderVariablesPanel()}
    </div>
  )

  const renderHeaderFields = () => {
    if (!draft.headerEnabled) return null

    return (
      <>
        <div className={styles.headerTypeGrid}>
          {headerTypeOptions.map((option) => (
            <button
              type="button"
              key={option.value}
              className={`${styles.headerTypeButton} ${draft.headerType === option.value ? styles.headerTypeButtonActive : ''}`}
              onClick={() => updateDraft('headerType', option.value)}
            >
              {option.icon}
              <span>{option.label}</span>
            </button>
          ))}
        </div>

        {draft.headerType === 'text' && (
          <label className={styles.field}>
            <span>Cuerpo del encabezado</span>
            <input
              value={draft.headerText || ''}
              onFocus={() => setActiveTextTarget('headerText')}
              onChange={(event) => updateDraft('headerText', event.target.value.slice(0, 60))}
              placeholder="Hola {{contact.first_name}}"
            />
          </label>
        )}

        {['image', 'video', 'document'].includes(draft.headerType) && (
          <label className={styles.field}>
            <span>URL del archivo</span>
            <input
              value={draft.headerMediaUrl || ''}
              onChange={(event) => updateDraft('headerMediaUrl', event.target.value)}
              placeholder="https://..."
            />
          </label>
        )}

        {draft.headerType === 'location' && (
          <div className={styles.locationGrid}>
            <label className={styles.field}>
              <span>Latitud</span>
              <input
                value={draft.headerLocation.latitude}
                onChange={(event) => updateDraft('headerLocation', { ...draft.headerLocation, latitude: event.target.value })}
                placeholder="28.612195"
              />
            </label>
            <label className={styles.field}>
              <span>Longitud</span>
              <input
                value={draft.headerLocation.longitude}
                onChange={(event) => updateDraft('headerLocation', { ...draft.headerLocation, longitude: event.target.value })}
                placeholder="-106.12195"
              />
            </label>
            <label className={styles.field}>
              <span>Nombre</span>
              <input
                value={draft.headerLocation.name}
                onChange={(event) => updateDraft('headerLocation', { ...draft.headerLocation, name: event.target.value })}
                placeholder="Consultorio"
              />
            </label>
            <label className={styles.field}>
              <span>Dirección</span>
              <input
                value={draft.headerLocation.address}
                onChange={(event) => updateDraft('headerLocation', { ...draft.headerLocation, address: event.target.value })}
                placeholder="Calle 123"
              />
            </label>
          </div>
        )}
      </>
    )
  }

  const renderEditor = () => (
    <div className={styles.editorGrid}>
      <section className={styles.editorPanel}>
        <div className={styles.editorActions}>
          <Button variant="ghost" onClick={() => setView('list')}>
            <ArrowLeft size={16} />
            Atrás
          </Button>
          <Button onClick={saveTemplate} loading={saving}>
            <Save size={16} />
            Guardar
          </Button>
        </div>

        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>Nombre</span>
            <input
              value={draft.name}
              onChange={(event) => updateDraft('name', normalizeTemplateNameInput(event.target.value))}
              placeholder="recordatorio_cita"
            />
          </label>
          <label className={styles.field}>
            <span>Categoría</span>
            <select value={draft.category} onChange={(event) => updateDraft('category', event.target.value as MessageTemplateCategory)}>
              {categoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>Idioma</span>
            <select value={draft.language} onChange={(event) => updateDraft('language', event.target.value)}>
              {languageOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>Carpeta</span>
            <select value={draft.folderId || ''} onChange={(event) => updateDraft('folderId', event.target.value || null)}>
              <option value="">Sin carpeta</option>
              {folderOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>Estado</span>
            <select value={draft.status} onChange={(event) => updateDraft('status', event.target.value as MessageTemplateStatus)}>
              {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>Descripción</span>
            <input
              value={draft.description || ''}
              onChange={(event) => updateDraft('description', event.target.value)}
              placeholder="Recordatorio antes de cita"
            />
          </label>
        </div>

        <div className={styles.formSection}>
          <label className={styles.switchRow}>
            <input
              type="checkbox"
              checked={draft.headerEnabled}
              onChange={(event) => {
                const enabled = event.target.checked
                updateDraft('headerEnabled', enabled)
                updateDraft('headerType', enabled ? 'text' : 'none')
              }}
            />
            <span>Mostrar encabezado</span>
          </label>
          {renderHeaderFields()}
        </div>

        <div className={styles.formSection}>
          <label className={styles.field}>
            <span>Cuerpo</span>
            <textarea
              value={draft.bodyText}
              onFocus={() => setActiveTextTarget('bodyText')}
              onChange={(event) => updateDraft('bodyText', event.target.value.slice(0, 1024))}
              placeholder="Qué onda {{contact.first_name}}, tu cita es para {{contact.custom.fecha_de_cita}}."
            />
          </label>
          <div className={styles.characterCount}>{draft.bodyText.length} / 1024</div>
        </div>

        <div className={styles.formSection}>
          <label className={styles.field}>
            <span>Pie de página</span>
            <input
              value={draft.footerText || ''}
              onFocus={() => setActiveTextTarget('footerText')}
              onChange={(event) => updateDraft('footerText', event.target.value.slice(0, 60))}
              placeholder="Mensaje automático"
            />
          </label>
          <div className={styles.characterCount}>{(draft.footerText || '').length} / 60</div>
        </div>

        <div className={styles.formSection}>
          <div className={styles.sectionHeading}>
            <strong>Botones</strong>
            <Button variant="outline" size="sm" onClick={addButton}>
              <Plus size={15} />
              Agregar
            </Button>
          </div>
          {(draft.buttons || []).length ? (
            <div className={styles.buttonsEditor}>
              {(draft.buttons || []).map((button, index) => (
                <div key={button.id || index} className={styles.buttonEditorRow}>
                  <select value={button.type} onChange={(event) => updateButton(index, { type: event.target.value as MessageTemplateButtonType })}>
                    {buttonTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <input
                    value={button.label}
                    onChange={(event) => updateButton(index, { label: event.target.value.slice(0, 25) })}
                    placeholder="Texto"
                  />
                  <input
                    value={button.value || ''}
                    onChange={(event) => updateButton(index, { value: event.target.value })}
                    placeholder={button.type === 'website' ? 'https://...' : button.type === 'phone' ? '+526561234567' : 'Valor'}
                  />
                  <button type="button" className={styles.iconButton} onClick={() => removeButton(index)} aria-label="Eliminar botón" title="Eliminar">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.subtleEmpty}>Sin botones</div>
          )}
        </div>

        <div className={styles.formSection}>
          <div className={styles.sectionHeading}>
            <strong>Ejemplos de variables</strong>
          </div>
          {usedVariables.length ? (
            <div className={styles.variableExamplesGrid}>
              {usedVariables.map((mergeField) => {
                const variable = variableByMergeField.get(mergeField)
                return (
                  <label key={mergeField} className={styles.field}>
                    <span>{variable?.label || mergeField}</span>
                    <input
                      value={draft.variableExamples?.[mergeField] || ''}
                      onChange={(event) => updateDraft('variableExamples', {
                        ...(draft.variableExamples || {}),
                        [mergeField]: event.target.value
                      })}
                      placeholder={variable?.example || mergeField}
                    />
                  </label>
                )
              })}
            </div>
          ) : (
            <div className={styles.subtleEmpty}>Sin variables en uso</div>
          )}
        </div>
      </section>

      <div className={styles.editorSide}>
        {renderPreview()}
        {renderVariablesPanel()}
      </div>
    </div>
  )

  if (loading) {
    return <Loading page="settings" />
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerIcon}>
          <MessageSquare size={26} />
        </div>
        <div>
          <h2>Plantillas</h2>
          <p>WhatsApp · Variables · YCloud</p>
        </div>
        <Button variant="secondary" onClick={loadBundle}>
          <ListTree size={16} />
          Refrescar
        </Button>
      </div>

      {view === 'list' ? renderList() : renderEditor()}
    </div>
  )
}
