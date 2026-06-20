import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Edit3,
  Eye,
  File,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Globe2,
  GripVertical,
  Hash as HashIcon,
  Image,
  ListTree,
  Loader2,
  MapPin,
  MessageSquare,
  MoreHorizontal,
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
import { Button, Loading, CustomSelect, PageHeader, SearchField } from '@/components/common'
import { PhoneChatPreview, type PhoneChatPreviewMessage } from '@/components/phone/PhoneChatPreview'
import { useAuth } from '@/contexts/AuthContext'
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
  type MessageTemplateVariable,
  type MessageTemplateVariableBinding,
  type MessageTemplateVariableTarget
} from '@/services/messageTemplatesService'
import { whatsappApiService, type WhatsAppApiPhoneNumber } from '@/services/whatsappApiService'
import styles from './MessageTemplates.module.css'

const ROOT_FOLDER_KEY = '__root__'
const DRAG_DATA_TYPE = 'application/x-ristak-template-manager'
const VARIABLE_PATTERN = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g
const META_VARIABLE_PATTERN = /{{\s*(\d+)\s*}}/g
type TemplateFolderFilter = 'all' | 'unfiled' | string

interface VariablePickerGroup {
  id: string
  label: string
  items: MessageTemplateVariable[]
}

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

type WhatsAppBusinessProfile = {
  businessName?: string
  name?: string
  verifiedName?: string
}

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

function normalizeTemplateNameDraftInput(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+/g, '')
    .replace(/_+/g, '_')
}

function normalizeTemplateNameInput(value: string) {
  return normalizeTemplateNameDraftInput(value).replace(/_+$/g, '')
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
  if (isTemplateUnderReviewStatus(normalized)) return 'Warning'
  return 'Neutral'
}

function getYCloudStatusLabel(status?: string | null) {
  const normalized = (status || '').toUpperCase()
  if (!normalized) return 'Sin enviar'
  if (normalized === 'APPROVED') return 'Aprobada'
  if (normalized === 'REJECTED') return 'Rechazada'
  if (normalized === 'PENDING' || normalized === 'IN_REVIEW' || normalized === 'UNDER_REVIEW' || normalized === 'PENDING_REVIEW') return 'En revisión'
  if (normalized === 'PAUSED') return 'Pausada'
  if (normalized === 'DISABLED') return 'Deshabilitada'
  if (normalized === 'ARCHIVED') return 'Archivada'
  if (normalized === 'IN_APPEAL') return 'En apelación'
  return normalized
}

function isTemplateUnderReviewStatus(status?: string | null) {
  const normalized = String(status || '').toUpperCase()
  return ['PENDING', 'IN_APPEAL', 'IN_REVIEW', 'UNDER_REVIEW', 'PENDING_REVIEW'].includes(normalized)
}

function normalizeFilterValue(value?: string | null) {
  return String(value || '').trim().toLowerCase()
}

function getPhoneFilterLabel(phone: WhatsAppApiPhoneNumber) {
  const number = phone.display_phone_number || phone.phone_number || 'Número'
  return phone.verified_name ? `${number} · ${phone.verified_name}` : number
}

function parseBusinessProfile(value?: string | null): WhatsAppBusinessProfile | null {
  if (!value) return null
  try {
    return JSON.parse(value) as WhatsAppBusinessProfile
  } catch {
    return null
  }
}

function cleanDisplayName(value?: string | null) {
  return String(value || '').trim()
}

function getTemplateReviewStatus(template: MessageTemplate): TemplateReviewStatusFilter {
  const ycloudStatus = String(template.ycloudStatus || '').toUpperCase()

  if (ycloudStatus === 'APPROVED') return 'active'
  if (isTemplateUnderReviewStatus(ycloudStatus)) return 'pending'
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

function isTemplateFolderId(folderId: TemplateFolderFilter | null): folderId is string {
  return Boolean(folderId && folderId !== 'all' && folderId !== 'unfiled')
}

function getTemplateFolderTargetId(folderId: TemplateFolderFilter | null) {
  return isTemplateFolderId(folderId) ? folderId : null
}

function getVariableGroupLabel(variable: MessageTemplateVariable) {
  return String(variable.group || '').trim() || 'Otros datos'
}

function getVariableGroupId(label: string) {
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'otros-datos'
}

function buildVariablePickerGroups(variables: MessageTemplateVariable[], query: string): VariablePickerGroup[] {
  const normalizedQuery = query.trim().toLowerCase()
  const groups = new Map<string, VariablePickerGroup>()

  for (const variable of variables) {
    const groupLabel = getVariableGroupLabel(variable)
    const matches = !normalizedQuery || [
      variable.label,
      variable.key,
      variable.mergeField,
      variable.example,
      groupLabel
    ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery))

    if (!matches) continue

    const groupId = getVariableGroupId(groupLabel)
    const currentGroup = groups.get(groupId)
    if (currentGroup) {
      currentGroup.items.push(variable)
    } else {
      groups.set(groupId, {
        id: groupId,
        label: groupLabel,
        items: [variable]
      })
    }
  }

  return Array.from(groups.values())
}

interface MessageTemplatesProps {
  embedded?: boolean
  title?: string
  subtitle?: string
}

export const MessageTemplates: React.FC<MessageTemplatesProps> = ({
  embedded = false,
  title = 'Plantillas',
  subtitle = 'WhatsApp · Variables · WhatsApp API'
}) => {
  const { user } = useAuth()
  const { showToast, showConfirm } = useNotification()
  const [bundle, setBundle] = useState<MessageTemplateBundle>({
    folders: [],
    templates: [],
    customFields: [],
    variables: []
  })
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'list' | 'editor'>('list')
  const [activeFolderId, setActiveFolderId] = useState<TemplateFolderFilter>('all')
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
  const [folderName, setFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<Set<string>>(() => new Set())
  const [bulkTargetFolderId, setBulkTargetFolderId] = useState(ROOT_FOLDER_KEY)
  const [bulkWorking, setBulkWorking] = useState(false)
  const [dragging, setDragging] = useState<{ templateIds: string[]; folderIds: string[] } | null>(null)
  const [activeVariablePicker, setActiveVariablePicker] = useState<string | null>(null)
  const [variableSearchDrafts, setVariableSearchDrafts] = useState<Record<string, string>>({})
  const [expandedVariableCategories, setExpandedVariableCategories] = useState<Set<string>>(() => new Set())
  const [dropTargetFolderId, setDropTargetFolderId] = useState<string | null>(null)
  const [openFolderMenuId, setOpenFolderMenuId] = useState<string | null>(null)

  useEffect(() => {
    loadBundle()
    loadWhatsAppPhones()
  }, [])

  useEffect(() => {
    const templateIds = new Set(bundle.templates.map((template) => template.id))
    setSelectedTemplateIds((current) => new Set([...current].filter((id) => templateIds.has(id))))
  }, [bundle.templates])

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

  const phoneById = useMemo(() => (
    new Map(whatsappPhones.map((phone) => [phone.id, phone]))
  ), [whatsappPhones])

  const selectedFilterPhone = templatePhoneFilter === 'all' ? null : phoneById.get(templatePhoneFilter) || null
  const defaultWhatsappPhone = useMemo(() => (
    whatsappPhones.find((phone) => phone.is_default_sender) || whatsappPhones[0] || null
  ), [whatsappPhones])

  const previewBusinessName = useMemo(() => {
    const phone = selectedFilterPhone || defaultWhatsappPhone
    const phoneProfile = parseBusinessProfile(phone?.business_profile_json)

    return cleanDisplayName(user?.businessName) ||
      cleanDisplayName(phone?.verified_name) ||
      cleanDisplayName(phoneProfile?.businessName) ||
      cleanDisplayName(phoneProfile?.verifiedName) ||
      cleanDisplayName(phoneProfile?.name) ||
      cleanDisplayName(phone?.label) ||
      'Mi negocio'
  }, [defaultWhatsappPhone, selectedFilterPhone, user?.businessName])

  const hasTemplateFilters = Boolean(
    templatePhoneFilter !== 'all' ||
    templateCategoryFilter !== 'all' ||
    templateStatusFilter !== 'all'
  )

  const visibleTemplates = useMemo(() => {
    const query = searchTerm.trim().toLowerCase()
    return bundle.templates.filter((template) => {
      const matchesFolder =
        activeFolderId === 'all' ||
        (activeFolderId === 'unfiled' ? !template.folderId : template.folderId === activeFolderId)

      if (!matchesFolder) return false

      const matchesSearch = !query || [
        template.name,
        template.description || '',
        template.bodyText,
        template.headerText || '',
        template.footerText || '',
        getCategoryLabel(template.category),
        getYCloudStatusLabel(template.ycloudStatus),
        folderMap.get(template.folderId || '')?.name || ''
      ].some((value) => value.toLowerCase().includes(query))

      if (!matchesSearch) return false
      if (templateCategoryFilter !== 'all' && template.category !== templateCategoryFilter) return false
      if (templateStatusFilter !== 'all' && getTemplateReviewStatus(template) !== templateStatusFilter) return false
      if (templatePhoneFilter !== 'all' && !templateMatchesPhone(template, selectedFilterPhone)) return false

      return true
    })
  }, [activeFolderId, bundle.templates, folderMap, searchTerm, selectedFilterPhone, templateCategoryFilter, templatePhoneFilter, templateStatusFilter])

  const templateCountsByFolder = useMemo(() => {
    const counts = new Map<string, number>()
    for (const template of bundle.templates) {
      if (!template.folderId) continue
      counts.set(template.folderId, (counts.get(template.folderId) || 0) + 1)
    }
    return counts
  }, [bundle.templates])

  const unfiledTemplateCount = useMemo(() => (
    bundle.templates.filter((template) => !template.folderId).length
  ), [bundle.templates])

  const childFoldersByParent = useMemo(() => {
    const rows = new Map<string, typeof bundle.folders>()
    for (const folder of bundle.folders) {
      const parentKey = folder.parentId || ROOT_FOLDER_KEY
      rows.set(parentKey, [...(rows.get(parentKey) || []), folder])
    }
    return rows
  }, [bundle.folders])

  const folderRows = useMemo(() => {
    const rows: Array<{ folder: MessageTemplateFolder; depth: number }> = []

    const walk = (parentId: string, depth: number) => {
      for (const folder of childFoldersByParent.get(parentId) || []) {
        rows.push({ folder, depth })
        walk(folder.id, depth + 1)
      }
    }

    walk(ROOT_FOLDER_KEY, 0)
    return rows
  }, [childFoldersByParent])

  const selectedTemplates = useMemo(() => (
    bundle.templates.filter((template) => selectedTemplateIds.has(template.id))
  ), [bundle.templates, selectedTemplateIds])

  const visibleTemplateIds = useMemo(() => (
    visibleTemplates.map((template) => template.id)
  ), [visibleTemplates])

  const selectedTotal = selectedTemplateIds.size
  const allVisibleSelected = Boolean(
    visibleTemplateIds.length &&
    visibleTemplateIds.every((id) => selectedTemplateIds.has(id))
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
    setDraft(createEmptyDraft(getTemplateFolderTargetId(activeFolderId)))
    setActiveVariablePicker(null)
    setVariableSearchDrafts({})
    setExpandedVariableCategories(new Set())
    setTestPhone('')
    setView('editor')
  }

  const editTemplate = (template: MessageTemplate) => {
    if (isTemplateUnderReviewStatus(template.ycloudStatus)) {
      showToast('warning', 'Plantilla en revisión', 'Meta está revisando esta plantilla. Puedes eliminarla o sincronizar el estado, pero no editarla todavía.')
      return
    }

    setSelectedTemplateId(template.id)
    setDraft(templateToDraft(template))
    setActiveVariablePicker(null)
    setVariableSearchDrafts({})
    setExpandedVariableCategories(new Set())
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

  const getMissingVariableBinding = () => {
    const targets: Array<{ key: MessageTemplateVariableTarget; section: string; enabled: boolean }> = [
      { key: 'headerText', section: 'el encabezado', enabled: draft.headerEnabled && draft.headerType === 'text' },
      { key: 'bodyText', section: 'el cuerpo', enabled: true }
    ]

    for (const target of targets) {
      if (!target.enabled) continue
      const indexes = extractMetaVariableIndexes(String(draft[target.key] || ''))
      for (const index of indexes) {
        const binding = draft.variableBindings?.[target.key]?.[String(index)]
        if (!binding?.variableKey || !variableByKey.has(binding.variableKey)) {
          return { placeholder: `{{${index}}}`, section: target.section }
        }
      }
    }

    return null
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
    const missingBinding = getMissingVariableBinding()
    if (missingBinding) {
      showToast(
        'warning',
        'Dato dinámico requerido',
        `Selecciona una variable para ${missingBinding.placeholder} en ${missingBinding.section}. No se puede enviar texto libre.`
      )
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
      setActiveFolderId(saved.folderId || 'unfiled')
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
      setSelectedTemplateId(null)
      setDraft(createEmptyDraft(result.template.folderId || null))
      setActiveFolderId(result.template.folderId || 'unfiled')
      await loadBundle()
      setView('list')
      showToast('success', 'Enviada a revisión', result.message || 'WhatsApp API recibio la plantilla')
    } catch (error) {
      await loadBundle()
      showToast('error', 'WhatsApp API rechazo la plantilla', getErrorMessage(error, 'Revisa los errores de Meta o WhatsApp API'))
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
      if (isTemplateUnderReviewStatus(result.template.ycloudStatus)) {
        setSelectedTemplateId(null)
        setView('list')
      }
      showToast('success', 'Estado sincronizado', result.message || 'WhatsApp API respondió correctamente')
    } catch (error) {
      await loadBundle()
      showToast('error', 'No se pudo sincronizar', getErrorMessage(error, 'WhatsApp API no regreso estado'))
    } finally {
      setSyncing(false)
    }
  }

  const syncAllTemplates = async () => {
    setSyncing(true)
    try {
      const data = await messageTemplatesService.syncAll()
      setBundle(data)
      showToast('success', 'Plantillas sincronizadas', 'Estados actualizados desde WhatsApp API')
    } catch (error) {
      showToast('error', 'No se pudo sincronizar', getErrorMessage(error, 'Revisa la conexión con WhatsApp API'))
    } finally {
      setSyncing(false)
    }
  }

  const clearSelection = () => {
    setSelectedTemplateIds(new Set())
  }

  const toggleTemplateSelection = (templateId: string) => {
    setSelectedTemplateIds((current) => {
      const next = new Set(current)
      if (next.has(templateId)) next.delete(templateId)
      else next.add(templateId)
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
      return
    }

    setSelectedTemplateIds((current) => new Set([...current, ...visibleTemplateIds]))
  }

  const moveTemplatesToFolder = async (templates: MessageTemplate[], folderId: string | null) => {
    for (const template of templates) {
      if ((template.folderId || null) === folderId) continue
      await messageTemplatesService.updateTemplate(template.id, templateToPayload(template, folderId))
    }
  }

  const moveSelectionToFolder = async (targetFolderIdValue = bulkTargetFolderId) => {
    if (!selectedTotal || bulkWorking) return

    const targetFolderId = targetFolderIdValue === ROOT_FOLDER_KEY ? null : targetFolderIdValue
    setBulkWorking(true)
    try {
      await moveTemplatesToFolder(selectedTemplates, targetFolderId)
      clearSelection()
      await loadBundle()
      showToast('success', 'Movido', 'La selección quedo en su nueva carpeta')
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
      showToast('success', 'Plantillas sincronizadas', 'Se actualizo el estado de la selección')
    } catch (error) {
      await loadBundle()
      showToast('error', 'No se pudo sincronizar', getErrorMessage(error, 'Revisa la conexión con WhatsApp API'))
    } finally {
      setBulkWorking(false)
    }
  }

  const deleteSelection = () => {
    if (!selectedTemplates.length || bulkWorking) return

    const templatesToDelete = selectedTemplates
    const total = templatesToDelete.length
    showConfirm(
      'Eliminar selección',
      `Se eliminarán ${total} plantilla${total === 1 ? '' : 's'}.`,
      async () => {
        setBulkWorking(true)
        try {
          for (const template of templatesToDelete) {
            await messageTemplatesService.deleteTemplate(template.id)
          }
          clearSelection()
          await loadBundle()
          showToast('success', 'Selección eliminada', 'Listo, ya no aparece en plantillas')
        } catch (error) {
          showToast('error', 'No se pudo eliminar', getErrorMessage(error, 'Intenta nuevamente'))
        } finally {
          setBulkWorking(false)
        }
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const getDragPayload = (id: string) => {
    return {
      templateIds: selectedTemplateIds.has(id) ? [...selectedTemplateIds] : [id],
      folderIds: []
    }
  }

  const handleDragStart = (event: React.DragEvent, id: string) => {
    const payload = getDragPayload(id)
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
    if (!payload?.templateIds.length) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTargetFolderId(folderId || ROOT_FOLDER_KEY)
  }

  const handleDropOnFolder = async (event: React.DragEvent, folderId: string | null) => {
    event.preventDefault()
    const payload = readDragPayload(event)
    if (!payload || bulkWorking) return

    const templates = bundle.templates.filter((template) => payload.templateIds.includes(template.id))

    setBulkWorking(true)
    try {
      await moveTemplatesToFolder(templates, folderId)
      clearSelection()
      await loadBundle()
      showToast('success', 'Movido', folderId ? `Guardado en ${folderMap.get(folderId)?.name || 'carpeta'}` : 'Guardado sin carpeta')
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
      showToast('success', 'Prueba enviada', result.message || 'WhatsApp Business aceptó el envío')
    } catch (error) {
      await loadBundle()
      showToast('error', 'No se pudo enviar', getErrorMessage(error, 'Meta o WhatsApp API rechazó el envío'))
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
        parentId: getTemplateFolderTargetId(activeFolderId)
      })
      setFolderName('')
      await loadBundle()
      showToast('success', getTemplateFolderTargetId(activeFolderId) ? 'Subcarpeta creada' : 'Carpeta creada', folderName.trim())
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
          if (activeFolderId === folder.id) setActiveFolderId('all')
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

  const toggleVariableCategory = (categoryId: string) => {
    setExpandedVariableCategories((current) => {
      const next = new Set(current)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
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

    return (
      <div className={styles.variableBindings}>
        {indexes.map((index) => {
          const binding = draft.variableBindings?.[target]?.[String(index)] || {}
          const selectedVariable = binding.variableKey ? variableByKey.get(binding.variableKey) : null
          const pickerKey = `${target}-${index}`
          const searchValue = variableSearchDrafts[pickerKey] || ''
          const searchQuery = searchValue.trim().toLowerCase()
          const isSearchingVariables = searchQuery.length > 0
          const pickerGroups = buildVariablePickerGroups(bundle.variables, searchValue)
          const pickerMatches = pickerGroups.flatMap((group) => group.items)
          const pickerOpen = activeVariablePicker === pickerKey && !selectedVariable
          const selectVariable = (variable: MessageTemplateVariable) => {
            updateVariableBinding(target, index, {
              label: variable.label,
              variableKey: variable.key,
              mergeField: variable.mergeField
            })
            setVariableSearchDrafts((current) => ({ ...current, [pickerKey]: '' }))
            setActiveVariablePicker(null)
          }
          const clearVariable = () => {
            updateVariableBinding(target, index, {
              label: '',
              variableKey: '',
              mergeField: ''
            })
            setVariableSearchDrafts((current) => ({ ...current, [pickerKey]: '' }))
            setActiveVariablePicker(pickerKey)
          }

          return (
            <div key={`${target}-${index}`} className={styles.variableBindingRow}>
              <strong>{`{{${index}}}`}</strong>
              <label>
                <span>Dato dinámico</span>
                <div className={styles.variablePicker}>
                  {selectedVariable ? (
                    <div className={styles.variablePickerSelection} data-ristak-dropdown-trigger>
                      <span>
                        <strong>{selectedVariable.label}</strong>
                        <small>{selectedVariable.group} · {selectedVariable.mergeField}</small>
                      </span>
                      <button type="button" onClick={clearVariable} aria-label={`Cambiar variable {{${index}}}`}>
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className={styles.variablePickerSearch}>
                        <Search size={14} />
                        <input
                          type="text"
                          value={searchValue}
                          onFocus={() => setActiveVariablePicker(pickerKey)}
                          onChange={(event) => {
                            setActiveVariablePicker(pickerKey)
                            setVariableSearchDrafts((current) => ({ ...current, [pickerKey]: event.target.value }))
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              const firstMatch = pickerMatches[0]
                              if (firstMatch) selectVariable(firstMatch)
                            }
                            if (event.key === 'Escape') {
                              setActiveVariablePicker(null)
                            }
                          }}
                          onBlur={() => {
                            window.setTimeout(() => {
                              setActiveVariablePicker((current) => current === pickerKey ? null : current)
                            }, 0)
                          }}
                          placeholder="Busca categoría, First Name, Email..."
                          aria-expanded={pickerOpen}
                          aria-autocomplete="list"
                        />
                      </div>
                      {pickerOpen && (
                        <div className={styles.variablePickerMenu} data-ristak-dropdown-panel>
                          {pickerGroups.length ? (
                            pickerGroups.map((group) => {
                              const expanded = isSearchingVariables || expandedVariableCategories.has(group.id)
                              return (
                                <div key={group.id} className={styles.variablePickerCategoryGroup}>
                                  <button
                                    type="button"
                                    className={styles.variablePickerCategoryButton}
                                    aria-expanded={expanded}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => toggleVariableCategory(group.id)}
                                  >
                                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                    <span className={styles.variablePickerCategoryName}>{group.label}</span>
                                    <span className={styles.variablePickerCategoryCount}>{group.items.length}</span>
                                  </button>
                                  {expanded && (
                                    <div className={styles.variablePickerCategoryItems}>
                                      {group.items.map((variable) => (
                                        <button
                                          key={variable.key}
                                          type="button"
                                          className={styles.variablePickerOptionButton}
                                          onMouseDown={(event) => event.preventDefault()}
                                          onClick={() => selectVariable(variable)}
                                          data-ristak-dropdown-item
                                        >
                                          <span>
                                            <strong>{variable.label}</strong>
                                            <small>{variable.group} · {variable.mergeField}</small>
                                          </span>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )
                            })
                          ) : (
                            <div className={styles.variablePickerEmpty}>Sin variables encontradas</div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
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

  const renderPreview = () => {
    const templatePreviewMessage: PhoneChatPreviewMessage = {
      id: 'template-preview',
      direction: 'inbound',
      header: renderPreviewHeader(),
      body: preview.bodyText || 'El mensaje aparecerá aquí',
      footer: preview.footerText || undefined,
      time: '11:48',
      buttons: preview.buttons.map((button, index) => ({
        id: button.id || `button-${index}`,
        label: button.label || 'Botón',
        // En WhatsApp solo los CTA (sitio/teléfono) llevan ícono; las respuestas
        // rápidas se muestran como texto centrado sin ícono.
        icon: button.type === 'website'
          ? <Globe2 size={14} />
          : (button.type === 'phone' || button.type === 'whatsapp_call')
            ? <Phone size={14} />
            : undefined
      }))
    }

    return (
      <aside className={styles.previewPanel}>
        <div className={styles.previewTitle}>
          <Eye size={17} />
          <span>Vista previa</span>
        </div>
        <PhoneChatPreview
          className={styles.templatePhonePreview}
          title={previewBusinessName}
          subtitle="Plantilla de WhatsApp"
          avatarLabel={previewBusinessName}
          messages={[templatePreviewMessage]}
        />
      </aside>
    )
  }

  const renderList = () => {
    const activeFolderName = activeFolderId === 'all'
      ? 'Todas las plantillas'
      : activeFolderId === 'unfiled'
        ? 'Sin carpeta'
        : folderMap.get(activeFolderId)?.name || 'Carpeta'
    const emptyTitle = hasTemplateFilters || searchTerm.trim()
      ? 'Sin resultados'
      : activeFolderId === 'all'
        ? 'Todavía no hay plantillas'
        : 'No hay plantillas en esta carpeta'

    return (
      <div className={styles.managerGrid}>
        <aside className={styles.folders} aria-label="Carpetas de plantillas">
          <div className={styles.folderHeader}>
            <strong>Carpetas</strong>
            <span>{bundle.folders.length} activas</span>
          </div>

          <div className={`${styles.folderRow} ${styles.folderSystemRow} ${activeFolderId === 'all' ? styles.folderSystemRowActive : ''}`}>
            <button
              type="button"
              onClick={() => {
                setActiveFolderId('all')
                setOpenFolderMenuId(null)
              }}
            >
              <HashIcon size={16} />
              <span>Todas las plantillas</span>
              <b>{bundle.templates.length}</b>
            </button>
            <span className={styles.folderActionSpacer} aria-hidden="true" />
          </div>

          <div
            className={`${styles.folderRow} ${styles.folderSystemRow} ${activeFolderId === 'unfiled' ? styles.folderSystemRowActive : ''} ${dropTargetFolderId === ROOT_FOLDER_KEY ? styles.folderDropActive : ''}`}
            onDragOver={(event) => handleFolderDragOver(event, null)}
            onDragLeave={() => setDropTargetFolderId(null)}
            onDrop={(event) => handleDropOnFolder(event, null)}
          >
            <button
              type="button"
              onClick={() => {
                setActiveFolderId('unfiled')
                setOpenFolderMenuId(null)
              }}
            >
              <HashIcon size={16} />
              <span>Sin carpeta</span>
              <b>{unfiledTemplateCount}</b>
            </button>
            <span className={styles.folderActionSpacer} aria-hidden="true" />
          </div>

          <div className={styles.folderList}>
            {folderRows.map(({ folder, depth }) => (
              <div
                key={folder.id}
                className={`${styles.folderRow} ${activeFolderId === folder.id ? styles.folderRowActive : ''} ${dropTargetFolderId === folder.id ? styles.folderDropActive : ''}`}
                onDragOver={(event) => handleFolderDragOver(event, folder.id)}
                onDragLeave={() => setDropTargetFolderId(null)}
                onDrop={(event) => handleDropOnFolder(event, folder.id)}
              >
                <button
                  type="button"
                  onClick={() => {
                    setActiveFolderId(folder.id)
                    setOpenFolderMenuId(null)
                  }}
                >
                  <Folder size={16} />
                  <span style={{ paddingLeft: depth ? depth * 12 : 0 }}>{folder.name}</span>
                  <b>{templateCountsByFolder.get(folder.id) || 0}</b>
                </button>
                <button
                  type="button"
                  className={styles.folderMenuButton}
                  aria-label={`Opciones de ${folder.name}`}
                  aria-expanded={openFolderMenuId === folder.id}
                  title="Opciones"
                  onClick={() => setOpenFolderMenuId((current) => current === folder.id ? null : folder.id)}
                >
                  <MoreHorizontal size={16} />
                </button>
                {openFolderMenuId === folder.id && (
                  <div className={styles.folderMenu} role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpenFolderMenuId(null)
                        confirmDeleteFolder(folder.id)
                      }}
                    >
                      <Trash2 size={14} />
                      <span>Eliminar carpeta</span>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className={styles.newFolder}>
            <input
              value={folderName}
              placeholder={isTemplateFolderId(activeFolderId) ? 'Nueva subcarpeta' : 'Nueva carpeta'}
              onChange={(event) => setFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitFolder()
              }}
            />
            <button
              type="button"
              disabled={!folderName.trim() || creatingFolder}
              onClick={() => void submitFolder()}
              aria-label="Crear carpeta"
              title="Crear carpeta"
            >
              {creatingFolder ? <Loader2 size={15} className={styles.spin} /> : <FolderPlus size={15} />}
            </button>
          </div>
        </aside>

        <main className={styles.tablePanel}>
          <div className={styles.toolbar}>
            <SearchField
              className={styles.toolbarSearch}
              value={searchTerm}
              placeholder="Buscar por nombre, texto, carpeta o estado"
              onChange={(nextSearch) => setSearchTerm(nextSearch)}
              onClear={() => setSearchTerm('')}
            />
            <div className={styles.toolbarActions}>
              <span className={styles.toolbarCount}>{visibleTemplates.length} plantillas</span>
              <Button variant="outline" onClick={syncAllTemplates} loading={syncing}>
                <RefreshCw size={16} />
                Sincronizar
              </Button>
              <Button onClick={startNewTemplate}>
                <Plus size={16} />
                Plantilla
              </Button>
            </div>
          </div>

          <div className={styles.filterBar}>
            <div className={styles.filterTitle}>
              <SlidersHorizontal size={16} />
              <span>{activeFolderName}</span>
            </div>
            <label className={styles.filterControl}>
              <span>Número</span>
              <CustomSelect
                value={templatePhoneFilter}
                onChange={(event) => setTemplatePhoneFilter(event.target.value)}
                disabled={!whatsappPhones.length}
              >
                <option value="all">{whatsappPhones.length ? 'Todos los números' : 'Sin números conectados'}</option>
                {whatsappPhones.map((phone) => (
                  <option key={phone.id} value={phone.id}>{getPhoneFilterLabel(phone)}</option>
                ))}
              </CustomSelect>
            </label>
            <label className={styles.filterControl}>
              <span>Tipo</span>
              <CustomSelect
                value={templateCategoryFilter}
                onChange={(event) => setTemplateCategoryFilter(event.target.value as 'all' | MessageTemplateCategory)}
              >
                <option value="all">Todos los tipos</option>
                {categoryOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </CustomSelect>
            </label>
            <label className={styles.filterControl}>
              <span>Estado</span>
              <CustomSelect
                value={templateStatusFilter}
                onChange={(event) => setTemplateStatusFilter(event.target.value as TemplateReviewStatusFilter)}
              >
                {reviewStatusFilterOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </CustomSelect>
            </label>
            <span className={styles.filterCount}>{visibleTemplates.length} de {bundle.templates.length}</span>
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

          {selectedTotal > 0 && (
            <div className={styles.bulkBar}>
              <strong>{selectedTotal} seleccionada{selectedTotal === 1 ? '' : 's'}</strong>
              <button type="button" onClick={toggleVisibleSelection}>
                {allVisibleSelected ? 'Quitar visibles' : 'Seleccionar visibles'}
              </button>
              <label>
                <span>Mover a</span>
                <CustomSelect value={bulkTargetFolderId} onChange={(event) => setBulkTargetFolderId(event.target.value)}>
                  <option value={ROOT_FOLDER_KEY}>Sin carpeta</option>
                  {folderOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </CustomSelect>
              </label>
              <Button variant="outline" size="sm" onClick={() => moveSelectionToFolder()} loading={bulkWorking}>
                <FolderInput size={15} />
                Mover
              </Button>
              <Button variant="outline" size="sm" onClick={syncSelectedTemplates} disabled={!selectedTemplates.length || bulkWorking}>
                <RefreshCw size={15} />
                Sincronizar
              </Button>
              <Button variant="danger" size="sm" onClick={deleteSelection} disabled={!selectedTemplates.length || bulkWorking}>
                <Trash2 size={15} />
                Eliminar
              </Button>
              <Button variant="ghost" size="sm" onClick={clearSelection} disabled={bulkWorking}>
                <X size={15} />
              </Button>
            </div>
          )}

          {visibleTemplates.length ? (
            <div className={styles.collectionTableWrap}>
              <table className={styles.collectionTable} data-ristak-table data-ristak-table-element>
                <thead>
                  <tr>
                    <th className={styles.selectionHead}>
                      <input
                        type="checkbox"
                        aria-label="Seleccionar plantillas visibles"
                        checked={allVisibleSelected}
                        onChange={toggleVisibleSelection}
                      />
                    </th>
                    <th>Plantilla</th>
                    <th>Tipo</th>
                    <th>Carpeta</th>
                    <th>Idioma</th>
                    <th>Estado</th>
                    <th aria-label="Acciones" />
                  </tr>
                </thead>
                <tbody>
                  {visibleTemplates.map((template) => {
                    const templateLockedForEditing = isTemplateUnderReviewStatus(template.ycloudStatus)
                    return (
                      <tr
                        key={template.id}
                        className={[
                          selectedTemplateIds.has(template.id) ? styles.collectionRowSelected : '',
                          templateLockedForEditing ? styles.collectionRowLocked : ''
                        ].filter(Boolean).join(' ')}
                        draggable
                        onDragStart={(event) => handleDragStart(event, template.id)}
                        onDragEnd={() => {
                          setDragging(null)
                          setDropTargetFolderId(null)
                        }}
                      >
                        <td className={styles.selectionCell}>
                          <span className={styles.dragHandle} aria-hidden="true">
                            <GripVertical size={15} />
                          </span>
                          <input
                            type="checkbox"
                            aria-label={`Seleccionar ${template.name}`}
                            checked={selectedTemplateIds.has(template.id)}
                            onChange={() => toggleTemplateSelection(template.id)}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className={styles.collectionNameButton}
                            onClick={() => editTemplate(template)}
                            disabled={templateLockedForEditing}
                            title={templateLockedForEditing ? 'En revisión: espera respuesta de Meta antes de editar' : 'Editar plantilla'}
                          >
                            <strong>{template.name}</strong>
                            <small>{template.bodyText || template.description || 'Sin texto principal'}</small>
                          </button>
                        </td>
                        <td>
                          <span className={`${styles.collectionTypeBadge} ${styles.collectionTypeTemplate}`}>
                            <FileText size={14} />
                            {getCategoryLabel(template.category)}
                          </span>
                        </td>
                        <td>{folderMap.get(template.folderId || '')?.name || 'Sin carpeta'}</td>
                        <td>{template.language}</td>
                        <td>
                          <span className={`${styles.ycloudBadge} ${styles[`ycloudBadge${getYCloudStatusTone(template.ycloudStatus)}`]}`}>
                            {getYCloudStatusLabel(template.ycloudStatus)}
                          </span>
                        </td>
                        <td>
                          <div className={styles.collectionTableActions}>
                            <button
                              type="button"
                              className={styles.iconButton}
                              onClick={() => editTemplate(template)}
                              disabled={templateLockedForEditing}
                              aria-label={templateLockedForEditing ? `${template.name} está en revisión` : `Editar ${template.name}`}
                              title={templateLockedForEditing ? 'En revisión' : 'Editar'}
                            >
                              <Edit3 size={15} />
                            </button>
                            <button type="button" className={styles.iconButton} onClick={() => confirmDeleteTemplate(template)} aria-label={`Eliminar ${template.name}`} title="Eliminar">
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
          ) : (
            <div className={styles.emptyState}>
              <ListTree size={28} />
              <strong>{emptyTitle}</strong>
              <span>{hasTemplateFilters ? 'Prueba con otro número, tipo o estado.' : 'Crea una plantilla nueva o cambia de carpeta.'}</span>
            </div>
          )}
        </main>
      </div>
    )
  }

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

  const renderEditor = () => {
    const draftLockedForEditing = isTemplateUnderReviewStatus(draft.ycloudStatus)

    return (
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
              <Button variant="secondary" onClick={saveTemplate} loading={saving} disabled={draftLockedForEditing}>
                <Save size={16} />
                Guardar
              </Button>
              <Button onClick={submitTemplate} loading={submitting} disabled={draftLockedForEditing}>
                <UploadCloud size={16} />
                Enviar a revisión
              </Button>
            </div>
          </div>

          {draftLockedForEditing && (
            <div className={styles.editorLockNotice}>
              <UploadCloud size={17} />
              <span>Esta plantilla está en revisión. Espera la respuesta de Meta antes de editarla otra vez.</span>
            </div>
          )}

          <fieldset className={styles.editorFieldset} disabled={draftLockedForEditing}>
          <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>Nombre</span>
            <input
              value={draft.name}
              onChange={(event) => updateDraft('name', normalizeTemplateNameDraftInput(event.target.value))}
              onBlur={() => updateDraft('name', normalizeTemplateNameInput(draft.name))}
              placeholder="recordatorio_cita"
            />
          </label>
          <label className={styles.field}>
            <span>Categoría</span>
            <CustomSelect value={draft.category} onChange={(event) => updateDraft('category', event.target.value as MessageTemplateCategory)}>
              {categoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </CustomSelect>
          </label>
          <label className={styles.field}>
            <span>Idioma</span>
            <CustomSelect value={draft.language} onChange={(event) => updateDraft('language', event.target.value)}>
              {languageOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </CustomSelect>
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
                  <CustomSelect value={button.type} onChange={(event) => updateButton(index, { type: event.target.value as MessageTemplateButtonType })}>
                    {buttonTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </CustomSelect>
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
        </fieldset>
      </section>

      <div className={styles.editorSide}>
        {renderPreview()}
      </div>
    </div>
  )}

  if (loading) {
    return <Loading page="settings-list" />
  }

  return (
    <div className={`${styles.container} ${embedded ? styles.embedded : ''}`}>
      {!embedded && (
        <PageHeader
          title={title}
          subtitle={subtitle}
          actions={
            <Button variant="secondary" onClick={loadBundle}>
              <ListTree size={16} />
              Refrescar
            </Button>
          }
        />
      )}

      {view === 'list' ? renderList() : renderEditor()}
    </div>
  )
}
