import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarClock, ExternalLink, MessageSquare, Workflow } from 'lucide-react'
import { Button, CustomSelect, Modal } from '@/components/common'
import automationsService, { type AutomationSummary } from '@/services/automationsService'
import { contactBulkActionsService, type ContactBulkAction, type ContactBulkActionScheduleInput } from '@/services/contactBulkActionsService'
import { whatsappApiService, type WhatsAppApiPhoneNumber, type WhatsAppApiTemplate } from '@/services/whatsappApiService'
import type { Contact } from '@/services/contactsService'
import { useNotification } from '@/contexts/NotificationContext'
import styles from './Contacts.module.css'

interface ContactBulkActionModalsProps {
  selectedContacts: Contact[]
  whatsappPhoneNumbers: WhatsAppApiPhoneNumber[]
  whatsappOpen: boolean
  automationOpen: boolean
  onCloseWhatsApp: () => void
  onCloseAutomation: () => void
  onCreated: (action: ContactBulkAction) => void
}

const pad = (value: number) => String(value).padStart(2, '0')

const toDateTimeLocalValue = (date: Date) => {
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

const defaultScheduledAt = () => toDateTimeLocalValue(new Date(Date.now() + 30 * 60 * 1000))

const toIsoFromLocal = (value: string) => value ? new Date(value).toISOString() : undefined

const phoneLabel = (phone: WhatsAppApiPhoneNumber) =>
  phone.label ||
  phone.verified_name ||
  phone.display_phone_number ||
  phone.phone_number ||
  phone.id

const phoneValue = (phone?: WhatsAppApiPhoneNumber | null) =>
  phone?.phone_number || phone?.display_phone_number || ''

const templateLabel = (template: WhatsAppApiTemplate) =>
  `${template.name}${template.language ? ` · ${template.language}` : ''}`

const getTemplateVariables = (template?: WhatsAppApiTemplate | null) => {
  if (!template) return []
  const components = Array.isArray(template.components) ? template.components : []
  const text = components
    .filter((component) => ['HEADER', 'BODY'].includes(String(component.type || '').toUpperCase()))
    .map((component) => String(component.text || ''))
    .join('\n')
  return [...new Set([...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((match) => match[1]))]
    .sort((left, right) => Number(left) - Number(right))
}

const buildSchedule = (scheduled: boolean, scheduledAt: string, dripEnabled: boolean, dripIntervalMinutes: number): ContactBulkActionScheduleInput => ({
  mode: scheduled ? 'scheduled' : 'now',
  scheduledAt: scheduled ? toIsoFromLocal(scheduledAt) : undefined,
  drip: {
    enabled: dripEnabled,
    intervalMinutes: dripEnabled ? dripIntervalMinutes : undefined
  }
})

export const ContactBulkActionModals: React.FC<ContactBulkActionModalsProps> = ({
  selectedContacts,
  whatsappPhoneNumbers,
  whatsappOpen,
  automationOpen,
  onCloseWhatsApp,
  onCloseAutomation,
  onCreated
}) => {
  const navigate = useNavigate()
  const { showToast } = useNotification()
  const selectedIds = useMemo(() => selectedContacts.map((contact) => contact.id), [selectedContacts])
  const selectedCount = selectedContacts.length

  const [templates, setTemplates] = useState<WhatsAppApiTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templateId, setTemplateId] = useState('')
  const [phoneNumberId, setPhoneNumberId] = useState('')
  const [templateVariables, setTemplateVariables] = useState<Record<string, string>>({})
  const [whatsappScheduled, setWhatsappScheduled] = useState(false)
  const [whatsappScheduledAt, setWhatsappScheduledAt] = useState(defaultScheduledAt)
  const [whatsappDrip, setWhatsappDrip] = useState(false)
  const [whatsappDripMinutes, setWhatsappDripMinutes] = useState(2)
  const [sendingWhatsApp, setSendingWhatsApp] = useState(false)

  const [automations, setAutomations] = useState<AutomationSummary[]>([])
  const [automationsLoading, setAutomationsLoading] = useState(false)
  const [automationId, setAutomationId] = useState('')
  const [automationScheduled, setAutomationScheduled] = useState(false)
  const [automationScheduledAt, setAutomationScheduledAt] = useState(defaultScheduledAt)
  const [automationDrip, setAutomationDrip] = useState(false)
  const [automationDripMinutes, setAutomationDripMinutes] = useState(2)
  const [sendingAutomation, setSendingAutomation] = useState(false)

  const [createdAction, setCreatedAction] = useState<ContactBulkAction | null>(null)

  const selectedTemplate = templates.find((template) => template.id === templateId) || null
  const selectedPhone = whatsappPhoneNumbers.find((phone) => phone.id === phoneNumberId) || null
  const variableNumbers = getTemplateVariables(selectedTemplate)
  const missingVariables = variableNumbers.filter((number) => !String(templateVariables[number] || '').trim())

  useEffect(() => {
    if (!whatsappOpen) return
    setTemplatesLoading(true)
    whatsappApiService.getTemplates('APPROVED')
      .then((response) => {
        const items = Array.isArray(response.items) ? response.items : []
        setTemplates(items.filter((template) => String(template.status || '').toUpperCase() === 'APPROVED'))
      })
      .catch((error) => {
        showToast('error', 'No se pudieron cargar plantillas', error instanceof Error ? error.message : 'Intenta otra vez.')
      })
      .finally(() => setTemplatesLoading(false))
  }, [showToast, whatsappOpen])

  useEffect(() => {
    if (!whatsappOpen) return
    const preferred = whatsappPhoneNumbers.find((phone) => phone.is_default_sender) || whatsappPhoneNumbers[0]
    if (preferred && !phoneNumberId) setPhoneNumberId(preferred.id)
  }, [phoneNumberId, whatsappOpen, whatsappPhoneNumbers])

  useEffect(() => {
    if (!selectedTemplate) {
      setTemplateVariables({})
      return
    }
    setTemplateVariables((current) => {
      const next: Record<string, string> = {}
      getTemplateVariables(selectedTemplate).forEach((number) => {
        next[number] = current[number] || ''
      })
      return next
    })
  }, [selectedTemplate])

  useEffect(() => {
    if (!automationOpen) return
    setAutomationsLoading(true)
    automationsService.getOverview()
      .then((overview) => {
        const published = overview.automations.filter((automation) => automation.status === 'published')
        setAutomations(published)
        if (published[0] && !automationId) setAutomationId(published[0].id)
      })
      .catch((error) => {
        showToast('error', 'No se pudieron cargar automatizaciones', error instanceof Error ? error.message : 'Intenta otra vez.')
      })
      .finally(() => setAutomationsLoading(false))
  }, [automationId, automationOpen, showToast])

  const closeWhatsApp = () => {
    if (sendingWhatsApp) return
    onCloseWhatsApp()
  }

  const closeAutomation = () => {
    if (sendingAutomation) return
    onCloseAutomation()
  }

  const handleCreated = (action: ContactBulkAction) => {
    onCreated(action)
    setCreatedAction(action)
  }

  const submitWhatsApp = async () => {
    if (!selectedTemplate || !selectedPhone) return
    if (missingVariables.length > 0) {
      showToast('error', 'Faltan variables', 'Llena todos los campos que pide la plantilla.')
      return
    }

    setSendingWhatsApp(true)
    try {
      const action = await contactBulkActionsService.createWhatsAppTemplate({
        contactIds: selectedIds,
        phoneNumberId: selectedPhone.id,
        fromPhone: phoneValue(selectedPhone),
        templateId: selectedTemplate.id,
        templateName: selectedTemplate.name,
        language: selectedTemplate.language,
        variables: templateVariables,
        schedule: buildSchedule(whatsappScheduled, whatsappScheduledAt, whatsappDrip, whatsappDripMinutes)
      })
      onCloseWhatsApp()
      handleCreated(action)
    } catch (error) {
      showToast('error', 'No se pudo crear el envío', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      setSendingWhatsApp(false)
    }
  }

  const submitAutomation = async () => {
    if (!automationId) return
    setSendingAutomation(true)
    try {
      const action = await contactBulkActionsService.createAutomation({
        contactIds: selectedIds,
        automationId,
        schedule: buildSchedule(automationScheduled, automationScheduledAt, automationDrip, automationDripMinutes)
      })
      onCloseAutomation()
      handleCreated(action)
    } catch (error) {
      showToast('error', 'No se pudo crear el lote', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      setSendingAutomation(false)
    }
  }

  const openProgress = () => {
    if (!createdAction) return
    const actionId = createdAction.id
    setCreatedAction(null)
    navigate(`/contacts/bulk-actions/${encodeURIComponent(actionId)}`)
  }

  return (
    <>
      <Modal isOpen={whatsappOpen} onClose={closeWhatsApp} title="Mandar WhatsApp" size="lg">
        <div className={styles.bulkModalBody}>
          <p className={styles.bulkModalLead}>
            Se creará un envío para {selectedCount} contacto{selectedCount === 1 ? '' : 's'} seleccionado{selectedCount === 1 ? '' : 's'}.
          </p>

          <div className={styles.bulkFormGrid}>
            <div className={styles.formGroup}>
              <label>Número que manda</label>
              <CustomSelect
                value={phoneNumberId}
                onValueChange={setPhoneNumberId}
                disabled={sendingWhatsApp || whatsappPhoneNumbers.length === 0}
                placeholder="Selecciona un número"
                options={whatsappPhoneNumbers.map((phone) => ({
                  value: phone.id,
                  label: phoneLabel(phone)
                }))}
              />
            </div>

            <div className={styles.formGroup}>
              <label>Plantilla aprobada</label>
              <CustomSelect
                value={templateId}
                onValueChange={setTemplateId}
                disabled={sendingWhatsApp || templatesLoading || templates.length === 0}
                placeholder={templatesLoading ? 'Cargando plantillas...' : 'Selecciona una plantilla'}
                options={templates.map((template) => ({
                  value: template.id,
                  label: templateLabel(template)
                }))}
              />
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => navigate('/settings/whatsapp/templates')}
          >
            <ExternalLink size={15} />
            Crear plantilla
          </Button>

          {variableNumbers.length > 0 && (
            <div className={styles.bulkVariablePanel}>
              <h3>Variables de la plantilla</h3>
              {variableNumbers.map((number) => (
                <div key={number} className={styles.formGroup}>
                  <label>Variable {number}</label>
                  <input
                    value={templateVariables[number] || ''}
                    onChange={(event) => setTemplateVariables((current) => ({ ...current, [number]: event.target.value }))}
                    placeholder="Texto o variable, por ejemplo {{contact.name}}"
                    disabled={sendingWhatsApp}
                  />
                </div>
              ))}
            </div>
          )}

          <div className={styles.bulkOptionsGrid}>
            <label className={styles.bulkOptionToggle}>
              <input
                type="checkbox"
                checked={whatsappScheduled}
                onChange={(event) => setWhatsappScheduled(event.target.checked)}
                disabled={sendingWhatsApp}
              />
              Programar envío
            </label>
            {whatsappScheduled && (
              <input
                type="datetime-local"
                value={whatsappScheduledAt}
                onChange={(event) => setWhatsappScheduledAt(event.target.value)}
                disabled={sendingWhatsApp}
              />
            )}

            <label className={styles.bulkOptionToggle}>
              <input
                type="checkbox"
                checked={whatsappDrip}
                onChange={(event) => setWhatsappDrip(event.target.checked)}
                disabled={sendingWhatsApp}
              />
              Modo goteo
            </label>
            {whatsappDrip && (
              <div className={styles.bulkInlineField}>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={whatsappDripMinutes}
                  onChange={(event) => setWhatsappDripMinutes(Number(event.target.value) || 1)}
                  disabled={sendingWhatsApp}
                />
                <span>min entre contactos</span>
              </div>
            )}
          </div>

          <div className={styles.formActions}>
            <Button type="button" variant="ghost" onClick={closeWhatsApp} disabled={sendingWhatsApp}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submitWhatsApp}
              loading={sendingWhatsApp}
              disabled={!selectedTemplate || !selectedPhone || selectedCount === 0 || missingVariables.length > 0}
            >
              <MessageSquare size={16} />
              Crear envío
            </Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={automationOpen} onClose={closeAutomation} title="Añadir a automatización" size="lg">
        <div className={styles.bulkModalBody}>
          <p className={styles.bulkModalLead}>
            Se agregará a {selectedCount} contacto{selectedCount === 1 ? '' : 's'} seleccionado{selectedCount === 1 ? '' : 's'}.
          </p>

          <div className={styles.formGroup}>
            <label>Automatización publicada</label>
            <CustomSelect
              value={automationId}
              onValueChange={setAutomationId}
              disabled={sendingAutomation || automationsLoading || automations.length === 0}
              placeholder={automationsLoading ? 'Cargando automatizaciones...' : 'Selecciona una automatización'}
              options={automations.map((automation) => ({
                value: automation.id,
                label: automation.name
              }))}
            />
          </div>

          <div className={styles.bulkOptionsGrid}>
            <label className={styles.bulkOptionToggle}>
              <input
                type="checkbox"
                checked={automationScheduled}
                onChange={(event) => setAutomationScheduled(event.target.checked)}
                disabled={sendingAutomation}
              />
              Programar
            </label>
            {automationScheduled && (
              <input
                type="datetime-local"
                value={automationScheduledAt}
                onChange={(event) => setAutomationScheduledAt(event.target.value)}
                disabled={sendingAutomation}
              />
            )}

            <label className={styles.bulkOptionToggle}>
              <input
                type="checkbox"
                checked={automationDrip}
                onChange={(event) => setAutomationDrip(event.target.checked)}
                disabled={sendingAutomation}
              />
              Modo goteo
            </label>
            {automationDrip && (
              <div className={styles.bulkInlineField}>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={automationDripMinutes}
                  onChange={(event) => setAutomationDripMinutes(Number(event.target.value) || 1)}
                  disabled={sendingAutomation}
                />
                <span>min entre contactos</span>
              </div>
            )}
          </div>

          <div className={styles.formActions}>
            <Button type="button" variant="ghost" onClick={closeAutomation} disabled={sendingAutomation}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submitAutomation}
              loading={sendingAutomation}
              disabled={!automationId || selectedCount === 0}
            >
              <Workflow size={16} />
              Crear lote
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={Boolean(createdAction)}
        onClose={() => setCreatedAction(null)}
        title={createdAction?.scheduledAt ? 'Lote creado' : 'Acción creada'}
        size="md"
      >
        <div className={styles.bulkSuccessBody}>
          <CalendarClock size={28} />
          <p>
            El lote quedó guardado. Puedes consultar el progreso, detenerlo, reprogramarlo o eliminarlo desde su vista.
          </p>
          <div className={styles.formActions}>
            <Button type="button" variant="ghost" onClick={() => setCreatedAction(null)}>
              Cerrar
            </Button>
            <Button type="button" onClick={openProgress}>
              Ver progreso
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
