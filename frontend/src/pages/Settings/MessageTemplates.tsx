import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  Check,
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
  RefreshCw,
  Save,
  Search,
  Send,
  Trash2,
  Type,
  UploadCloud,
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
  type MessageTemplateVariableBinding,
  type MessageTemplateVariableTarget
} from '@/services/messageTemplatesService'
import styles from './MessageTemplates.module.css'

const ROOT_FOLDER_KEY = '__root__'
const VARIABLE_PATTERN = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g
const META_VARIABLE_PATTERN = /{{\s*(\d+)\s*}}/g

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

type MessageTemplateDraft = MessageTemplatePayload & Partial<Pick<
  MessageTemplate,
  'ycloudReason' | 'ycloudStatusUpdateEvent' | 'ycloudQualityRating' | 'ycloudSubmittedAt' | 'ycloudSyncedAt' | 'lastError'
>>

function createEmptyDraft(folderId: string | null): MessageTemplateDraft {
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
    variableBindings: { headerText: {}, bodyText: {} },
    ycloudTemplateId: null,
    ycloudStatus: null
  }
}

function templateToDraft(template: MessageTemplate): MessageTemplateDraft {
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
    variableBindings: template.variableBindings || { headerText: {}, bodyText: {} },
    ycloudTemplateId: template.ycloudTemplateId || null,
    ycloudStatus: template.ycloudStatus || null,
    ycloudReason: template.ycloudReason || null,
    ycloudStatusUpdateEvent: template.ycloudStatusUpdateEvent || null,
    ycloudQualityRating: template.ycloudQualityRating || null,
    ycloudSubmittedAt: template.ycloudSubmittedAt || null,
    ycloudSyncedAt: template.ycloudSyncedAt || null,
    lastError: template.lastError || null
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

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function extractMetaVariableIndexes(text: string | undefined) {
  const indexes = new Set<number>()
  if (!text) return []

  for (const match of text.matchAll(META_VARIABLE_PATTERN)) {
    const index = Number(match[1])
    if (Number.isInteger(index) && index > 0) indexes.add(index)
  }

  return Array.from(indexes).sort((left, right) => left - right)
}

function getNextMetaVariable(text: string | undefined) {
  const indexes = extractMetaVariableIndexes(text)
  return indexes.length ? Math.max(...indexes) + 1 : 1
}

function appendMetaVariable(text: string | undefined) {
  const current = text || ''
  const variable = `{{${getNextMetaVariable(current)}}}`
  return current ? `${current} ${variable}` : variable
}

function getStatusLabel(status: MessageTemplateStatus) {
  return statusOptions.find((option) => option.value === status)?.label || status
}

function getCategoryLabel(category: MessageTemplateCategory) {
  return categoryOptions.find((option) => option.value === category)?.label || category
}

function getYCloudStatusTone(status?: string | null) {
  const normalized = (status || '').toUpperCase()
  if (normalized === 'APPROVED') return 'Success'
  if (normalized === 'REJECTED' || normalized === 'DISABLED' || normalized === 'PAUSED') return 'Danger'
  if (normalized === 'PENDING' || normalized === 'IN_APPEAL') return 'Warning'
  return 'Neutral'
}

function getYCloudStatusLabel(status?: string | null) {
  const normalized = (status || '').toUpperCase()
  if (!normalized) return 'Sin enviar'
  if (normalized === 'APPROVED') return 'Aprobada'
  if (normalized === 'REJECTED') return 'Rechazada'
  if (normalized === 'PENDING') return 'En revisión'
  if (normalized === 'PAUSED') return 'Pausada'
  if (normalized === 'DISABLED') return 'Deshabilitada'
  if (normalized === 'ARCHIVED') return 'Archivada'
  return normalized
}

interface MessageTemplatesProps {
  embedded?: boolean
  title?: string
  subtitle?: string
}

export const MessageTemplates: React.FC<MessageTemplatesProps> = ({
  embedded = false,
  title = 'Plantillas',
  subtitle = 'WhatsApp · Variables · YCloud'
}) => {
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
  const [draft, setDraft] = useState<MessageTemplateDraft>(() => createEmptyDraft(null))
  const [searchTerm, setSearchTerm] = useState('')
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [sendingTest, setSendingTest] = useState(false)
  const [testPhone, setTestPhone] = useState('')
  const [showFolderForm, setShowFolderForm] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)

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

  const variableByKey = useMemo(() => (
    new Map(bundle.variables.map((variable) => [variable.key, variable]))
  ), [bundle.variables])

  const preview = useMemo(() => {
    const resolveText = (text: string | undefined, target?: MessageTemplateVariableTarget) => {
      if (!text) return ''
      const withMetaVariables = target
        ? text.replace(META_VARIABLE_PATTERN, (fullMatch, key) => {
          const binding = draft.variableBindings?.[target]?.[key]
          return binding?.example || (binding?.variableKey ? variableByKey.get(binding.variableKey)?.example : '') || fullMatch
        })
        : text

      return withMetaVariables.replace(VARIABLE_PATTERN, (fullMatch, key) => {
        if (/^\d+$/.test(key)) return fullMatch
        const mergeField = `{{${key}}}`
        return draft.variableExamples?.[mergeField] ||
          draft.variableExamples?.[key] ||
          variableByMergeField.get(mergeField)?.example ||
          fullMatch
      })
    }

    return {
      headerText: resolveText(draft.headerText, 'headerText'),
      bodyText: resolveText(draft.bodyText, 'bodyText'),
      footerText: resolveText(draft.footerText),
      buttons: (draft.buttons || []).map((button) => ({
        ...button,
        label: resolveText(button.label),
        value: resolveText(button.value)
      }))
    }
  }, [draft, variableByKey, variableByMergeField])

  const updateDraft = <K extends keyof MessageTemplatePayload>(key: K, value: MessageTemplatePayload[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const startNewTemplate = () => {
    setSelectedTemplateId(null)
    setDraft(createEmptyDraft(activeFolderId))
    setTestPhone('')
    setView('editor')
  }

  const editTemplate = (template: MessageTemplate) => {
    setSelectedTemplateId(template.id)
    setDraft(templateToDraft(template))
    setTestPhone('')
    setView('editor')
  }

  const cleanBindingsForPayload = (payload: MessageTemplatePayload): MessageTemplatePayload => {
    const cleanTarget = (target: MessageTemplateVariableTarget) => {
      const indexes = extractMetaVariableIndexes(String(payload[target] || ''))
      const current = payload.variableBindings?.[target] || {}
      return Object.fromEntries(indexes.map((index) => {
        const key = String(index)
        return [key, current[key] || {}]
      }))
    }

    return {
      ...payload,
      variableBindings: {
        headerText: cleanTarget('headerText'),
        bodyText: cleanTarget('bodyText')
      }
    }
  }

  const saveDraft = async (options: { silent?: boolean } = {}) => {
    if (!draft.name.trim()) {
      showToast('warning', 'Nombre requerido', 'Escribe un nombre para la plantilla')
      return null
    }
    if (!draft.bodyText.trim()) {
      showToast('warning', 'Cuerpo requerido', 'Escribe el mensaje principal')
      return null
    }

    setSaving(true)
    try {
      const payload: MessageTemplatePayload = cleanBindingsForPayload({
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
      })

      const saved = selectedTemplateId
        ? await messageTemplatesService.updateTemplate(selectedTemplateId, payload)
        : await messageTemplatesService.createTemplate(payload)

      setSelectedTemplateId(saved.id)
      setDraft(templateToDraft(saved))
      setActiveFolderId(saved.folderId || null)
      await loadBundle()
      if (!options.silent) {
        showToast('success', 'Plantilla guardada', `${saved.name} quedó lista`)
      }
      return saved
    } catch (error) {
      showToast('error', 'No se pudo guardar', getErrorMessage(error, 'Revisa la plantilla'))
      return null
    } finally {
      setSaving(false)
    }
  }

  const saveTemplate = async () => {
    await saveDraft()
  }

  const submitTemplate = async () => {
    const saved = await saveDraft({ silent: true })
    if (!saved) return

    setSubmitting(true)
    try {
      const result = await messageTemplatesService.submitTemplate(saved.id)
      setSelectedTemplateId(result.template.id)
      setDraft(templateToDraft(result.template))
      await loadBundle()
      showToast('success', 'Enviada a revisión', result.message || 'YCloud recibio la plantilla')
    } catch (error) {
      await loadBundle()
      showToast('error', 'YCloud rechazo la plantilla', getErrorMessage(error, 'Revisa los errores de Meta/YCloud'))
    } finally {
      setSubmitting(false)
    }
  }

  const syncCurrentTemplate = async () => {
    if (!selectedTemplateId) {
      showToast('warning', 'Guarda primero', 'La plantilla debe existir antes de sincronizar')
      return
    }

    setSyncing(true)
    try {
      const result = await messageTemplatesService.syncTemplate(selectedTemplateId)
      setDraft(templateToDraft(result.template))
      await loadBundle()
      showToast('success', 'Estado sincronizado', result.message || 'YCloud respondio correctamente')
    } catch (error) {
      await loadBundle()
      showToast('error', 'No se pudo sincronizar', getErrorMessage(error, 'YCloud no regreso estado'))
    } finally {
      setSyncing(false)
    }
  }

  const syncAllTemplates = async () => {
    setSyncing(true)
    try {
      const data = await messageTemplatesService.syncAll()
      setBundle(data)
      showToast('success', 'Plantillas sincronizadas', 'Estados actualizados desde YCloud')
    } catch (error) {
      showToast('error', 'No se pudo sincronizar', getErrorMessage(error, 'Revisa la conexion con YCloud'))
    } finally {
      setSyncing(false)
    }
  }

  const sendTestTemplate = async () => {
    if (!selectedTemplateId) {
      showToast('warning', 'Guarda primero', 'La plantilla debe existir antes de enviar prueba')
      return
    }
    if (!testPhone.trim()) {
      showToast('warning', 'Número requerido', 'Escribe el número destino en formato internacional')
      return
    }

    setSendingTest(true)
    try {
      const result = await messageTemplatesService.sendTest(selectedTemplateId, { to: testPhone.trim() })
      showToast('success', 'Prueba enviada', result.message || 'WhatsApp Business acepto el envio')
    } catch (error) {
      await loadBundle()
      showToast('error', 'No se pudo enviar', getErrorMessage(error, 'Meta/YCloud rechazo el envio'))
    } finally {
      setSendingTest(false)
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

  const resolveVariableOption = (value: string) => {
    const query = value.trim().toLowerCase()
    if (!query) return null
    return bundle.variables.find((variable) => (
      variable.label.toLowerCase() === query ||
      variable.key.toLowerCase() === query ||
      variable.mergeField.toLowerCase() === query
    )) || null
  }

  const addMetaVariable = (target: MessageTemplateVariableTarget) => {
    setDraft((current) => {
      const nextText = appendMetaVariable(String(current[target] || ''))
      const index = String(getNextMetaVariable(String(current[target] || '')))
      return {
        ...current,
        [target]: nextText,
        variableBindings: {
          ...(current.variableBindings || { headerText: {}, bodyText: {} }),
          [target]: {
            ...(current.variableBindings?.[target] || {}),
            [index]: current.variableBindings?.[target]?.[index] || {}
          }
        }
      }
    })
  }

  const updateVariableBinding = (
    target: MessageTemplateVariableTarget,
    index: number,
    nextBinding: Partial<MessageTemplateVariableBinding>
  ) => {
    setDraft((current) => ({
      ...current,
      variableBindings: {
        ...(current.variableBindings || { headerText: {}, bodyText: {} }),
        [target]: {
          ...(current.variableBindings?.[target] || {}),
          [String(index)]: {
            ...(current.variableBindings?.[target]?.[String(index)] || {}),
            ...nextBinding
          }
        }
      }
    }))
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

  const renderVariableBindings = (target: MessageTemplateVariableTarget, text: string | undefined) => {
    const indexes = extractMetaVariableIndexes(text)
    if (!indexes.length) return null

    const datalistId = `template-variable-options-${target}`

    return (
      <div className={styles.variableBindings}>
        <datalist id={datalistId}>
          {bundle.variables.map((variable) => (
            <option key={variable.key} value={variable.label}>
              {variable.group}
            </option>
          ))}
        </datalist>

        {indexes.map((index) => {
          const binding = draft.variableBindings?.[target]?.[String(index)] || {}
          const selectedVariable = binding.variableKey ? variableByKey.get(binding.variableKey) : null
          const inputValue = binding.label || selectedVariable?.label || ''

          return (
            <div key={`${target}-${index}`} className={styles.variableBindingRow}>
              <strong>{`{{${index}}}`}</strong>
              <label>
                <span>Dato dinámico</span>
                <input
                  list={datalistId}
                  value={inputValue}
                  onChange={(event) => {
                    const value = event.target.value
                    const match = resolveVariableOption(value)
                    updateVariableBinding(target, index, {
                      label: value,
                      variableKey: match?.key || '',
                      mergeField: match?.mergeField || ''
                    })
                  }}
                  placeholder="Busca First Name, Email, Phone..."
                />
              </label>
              <label>
                <span>Ejemplo para Meta</span>
                <input
                  value={binding.example || ''}
                  onChange={(event) => updateVariableBinding(target, index, { example: event.target.value })}
                  placeholder={selectedVariable?.example || 'Jane'}
                />
              </label>
            </div>
          )
        })}
      </div>
    )
  }

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
          <Button variant="outline" onClick={syncAllTemplates} loading={syncing}>
            <RefreshCw size={16} />
            Sincronizar
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
                  <span className={`${styles.ycloudBadge} ${styles[`ycloudBadge${getYCloudStatusTone(template.ycloudStatus)}`]}`}>
                    {getYCloudStatusLabel(template.ycloudStatus)}
                  </span>
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
          <div className={styles.variableFieldBlock}>
            <label className={styles.field}>
              <span>Cuerpo del encabezado</span>
              <input
                value={draft.headerText || ''}
                onChange={(event) => updateDraft('headerText', event.target.value.slice(0, 60))}
                placeholder="Hola {{1}}"
              />
            </label>
            <div className={styles.fieldInlineActions}>
              <Button variant="secondary" size="sm" onClick={() => addMetaVariable('headerText')}>
                <Plus size={15} />
                Añadir variable
              </Button>
            </div>
            {renderVariableBindings('headerText', draft.headerText)}
          </div>
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
          <div className={styles.editorActionGroup}>
            {selectedTemplateId && (
              <Button variant="outline" onClick={syncCurrentTemplate} loading={syncing}>
                <RefreshCw size={16} />
                Sincronizar estado
              </Button>
            )}
            <Button variant="secondary" onClick={saveTemplate} loading={saving}>
              <Save size={16} />
              Guardar
            </Button>
            <Button onClick={submitTemplate} loading={submitting}>
              <UploadCloud size={16} />
              Enviar a revisión
            </Button>
          </div>
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

        <div className={styles.ycloudStatusPanel}>
          <div>
            <span className={`${styles.ycloudBadge} ${styles[`ycloudBadge${getYCloudStatusTone(draft.ycloudStatus)}`]}`}>
              {getYCloudStatusLabel(draft.ycloudStatus)}
            </span>
            <strong>Estado Meta/YCloud</strong>
          </div>
          <p>
            {(draft.ycloudStatus || '').toUpperCase() === 'APPROVED'
              ? 'Plantilla aprobada y lista para enviarse por WhatsApp Business.'
              : (draft.ycloudStatus || '').toUpperCase() === 'REJECTED'
                ? draft.ycloudReason || draft.lastError || 'Meta rechazo la plantilla. Revisa el motivo y ajusta el contenido.'
                : (draft.ycloudStatus || '').toUpperCase() === 'PENDING'
                  ? 'Meta esta revisando la plantilla. Puedes sincronizar para actualizar el estado.'
                  : draft.lastError || 'Guarda la plantilla y enviala a revision cuando este lista.'}
          </p>
          {(draft.ycloudReason || draft.lastError) && (
            <div className={styles.ycloudError}>
              <AlertCircle size={15} />
              <span>{draft.ycloudReason || draft.lastError}</span>
            </div>
          )}
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
          <div className={styles.variableFieldBlock}>
            <label className={styles.field}>
              <span>Cuerpo</span>
              <textarea
                value={draft.bodyText}
                onChange={(event) => updateDraft('bodyText', event.target.value.slice(0, 1024))}
                placeholder="Qué onda {{1}}, tu cita es para {{2}}."
              />
            </label>
            <div className={styles.fieldInlineActions}>
              <span className={styles.characterCount}>{draft.bodyText.length} / 1024</span>
              <Button variant="secondary" size="sm" onClick={() => addMetaVariable('bodyText')}>
                <Plus size={15} />
                Añadir variable
              </Button>
            </div>
            {renderVariableBindings('bodyText', draft.bodyText)}
          </div>
        </div>

        <div className={styles.formSection}>
          <label className={styles.field}>
            <span>Pie de página</span>
            <input
              value={draft.footerText || ''}
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

        {(draft.ycloudStatus || '').toUpperCase() === 'APPROVED' && (
          <div className={styles.formSection}>
            <div className={styles.sectionHeading}>
              <strong>Enviar prueba</strong>
            </div>
            <div className={styles.testSendRow}>
              <input
                value={testPhone}
                onChange={(event) => setTestPhone(event.target.value)}
                placeholder="+526561234567"
              />
              <Button onClick={sendTestTemplate} loading={sendingTest}>
                <Send size={15} />
                Enviar
              </Button>
            </div>
          </div>
        )}
      </section>

      <div className={styles.editorSide}>
        {renderPreview()}
      </div>
    </div>
  )

  if (loading) {
    return <Loading page="settings" />
  }

  return (
    <div className={`${styles.container} ${embedded ? styles.embedded : ''}`}>
      {!embedded && (
        <div className={styles.header}>
          <div className={styles.headerIcon}>
            <MessageSquare size={26} />
          </div>
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <Button variant="secondary" onClick={loadBundle}>
            <ListTree size={16} />
            Refrescar
          </Button>
        </div>
      )}

      {view === 'list' ? renderList() : renderEditor()}
    </div>
  )
}
