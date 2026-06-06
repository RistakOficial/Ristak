import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Check,
  Edit3,
  Eye,
  File,
  FileText,
  Folder,
  FolderInput,
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
  SlidersHorizontal,
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
  type MessageTemplateFolder,
  type MessageTemplateHeaderType,
  type MessageTemplatePayload,
  type MessageTemplateStatus,
  type MessageTemplateVariableBinding,
  type MessageTemplateVariableTarget
} from '@/services/messageTemplatesService'
import { whatsappApiService, type WhatsAppApiPhoneNumber } from '@/services/whatsappApiService'
import styles from './MessageTemplates.module.css'

const ROOT_FOLDER_KEY = '__root__'
const DRAG_DATA_TYPE = 'application/x-ristak-template-manager'
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

type TemplateReviewStatusFilter = 'all' | 'active' | 'pending' | 'rejected' | 'draft' | 'paused' | 'archived'

const reviewStatusFilterOptions: Array<{ value: TemplateReviewStatusFilter; label: string }> = [
  { value: 'all', label: 'Todos los estados' },
  { value: 'active', label: 'Activas' },
  { value: 'pending', label: 'Pendientes' },
  { value: 'rejected', label: 'Rechazadas' },
  { value: 'draft', label: 'Borradores' },
  { value: 'paused', label: 'Pausadas' },
  { value: 'archived', label: 'Archivadas' }
]

const templateAssociationKeys = {
  waba: new Set(['wabaid', 'waba_id', 'whatsappbusinessaccountid', 'whatsapp_business_account_id']),
  phone: new Set(['phonenumberid', 'phone_number_id', 'businessphonenumberid', 'business_phone_number_id'])
}

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

function templateToPayload(template: MessageTemplate, folderId: string | null): MessageTemplatePayload {
  return {
    folderId,
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

function normalizeFilterValue(value?: string | null) {
  return String(value || '').trim().toLowerCase()
}

function getPhoneFilterLabel(phone: WhatsAppApiPhoneNumber) {
  const number = phone.display_phone_number || phone.phone_number || 'Número'
  return phone.verified_name ? `${number} · ${phone.verified_name}` : number
}

function getTemplateReviewStatus(template: MessageTemplate): TemplateReviewStatusFilter {
  const ycloudStatus = String(template.ycloudStatus || '').toUpperCase()

  if (ycloudStatus === 'APPROVED') return 'active'
  if (ycloudStatus === 'PENDING' || ycloudStatus === 'IN_APPEAL') return 'pending'
  if (ycloudStatus === 'REJECTED') return 'rejected'
  if (ycloudStatus === 'PAUSED' || ycloudStatus === 'DISABLED') return 'paused'
  if (ycloudStatus === 'ARCHIVED') return 'archived'
  if (template.status === 'archived') return 'archived'
  if (template.status === 'active') return 'active'
  return 'draft'
}

function collectAssociationValues(source: unknown, keys: Set<string>, depth = 0, output = new Set<string>()) {
  if (!source || depth > 4) return output

  if (Array.isArray(source)) {
    source.forEach((item) => collectAssociationValues(item, keys, depth + 1, output))
    return output
  }

  if (typeof source !== 'object') return output

  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const normalizedKey = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
    if (keys.has(normalizedKey) && typeof value !== 'object') {
      const normalizedValue = normalizeFilterValue(String(value))
      if (normalizedValue) output.add(normalizedValue)
      continue
    }

    collectAssociationValues(value, keys, depth + 1, output)
  }

  return output
}

function templateMatchesPhone(template: MessageTemplate, phone?: WhatsAppApiPhoneNumber | null) {
  if (!phone) return true

  const rawPayload = template.ycloudRawPayload || null
  const templateWabaIds = collectAssociationValues(rawPayload, templateAssociationKeys.waba)
  const templatePhoneIds = collectAssociationValues(rawPayload, templateAssociationKeys.phone)
  const selectedWabaId = normalizeFilterValue(phone.waba_id)
  const selectedPhoneId = normalizeFilterValue(phone.id)

  if (!templateWabaIds.size && !templatePhoneIds.size) return true
  if (selectedPhoneId && templatePhoneIds.has(selectedPhoneId)) return true
  if (selectedWabaId && templateWabaIds.has(selectedWabaId)) return true

  return false
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
  const [templatePhoneFilter, setTemplatePhoneFilter] = useState('all')
  const [templateCategoryFilter, setTemplateCategoryFilter] = useState<'all' | MessageTemplateCategory>('all')
  const [templateStatusFilter, setTemplateStatusFilter] = useState<TemplateReviewStatusFilter>('all')
  const [whatsappPhones, setWhatsappPhones] = useState<WhatsAppApiPhoneNumber[]>([])
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [sendingTest, setSendingTest] = useState(false)
  const [testPhone, setTestPhone] = useState('')
  const [showFolderForm, setShowFolderForm] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<Set<string>>(() => new Set())
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(() => new Set())
  const [bulkTargetFolderId, setBulkTargetFolderId] = useState(ROOT_FOLDER_KEY)
  const [bulkWorking, setBulkWorking] = useState(false)
  const [dragging, setDragging] = useState<{ templateIds: string[]; folderIds: string[] } | null>(null)
  const [dropTargetFolderId, setDropTargetFolderId] = useState<string | null>(null)

  useEffect(() => {
    loadBundle()
    loadWhatsAppPhones()
  }, [])

  useEffect(() => {
    const templateIds = new Set(bundle.templates.map((template) => template.id))
    const folderIds = new Set(bundle.folders.map((folder) => folder.id))

    setSelectedTemplateIds((current) => new Set([...current].filter((id) => templateIds.has(id))))
    setSelectedFolderIds((current) => new Set([...current].filter((id) => folderIds.has(id))))
  }, [bundle.templates, bundle.folders])

  useEffect(() => {
    if (templatePhoneFilter === 'all') return
    if (whatsappPhones.some((phone) => phone.id === templatePhoneFilter)) return
    setTemplatePhoneFilter('all')
  }, [templatePhoneFilter, whatsappPhones])

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

  const loadWhatsAppPhones = async () => {
    try {
      const status = await whatsappApiService.getStatus()
      setWhatsappPhones(status.phoneNumbers || [])
    } catch {
      setWhatsappPhones([])
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

  const phoneById = useMemo(() => (
    new Map(whatsappPhones.map((phone) => [phone.id, phone]))
  ), [whatsappPhones])

  const selectedFilterPhone = templatePhoneFilter === 'all' ? null : phoneById.get(templatePhoneFilter) || null

  const hasTemplateFilters = Boolean(
    templatePhoneFilter !== 'all' ||
    templateCategoryFilter !== 'all' ||
    templateStatusFilter !== 'all'
  )

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
      const matchesLocation = !query
        ? (template.folderId || null) === activeFolderId
        : [
        template.name,
        template.bodyText,
        template.headerText || '',
        template.footerText || ''
      ].some((value) => value.toLowerCase().includes(query))

      if (!matchesLocation) return false
      if (templateCategoryFilter !== 'all' && template.category !== templateCategoryFilter) return false
      if (templateStatusFilter !== 'all' && getTemplateReviewStatus(template) !== templateStatusFilter) return false
      if (templatePhoneFilter !== 'all' && !templateMatchesPhone(template, selectedFilterPhone)) return false

      return true
    })
  }, [activeFolderId, bundle.templates, searchTerm, selectedFilterPhone, templateCategoryFilter, templatePhoneFilter, templateStatusFilter])

  const templateCountsByFolder = useMemo(() => {
    const counts = new Map<string, number>()
    for (const template of bundle.templates) {
      if (!template.folderId) continue
      counts.set(template.folderId, (counts.get(template.folderId) || 0) + 1)
    }
    return counts
  }, [bundle.templates])

  const childFoldersByParent = useMemo(() => {
    const rows = new Map<string, typeof bundle.folders>()
    for (const folder of bundle.folders) {
      const parentKey = folder.parentId || ROOT_FOLDER_KEY
      rows.set(parentKey, [...(rows.get(parentKey) || []), folder])
    }
    return rows
  }, [bundle.folders])

  const descendantFolderIdsByFolder = useMemo(() => {
    const rows = new Map<string, Set<string>>()
    const collect = (folderId: string, target: Set<string>) => {
      for (const child of childFoldersByParent.get(folderId) || []) {
        if (target.has(child.id)) continue
        target.add(child.id)
        collect(child.id, target)
      }
    }

    for (const folder of bundle.folders) {
      const descendants = new Set<string>()
      collect(folder.id, descendants)
      rows.set(folder.id, descendants)
    }

    return rows
  }, [bundle.folders, childFoldersByParent])

  const selectedTemplates = useMemo(() => (
    bundle.templates.filter((template) => selectedTemplateIds.has(template.id))
  ), [bundle.templates, selectedTemplateIds])

  const selectedFolders = useMemo(() => (
    bundle.folders.filter((folder) => selectedFolderIds.has(folder.id))
  ), [bundle.folders, selectedFolderIds])

  const visibleTemplateIds = useMemo(() => (
    visibleTemplates.map((template) => template.id)
  ), [visibleTemplates])

  const visibleFolderIds = useMemo(() => (
    currentFolders.map((folder) => folder.id)
  ), [currentFolders])

  const selectedTotal = selectedTemplateIds.size + selectedFolderIds.size
  const allVisibleSelected = Boolean(
    (visibleTemplateIds.length || visibleFolderIds.length) &&
    visibleTemplateIds.every((id) => selectedTemplateIds.has(id)) &&
    visibleFolderIds.every((id) => selectedFolderIds.has(id))
  )

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

  const clearSelection = () => {
    setSelectedTemplateIds(new Set())
    setSelectedFolderIds(new Set())
  }

  const toggleTemplateSelection = (templateId: string) => {
    setSelectedTemplateIds((current) => {
      const next = new Set(current)
      if (next.has(templateId)) next.delete(templateId)
      else next.add(templateId)
      return next
    })
  }

  const toggleFolderSelection = (folderId: string) => {
    setSelectedFolderIds((current) => {
      const next = new Set(current)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  const toggleVisibleSelection = () => {
    if (allVisibleSelected) {
      setSelectedTemplateIds((current) => {
        const next = new Set(current)
        visibleTemplateIds.forEach((id) => next.delete(id))
        return next
      })
      setSelectedFolderIds((current) => {
        const next = new Set(current)
        visibleFolderIds.forEach((id) => next.delete(id))
        return next
      })
      return
    }

    setSelectedTemplateIds((current) => new Set([...current, ...visibleTemplateIds]))
    setSelectedFolderIds((current) => new Set([...current, ...visibleFolderIds]))
  }

  const canMoveFolderTo = (folderId: string, targetFolderId: string | null) => {
    if (!targetFolderId) return true
    if (folderId === targetFolderId) return false
    return !descendantFolderIdsByFolder.get(folderId)?.has(targetFolderId)
  }

  const moveTemplatesToFolder = async (templates: MessageTemplate[], folderId: string | null) => {
    for (const template of templates) {
      if ((template.folderId || null) === folderId) continue
      await messageTemplatesService.updateTemplate(template.id, templateToPayload(template, folderId))
    }
  }

  const moveFoldersToFolder = async (folders: MessageTemplateFolder[], folderId: string | null) => {
    const invalid = folders.find((folder) => !canMoveFolderTo(folder.id, folderId))
    if (invalid) {
      throw new Error(`No puedes meter ${invalid.name} dentro de si misma o de una subcarpeta propia`)
    }

    for (const folder of folders) {
      if ((folder.parentId || null) === folderId) continue
      await messageTemplatesService.updateFolder(folder.id, {
        name: folder.name,
        parentId: folderId,
        sortOrder: folder.sortOrder
      })
    }
  }

  const moveSelectionToFolder = async (targetFolderIdValue = bulkTargetFolderId) => {
    if (!selectedTotal || bulkWorking) return

    const targetFolderId = targetFolderIdValue === ROOT_FOLDER_KEY ? null : targetFolderIdValue
    setBulkWorking(true)
    try {
      await moveTemplatesToFolder(selectedTemplates, targetFolderId)
      await moveFoldersToFolder(selectedFolders, targetFolderId)
      clearSelection()
      await loadBundle()
      showToast('success', 'Movido', 'La seleccion quedo en su nueva carpeta')
    } catch (error) {
      showToast('error', 'No se pudo mover', getErrorMessage(error, 'Intenta con otra carpeta'))
    } finally {
      setBulkWorking(false)
      setDragging(null)
      setDropTargetFolderId(null)
    }
  }

  const syncSelectedTemplates = async () => {
    if (!selectedTemplates.length || bulkWorking) return

    setBulkWorking(true)
    try {
      for (const template of selectedTemplates) {
        await messageTemplatesService.syncTemplate(template.id)
      }
      await loadBundle()
      showToast('success', 'Plantillas sincronizadas', 'Se actualizo el estado de la seleccion')
    } catch (error) {
      await loadBundle()
      showToast('error', 'No se pudo sincronizar', getErrorMessage(error, 'Revisa la conexion con YCloud'))
    } finally {
      setBulkWorking(false)
    }
  }

  const deleteSelection = () => {
    if (!selectedTotal || bulkWorking) return

    showConfirm(
      'Eliminar seleccion',
      `Se eliminaran ${selectedTotal} elemento${selectedTotal === 1 ? '' : 's'}. Las plantillas dentro de carpetas eliminadas quedaran sueltas.`,
      async () => {
        setBulkWorking(true)
        try {
          for (const template of selectedTemplates) {
            await messageTemplatesService.deleteTemplate(template.id)
          }
          for (const folder of selectedFolders) {
            await messageTemplatesService.deleteFolder(folder.id)
          }
          clearSelection()
          await loadBundle()
          showToast('success', 'Seleccion eliminada', 'Listo, ya no aparece en plantillas')
        } catch (error) {
          showToast('error', 'No se pudo eliminar', getErrorMessage(error, 'Intenta nuevamente'))
        } finally {
          setBulkWorking(false)
        }
      },
      'Eliminar',
      'Cancelar'
    )
  }

  const getDragPayload = (type: 'template' | 'folder', id: string) => {
    if (type === 'template') {
      return {
        templateIds: selectedTemplateIds.has(id) ? [...selectedTemplateIds] : [id],
        folderIds: selectedFolderIds.has(id) ? [...selectedFolderIds] : []
      }
    }

    return {
      templateIds: selectedTemplateIds.has(id) ? [...selectedTemplateIds] : [],
      folderIds: selectedFolderIds.has(id) ? [...selectedFolderIds] : [id]
    }
  }

  const handleDragStart = (event: React.DragEvent, type: 'template' | 'folder', id: string) => {
    const payload = getDragPayload(type, id)
    setDragging(payload)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(DRAG_DATA_TYPE, JSON.stringify(payload))
  }

  const readDragPayload = (event: React.DragEvent) => {
    if (dragging) return dragging
    try {
      const raw = event.dataTransfer.getData(DRAG_DATA_TYPE)
      return raw ? JSON.parse(raw) as { templateIds: string[]; folderIds: string[] } : null
    } catch {
      return null
    }
  }

  const handleFolderDragOver = (event: React.DragEvent, folderId: string | null) => {
    const payload = dragging
    if (!payload) return
    const canDrop = payload.folderIds.every((draggedFolderId) => canMoveFolderTo(draggedFolderId, folderId))
    if (!canDrop) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTargetFolderId(folderId || ROOT_FOLDER_KEY)
  }

  const handleDropOnFolder = async (event: React.DragEvent, folderId: string | null) => {
    event.preventDefault()
    const payload = readDragPayload(event)
    if (!payload || bulkWorking) return

    const templates = bundle.templates.filter((template) => payload.templateIds.includes(template.id))
    const folders = bundle.folders.filter((folder) => payload.folderIds.includes(folder.id))

    setBulkWorking(true)
    try {
      await moveTemplatesToFolder(templates, folderId)
      await moveFoldersToFolder(folders, folderId)
      clearSelection()
      await loadBundle()
      showToast('success', 'Movido', folderId ? `Guardado en ${folderMap.get(folderId)?.name || 'carpeta'}` : 'Guardado en Inicio')
    } catch (error) {
      showToast('error', 'No se pudo mover', getErrorMessage(error, 'Intenta con otra carpeta'))
    } finally {
      setBulkWorking(false)
      setDragging(null)
      setDropTargetFolderId(null)
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

        <div className={styles.filterBar}>
          <div className={styles.filterTitle}>
            <SlidersHorizontal size={16} />
            <span>Filtros</span>
          </div>
          <label className={styles.filterControl}>
            <span>Número</span>
            <select
              value={templatePhoneFilter}
              onChange={(event) => setTemplatePhoneFilter(event.target.value)}
              disabled={!whatsappPhones.length}
            >
              <option value="all">{whatsappPhones.length ? 'Todos los números' : 'Sin números conectados'}</option>
              {whatsappPhones.map((phone) => (
                <option key={phone.id} value={phone.id}>{getPhoneFilterLabel(phone)}</option>
              ))}
            </select>
          </label>
          <label className={styles.filterControl}>
            <span>Tipo</span>
            <select
              value={templateCategoryFilter}
              onChange={(event) => setTemplateCategoryFilter(event.target.value as 'all' | MessageTemplateCategory)}
            >
              <option value="all">Todos los tipos</option>
              {categoryOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className={styles.filterControl}>
            <span>Estado</span>
            <select
              value={templateStatusFilter}
              onChange={(event) => setTemplateStatusFilter(event.target.value as TemplateReviewStatusFilter)}
            >
              {reviewStatusFilterOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <span className={styles.filterCount}>{visibleTemplates.length} de {bundle.templates.length} plantillas</span>
          {hasTemplateFilters && (
            <button
              type="button"
              className={styles.clearFiltersButton}
              onClick={() => {
                setTemplatePhoneFilter('all')
                setTemplateCategoryFilter('all')
                setTemplateStatusFilter('all')
              }}
            >
              Limpiar filtros
            </button>
          )}
        </div>

        <div className={styles.breadcrumbs}>
          <button
            type="button"
            className={dropTargetFolderId === ROOT_FOLDER_KEY ? styles.dropTargetActive : ''}
            onClick={() => setActiveFolderId(null)}
            onDragOver={(event) => handleFolderDragOver(event, null)}
            onDragLeave={() => setDropTargetFolderId(null)}
            onDrop={(event) => handleDropOnFolder(event, null)}
          >
            Inicio
          </button>
          {activeTrail.map((folder) => (
            <React.Fragment key={folder.id}>
              <span>/</span>
              <button
                type="button"
                className={dropTargetFolderId === folder.id ? styles.dropTargetActive : ''}
                onClick={() => setActiveFolderId(folder.id)}
                onDragOver={(event) => handleFolderDragOver(event, folder.id)}
                onDragLeave={() => setDropTargetFolderId(null)}
                onDrop={(event) => handleDropOnFolder(event, folder.id)}
              >
                {folder.name}
              </button>
            </React.Fragment>
          ))}
        </div>

        {selectedTotal > 0 && (
          <div className={styles.bulkBar}>
            <strong>{selectedTotal} seleccionado{selectedTotal === 1 ? '' : 's'}</strong>
            <button type="button" onClick={toggleVisibleSelection}>
              {allVisibleSelected ? 'Quitar visibles' : 'Seleccionar visibles'}
            </button>
            <label>
              <span>Mover a</span>
              <select value={bulkTargetFolderId} onChange={(event) => setBulkTargetFolderId(event.target.value)}>
                <option value={ROOT_FOLDER_KEY}>Inicio</option>
                {folderOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <Button variant="outline" size="sm" onClick={() => moveSelectionToFolder()} loading={bulkWorking}>
              <FolderInput size={15} />
              Mover
            </Button>
            <Button variant="outline" size="sm" onClick={syncSelectedTemplates} disabled={!selectedTemplates.length || bulkWorking}>
              <RefreshCw size={15} />
              Sincronizar
            </Button>
            <Button variant="danger" size="sm" onClick={deleteSelection} disabled={bulkWorking}>
              <Trash2 size={15} />
              Eliminar
            </Button>
            <Button variant="ghost" size="sm" onClick={clearSelection} disabled={bulkWorking}>
              <X size={15} />
            </Button>
          </div>
        )}

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
            <article
              key={folder.id}
              className={`${styles.collectionItem} ${selectedFolderIds.has(folder.id) ? styles.collectionItemSelected : ''} ${dropTargetFolderId === folder.id ? styles.collectionItemDropTarget : ''}`}
              draggable
              onDragStart={(event) => handleDragStart(event, 'folder', folder.id)}
              onDragEnd={() => {
                setDragging(null)
                setDropTargetFolderId(null)
              }}
              onDragOver={(event) => handleFolderDragOver(event, folder.id)}
              onDragLeave={() => setDropTargetFolderId(null)}
              onDrop={(event) => handleDropOnFolder(event, folder.id)}
            >
              <label className={styles.itemCheck} aria-label={`Seleccionar ${folder.name}`}>
                <input
                  type="checkbox"
                  checked={selectedFolderIds.has(folder.id)}
                  onChange={() => toggleFolderSelection(folder.id)}
                />
              </label>
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
            <article
              key={template.id}
              className={`${styles.collectionItem} ${selectedTemplateIds.has(template.id) ? styles.collectionItemSelected : ''}`}
              draggable
              onDragStart={(event) => handleDragStart(event, 'template', template.id)}
              onDragEnd={() => {
                setDragging(null)
                setDropTargetFolderId(null)
              }}
            >
              <label className={styles.itemCheck} aria-label={`Seleccionar ${template.name}`}>
                <input
                  type="checkbox"
                  checked={selectedTemplateIds.has(template.id)}
                  onChange={() => toggleTemplateSelection(template.id)}
                />
              </label>
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
              <strong>{hasTemplateFilters ? 'Sin resultados' : 'Sin plantillas'}</strong>
              {hasTemplateFilters && <span>Prueba con otro número, tipo o estado.</span>}
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
