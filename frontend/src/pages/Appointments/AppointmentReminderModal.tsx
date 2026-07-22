import React, { useEffect, useMemo, useState } from 'react'
import { Bell, CalendarCheck, Sparkles, Trash2 } from 'lucide-react'
import { Modal, Button, CustomSelect, NumberInput, Switch } from '@/components/common'
import { Badge, type BadgeVariant } from '@/components/common/Badge'
import {
  type AppointmentReminder,
  type AppointmentReminderInput,
  type ReminderConfirmationSuccessAction,
  type ReminderChannelOption,
  type ReminderNoConfirmAction,
  type ReminderOffsetUnit,
  type ReminderSenderOption,
  type ReminderTimingAnchor,
  formatReminderOffsetLabel
} from '@/services/appointmentRemindersService'
import {
  getMessageTemplateProviderStatus,
  type MessageTemplate
} from '@/services/messageTemplatesService'
import {
  getWhatsAppSenderConnectionAvailability
} from '@/utils/whatsappQrFallbackWarning'
import styles from './AppointmentReminderModal.module.css'

interface AppointmentReminderModalProps {
  isOpen: boolean
  reminder: AppointmentReminder | null
  senders: ReminderSenderOption[]
  channels: ReminderChannelOption[]
  templates: MessageTemplate[]
  onClose: () => void
  onSave: (reminderId: string, input: AppointmentReminderInput) => Promise<void>
  onDelete: (reminderId: string) => Promise<void>
}

const OFFSET_UNIT_OPTIONS = [
  { value: 'minutes', label: 'Minutos' },
  { value: 'hours', label: 'Horas' },
  { value: 'days', label: 'Días' }
]

// Después de agendar el tope es 24h, por eso van segundos/minutos/horas (sin días).
const AFTER_OFFSET_UNIT_OPTIONS = [
  { value: 'seconds', label: 'Segundos' },
  { value: 'minutes', label: 'Minutos' },
  { value: 'hours', label: 'Horas' }
]

const MAX_AFTER_BOOKING_MS = 24 * 60 * 60 * 1000
const AFTER_OFFSET_UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000
}

// Tope de cada unidad para no pasar de 24h después de agendar.
const maxAfterOffsetValue = (unit: ReminderOffsetUnit): number => (
  Math.floor(MAX_AFTER_BOOKING_MS / (AFTER_OFFSET_UNIT_MS[unit] || AFTER_OFFSET_UNIT_MS.minutes))
)

const clampAfterOffsetValue = (value: number, unit: ReminderOffsetUnit): number => (
  Math.max(1, Math.min(maxAfterOffsetValue(unit), Math.round(value)))
)

const DEFAULT_TEMPLATE_NAME_BY_PURPOSE = {
  reminder: 'recordatorio_cita_un_dia_antes',
  notice: 'cita_programada',
  confirmation: 'confirmacion_cita_dia_anterior'
} as const

const getDefaultTemplateName = (
  messageType: AppointmentReminderInput['messageType'],
  timingAnchor: ReminderTimingAnchor
) => {
  if (messageType === 'confirmation') return DEFAULT_TEMPLATE_NAME_BY_PURPOSE.confirmation
  return timingAnchor === 'after_booking'
    ? DEFAULT_TEMPLATE_NAME_BY_PURPOSE.notice
    : DEFAULT_TEMPLATE_NAME_BY_PURPOSE.reminder
}

const CONFIRMATION_SUCCESS_ACTION_OPTIONS: { value: ReminderConfirmationSuccessAction; label: string; description: string }[] = [
  {
    value: 'chat_card',
    label: 'Agregar tarjetita en el chat',
    description: 'Ristak deja una tarjeta visible en la conversación indicando que la cita quedó confirmada.'
  },
  {
    value: 'notify_push',
    label: 'Mandarme notificación push',
    description: 'Te avisa cuando la IA detecta que la persona sí confirmó su cita.'
  },
  {
    value: 'chat_badge',
    label: 'Mostrar etiqueta "Asistirá a cita"',
    description: 'El chat muestra esa etiqueta en compu y celular hasta que pase la hora de la cita.'
  },
  {
    value: 'mark_confirmed',
    label: 'Sólo marcar la cita confirmada',
    description: 'La cita cambia a confirmada sin agregar avisos extra.'
  }
]

const NO_CONFIRM_ACTION_OPTIONS: { value: ReminderNoConfirmAction; label: string; description: string }[] = [
  {
    value: 'no_action',
    label: 'No hacer nada',
    description: 'Ristak deja la cita como está y no avisa al equipo.'
  },
  {
    value: 'cancel_appointment',
    label: 'Cancelar la cita',
    description: 'La cita se marca como cancelada si la respuesta no confirma asistencia.'
  },
  {
    value: 'notify_push',
    label: 'Enviarme una notificación',
    description: 'Te avisa si la IA detecta que no confirmó, quiere moverla o hace falta revisar.'
  }
]

const getTemplateReviewStatus = (template?: MessageTemplate | null) => getMessageTemplateProviderStatus(template)

const getTemplateStatusLabel = (template?: MessageTemplate | null) => {
  const status = getTemplateReviewStatus(template)
  if (!template) return 'Sin plantilla'
  if (status === 'APPROVED') return 'Aprobada'
  if (['PENDING', 'IN_REVIEW', 'UNDER_REVIEW', 'PENDING_REVIEW'].includes(status)) return 'En revisión'
  if (status === 'REJECTED') return 'Rechazada'
  if (status === 'PAUSED') return 'Pausada'
  if (status === 'DISABLED') return 'Deshabilitada'
  if (!status) return 'No enviada'
  return status
}

const getTemplateStatusVariant = (template?: MessageTemplate | null): BadgeVariant => {
  const status = getTemplateReviewStatus(template)
  if (status === 'APPROVED') return 'success'
  if (['PENDING', 'IN_REVIEW', 'UNDER_REVIEW', 'PENDING_REVIEW', 'IN_APPEAL'].includes(status)) return 'warning'
  if (['REJECTED', 'PAUSED', 'DISABLED', 'ARCHIVED', 'DELETED'].includes(status)) return 'error'
  return 'neutral'
}

const replaceTemplateVariables = (
  text: string | undefined,
  bindings: MessageTemplate['variableBindings']['bodyText'] = {}
) => (text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (match, index) => (
  bindings[index]?.mergeField || (bindings[index]?.variableKey ? `{{${bindings[index]?.variableKey}}}` : match)
))

const buildTemplatePreview = (template?: MessageTemplate | null) => {
  if (!template) return ''
  return [
    replaceTemplateVariables(template.headerText, template.variableBindings.headerText),
    replaceTemplateVariables(template.bodyText, template.variableBindings.bodyText),
    template.footerText || ''
  ].filter(Boolean).join('\n\n')
}

const isWhatsAppChannelId = (channelId: string) => channelId === 'whatsapp' || channelId === 'whatsapp_qr'
const isAutomaticChannelId = (channelId: string) => channelId === 'booking_channel' || channelId === 'available_channel'

export const AppointmentReminderModal: React.FC<AppointmentReminderModalProps> = ({
  isOpen,
  reminder,
  senders,
  channels,
  templates,
  onClose,
  onSave,
  onDelete
}) => {
  const [draft, setDraft] = useState<AppointmentReminderInput>({})
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

  useEffect(() => {
    if (!isOpen || !reminder) return
    setDraft({
      messageType: reminder.messageType,
      aiEnabled: reminder.aiEnabled,
      bypassAutomations: reminder.bypassAutomations,
      senderMode: reminder.senderMode,
      senderPhoneNumberId: reminder.senderPhoneNumberId,
      templateId: reminder.templateId,
      templateName: reminder.templateName || '',
      templateLanguage: reminder.templateLanguage || 'es_MX',
      contentMode: reminder.contentMode || 'template',
      channel: reminder.channel || 'whatsapp',
      qrFallbackEnabled: reminder.qrFallbackEnabled,
      timingAnchor: reminder.timingAnchor || 'before_appointment',
      offsetValue: reminder.offsetValue,
      offsetUnit: reminder.offsetUnit,
      messageText: reminder.messageText,
      smartEnabled: reminder.smartEnabled,
      smartStart: reminder.smartStart,
      smartEnd: reminder.smartEnd,
      smartOverflow: reminder.smartOverflow,
      noConfirmAction: reminder.noConfirmAction,
      confirmationSuccessAction: reminder.confirmationSuccessAction
    })
    setSaving(false)
    setDeleting(false)
    setConfirmDeleteOpen(false)
  }, [isOpen, reminder])

  const set = <K extends keyof AppointmentReminderInput>(key: K, value: AppointmentReminderInput[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  const selectedChannelId = String(draft.channel || reminder?.channel || 'whatsapp')
  const channel = channels.find(item => item.id === selectedChannelId) || channels[0]
  const isWhatsAppApiChannel = selectedChannelId === 'whatsapp'
  const isWhatsAppQrOnly = selectedChannelId === 'whatsapp_qr'
  const isBookingChannel = selectedChannelId === 'booking_channel'
  const isAvailableChannel = selectedChannelId === 'available_channel'
  const isAutomaticChannel = isAutomaticChannelId(selectedChannelId)
  const usesWhatsApp = isWhatsAppChannelId(selectedChannelId)
  const contentMode = usesWhatsApp ? (draft.contentMode || 'template') : 'direct'
  const isDirectMessage = contentMode === 'direct'
  const isConfirmation = draft.messageType === 'confirmation'
  const timingAnchor: ReminderTimingAnchor = draft.timingAnchor || 'before_appointment'
  const isAfterBooking = timingAnchor === 'after_booking'
  const whatsappAvailability = getWhatsAppSenderConnectionAvailability(senders)
  const hasQrConnected = whatsappAvailability.hasQrConnected
  const hasApiConnected = whatsappAvailability.hasApiConnected
  const qrOnlyConnected = isWhatsAppApiChannel && hasQrConnected && !hasApiConnected

  const visibleTemplates = useMemo(() => (
    templates
      .filter(template => template.status !== 'archived')
      .sort((left, right) => {
        const leftReminder = left.folderId === 'Reminders' ? 0 : 1
        const rightReminder = right.folderId === 'Reminders' ? 0 : 1
        if (leftReminder !== rightReminder) return leftReminder - rightReminder
        return left.name.localeCompare(right.name)
      })
  ), [templates])

  const selectedTemplate = useMemo(() => (
    visibleTemplates.find(template => template.id === draft.templateId) || null
  ), [draft.templateId, visibleTemplates])

  const defaultTemplateForType = useMemo(() => {
    const name = getDefaultTemplateName(
      (draft.messageType as AppointmentReminder['messageType']) || 'reminder',
      timingAnchor
    )
    return visibleTemplates.find(template => template.name === name) || visibleTemplates[0] || null
  }, [draft.messageType, timingAnchor, visibleTemplates])

  useEffect(() => {
    if (!isOpen || !reminder || isDirectMessage || draft.templateId || !defaultTemplateForType) return
    setDraft(prev => ({
      ...prev,
      templateId: defaultTemplateForType.id,
      templateName: defaultTemplateForType.name,
      templateLanguage: defaultTemplateForType.language
    }))
  }, [defaultTemplateForType, draft.templateId, isDirectMessage, isOpen, reminder])

  const templateOptions = useMemo(() => visibleTemplates.map(template => ({
    value: template.id,
    label: `${template.name} · ${getTemplateStatusLabel(template)}`
  })), [visibleTemplates])

  const selectedTemplatePreview = useMemo(() => buildTemplatePreview(selectedTemplate), [selectedTemplate])
  const selectedTemplateApproved = getTemplateReviewStatus(selectedTemplate) === 'APPROVED'
  const selectedConfirmationSuccessAction = CONFIRMATION_SUCCESS_ACTION_OPTIONS.find(
    option => option.value === (draft.confirmationSuccessAction || 'chat_card')
  ) || CONFIRMATION_SUCCESS_ACTION_OPTIONS[0]
  const selectedNoConfirmAction = NO_CONFIRM_ACTION_OPTIONS.find(
    option => option.value === (draft.noConfirmAction || 'no_action')
  ) || NO_CONFIRM_ACTION_OPTIONS[0]

  const senderOptions = useMemo(() => senders
    .filter(sender => !isWhatsAppQrOnly || sender.qrConnected)
    .map(sender => ({
      value: sender.id,
      label: sender.name ? `${sender.phone} · ${sender.name}` : sender.phone
    })), [isWhatsAppQrOnly, senders])

  const isImmediate = isAfterBooking && (Number(draft.offsetValue) || 0) <= 0
  const offsetLabel = formatReminderOffsetLabel(
    Number(draft.offsetValue) || (isAfterBooking ? 0 : 1),
    (draft.offsetUnit as ReminderOffsetUnit) || (isAfterBooking ? 'minutes' : 'days'),
    timingAnchor
  )

  if (!reminder) return null

  // El tipo visible (Recordatorio/Aviso) define el ancla de envío. La confirmación
  // es una capacidad aparte y no debe cambiarse automáticamente al mover el ancla.
  const changeTimingAnchor = (nextAnchor: ReminderTimingAnchor) => {
    if (nextAnchor === timingAnchor) return
    const messageType = (draft.messageType as AppointmentReminder['messageType']) || 'reminder'
    const previousName = getDefaultTemplateName(messageType, timingAnchor)
    const nextName = getDefaultTemplateName(messageType, nextAnchor)
    const shouldSwitchTemplate = !draft.templateId || selectedTemplate?.name === previousName
    const nextTemplate = visibleTemplates.find(template => template.name === nextName) || null

    setDraft(prev => ({
      ...prev,
      timingAnchor: nextAnchor,
      offsetValue: nextAnchor === 'after_booking' ? 0 : 1,
      offsetUnit: nextAnchor === 'after_booking' ? 'minutes' : 'days',
      ...(shouldSwitchTemplate && nextTemplate
        ? {
            templateId: nextTemplate.id,
            templateName: nextTemplate.name,
            templateLanguage: nextTemplate.language
          }
        : {})
    }))
  }

  // "Inmediatamente" = offset 0; "Pasado un tiempo" = arranca en 5 minutos.
  const changeAfterTimingMode = (mode: 'immediate' | 'delay') => {
    if (mode === 'immediate') {
      set('offsetValue', 0)
      return
    }
    const unit = (draft.offsetUnit as ReminderOffsetUnit) || 'minutes'
    const safeUnit = unit === 'days' ? 'minutes' : unit
    setDraft(prev => ({
      ...prev,
      offsetUnit: safeUnit,
      offsetValue: clampAfterOffsetValue(Number(prev.offsetValue) || 5, safeUnit)
    }))
  }

  const changeAfterOffsetUnit = (nextUnit: ReminderOffsetUnit) => {
    setDraft(prev => ({
      ...prev,
      offsetUnit: nextUnit,
      offsetValue: clampAfterOffsetValue(Number(prev.offsetValue) || 1, nextUnit)
    }))
  }

  const selectTemplate = (templateId: string) => {
    const template = visibleTemplates.find(item => item.id === templateId)
    setDraft(prev => ({
      ...prev,
      templateId,
      templateName: template?.name || prev.templateName || '',
      templateLanguage: template?.language || prev.templateLanguage || 'es_MX'
    }))
  }

  const changeChannel = (nextChannel: string) => {
    const nextUsesWhatsApp = isWhatsAppChannelId(nextChannel)
    const nextAutomatic = isAutomaticChannelId(nextChannel)
    const nextContentMode = nextChannel === 'whatsapp_qr'
      ? 'direct'
      : nextUsesWhatsApp
        ? 'template'
        : 'direct'
    setDraft(prev => ({
      ...prev,
      channel: nextChannel,
      contentMode: prev.contentMode === 'direct' ? 'direct' : nextContentMode,
      qrFallbackEnabled: nextChannel === 'whatsapp',
      senderMode: nextUsesWhatsApp && !nextAutomatic ? prev.senderMode : 'contact',
      senderPhoneNumberId: nextUsesWhatsApp && !nextAutomatic ? prev.senderPhoneNumberId : null
    }))
  }

  const changeContentMode = (nextMode: 'template' | 'direct') => {
    if (!usesWhatsApp && nextMode === 'template') return
    setDraft(prev => ({
      ...prev,
      contentMode: nextMode,
      ...(nextMode === 'direct'
        ? {
            templateId: null,
            templateName: '',
            qrFallbackEnabled: isWhatsAppApiChannel
          }
        : {})
    }))
  }

  const changeConfirmationMode = (enabled: boolean) => {
    const messageType: AppointmentReminderInput['messageType'] = enabled ? 'confirmation' : 'reminder'
    const previousName = getDefaultTemplateName(
      (draft.messageType as AppointmentReminder['messageType']) || 'reminder',
      timingAnchor
    )
    const nextName = getDefaultTemplateName(messageType, timingAnchor)
    const shouldSwitchTemplate = !draft.templateId || selectedTemplate?.name === previousName
    const nextTemplate = visibleTemplates.find(template => template.name === nextName) || null

    setDraft(prev => ({
      ...prev,
      messageType,
      aiEnabled: enabled ? true : false,
      bypassAutomations: enabled ? prev.bypassAutomations : false,
      ...(shouldSwitchTemplate && nextTemplate
        ? {
            templateId: nextTemplate.id,
            templateName: nextTemplate.name,
            templateLanguage: nextTemplate.language
          }
        : {})
    }))
  }

  const handleSave = async () => {
    if (contentMode === 'template' && !draft.templateId) return
    if (contentMode === 'direct' && !String(draft.messageText || '').trim()) return
    setSaving(true)
    try {
      await onSave(reminder.id, {
        ...draft,
        channel: selectedChannelId,
        contentMode,
        qrFallbackEnabled: isWhatsAppApiChannel
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await onDelete(reminder.id)
      onClose()
    } finally {
      setDeleting(false)
    }
  }

  const saveDisabled = saving || deleting ||
    (contentMode === 'template' ? !draft.templateId : !String(draft.messageText || '').trim())

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Detalles del mensaje automático"
        size="lg"
        type="custom"
      >
        <div className={styles.form}>
          {/* Tipo de mensaje */}
          <section className={styles.section}>
            <h4 className={styles.sectionTitle}>Tipo de mensaje</h4>
            <div className={styles.typeGrid}>
              <button
                type="button"
                className={`${styles.typeCard} ${!isAfterBooking ? styles.typeCardActive : ''}`}
                onClick={() => changeTimingAnchor('before_appointment')}
              >
                <Bell size={18} aria-hidden="true" />
                <div>
                  <div className={styles.typeCardTitle}>Recordatorio de cita</div>
                  <div className={styles.typeCardDetail}>Se envía antes de que empiece la cita.</div>
                </div>
              </button>
              <button
                type="button"
                className={`${styles.typeCard} ${isAfterBooking ? styles.typeCardActive : ''}`}
                onClick={() => changeTimingAnchor('after_booking')}
              >
                <CalendarCheck size={18} aria-hidden="true" />
                <div>
                  <div className={styles.typeCardTitle}>Aviso de cita</div>
                  <div className={styles.typeCardDetail}>Se envía después de que la persona agenda.</div>
                </div>
              </button>
            </div>

            <div className={styles.confirmationToggleBox}>
              <div className={styles.confirmationToggleCopy}>
                <span className={styles.confirmationToggleTitle}>
                  <Sparkles size={16} aria-hidden="true" />
                  Usar como confirmación de cita
                </span>
                <span className={styles.helpText}>
                  El mensaje pedirá que la persona confirme asistencia. Si activas la IA,
                  Ristak interpretará la respuesta y ejecutará la acción que configures.
                </span>
              </div>
              <Switch
                checked={isConfirmation}
                onChange={changeConfirmationMode}
                aria-label="Usar como confirmación de cita"
              />
            </div>

            {isConfirmation && (
              <div className={styles.aiBox}>
                <label className={styles.switchRow}>
                  <span className={styles.switchControl}>
                    <input
                      type="checkbox"
                      checked={draft.aiEnabled !== false}
                      onChange={(e) => set('aiEnabled', e.target.checked)}
                    />
                    <span className={styles.switchTrack} />
                  </span>
                  <span>
                    <span className={styles.switchLabel}>Confirmación automática con IA</span>
                    <span className={styles.helpText}>
                      Al enviarse este mensaje, la IA queda pendiente de la respuesta del contacto.
                      En cuanto responda, esperará 2 minutos después de su último mensaje antes de
                      clasificar si confirmó, quiere reagendar, canceló o necesita atención humana.
                    </span>
                  </span>
                </label>

                {draft.aiEnabled !== false && (
                  <>
                    <label className={`${styles.switchRow} ${styles.stackedSwitchRow}`}>
                      <span className={styles.switchControl}>
                        <input
                          type="checkbox"
                          checked={draft.bypassAutomations === true}
                          onChange={(e) => set('bypassAutomations', e.target.checked)}
                        />
                        <span className={styles.switchTrack} />
                      </span>
                      <span>
                        <span className={styles.switchLabel}>Pausar agentes y automatizaciones durante la confirmación</span>
                        <span className={styles.helpText}>
                          Mientras el contacto esté respondiendo al mensaje de confirmación, otros agentes
                          de IA y automatizaciones activas quedarán en pausa para evitar respuestas cruzadas.
                          Se reanudan automáticamente cuando la IA termina de clasificar la respuesta.
                        </span>
                      </span>
                    </label>

                    <div className={styles.confirmationActionBox}>
                      <div className={styles.field}>
                        <label className={styles.fieldLabel}>Qué quieres que pase cuando se detecte que confirmó la cita</label>
                        <CustomSelect
                          value={draft.confirmationSuccessAction || 'chat_card'}
                          options={CONFIRMATION_SUCCESS_ACTION_OPTIONS.map(option => ({
                            value: option.value,
                            label: option.label
                          }))}
                          onValueChange={(value) => set('confirmationSuccessAction', value as ReminderConfirmationSuccessAction)}
                          aria-label="Acción cuando el contacto confirma la cita"
                          portal
                        />
                        <span className={styles.helpText}>{selectedConfirmationSuccessAction.description}</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {isConfirmation && (
              <div className={styles.noConfirmBox}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Si el contacto no confirma</label>
                  <CustomSelect
                    value={draft.noConfirmAction || 'no_action'}
                    options={NO_CONFIRM_ACTION_OPTIONS.map(option => ({
                      value: option.value,
                      label: option.label
                    }))}
                    onValueChange={(value) => set('noConfirmAction', value as ReminderNoConfirmAction)}
                    aria-label="Acción si el contacto no confirma"
                    portal
                  />
                  <span className={styles.helpText}>{selectedNoConfirmAction.description}</span>
                </div>
              </div>
            )}
          </section>

          {/* Canal y remitente */}
          <section className={styles.section}>
            <h4 className={styles.sectionTitle}>Canal de envío</h4>
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Canal</label>
                <CustomSelect
                  value={channel?.id || selectedChannelId}
                  options={channels.map(c => ({
                    value: c.id,
                    label: c.connected ? `${c.label} (conectado)` : c.label
                  }))}
                  onValueChange={changeChannel}
                  aria-label="Canal de mensajes"
                />
              </div>
              {usesWhatsApp && (
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Enviar desde</label>
                  <CustomSelect
                    value={draft.senderMode || 'contact'}
                    options={[
                      { value: 'contact', label: 'El número por el que te escribió el contacto' },
                      { value: 'default', label: 'El número predeterminado de la aplicación' },
                      { value: 'specific', label: 'Un número específico' }
                    ]}
                    onValueChange={(value) => set('senderMode', value as AppointmentReminderInput['senderMode'])}
                    aria-label="Número remitente"
                  />
                </div>
              )}
            </div>
            {usesWhatsApp && draft.senderMode === 'specific' && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Número</label>
                {senderOptions.length ? (
                  <CustomSelect
                    value={draft.senderPhoneNumberId || ''}
                    options={senderOptions}
                    placeholder="Elige un número conectado"
                    onValueChange={(value) => set('senderPhoneNumberId', value)}
                    aria-label="Número específico"
                  />
                ) : (
                  <p className={styles.helpText}>No hay números de WhatsApp conectados todavía.</p>
                )}
              </div>
            )}
            {isBookingChannel && (
              <p className={styles.helpText}>
                Ristak intentará enviar por el mismo canal donde nació la cita. Si ese canal falla o no está disponible,
                usará el siguiente canal conectado como respaldo.
              </p>
            )}
            {isAvailableChannel && (
              <p className={styles.helpText}>
                Ristak elegirá automáticamente el primer canal conectado en este orden: WhatsApp API, WhatsApp QR,
                Instagram, Messenger y correo electrónico.
              </p>
            )}
            {!usesWhatsApp && !isAutomaticChannel && (
              <p className={styles.helpText}>
                Este canal usa mensaje directo. Ristak lo enviará si el contacto tiene ese canal enlazado y la integración está conectada.
              </p>
            )}
          </section>

          {/* Tiempo de envío */}
          <section className={styles.section}>
            <h4 className={styles.sectionTitle}>¿Cuándo se envía?</h4>
            <span className={styles.helpText}>
              {isAfterBooking
                ? 'El tiempo se cuenta desde que la persona agenda. Útil para avisos o confirmaciones de citas hechas por la URL pública.'
                : 'El tiempo se cuenta hacia atrás desde la hora de la cita.'}
            </span>

            {isAfterBooking ? (
              <>
                <div className={styles.offsetRow}>
                  <div className={styles.offsetUnit}>
                    <CustomSelect
                      value={isImmediate ? 'immediate' : 'delay'}
                      options={[
                        { value: 'immediate', label: 'Inmediatamente al agendar' },
                        { value: 'delay', label: 'Pasado un tiempo' }
                      ]}
                      onValueChange={(value) => changeAfterTimingMode(value as 'immediate' | 'delay')}
                      aria-label="Cuándo enviar después de agendar"
                    />
                  </div>
                  {!isImmediate && (
                    <>
                      <NumberInput
                        className={styles.offsetInput}
                        min={1}
                        max={maxAfterOffsetValue((draft.offsetUnit as ReminderOffsetUnit) || 'minutes')}
                        value={draft.offsetValue ?? 5}
                        onValueChange={(value) => set('offsetValue', clampAfterOffsetValue(value, (draft.offsetUnit as ReminderOffsetUnit) || 'minutes'))}
                        aria-label="Cantidad de tiempo después de agendar"
                      />
                      <div className={styles.offsetUnit}>
                        <CustomSelect
                          value={draft.offsetUnit || 'minutes'}
                          options={AFTER_OFFSET_UNIT_OPTIONS}
                          onValueChange={(value) => changeAfterOffsetUnit(value as ReminderOffsetUnit)}
                          aria-label="Unidad de tiempo"
                        />
                      </div>
                      <span className={styles.offsetSuffix}>después de agendar</span>
                    </>
                  )}
                </div>
                <span className={styles.helpText}>
                  {isImmediate
                    ? 'Se envía apenas la persona agende (en cuanto el sistema lo detecte, en menos de un minuto).'
                    : `Máximo 24 horas. Quedará como “${offsetLabel}”.`}
                </span>
              </>
            ) : (
              <div className={styles.offsetRow}>
                <NumberInput
                  className={styles.offsetInput}
                  min={1}
                  max={60}
                  value={draft.offsetValue ?? 1}
                  onValueChange={(value) => set('offsetValue', Math.max(1, Math.round(value)))}
                  aria-label="Cantidad de tiempo antes de la cita"
                />
                <div className={styles.offsetUnit}>
                  <CustomSelect
                    value={draft.offsetUnit || 'days'}
                    options={OFFSET_UNIT_OPTIONS}
                    onValueChange={(value) => set('offsetUnit', value as AppointmentReminderInput['offsetUnit'])}
                    aria-label="Unidad de tiempo"
                  />
                </div>
                <span className={styles.offsetSuffix}>antes de la cita ({offsetLabel})</span>
              </div>
            )}

            <label className={styles.checkboxRow}>
              <input
                type="checkbox"
                checked={draft.smartEnabled !== false}
                onChange={(e) => set('smartEnabled', e.target.checked)}
              />
              <span>
                <span className={styles.switchLabel}>Envío inteligente</span>
                <span className={styles.helpText}>
                  {isAfterBooking
                    ? 'Si el envío cae en un horario incómodo (por ejemplo, agendaron a las 3 de la madrugada), el mensaje se mueve automáticamente a una hora adecuada para no escribirle al contacto en horas indebidas.'
                    : 'Si la cita cae en un horario incómodo (por ejemplo, agendada a las 5 de la madrugada), el mensaje se mueve automáticamente a una hora adecuada para no escribirle al contacto en horas indebidas.'}
                </span>
              </span>
            </label>

            {draft.smartEnabled !== false && (
              <div className={styles.smartBox}>
                <div className={styles.fieldRow}>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>Desde</label>
                    <input
                      type="time"
                      className={styles.timeInput}
                      value={draft.smartStart || '09:00'}
                      onChange={(e) => set('smartStart', e.target.value)}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>Hasta</label>
                    <input
                      type="time"
                      className={styles.timeInput}
                      value={draft.smartEnd || '21:00'}
                      onChange={(e) => set('smartEnd', e.target.value)}
                    />
                  </div>
                </div>
                <label className={styles.fieldLabel}>Si el mensaje queda fuera de ese horario…</label>
                <div className={styles.radioGroup}>
                  <label className={styles.radioRow}>
                    <input
                      type="radio"
                      name="smartOverflow"
                      checked={(draft.smartOverflow || 'before') === 'before'}
                      onChange={() => set('smartOverflow', 'before')}
                    />
                    <span>{isAfterBooking ? 'Enviarlo en cuanto cierre el horario de ese día' : 'Enviarlo antes, sin dejar que acabe el día anterior'}</span>
                  </label>
                  <label className={styles.radioRow}>
                    <input
                      type="radio"
                      name="smartOverflow"
                      checked={draft.smartOverflow === 'next_day'}
                      onChange={() => set('smartOverflow', 'next_day')}
                    />
                    <span>{isAfterBooking ? 'Enviarlo a la apertura del día siguiente' : 'Enviarlo después, empezando el día siguiente'}</span>
                  </label>
                </div>
              </div>
            )}
          </section>

          {/* Mensaje */}
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h4 className={styles.sectionTitle}>Contenido del mensaje</h4>
              {contentMode === 'template' && selectedTemplate && (
                <Badge variant={getTemplateStatusVariant(selectedTemplate)}>
                  {getTemplateStatusLabel(selectedTemplate)}
                </Badge>
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Tipo de contenido</label>
              <CustomSelect
                value={contentMode}
                options={usesWhatsApp
                  ? [
                      { value: 'template', label: isWhatsAppQrOnly ? 'Usar mensaje guardado como texto QR' : 'Usar plantilla de WhatsApp API' },
                      { value: 'direct', label: 'Escribir mensaje propio' }
                    ]
                  : [
                      { value: 'direct', label: 'Escribir mensaje propio' }
                    ]}
                onValueChange={(value) => changeContentMode(value as 'template' | 'direct')}
                aria-label="Tipo de contenido del mensaje"
              />
              <span className={styles.helpText}>
                {contentMode === 'direct'
                  ? isAutomaticChannel
                    ? 'Ristak enviará este texto por el canal automático elegido, renderizando variables como {{contact.first_name}}, {{cita.fecha}} y {{cita.hora}}.'
                    : usesWhatsApp
                    ? isWhatsAppQrOnly
                      ? 'Ristak enviará este texto por WhatsApp QR como canal principal. No requiere aprobación de Meta ni ventana de 24 horas.'
                      : 'Ristak enviará este texto si WhatsApp permite mensaje libre. Con API activa requiere conversación abierta de 24 horas; el QR sólo entra si la API deja de estar disponible.'
                    : 'Ristak enviará este texto tal cual, renderizando variables como {{contact.first_name}}, {{cita.fecha}} y {{cita.hora}}.'
                  : isWhatsAppQrOnly
                    ? 'Ristak tomará el texto del mensaje seleccionado y lo enviará por WhatsApp QR. No necesita aprobación de Meta porque no sale como plantilla API.'
                    : qrOnlyConnected
                    ? 'Con WhatsApp QR, Ristak manda el texto del mensaje seleccionado. No necesita aprobación de Meta porque no sale como plantilla API.'
                    : 'Los mensajes por WhatsApp API salen con plantillas aprobadas. Si la plantilla no está aprobada, el envío queda detenido hasta que Meta la apruebe y WhatsApp API esté disponible.'}
              </span>
            </div>

            {contentMode === 'template' ? (
              <>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Mensaje seleccionado</label>
                  <CustomSelect
                    value={draft.templateId || ''}
                    options={templateOptions}
                    placeholder={templateOptions.length ? 'Elige una plantilla' : 'Sin plantillas disponibles'}
                    disabled={!templateOptions.length}
                    onValueChange={selectTemplate}
                    aria-label="Plantilla del mensaje automático"
                    portal
                  />
                </div>

                {selectedTemplate ? (
                  <div className={styles.templatePreview}>
                    <div className={styles.templatePreviewHeader}>
                      <span>{selectedTemplate.name}</span>
                      <small>{selectedTemplate.language}</small>
                    </div>
                    <p>{selectedTemplatePreview || 'Esta plantilla no tiene texto para previsualizar.'}</p>
                  </div>
                ) : (
                  <p className={styles.templateEmpty}>
                    {isWhatsAppQrOnly
                      ? 'Elige un mensaje guardado o cambia a mensaje directo para escribir el texto aquí.'
                      : 'Cuando conectes WhatsApp API, Ristak crea las plantillas de recordatorios y las manda a revisión.'}
                  </p>
                )}
              </>
            ) : (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Mensaje propio</label>
                <textarea
                  className={styles.messageTextarea}
                  value={draft.messageText || ''}
                  onChange={(event) => set('messageText', event.target.value)}
                  placeholder="Escribe aquí el mensaje que recibirá el contacto."
                />
                <span className={styles.helpText}>
                  Variables disponibles: {'{{contact.first_name}}'}, {'{{contact.name}}'}, {'{{cita.titulo}}'}, {'{{cita.fecha}}'}, {'{{cita.hora}}'}.
                </span>
              </div>
            )}

            {contentMode === 'template' && selectedTemplate && !selectedTemplateApproved && !qrOnlyConnected && !isWhatsAppQrOnly && (
              <div className={styles.templateNotice}>
                Esta plantilla todavía no está aprobada por WhatsApp API. No se enviará hasta que Meta la apruebe y WhatsApp API esté disponible.
              </div>
            )}

            {isWhatsAppApiChannel && !hasApiConnected && !hasQrConnected && (
              <div className={styles.templateNotice}>
                WhatsApp no está disponible ahora. Conecta WhatsApp API o un número por QR para enviar este recordatorio.
              </div>
            )}

            {isWhatsAppQrOnly && !hasQrConnected && (
              <div className={styles.templateNotice}>
                Conecta un número de WhatsApp QR para enviar este mensaje por QR solo.
              </div>
            )}

            {isWhatsAppApiChannel && hasApiConnected && hasQrConnected && (
              <div className={styles.templateNotice}>
                Ristak enviará primero por WhatsApp API. Si ese mismo número pierde la API, usará su QR automáticamente; una plantilla sin aprobar o una ventana cerrada no provocan ese cambio.
              </div>
            )}
          </section>

          <div className={styles.footer}>
            <Button
              variant="ghost"
              onClick={() => setConfirmDeleteOpen(true)}
              disabled={saving || deleting}
            >
              <Trash2 size={16} aria-hidden="true" />
              Eliminar
            </Button>
            <div className={styles.footerActions}>
              <Button variant="secondary" onClick={onClose} disabled={saving || deleting}>
                Cancelar
              </Button>
              <Button variant="primary" onClick={handleSave} disabled={saveDisabled}>
                {saving ? 'Guardando…' : 'Guardar'}
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        title="Eliminar mensaje automático"
        message={`Se dejará de enviar "${reminder.name}" a tus contactos. Esta acción no se puede deshacer.`}
        type="confirm"
        confirmText="Eliminar"
        cancelText="Cancelar"
        onConfirm={handleDelete}
      />
    </>
  )
}

export default AppointmentReminderModal
