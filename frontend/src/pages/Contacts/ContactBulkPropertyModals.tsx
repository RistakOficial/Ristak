import React, { useEffect, useMemo, useState } from 'react'
import { Check, Tags } from 'lucide-react'
import { Button, CustomSelect, Modal, TagPicker } from '@/components/common'
import { contactTagsService } from '@/services/contactTagsService'
import { contactsService, type Contact } from '@/services/contactsService'
import { useNotification } from '@/contexts/NotificationContext'
import type { ContactCustomField, ContactCustomFieldDefinition, ContactCustomFieldValue } from '@/types'
import styles from './Contacts.module.css'

type BulkTagMode = 'add' | 'remove'

interface BulkTagResult {
  updated: number
  total: number
}

interface BulkCustomFieldResult {
  updated: number
  total: number
  customFields: ContactCustomField[]
}

interface ContactBulkPropertyModalsProps {
  selectedContacts: Contact[]
  tagsOpen: boolean
  customFieldsOpen: boolean
  onCloseTags: () => void
  onCloseCustomFields: () => void
  onTagsApplied: (input: { mode: BulkTagMode; tagIds: string[]; result: BulkTagResult }) => void
  onCustomFieldsApplied: (input: { customFields: ContactCustomField[]; result: BulkCustomFieldResult }) => void
}

const tagModeOptions = [
  { value: 'add', label: 'Añadir etiqueta' },
  { value: 'remove', label: 'Eliminar etiqueta' }
]

const customFieldValueInputTypes = new Set(['text', 'email', 'phone', 'url', 'number', 'currency', 'date', 'datetime', 'time'])
const longTextTypes = new Set(['textarea', 'json'])
const booleanTypes = new Set(['boolean', 'checkbox'])
const choiceTypes = new Set(['dropdown', 'radio', 'select'])
const multiValueTypes = new Set(['checkboxes', 'multiselect'])

const cleanString = (value: unknown) => String(value || '').trim()

const getCustomFieldIdentity = (field: ContactCustomFieldDefinition) =>
  field.definitionId || field.fieldKey || field.key || field.label

const getCustomFieldLabel = (field: ContactCustomFieldDefinition) =>
  `${field.label || field.name || field.fieldKey || field.key}${field.folderName ? ` · ${field.folderName}` : ''}`

const normalizeOption = (option: unknown) => {
  if (option && typeof option === 'object') {
    const item = option as Record<string, unknown>
    const label = cleanString(item.label || item.name || item.value)
    const value = cleanString(item.value || item.label || item.name)
    return { label: label || value, value: value || label }
  }
  const value = cleanString(option)
  return { label: value, value }
}

const normalizeDataType = (value?: string | null) => cleanString(value || 'text').toLowerCase()

const parseCustomFieldValue = (rawValue: string, field?: ContactCustomFieldDefinition | null): ContactCustomFieldValue => {
  const dataType = normalizeDataType(field?.dataType)
  const value = rawValue.trim()

  if (booleanTypes.has(dataType)) return value === 'true'
  if (multiValueTypes.has(dataType)) {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (['number', 'currency'].includes(dataType)) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }
  if (dataType === 'json' && value) {
    try {
      return JSON.parse(value) as ContactCustomFieldValue
    } catch {
      return value
    }
  }

  return value
}

const buildCustomFieldPayload = (field: ContactCustomFieldDefinition, value: string): ContactCustomField => ({
  definitionId: field.definitionId,
  key: field.key || field.fieldKey,
  fieldKey: field.fieldKey || field.key,
  label: field.label,
  name: field.name || field.label,
  dataType: field.dataType,
  options: field.options || [],
  syncTarget: field.syncTarget,
  sourceType: field.sourceType,
  sourceId: field.sourceId,
  sourceSiteId: field.sourceSiteId,
  sourcePageId: field.sourcePageId,
  sourceFormId: field.sourceFormId,
  sourceFormName: field.sourceFormName,
  sourceFieldId: field.sourceFieldId,
  sourceFieldName: field.sourceFieldName,
  sourceLabel: field.sourceLabel,
  sourceContext: field.sourceContext,
  value: parseCustomFieldValue(value, field)
})

export const ContactBulkPropertyModals: React.FC<ContactBulkPropertyModalsProps> = ({
  selectedContacts,
  tagsOpen,
  customFieldsOpen,
  onCloseTags,
  onCloseCustomFields,
  onTagsApplied,
  onCustomFieldsApplied
}) => {
  const { showToast } = useNotification()
  const selectedIds = useMemo(() => selectedContacts.map((contact) => contact.id), [selectedContacts])
  const selectedCount = selectedContacts.length

  const [tagMode, setTagMode] = useState<BulkTagMode>('add')
  const [tagId, setTagId] = useState('')
  const [applyingTags, setApplyingTags] = useState(false)

  const [customFieldDefinitions, setCustomFieldDefinitions] = useState<ContactCustomFieldDefinition[]>([])
  const [customFieldsLoading, setCustomFieldsLoading] = useState(false)
  const [customFieldId, setCustomFieldId] = useState('')
  const [customFieldValue, setCustomFieldValue] = useState('')
  const [applyingCustomField, setApplyingCustomField] = useState(false)

  const availableCustomFields = useMemo(
    () => customFieldDefinitions.filter((field) => !field.archived && field.sourceType !== 'system'),
    [customFieldDefinitions]
  )
  const selectedCustomField = availableCustomFields.find((field) => getCustomFieldIdentity(field) === customFieldId) || null
  const selectedCustomFieldType = normalizeDataType(selectedCustomField?.dataType)
  const selectedCustomFieldOptions = useMemo(
    () => (selectedCustomField?.options || []).map(normalizeOption).filter((option) => option.value || option.label),
    [selectedCustomField?.options]
  )

  useEffect(() => {
    if (!tagsOpen) return
    setTagMode('add')
    setTagId('')
  }, [tagsOpen])

  useEffect(() => {
    if (!customFieldsOpen) return
    setCustomFieldValue('')
    setCustomFieldsLoading(true)
    contactsService.getCustomFieldDefinitions()
      .then((definitions) => {
        const activeDefinitions = Array.isArray(definitions) ? definitions.filter((field) => !field.archived && field.sourceType !== 'system') : []
        setCustomFieldDefinitions(activeDefinitions)
        setCustomFieldId((current) => current || (activeDefinitions[0] ? getCustomFieldIdentity(activeDefinitions[0]) : ''))
      })
      .catch((error) => {
        showToast('error', 'No se pudieron cargar campos', error instanceof Error ? error.message : 'Intenta otra vez.')
      })
      .finally(() => setCustomFieldsLoading(false))
  }, [customFieldsOpen, showToast])

  useEffect(() => {
    setCustomFieldValue(booleanTypes.has(selectedCustomFieldType) ? 'true' : '')
  }, [selectedCustomFieldType, customFieldId])

  const closeTags = () => {
    if (applyingTags) return
    onCloseTags()
  }

  const closeCustomFields = () => {
    if (applyingCustomField) return
    onCloseCustomFields()
  }

  const submitTags = async () => {
    if (!tagId || selectedIds.length === 0) return
    setApplyingTags(true)
    try {
      const result = await contactTagsService.bulkUpdateTags(
        selectedIds,
        tagMode === 'add' ? [tagId] : [],
        tagMode === 'remove' ? [tagId] : []
      )
      onTagsApplied({ mode: tagMode, tagIds: [tagId], result })
      onCloseTags()
      showToast(
        'success',
        tagMode === 'add' ? 'Etiqueta añadida' : 'Etiqueta eliminada',
        `Se actualizaron ${result.updated} de ${selectedCount} contactos.`
      )
    } catch (error) {
      showToast('error', 'No se pudo aplicar la etiqueta', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      setApplyingTags(false)
    }
  }

  const submitCustomField = async () => {
    if (!selectedCustomField || selectedIds.length === 0) return
    if (!booleanTypes.has(selectedCustomFieldType) && !customFieldValue.trim()) {
      showToast('error', 'Falta el valor', 'Escribe el valor que quieres guardar en los contactos.')
      return
    }

    const customField = buildCustomFieldPayload(selectedCustomField, customFieldValue)
    setApplyingCustomField(true)
    try {
      const result = await contactsService.bulkUpdateCustomFields(selectedIds, [customField])
      onCustomFieldsApplied({ customFields: result.customFields || [customField], result })
      onCloseCustomFields()
      showToast('success', 'Campo guardado', `Se actualizaron ${result.updated} de ${selectedCount} contactos.`)
    } catch (error) {
      showToast('error', 'No se pudo guardar el campo', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      setApplyingCustomField(false)
    }
  }

  const renderCustomFieldValueControl = () => {
    if (!selectedCustomField) {
      return (
        <input
          value=""
          placeholder={customFieldsLoading ? 'Cargando campos...' : 'No hay campos personalizados'}
          disabled
        />
      )
    }

    if (booleanTypes.has(selectedCustomFieldType)) {
      return (
        <CustomSelect
          portal
          value={customFieldValue}
          onValueChange={setCustomFieldValue}
          disabled={applyingCustomField}
          options={[
            { value: 'true', label: 'Sí' },
            { value: 'false', label: 'No' }
          ]}
        />
      )
    }

    if (choiceTypes.has(selectedCustomFieldType) && selectedCustomFieldOptions.length > 0) {
      return (
        <CustomSelect
          portal
          value={customFieldValue}
          onValueChange={setCustomFieldValue}
          disabled={applyingCustomField}
          placeholder="Selecciona un valor"
          options={selectedCustomFieldOptions}
        />
      )
    }

    if (longTextTypes.has(selectedCustomFieldType) || multiValueTypes.has(selectedCustomFieldType)) {
      return (
        <textarea
          value={customFieldValue}
          onChange={(event) => setCustomFieldValue(event.target.value)}
          disabled={applyingCustomField}
          rows={multiValueTypes.has(selectedCustomFieldType) ? 3 : 4}
          placeholder={multiValueTypes.has(selectedCustomFieldType) ? 'Escribe valores separados por coma' : 'Escribe el valor'}
        />
      )
    }

    const inputType = customFieldValueInputTypes.has(selectedCustomFieldType)
      ? selectedCustomFieldType === 'datetime'
        ? 'datetime-local'
        : selectedCustomFieldType === 'currency'
          ? 'number'
          : selectedCustomFieldType
      : 'text'

    return (
      <input
        type={inputType}
        value={customFieldValue}
        onChange={(event) => setCustomFieldValue(event.target.value)}
        disabled={applyingCustomField}
        placeholder="Escribe el valor"
      />
    )
  }

  return (
    <>
      <Modal
        isOpen={tagsOpen}
        onClose={closeTags}
        title="Etiquetas"
        size="sm"
        className={styles.bulkActionModal}
        contentClassName={styles.bulkActionModalContent}
      >
        <div className={styles.bulkModalBody}>
          <p className={styles.bulkModalLead}>
            Se aplicará a {selectedCount} contacto{selectedCount === 1 ? '' : 's'} seleccionado{selectedCount === 1 ? '' : 's'}.
          </p>

          <div className={styles.formGroup}>
            <label>Acción</label>
            <CustomSelect
              portal
              value={tagMode}
              onValueChange={(value) => setTagMode(value === 'remove' ? 'remove' : 'add')}
              disabled={applyingTags}
              options={tagModeOptions}
            />
          </div>

          <div className={styles.formGroup}>
            <label>Etiqueta</label>
            <TagPicker
              value={tagId}
              onValueChange={(id) => setTagId(id)}
              allowCreate={tagMode === 'add'}
              disabled={applyingTags}
              portal
              placeholder={tagMode === 'add' ? 'Buscar o crear etiqueta...' : 'Buscar etiqueta a quitar...'}
              aria-label="Etiqueta para aplicar"
            />
          </div>

          <div className={styles.formActions}>
            <Button type="button" variant="ghost" onClick={closeTags} disabled={applyingTags}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submitTags}
              loading={applyingTags}
              disabled={!tagId || selectedCount === 0}
            >
              <Tags size={16} />
              Aplicar
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={customFieldsOpen}
        onClose={closeCustomFields}
        title="Campos personalizados"
        size="sm"
        className={styles.bulkActionModal}
        contentClassName={styles.bulkActionModalContent}
      >
        <div className={styles.bulkModalBody}>
          <p className={styles.bulkModalLead}>
            El valor se guardará en {selectedCount} contacto{selectedCount === 1 ? '' : 's'} seleccionado{selectedCount === 1 ? '' : 's'}.
          </p>

          <div className={styles.formGroup}>
            <label>Campo personalizado</label>
            <CustomSelect
              portal
              value={customFieldId}
              onValueChange={setCustomFieldId}
              disabled={applyingCustomField || customFieldsLoading || availableCustomFields.length === 0}
              placeholder={
                customFieldsLoading
                  ? 'Cargando campos...'
                  : availableCustomFields.length === 0
                    ? 'No hay campos personalizados'
                    : 'Selecciona un campo'
              }
              options={availableCustomFields.map((field) => ({
                value: getCustomFieldIdentity(field),
                label: getCustomFieldLabel(field)
              }))}
            />
          </div>

          <div className={styles.formGroup}>
            <label>Valor</label>
            {renderCustomFieldValueControl()}
          </div>

          {multiValueTypes.has(selectedCustomFieldType) && (
            <p className={styles.bulkModalHint}>
              Para varios valores, sepáralos con coma.
            </p>
          )}

          <div className={styles.formActions}>
            <Button type="button" variant="ghost" onClick={closeCustomFields} disabled={applyingCustomField}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submitCustomField}
              loading={applyingCustomField}
              disabled={!selectedCustomField || selectedCount === 0 || (!booleanTypes.has(selectedCustomFieldType) && !customFieldValue.trim())}
            >
              <Check size={16} />
              Guardar
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
