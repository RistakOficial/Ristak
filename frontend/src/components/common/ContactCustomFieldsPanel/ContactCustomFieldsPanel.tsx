import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { Check, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { CustomSelect } from '@/components/common/CustomSelect'
import { NumberInput } from '@/components/common/NumberInput'
import {
  customFieldsService,
  isSystemCustomFieldDefinition,
  type CustomFieldDefinition,
  type CustomFieldFolder,
  type CustomFieldOption
} from '@/services/customFieldsService'
import type { ContactCustomField, ContactCustomFieldDefinition, ContactCustomFieldValue } from '@/types'
import {
  formatContactCustomFieldDisplayValue,
  getContactCustomFieldDisplayLabel,
  getContactCustomFieldIdentity,
  getContactCustomFieldKeys,
  isReservedContactCustomField
} from '@/utils/contactCustomFields'
import { formatDateToISO } from '@/utils/format'
import { useTimezone } from '@/contexts/TimezoneContext'
import { cn } from '@/utils/cn'
import styles from './ContactCustomFieldsPanel.module.css'

type CatalogDefinition = Partial<ContactCustomFieldDefinition & CustomFieldDefinition>
type DraftValue = string | number | boolean | string[] | null | Record<string, unknown> | unknown[]
type Surface = 'desktop' | 'phone'

interface EditableCustomField extends ContactCustomField {
  folderId?: string | null
  folderName?: string | null
  fieldGroup?: string | null
}

interface FieldGroup {
  id: string
  label: string
  fields: EditableCustomField[]
}

export interface ContactCustomFieldsPanelProps {
  contactId?: string | null
  customFields?: ContactCustomField[]
  definitions?: CatalogDefinition[]
  folders?: CustomFieldFolder[]
  onUpdateCustomFields?: (contactId: string, customFields: ContactCustomField[]) => Promise<ContactCustomField[]>
  onCustomFieldsChange?: (customFields: ContactCustomField[]) => void
  title?: string
  emptyText?: string
  className?: string
  surface?: Surface
  collapsible?: boolean
  defaultExpanded?: boolean
  compact?: boolean
}

const FIELD_TYPE_LABELS: Record<string, string> = {
  text: 'Texto',
  textarea: 'Parrafo',
  radio: 'Radio buttons',
  dropdown: 'Dropdown',
  select: 'Dropdown',
  checkboxes: 'Checkboxes',
  multiselect: 'Checkboxes',
  checkbox: 'Checkbox',
  boolean: 'Si/No',
  number: 'Numero',
  currency: 'Moneda',
  date: 'Fecha',
  datetime: 'Fecha y hora',
  time: 'Hora',
  email: 'Email',
  phone: 'Telefono',
  url: 'URL',
  file: 'Archivo',
  json: 'JSON'
}

const choiceTypes = new Set(['radio', 'dropdown', 'select'])
const multiChoiceTypes = new Set(['checkboxes', 'multiselect'])
const booleanTypes = new Set(['checkbox', 'boolean'])
const numericTypes = new Set(['number', 'currency'])
const textAreaTypes = new Set(['textarea', 'json', 'file'])

const cleanString = (value: unknown) => String(value || '').trim()

const normalizeType = (value?: string | null) => {
  const type = cleanString(value).toLowerCase()
  if (type === 'select') return 'dropdown'
  if (type === 'multiselect') return 'checkboxes'
  return type || 'text'
}

const stableStringify = (value: unknown) => {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return String(value ?? '')
  }
}

const uniqueStrings = (...groups: unknown[][]) => {
  const seen = new Set<string>()
  const result: string[] = []

  groups.flat().forEach((value) => {
    const next = cleanString(value)
    if (!next || seen.has(next)) return
    seen.add(next)
    result.push(next)
  })

  return result
}

const normalizeOptions = (options: unknown[] = []): CustomFieldOption[] => (
  options
    .map((option) => {
      if (option && typeof option === 'object') {
        const item = option as Record<string, unknown>
        const value = cleanString(item.value || item.label || item.name)
        const label = cleanString(item.label || item.name || item.value)
        return value || label ? { value: value || label, label: label || value } : null
      }

      const value = cleanString(option)
      return value ? { value, label: value } : null
    })
    .filter((option): option is CustomFieldOption => Boolean(option))
)

const fieldIdentity = (field: Partial<ContactCustomField>, index = 0) =>
  getContactCustomFieldIdentity(field) ||
  cleanString(field.definitionId) ||
  cleanString(field.fieldKey) ||
  cleanString(field.key) ||
  cleanString(field.id) ||
  `custom-field-${index}`

const getAllFieldKeys = (field?: Partial<ContactCustomField | CatalogDefinition> | null) =>
  uniqueStrings(
    getContactCustomFieldKeys(field),
    [
      (field as CatalogDefinition | undefined)?.definitionId,
      (field as ContactCustomField | undefined)?.id,
      field?.key,
      field?.fieldKey,
      field?.label,
      field?.name
    ]
  )

const findMatchingValueField = (fields: ContactCustomField[], definition: CatalogDefinition) => {
  const definitionKeys = new Set(getAllFieldKeys(definition))
  if (!definitionKeys.size) return null

  return fields.find((field) => getAllFieldKeys(field).some((key) => definitionKeys.has(key))) || null
}

const isHiddenDefinition = (definition: CatalogDefinition) =>
  isSystemCustomFieldDefinition(definition as Partial<CustomFieldDefinition>) ||
  isReservedContactCustomField(definition)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const optionValueFromItem = (value: unknown) => {
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>
    return cleanString(item.value || item.label || item.name)
  }

  return cleanString(value)
}

const toChoiceArray = (value: ContactCustomFieldValue | undefined) => {
  if (Array.isArray(value)) return value.map(optionValueFromItem).filter(Boolean)
  const single = optionValueFromItem(value)
  return single ? [single] : []
}

const formatDateDraft = (value: ContactCustomFieldValue | undefined, timezone: string) => {
  const raw = cleanString(value)
  if (!raw) return ''

  try {
    return formatDateToISO(raw, { timezone })
  } catch {
    return raw
  }
}

const formatDraftValue = (field: EditableCustomField, timezone: string): DraftValue => {
  const type = normalizeType(field.dataType)

  if (multiChoiceTypes.has(type)) return toChoiceArray(field.value)
  if (booleanTypes.has(type)) {
    if (typeof field.value === 'boolean') return field.value
    const normalized = cleanString(field.value).toLowerCase()
    return ['true', '1', 'si', 'sí', 'yes'].includes(normalized)
  }
  if (numericTypes.has(type)) return field.value === null || field.value === undefined ? '' : String(field.value)
  if (type === 'date') return formatDateDraft(field.value, timezone)
  if (Array.isArray(field.value) || isPlainObject(field.value)) return JSON.stringify(field.value, null, 2)
  return field.value === null || field.value === undefined ? '' : String(field.value)
}

const buildDrafts = (fields: EditableCustomField[], timezone: string) =>
  fields.reduce<Record<string, DraftValue>>((drafts, field, index) => {
    drafts[fieldIdentity(field, index)] = formatDraftValue(field, timezone)
    return drafts
  }, {})

const parseJsonDraft = (draft: string) => {
  try {
    return JSON.parse(draft)
  } catch {
    throw new Error('Ese campo espera JSON valido.')
  }
}

const parseDraftForSave = (draft: DraftValue, field: EditableCustomField): ContactCustomFieldValue => {
  const type = normalizeType(field.dataType)

  if (multiChoiceTypes.has(type)) {
    if (Array.isArray(draft)) return draft.map(optionValueFromItem).filter(Boolean)
    const value = cleanString(draft)
    if (!value) return []
    if (value.startsWith('[')) return parseJsonDraft(value) as ContactCustomFieldValue
    return value.split(',').map(item => item.trim()).filter(Boolean)
  }

  if (booleanTypes.has(type)) {
    if (typeof draft === 'boolean') return draft
    return ['true', '1', 'si', 'sí', 'yes'].includes(cleanString(draft).toLowerCase())
  }

  if (numericTypes.has(type)) {
    const value = cleanString(draft)
    if (!value) return null
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) throw new Error('Ese campo espera un numero valido.')
    return parsed
  }

  if (type === 'json' || type === 'file' || Array.isArray(field.value) || isPlainObject(field.value)) {
    const value = cleanString(draft)
    if (!value) return type === 'json' || isPlainObject(field.value) ? {} : null
    if (value.startsWith('{') || value.startsWith('[')) return parseJsonDraft(value) as ContactCustomFieldValue
    return value
  }

  return draft === null || draft === undefined ? '' : String(draft)
}

const comparableDraft = (draft: DraftValue, field: EditableCustomField) =>
  stableStringify(parseDraftForSave(draft, field))

const inputTypeForField = (field: EditableCustomField) => {
  const type = normalizeType(field.dataType)
  if (type === 'email') return 'email'
  if (type === 'phone') return 'tel'
  if (type === 'url') return 'url'
  if (type === 'date') return 'date'
  return 'text'
}

const fieldTypeLabel = (field: EditableCustomField) =>
  FIELD_TYPE_LABELS[normalizeType(field.dataType)] || field.dataType || 'Texto'

const buildFieldFromDefinition = (definition: CatalogDefinition, valueField: ContactCustomField | null, index: number): EditableCustomField => {
  const options = normalizeOptions(
    (definition.options?.length ? definition.options : valueField?.options || []) as unknown[]
  )
  const fieldKey = cleanString(definition.fieldKey || definition.key || valueField?.fieldKey || valueField?.key)
  const definitionId = cleanString(definition.definitionId || valueField?.definitionId)

  return {
    ...valueField,
    id: valueField?.id || definitionId || fieldKey || `custom-field-${index}`,
    definitionId: definitionId || valueField?.definitionId || null,
    key: valueField?.key || definition.key || fieldKey || null,
    fieldKey: valueField?.fieldKey || definition.fieldKey || fieldKey || null,
    label: definition.label || valueField?.label || valueField?.name || fieldKey || `Campo ${index + 1}`,
    name: definition.name || definition.label || valueField?.name || valueField?.label || fieldKey || `Campo ${index + 1}`,
    dataType: definition.dataType || valueField?.dataType || 'text',
    options,
    folderId: definition.folderId || valueField?.folderId || null,
    folderName: definition.folderName || valueField?.folderName || null,
    fieldGroup: definition.fieldGroup || valueField?.fieldGroup || null,
    value: valueField?.value ?? null,
    syncTarget: valueField?.syncTarget || definition.syncTarget || null,
    sourceType: valueField?.sourceType || definition.sourceType || null,
    sourceId: valueField?.sourceId || definition.sourceId || null,
    sourceSiteId: valueField?.sourceSiteId || definition.sourceSiteId || null,
    sourcePageId: valueField?.sourcePageId || definition.sourcePageId || null,
    sourceFormId: valueField?.sourceFormId || definition.sourceFormId || null,
    sourceFormName: valueField?.sourceFormName || definition.sourceFormName || null,
    sourceFieldId: valueField?.sourceFieldId || definition.sourceFieldId || null,
    sourceFieldName: valueField?.sourceFieldName || definition.sourceFieldName || null,
    sourceLabel: valueField?.sourceLabel || definition.sourceLabel || null,
    sourceContext: valueField?.sourceContext || definition.sourceContext || null
  }
}

const buildEditableFields = (
  definitions: CatalogDefinition[],
  fields: ContactCustomField[]
) => {
  const visibleDefinitions = definitions.filter(definition => !isHiddenDefinition(definition))

  return visibleDefinitions.map((definition, index) => {
    const valueField = findMatchingValueField(fields, definition)
    return buildFieldFromDefinition(definition, valueField, index)
  })
}

const buildGroups = (
  fields: EditableCustomField[],
  folders: CustomFieldFolder[],
  unfiledLabel: string
): FieldGroup[] => {
  const byGroup = new Map<string, FieldGroup>()
  const folderById = new Map(folders.map(folder => [folder.id, folder]))

  const ensureGroup = (id: string, label: string) => {
    const current = byGroup.get(id)
    if (current) return current

    const group = { id, label, fields: [] }
    byGroup.set(id, group)
    return group
  }

  fields.forEach((field) => {
    const folderId = cleanString(field.folderId)
    const folder = folderId ? folderById.get(folderId) : null
    // Los campos dentro de una carpeta forman su propia seccion (nombre de la
    // carpeta). Los que NO tienen carpeta caen todos en un unico grupo
    // "sin archivar" etiquetado con `unfiledLabel` (por defecto "Campos
    // personalizados"), para que no se dupliquen headers.
    const folderLabel = folder?.name || field.folderName || field.fieldGroup
    const label = folderLabel || unfiledLabel
    const groupId = folderId || (folderLabel ? `group:${folderLabel}` : 'unfiled')
    ensureGroup(groupId, label).fields.push(field)
  })

  const folderOrder = new Map(folders.map((folder, index) => [folder.id, index]))

  // Orden: primero las carpetas reales (en su orden), luego cualquier grupo
  // heredado por nombre, y SIEMPRE al final el grupo "sin archivar"
  // (unfiled = "Campos personalizados"), como pidio el usuario.
  const orderOf = (group: FieldGroup) => {
    if (group.id === 'unfiled') return Number.MAX_SAFE_INTEGER
    if (folderOrder.has(group.id)) return folderOrder.get(group.id)!
    return Number.MAX_SAFE_INTEGER - 1
  }

  return [...byGroup.values()]
    .map(group => ({
      ...group,
      fields: group.fields.sort((left, right) =>
        getContactCustomFieldDisplayLabel(left).localeCompare(getContactCustomFieldDisplayLabel(right), 'es')
      )
    }))
    .sort((left, right) => {
      const orderDiff = orderOf(left) - orderOf(right)
      if (orderDiff !== 0) return orderDiff
      return left.label.localeCompare(right.label, 'es')
    })
}

export function ContactCustomFieldsPanel({
  contactId,
  customFields = [],
  definitions,
  folders,
  onUpdateCustomFields,
  onCustomFieldsChange,
  title = 'Campos personalizados',
  emptyText = 'Todavia no hay campos personalizados guardados.',
  className,
  surface = 'desktop',
  collapsible = true,
  defaultExpanded = false,
  compact = false
}: ContactCustomFieldsPanelProps) {
  const { timezone } = useTimezone()
  const [catalogFields, setCatalogFields] = useState<CatalogDefinition[]>([])
  const [catalogFolders, setCatalogFolders] = useState<CustomFieldFolder[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  const [drafts, setDrafts] = useState<Record<string, DraftValue>>({})
  const [savingFieldId, setSavingFieldId] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [localCustomFields, setLocalCustomFields] = useState<ContactCustomField[]>(customFields)

  const externalCatalog = Boolean(definitions || folders)
  const customFieldsFingerprint = useMemo(() => stableStringify(customFields), [customFields])

  useEffect(() => {
    setLocalCustomFields(customFields)
  }, [contactId, customFieldsFingerprint])

  useEffect(() => {
    if (externalCatalog) return

    let alive = true
    setCatalogLoading(true)
    setCatalogError('')

    customFieldsService.listCatalog()
      .then((catalog) => {
        if (!alive) return
        setCatalogFields((catalog.fields || []) as CatalogDefinition[])
        setCatalogFolders(catalog.folders || [])
      })
      .catch((error) => {
        if (!alive) return
        setCatalogError(error instanceof Error ? error.message : 'No se pudieron cargar los campos.')
      })
      .finally(() => {
        if (alive) setCatalogLoading(false)
      })

    return () => {
      alive = false
    }
  }, [externalCatalog])

  const effectiveDefinitions = useMemo(
    () => ((definitions || catalogFields) as CatalogDefinition[]).filter(definition => !definition.archived),
    [catalogFields, definitions]
  )

  const effectiveFolders = useMemo(
    () => (folders || catalogFolders).filter(folder => !folder.archived),
    [catalogFolders, folders]
  )

  const editableFields = useMemo(
    () => buildEditableFields(effectiveDefinitions, localCustomFields || []),
    [effectiveDefinitions, localCustomFields]
  )
  const groups = useMemo(
    () => buildGroups(editableFields, effectiveFolders, title),
    [editableFields, effectiveFolders, title]
  )
  const groupFingerprint = useMemo(() => stableStringify(groups.map(group => [group.id, group.fields.map(field => fieldIdentity(field))])), [groups])
  const valuesFingerprint = useMemo(
    () => stableStringify(editableFields.map((field, index) => [fieldIdentity(field, index), field.value])),
    [editableFields]
  )

  useEffect(() => {
    setDrafts(buildDrafts(editableFields, timezone))
  }, [contactId, valuesFingerprint, timezone])

  useEffect(() => {
    setExpandedGroups(defaultExpanded ? new Set(groups.map(group => group.id)) : new Set())
  }, [contactId, groupFingerprint, defaultExpanded])

  const updateDraft = (identity: string, value: DraftValue) => {
    setDrafts(current => ({ ...current, [identity]: value }))
    setFieldError(null)
  }

  const saveField = async (field: EditableCustomField, index: number) => {
    if (!contactId || !onUpdateCustomFields) return

    const identity = fieldIdentity(field, index)
    const draft = drafts[identity] ?? formatDraftValue(field, timezone)

    try {
      const value = parseDraftForSave(draft, field)
      const updatedField: ContactCustomField = {
        ...field,
        value
      }

      setSavingFieldId(identity)
      setFieldError(null)

      const nextCustomFields = await onUpdateCustomFields(contactId, [updatedField])
      setLocalCustomFields(nextCustomFields)
      setDrafts(buildDrafts(buildEditableFields(effectiveDefinitions, nextCustomFields), timezone))
      onCustomFieldsChange?.(nextCustomFields)
    } catch (error) {
      setFieldError(error instanceof Error ? error.message : 'No se pudo guardar el campo personalizado.')
    } finally {
      setSavingFieldId(null)
    }
  }

  const renderTextControl = (field: EditableCustomField, identity: string, disabled: boolean, multiline = false) => {
    const value = String(drafts[identity] ?? '')
    const commonProps = {
      id: identity,
      className: styles.input,
      value,
      disabled,
      readOnly: !onUpdateCustomFields,
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => updateDraft(identity, event.target.value)
    }

    if (multiline) {
      return (
        <textarea
          {...commonProps}
          className={cn(styles.input, styles.textarea)}
          rows={compact ? 3 : 4}
        />
      )
    }

    return (
      <input
        {...commonProps}
        type={inputTypeForField(field)}
      />
    )
  }

  const renderChoiceControl = (field: EditableCustomField, identity: string, disabled: boolean) => {
    const type = normalizeType(field.dataType)
    const options = normalizeOptions(field.options || [])
    const draft = drafts[identity]

    if (choiceTypes.has(type) && options.length > 0) {
      if (type === 'radio') {
        const selectedValue = String(draft ?? '')
        return (
          <div className={styles.choiceStack} role="radiogroup" aria-labelledby={`${identity}-label`}>
            {options.map(option => (
              <label key={option.value} className={styles.choiceOption}>
                <input
                  type="radio"
                  name={identity}
                  value={option.value}
                  checked={selectedValue === option.value}
                  disabled={disabled || !onUpdateCustomFields}
                  onChange={() => updateDraft(identity, option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        )
      }

      return (
        <CustomSelect
          className={styles.select}
          value={String(draft ?? '')}
          options={[{ value: '', label: 'Sin dato' }, ...options]}
          onValueChange={(value) => updateDraft(identity, value)}
          disabled={disabled || !onUpdateCustomFields}
          placeholder="Sin dato"
        />
      )
    }

    if (multiChoiceTypes.has(type) && options.length > 0) {
      const selectedValues = Array.isArray(draft) ? draft.map(String) : []
      return (
        <div className={styles.choiceStack} aria-labelledby={`${identity}-label`}>
          {options.map(option => {
            const checked = selectedValues.includes(option.value)
            return (
              <label key={option.value} className={styles.choiceOption}>
                <input
                  type="checkbox"
                  value={option.value}
                  checked={checked}
                  disabled={disabled || !onUpdateCustomFields}
                  onChange={(event) => {
                    const nextValues = event.target.checked
                      ? [...selectedValues, option.value]
                      : selectedValues.filter(value => value !== option.value)
                    updateDraft(identity, nextValues)
                  }}
                />
                <span>{option.label}</span>
              </label>
            )
          })}
        </div>
      )
    }

    if (booleanTypes.has(type)) {
      return (
        <label className={styles.booleanOption}>
          <input
            type="checkbox"
            checked={Boolean(draft)}
            disabled={disabled || !onUpdateCustomFields}
            onChange={(event) => updateDraft(identity, event.target.checked)}
          />
          <span>Activo</span>
        </label>
      )
    }

    return null
  }

  const renderFieldControl = (field: EditableCustomField, index: number) => {
    const identity = fieldIdentity(field, index)
    const type = normalizeType(field.dataType)
    const isSaving = savingFieldId === identity
    const draft = drafts[identity] ?? formatDraftValue(field, timezone)
    const original = formatDraftValue(field, timezone)
    let hasChanges = false

    try {
      hasChanges = comparableDraft(draft, field) !== comparableDraft(original, field)
    } catch {
      hasChanges = stableStringify(draft) !== stableStringify(original)
    }

    const disabled = isSaving || catalogLoading
    const choiceControl = renderChoiceControl(field, identity, disabled)

    return (
      <div key={identity} className={styles.fieldRow}>
        <label id={`${identity}-label`} className={styles.fieldLabel} htmlFor={identity}>
          <span>{getContactCustomFieldDisplayLabel(field, index)}</span>
          <small>{fieldTypeLabel(field)}</small>
        </label>
        <div className={styles.fieldControl}>
          {choiceControl || (
            numericTypes.has(type) ? (
              <NumberInput
                id={identity}
                className={styles.input}
                value={String(draft ?? '')}
                disabled={disabled}
                readOnly={!onUpdateCustomFields}
                step={type === 'currency' ? '0.01' : '1'}
                onChange={(event) => updateDraft(identity, event.target.value)}
              />
            ) : renderTextControl(field, identity, disabled, textAreaTypes.has(type))
          )}
          {onUpdateCustomFields && hasChanges ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={styles.saveButton}
              onClick={() => saveField(field, index)}
              disabled={isSaving}
              leftIcon={isSaving ? <Loader2 size={14} className={styles.spin} /> : <Check size={14} />}
            >
              {isSaving ? 'Guardando' : 'Guardar'}
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  // Cada grupo (carpeta o "sin archivar") se pinta como una seccion propia de
  // primer nivel, con el MISMO header. Asi las carpetas quedan al lado de
  // "Campos personalizados" en vez de anidadas dentro de el.
  const renderGroupSection = (group: FieldGroup) => {
    const groupOpen = !collapsible || expandedGroups.has(group.id)

    const toggleGroup = () => {
      setExpandedGroups(current => {
        const next = new Set(current)
        if (next.has(group.id)) next.delete(group.id)
        else next.add(group.id)
        return next
      })
    }

    return (
      <section key={group.id} className={styles.group}>
        {collapsible ? (
          <button
            type="button"
            className={styles.groupHeader}
            onClick={toggleGroup}
            aria-expanded={groupOpen}
            data-ristak-unstyled
          >
            <span>
              {groupOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              <strong>{group.label}</strong>
            </span>
            <small>{group.fields.length}</small>
          </button>
        ) : (
          <div className={styles.groupHeader} data-static="true">
            <span>
              <strong>{group.label}</strong>
            </span>
            <small>{group.fields.length}</small>
          </div>
        )}
        {groupOpen ? (
          <div className={styles.fields}>
            {group.fields.map(renderFieldControl)}
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <section
      className={cn(styles.panel, className)}
      data-cfp-variant={surface}
      data-cfp-compact={compact ? 'true' : undefined}
    >
      {catalogLoading ? (
        <div className={styles.loading} role="status" aria-live="polite">
          <Loader2 size={16} className={styles.spin} />
          <span>Cargando campos...</span>
        </div>
      ) : catalogError ? (
        <p className={styles.errorText}>{catalogError}</p>
      ) : groups.length === 0 ? (
        <div className={styles.group}>
          <div className={styles.groupHeader} data-static="true">
            <span>
              <strong>{title}</strong>
            </span>
            <small>0</small>
          </div>
          <p className={styles.emptyText}>{emptyText}</p>
        </div>
      ) : (
        <div className={styles.groupList}>
          {groups.map(renderGroupSection)}
        </div>
      )}
      {fieldError ? <p className={styles.errorText}>{fieldError}</p> : null}
    </section>
  )
}
