import React, { useEffect, useMemo, useState } from 'react'
import { Bell, CalendarCheck, Sparkles, Trash2 } from 'lucide-react'
import {
  Modal,
  Button,
  CheckboxMultiSelect,
  CustomSelect,
  ExpandableTextareaField,
  NumberInput,
  Switch
} from '@/components/common'
import { Badge, type BadgeVariant } from '@/components/common/Badge'
import {
  type AppointmentReminder,
  type AppointmentReminderInput,
  type ReminderConfirmationTimeoutMode,
  type ReminderConfirmationTimeoutUnit,
  type ReminderConfirmationSuccessAction,
  type ReminderChannelOption,
  type ReminderNoConfirmAction,
  type ReminderOffsetUnit,
  type ReminderSenderOption,
  type ReminderTimingAnchor,
  DEFAULT_APPOINTMENT_CONFIRMATION_REPLY_TEXT,
  formatReminderOffsetLabel,
  getAppointmentReminderScheduleConflict
} from '@/services/appointmentRemindersService'
import { useTimezone } from '@/contexts/TimezoneContext'
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
  onSave: (reminderId: string | null, input: AppointmentReminderInput) => Promise<void>
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
  if (timingAnchor === 'after_booking') return DEFAULT_TEMPLATE_NAME_BY_PURPOSE.notice
  return messageType === 'confirmation'
    ? DEFAULT_TEMPLATE_NAME_BY_PURPOSE.confirmation
    : DEFAULT_TEMPLATE_NAME_BY_PURPOSE.reminder
}

const CONFIRMATION_SUCCESS_ACTION_OPTIONS: {
  value: ReminderConfirmationSuccessAction
  label: string
  disabled?: boolean
}[] = [
  {
    value: 'chat_card',
    label: 'Agregar tarjeta de confirmación en el chat'
  },
  {
    value: 'chat_badge',
    label: 'Mostrar etiqueta "Asistirá a cita"'
  },
  {
    value: 'mark_confirmed',
    label: 'Marcar la cita como confirmada',
    disabled: true
  }
]

const DEFAULT_CONFIRMATION_SUCCESS_ACTIONS = CONFIRMATION_SUCCESS_ACTION_OPTIONS.map(option => option.value)

const normalizeConfirmationSuccessActions = (
  actions?: ReminderConfirmationSuccessAction[],
  legacyAction?: ReminderConfirmationSuccessAction
) => {
  const selected = new Set(actions?.length ? actions : legacyAction ? [legacyAction] : DEFAULT_CONFIRMATION_SUCCESS_ACTIONS)
  selected.add('mark_confirmed')
  return CONFIRMATION_SUCCESS_ACTION_OPTIONS
    .map(option => option.value)
    .filter(action => selected.has(action))
}

const NO_CONFIRM_ACTION_OPTIONS: { value: ReminderNoConfirmAction; label: string; description: string }[] = [
  {
    value: 'no_action',
    label: 'Conservar la cita',
    description: 'Ristak conserva la cita cuando vence el plazo sin una confirmación clara.'
  },
  {
    value: 'cancel_appointment',
    label: 'Cancelar la cita',
    description: 'Cancela si vence el plazo sin una confirmación clara. Una cancelación o reagendamiento explícitos se atienden de inmediato.'
  }
]

const CONFIRMATION_TIMEOUT_UNIT_OPTIONS: {
  value: ReminderConfirmationTimeoutUnit
  label: string
}[] = [
  { value: 'minutes', label: 'Minutos' },
  { value: 'hours', label: 'Horas' },
  { value: 'days', label: 'Días' }
]

const CONFIRMATION_TIMEOUT_MODE_OPTIONS: {
  value: ReminderConfirmationTimeoutMode
  label: string
}[] = [
  { value: 'response_window', label: 'Sólo dentro del horario de respuesta' },
  { value: 'elapsed', label: 'Tiempo corrido, incluyendo la noche' }
]

const CONFIRMATION_TIMEOUT_UNIT_MS: Record<ReminderConfirmationTimeoutUnit, number> = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000
}

const MAX_CONFIRMATION_TIMEOUT_MS = 30 * CONFIRMATION_TIMEOUT_UNIT_MS.days
const MAX_CONFIRMATION_REPLY_TEXT_LENGTH = 4096

const maxConfirmationTimeoutValue = (unit: ReminderConfirmationTimeoutUnit) => (
  Math.floor(MAX_CONFIRMATION_TIMEOUT_MS / CONFIRMATION_TIMEOUT_UNIT_MS[unit])
)

const getDefaultConfirmationTimeout = (
  timingAnchor: ReminderTimingAnchor,
  offsetValue: number,
  offsetUnit: ReminderOffsetUnit
): Pick<
  AppointmentReminderInput,
  'confirmationTimeoutValue' |
  'confirmationTimeoutUnit' |
  'confirmationTimeoutMode' |
  'confirmationResponseStart' |
  'confirmationResponseEnd'
> => {
  const protectedWindowDefaults = {
    confirmationTimeoutMode: 'response_window' as ReminderConfirmationTimeoutMode,
    confirmationResponseStart: '09:00',
    confirmationResponseEnd: '21:00'
  }
  if (timingAnchor === 'after_booking') {
    return {
      ...protectedWindowDefaults,
      confirmationTimeoutValue: 6,
      confirmationTimeoutUnit: 'hours'
    }
  }

  const leadMs = Math.max(1, offsetValue) * (
    offsetUnit === 'seconds'
      ? AFTER_OFFSET_UNIT_MS.seconds
      : CONFIRMATION_TIMEOUT_UNIT_MS[offsetUnit]
  )
  if (leadMs > 12 * CONFIRMATION_TIMEOUT_UNIT_MS.hours) {
    return {
      ...protectedWindowDefaults,
      confirmationTimeoutValue: 6,
      confirmationTimeoutUnit: 'hours'
    }
  }
  if (leadMs > 2 * CONFIRMATION_TIMEOUT_UNIT_MS.hours) {
    return {
      ...protectedWindowDefaults,
      confirmationTimeoutValue: 1,
      confirmationTimeoutUnit: 'hours'
    }
  }

  return {
    ...protectedWindowDefaults,
    confirmationTimeoutValue: leadMs > 30 * CONFIRMATION_TIMEOUT_UNIT_MS.minutes
      ? 15
      : leadMs > 5 * CONFIRMATION_TIMEOUT_UNIT_MS.minutes
        ? 5
        : 1,
    confirmationTimeoutUnit: 'minutes'
  }
}

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

const createNewReminderDraft = (): AppointmentReminderInput => ({
  messageType: 'reminder',
  aiEnabled: true,
  bypassAutomations: false,
  senderMode: 'contact',
  senderPhoneNumberId: null,
  templateId: null,
  templateName: '',
  templateLanguage: 'es_MX',
  contentMode: 'template',
  channel: 'whatsapp',
  qrFallbackEnabled: true,
  timingAnchor: 'before_appointment',
  offsetValue: 1,
  offsetUnit: 'days',
  messageText: '',
  smartEnabled: true,
  smartStart: '09:00',
  smartEnd: '21:00',
  smartOverflow: 'before',
  noConfirmAction: 'no_action',
  ...getDefaultConfirmationTimeout('before_appointment', 1, 'days'),
  confirmationReplyText: DEFAULT_APPOINTMENT_CONFIRMATION_REPLY_TEXT,
  confirmationSuccessActions: [...DEFAULT_CONFIRMATION_SUCCESS_ACTIONS]
})

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
  const { timezone } = useTimezone()
  const [draft, setDraft] = useState<AppointmentReminderInput>({})
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [scheduleConflictMessage, setScheduleConflictMessage] = useState('')

  useEffect(() => {
    if (!isOpen) return
    if (reminder) {
      const defaultConfirmationTimeout = getDefaultConfirmationTimeout(
        reminder.timingAnchor || 'before_appointment',
        reminder.offsetValue,
        reminder.offsetUnit
      )
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
          noConfirmAction: reminder.noConfirmAction === 'cancel_appointment'
            ? 'cancel_appointment'
            : 'no_action',
          confirmationTimeoutValue: reminder.confirmationTimeoutValue ??
            defaultConfirmationTimeout.confirmationTimeoutValue,
          confirmationTimeoutUnit: reminder.confirmationTimeoutUnit ??
            defaultConfirmationTimeout.confirmationTimeoutUnit,
          confirmationTimeoutMode: reminder.confirmationTimeoutMode ||
            defaultConfirmationTimeout.confirmationTimeoutMode,
          confirmationResponseStart: reminder.confirmationResponseStart ||
            defaultConfirmationTimeout.confirmationResponseStart,
          confirmationResponseEnd: reminder.confirmationResponseEnd ||
            defaultConfirmationTimeout.confirmationResponseEnd,
          confirmationReplyText: reminder.confirmationReplyText || '',
          confirmationSuccessActions: normalizeConfirmationSuccessActions(
            reminder.confirmationSuccessActions,
            reminder.confirmationSuccessAction
          )
        })
    } else {
      setDraft(createNewReminderDraft())
    }
    setSaving(false)
    setDeleting(false)
    setConfirmDeleteOpen(false)
    setScheduleConflictMessage('')
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
    // El draft de una regla existente se hidrata en otro efecto durante este mismo
    // render. Si elegimos el default antes de que esa hidratación se aplique, el
    // segundo setState pisa silenciosamente cualquier plantilla personalizada.
    if (!isOpen || reminder || isDirectMessage || draft.templateId || !defaultTemplateForType) return
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
  const confirmationTimeoutMode = (
    draft.confirmationTimeoutMode || 'elapsed'
  ) as ReminderConfirmationTimeoutMode
  const confirmationTimeoutUnit = (draft.confirmationTimeoutUnit || 'hours') as ReminderConfirmationTimeoutUnit
  const confirmationTimeoutUnitOptions = confirmationTimeoutMode === 'response_window'
    ? CONFIRMATION_TIMEOUT_UNIT_OPTIONS.filter(option => option.value !== 'days')
    : CONFIRMATION_TIMEOUT_UNIT_OPTIONS
  const confirmationTimeoutValue = Number(draft.confirmationTimeoutValue) || 0
  const confirmationTimeoutMs = confirmationTimeoutValue * CONFIRMATION_TIMEOUT_UNIT_MS[confirmationTimeoutUnit]
  const confirmationWindowEnabled = isConfirmation && draft.aiEnabled !== false
  const confirmationTimeoutMissing = confirmationWindowEnabled &&
    (!confirmationTimeoutValue || !draft.confirmationTimeoutUnit)
  const confirmationTimeoutTooLong = confirmationWindowEnabled &&
    confirmationTimeoutMs > MAX_CONFIRMATION_TIMEOUT_MS
  const confirmationTimeoutExceedsReminderWindow = confirmationWindowEnabled &&
    confirmationTimeoutMode === 'elapsed' &&
    !isAfterBooking &&
    confirmationTimeoutMs >= (
      (Number(draft.offsetValue) || 1) *
      CONFIRMATION_TIMEOUT_UNIT_MS[
        ((draft.offsetUnit as ReminderConfirmationTimeoutUnit) || 'days')
      ]
    )
  const confirmationResponseWindowInvalid = confirmationWindowEnabled &&
    confirmationTimeoutMode === 'response_window' &&
    (
      !draft.confirmationResponseStart ||
      !draft.confirmationResponseEnd ||
      draft.confirmationResponseStart === draft.confirmationResponseEnd
    )
  const confirmationTimeoutInvalid = confirmationTimeoutMissing ||
    confirmationTimeoutTooLong ||
    confirmationTimeoutExceedsReminderWindow ||
    confirmationResponseWindowInvalid
  const confirmationReplyTooLong = String(draft.confirmationReplyText || '').length >
    MAX_CONFIRMATION_REPLY_TEXT_LENGTH

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

    setDraft(prev => {
      const defaultConfirmationTimeout = getDefaultConfirmationTimeout(
        (prev.timingAnchor as ReminderTimingAnchor) || 'before_appointment',
        Number(prev.offsetValue) || 1,
        (prev.offsetUnit as ReminderOffsetUnit) || 'days'
      )
      return {
        ...prev,
        messageType,
        aiEnabled: enabled ? true : false,
        bypassAutomations: enabled ? prev.bypassAutomations : false,
        confirmationSuccessActions: enabled
          ? [...DEFAULT_CONFIRMATION_SUCCESS_ACTIONS]
          : prev.confirmationSuccessActions,
        ...(enabled && (
          !Number(prev.confirmationTimeoutValue) ||
          !prev.confirmationTimeoutUnit
        )
          ? defaultConfirmationTimeout
          : {}),
        ...(shouldSwitchTemplate && nextTemplate
          ? {
              templateId: nextTemplate.id,
              templateName: nextTemplate.name,
              templateLanguage: nextTemplate.language
            }
          : {})
      }
    })
  }

  const changeNoConfirmAction = (value: ReminderNoConfirmAction) => {
    set('noConfirmAction', value)
  }

  const changeConfirmationTimeoutUnit = (unit: ReminderConfirmationTimeoutUnit) => {
    setDraft(prev => ({
      ...prev,
      confirmationTimeoutUnit: unit,
      confirmationTimeoutValue: Math.min(
        Math.max(1, Math.round(Number(prev.confirmationTimeoutValue) || 1)),
        maxConfirmationTimeoutValue(unit)
      )
    }))
  }

  const changeConfirmationTimeoutMode = (mode: ReminderConfirmationTimeoutMode) => {
    setDraft(prev => {
      const currentUnit = (prev.confirmationTimeoutUnit || 'hours') as ReminderConfirmationTimeoutUnit
      if (mode !== 'response_window' || currentUnit !== 'days') {
        return {
          ...prev,
          confirmationTimeoutMode: mode,
          confirmationResponseStart: prev.confirmationResponseStart || '09:00',
          confirmationResponseEnd: prev.confirmationResponseEnd || '21:00'
        }
      }

      return {
        ...prev,
        confirmationTimeoutMode: mode,
        confirmationTimeoutValue: Math.min(
          maxConfirmationTimeoutValue('hours'),
          Math.max(1, Math.round(Number(prev.confirmationTimeoutValue) || 1) * 24)
        ),
        confirmationTimeoutUnit: 'hours',
        confirmationResponseStart: prev.confirmationResponseStart || '09:00',
        confirmationResponseEnd: prev.confirmationResponseEnd || '21:00'
      }
    })
  }

  const handleSave = async () => {
    if (contentMode === 'template' && !draft.templateId) return
    if (contentMode === 'direct' && !String(draft.messageText || '').trim()) return
    setSaving(true)
    try {
      await onSave(reminder?.id || null, {
        ...draft,
        channel: selectedChannelId,
        contentMode,
        qrFallbackEnabled: isWhatsAppApiChannel,
        confirmationReplyText: isConfirmation && draft.aiEnabled !== false
          ? String(draft.confirmationReplyText || '').trim()
          : reminder?.confirmationReplyText || '',
        confirmationSuccessActions: normalizeConfirmationSuccessActions(
          draft.confirmationSuccessActions,
          draft.confirmationSuccessAction
        )
      })
      onClose()
    } catch (error) {
      const conflict = getAppointmentReminderScheduleConflict(error)
      if (conflict) {
        setScheduleConflictMessage(conflict.message)
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!reminder) return
    setDeleting(true)
    try {
      await onDelete(reminder.id)
      onClose()
    } finally {
      setDeleting(false)
    }
  }

  const saveDisabled = saving || deleting ||
    confirmationTimeoutInvalid ||
    confirmationReplyTooLong ||
    (contentMode === 'template' ? !draft.templateId : !String(draft.messageText || '').trim())

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={reminder ? 'Detalles del mensaje automático' : 'Nuevo mensaje automático'}
        size="lg"
        type="custom"
        closeOnBackdropClick={false}
        closeOnEscape={false}
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
                        <span className={styles.switchLabel}>Reservar estas respuestas para la confirmación</span>
                        <span className={styles.helpText}>
                          Mientras la IA reúne y clasifica la respuesta, esos mensajes no se entregan a otros
                          agentes ni a automatizaciones. No se reproducen después; así evitas respuestas cruzadas.
                        </span>
                      </span>
                    </label>

                    <div className={styles.confirmationActionBox}>
                      <div className={styles.field}>
                        <label className={styles.fieldLabel}>Qué quieres que pase cuando se detecte que confirmó la cita</label>
                        <CheckboxMultiSelect
                          value={normalizeConfirmationSuccessActions(
                            draft.confirmationSuccessActions,
                            draft.confirmationSuccessAction
                          )}
                          options={CONFIRMATION_SUCCESS_ACTION_OPTIONS}
                          onChange={(value) => set(
                            'confirmationSuccessActions',
                            normalizeConfirmationSuccessActions(value)
                          )}
                          aria-label="Acciones cuando el contacto confirma la cita"
                        />
                        <span className={styles.helpText}>
                          La cita siempre se marca como confirmada. Aquí sólo eliges las señales
                          visuales que aparecerán dentro del chat.
                        </span>
                      </div>
                    </div>

                    <div className={styles.confirmationActionBox}>
                      <ExpandableTextareaField
                        id="appointment-confirmation-reply-text"
                        label="Mensaje de respuesta al confirmar (opcional)"
                        description="Cuando la IA confirme la cita, Ristak enviará este texto por la misma conversación de WhatsApp que recibió la respuesta. Es un mensaje normal, sin plantilla. Si la confirmación llegó por otro canal, no se enviará."
                        value={draft.confirmationReplyText || ''}
                        onChange={(value) => set('confirmationReplyText', value)}
                        expandedTitle="Editar mensaje de respuesta al confirmar"
                        characterLimit={MAX_CONFIRMATION_REPLY_TEXT_LENGTH}
                        rows={4}
                        placeholder="Ejemplo: ¡Perfecto! Te esperamos en tu cita. Nos vemos pronto."
                      />
                      <span className={styles.helpText}>
                        Puedes usar {'{{contact.first_name}}'}, {'{{contact.name}}'}, {'{{cita.titulo}}'}, {'{{cita.fecha}}'} y {'{{cita.hora}}'}.
                      </span>
                    </div>
                  </>
                )}
              </div>
            )}

            {isConfirmation && draft.aiEnabled !== false && (
              <div className={styles.noConfirmBox}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Al vencer el plazo sin confirmación</label>
                  <CustomSelect
                    value={draft.noConfirmAction || 'no_action'}
                    options={NO_CONFIRM_ACTION_OPTIONS.map(option => ({
                      value: option.value,
                      label: option.label
                    }))}
                    onValueChange={(value) => changeNoConfirmAction(value as ReminderNoConfirmAction)}
                    aria-label="Acción al vencer el plazo sin confirmación"
                    portal
                  />
                  <span className={styles.helpText}>{selectedNoConfirmAction.description}</span>
                  <span className={styles.helpText}>
                    Por defecto, Ristak envía el push de confirmación. Puedes apagarlo por
                    destinatario en Configuración → Notificaciones → Confirmaciones de cita.
                  </span>
                </div>
                <div className={styles.field}>
                    <label className={styles.fieldLabel}>Esperar la confirmación durante</label>
                    <div className={styles.offsetRow}>
                      <NumberInput
                        className={styles.offsetInput}
                        min={1}
                        max={maxConfirmationTimeoutValue(confirmationTimeoutUnit)}
                        maxFractionDigits={0}
                        value={draft.confirmationTimeoutValue ?? ''}
                        onValueChange={(value) => set('confirmationTimeoutValue', Math.round(value))}
                        aria-label="Tiempo límite para confirmar"
                      />
                      <div className={styles.offsetUnit}>
                        <CustomSelect
                          value={confirmationTimeoutUnit}
                          options={confirmationTimeoutUnitOptions}
                          onValueChange={(value) => changeConfirmationTimeoutUnit(value as ReminderConfirmationTimeoutUnit)}
                          aria-label="Unidad del tiempo límite para confirmar"
                          portal
                        />
                      </div>
                    </div>
                    {confirmationTimeoutMissing && (
                      <span className={styles.helpText}>Escribe un plazo para poder guardar esta confirmación.</span>
                    )}
                    {confirmationTimeoutTooLong && (
                      <span className={styles.helpText}>
                        {confirmationTimeoutMode === 'response_window'
                          ? 'El plazo máximo es de 30 días de tiempo disponible.'
                          : 'El plazo máximo es de 30 días.'}
                      </span>
                    )}
                    {confirmationTimeoutExceedsReminderWindow && (
                      <span className={styles.helpText}>
                        El plazo debe ser menor que el tiempo entre este mensaje y el inicio de la cita ({offsetLabel}).
                      </span>
                    )}
                    {!confirmationTimeoutInvalid && confirmationTimeoutMode === 'elapsed' && (
                      <span className={styles.helpText}>
                        El reloj empieza cuando Ristak termina de enviar el mensaje. Si hay una respuesta en análisis, termina de revisarla antes de decidir.
                      </span>
                    )}
                    {(isAfterBooking || confirmationTimeoutMode === 'response_window') && (
                      <span className={styles.helpText}>
                        Si la cita empieza antes de que termine este plazo, Ristak la conserva.
                      </span>
                    )}
                    <span className={styles.helpText}>
                      Una falla técnica o un caso que requiere atención humana conserva la cita y te avisa.
                    </span>
                    <div className={styles.field}>
                      <label className={styles.fieldLabel}>Cómo contar este plazo</label>
                      <CustomSelect
                        value={confirmationTimeoutMode}
                        options={CONFIRMATION_TIMEOUT_MODE_OPTIONS}
                        onValueChange={(value) => changeConfirmationTimeoutMode(
                          value as ReminderConfirmationTimeoutMode
                        )}
                        aria-label="Cómo contar el plazo de confirmación"
                        portal
                      />
                      <span className={styles.helpText}>
                        {confirmationTimeoutMode === 'response_window'
                          ? 'El contador se pausa fuera del horario elegido para no castigar horas de sueño o momentos en que normalmente nadie responde.'
                          : 'Cuenta cada minuto desde el envío, aunque sea de noche.'}
                      </span>

                      {confirmationTimeoutMode === 'response_window' && (
                        <>
                          <div className={styles.fieldRow}>
                            <div className={styles.field}>
                              <label className={styles.fieldLabel}>El contador corre desde</label>
                              <input
                                type="time"
                                className={styles.timeInput}
                                value={draft.confirmationResponseStart || '09:00'}
                                onChange={(event) => set('confirmationResponseStart', event.target.value)}
                                aria-label="Inicio del horario de respuesta"
                              />
                            </div>
                            <div className={styles.field}>
                              <label className={styles.fieldLabel}>Hasta</label>
                              <input
                                type="time"
                                className={styles.timeInput}
                                value={draft.confirmationResponseEnd || '21:00'}
                                onChange={(event) => set('confirmationResponseEnd', event.target.value)}
                                aria-label="Fin del horario de respuesta"
                              />
                            </div>
                          </div>
                          {confirmationResponseWindowInvalid ? (
                            <span className={styles.helpText}>
                              La hora de inicio y la hora de fin deben ser distintas.
                            </span>
                          ) : (
                            <span className={styles.helpText}>
                              Se aplica todos los días en la zona horaria del negocio ({timezone}).
                              Si la hora final es menor que la inicial, el horario cruza medianoche.
                            </span>
                          )}
                          <span className={styles.helpText}>
                            La persona puede responder a cualquier hora; este horario sólo decide
                            cuándo avanza el ultimátum.
                          </span>
                          <span className={styles.helpText}>
                            Ejemplo: si sólo queda una hora disponible hoy, Ristak cuenta esa hora,
                            pausa durante la noche y continúa mañana al abrir este horario.
                          </span>
                        </>
                      )}
                    </div>
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
            {reminder && (
              <Button
                variant="ghost"
                onClick={() => setConfirmDeleteOpen(true)}
                disabled={saving || deleting}
              >
                <Trash2 size={16} aria-hidden="true" />
                Eliminar
              </Button>
            )}
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
        message={`Se dejará de enviar "${reminder?.name || 'este mensaje automático'}" a tus contactos. Esta acción no se puede deshacer.`}
        type="confirm"
        confirmText="Eliminar"
        cancelText="Cancelar"
        onConfirm={handleDelete}
      />

      <Modal
        isOpen={Boolean(scheduleConflictMessage)}
        onClose={() => setScheduleConflictMessage('')}
        title="Ya existe un recordatorio en ese momento"
        message={scheduleConflictMessage}
        type="alert"
        confirmText="Entendido"
      />
    </>
  )
}

export default AppointmentReminderModal
