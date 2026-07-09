export type ContactAdvancedFieldType = 'text' | 'number' | 'date' | 'boolean' | 'select' | 'tags' | 'custom_field'

export type ContactAdvancedFieldCatalog =
  | 'campaigns'
  | 'adsets'
  | 'ads'
  | 'automations'
  | 'calendars'
  | 'users'
  | 'payments'
  | 'payment_plans'

export type ContactAdvancedOperator =
  | 'is'
  | 'is_not'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'empty'
  | 'not_empty'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'between'
  | 'before'
  | 'after'
  | 'on'
  | 'last_days'
  | 'older_days'
  | 'yes'
  | 'no'
  | 'any'
  | 'all'
  | 'none'

export interface ContactAdvancedOption {
  value: string
  label: string
}

export interface ContactAdvancedField {
  key: string
  label: string
  type: ContactAdvancedFieldType
  options?: ContactAdvancedOption[]
  catalog?: ContactAdvancedFieldCatalog
  placeholder?: string
}

export interface ContactAdvancedFieldGroup {
  label: string
  fields: ContactAdvancedField[]
}

export interface ContactAdvancedRule {
  id: string
  field: string
  operator: ContactAdvancedOperator
  value?: string | string[] | number | boolean | null
  valueTo?: string | number | null
  customKey?: string
  valueType?: ContactAdvancedFieldType
}

export interface ContactAdvancedGroup {
  id: string
  mode: 'all' | 'any'
  negate?: boolean
  rules: ContactAdvancedRule[]
}

export interface ContactAdvancedSort {
  by: string
  order: 'ASC' | 'DESC'
}

export interface ContactAdvancedFilterConfig {
  version: 1
  groupMode?: 'all' | 'any'
  groups: ContactAdvancedGroup[]
  sort?: ContactAdvancedSort | null
}

export const CONTACT_ADVANCED_FILTERS_URL_PARAM = 'conditions'

const idSuffix = () => Math.random().toString(36).slice(2, 9)

const textOperators: ContactAdvancedOption[] = [
  { value: 'contains', label: 'contiene' },
  { value: 'not_contains', label: 'no contiene' },
  { value: 'is', label: 'es igual a' },
  { value: 'is_not', label: 'no es igual a' },
  { value: 'starts_with', label: 'empieza con' },
  { value: 'ends_with', label: 'termina con' },
  { value: 'empty', label: 'está vacío' },
  { value: 'not_empty', label: 'no está vacío' }
]

const numberOperators: ContactAdvancedOption[] = [
  { value: 'eq', label: 'es igual a' },
  { value: 'neq', label: 'no es igual a' },
  { value: 'gt', label: 'mayor que' },
  { value: 'gte', label: 'mayor o igual que' },
  { value: 'lt', label: 'menor que' },
  { value: 'lte', label: 'menor o igual que' },
  { value: 'between', label: 'está entre' },
  { value: 'empty', label: 'está en cero' },
  { value: 'not_empty', label: 'no está en cero' }
]

const dateOperators: ContactAdvancedOption[] = [
  { value: 'after', label: 'después de' },
  { value: 'before', label: 'antes de' },
  { value: 'on', label: 'en la fecha' },
  { value: 'between', label: 'entre fechas' },
  { value: 'last_days', label: 'en los últimos días' },
  { value: 'older_days', label: 'hace más de días' },
  { value: 'empty', label: 'está vacío' },
  { value: 'not_empty', label: 'no está vacío' }
]

const booleanOperators: ContactAdvancedOption[] = [
  { value: 'yes', label: 'sí lo tiene' },
  { value: 'no', label: 'no lo tiene' }
]

const tagOperators: ContactAdvancedOption[] = [
  { value: 'any', label: 'tiene cualquiera de' },
  { value: 'all', label: 'tiene todas' },
  { value: 'none', label: 'no tiene' },
  { value: 'empty', label: 'sin etiquetas' },
  { value: 'not_empty', label: 'con etiquetas' }
]

const selectOperators: ContactAdvancedOption[] = [
  { value: 'is', label: 'es igual a' },
  { value: 'is_not', label: 'no es igual a' },
  { value: 'empty', label: 'está vacío' },
  { value: 'not_empty', label: 'no está vacío' }
]

const statusOptions: ContactAdvancedOption[] = [
  { value: 'lead', label: 'Interesado / lead' },
  { value: 'appointment', label: 'Citado' },
  { value: 'customer', label: 'Contacto comprador' }
]

const priorityOptions: ContactAdvancedOption[] = [
  { value: 'high', label: 'Alta: compradores' },
  { value: 'medium', label: 'Media: citados o asistencias' },
  { value: 'low', label: 'Baja: interesados' }
]

const paymentStatusOptions: ContactAdvancedOption[] = [
  { value: 'succeeded', label: 'Exitoso' },
  { value: 'paid', label: 'Pagado' },
  { value: 'completed', label: 'Completado' },
  { value: 'authorized', label: 'Autorizado' },
  { value: 'processing', label: 'Procesando' },
  { value: 'pending', label: 'Pendiente' },
  { value: 'sent', label: 'Link enviado' },
  { value: 'incomplete', label: 'Incompleto' },
  { value: 'unpaid', label: 'Sin pagar' },
  { value: 'failed', label: 'Fallido' },
  { value: 'declined', label: 'Declinado' },
  { value: 'rejected', label: 'Rechazado' },
  { value: 'cancelled', label: 'Cancelado' },
  { value: 'canceled', label: 'Cancelado' },
  { value: 'expired', label: 'Expirado' },
  { value: 'refunded', label: 'Reembolsado' },
  { value: 'chargeback', label: 'Contracargo' },
  { value: 'disputed', label: 'Disputado' }
]

const paymentModeOptions: ContactAdvancedOption[] = [
  { value: 'live', label: 'Real' },
  { value: 'test', label: 'Prueba' }
]

const appointmentStatusOptions: ContactAdvancedOption[] = [
  { value: 'pending', label: 'Pendiente' },
  { value: 'confirmed', label: 'Confirmada' },
  { value: 'scheduled', label: 'Agendada' },
  { value: 'booked', label: 'Reservada' },
  { value: 'showed', label: 'Asistió' },
  { value: 'attended', label: 'Asistió' },
  { value: 'completed', label: 'Completada' },
  { value: 'complete', label: 'Completada' },
  { value: 'no_show', label: 'No asistió' },
  { value: 'no-show', label: 'No asistió' },
  { value: 'missed', label: 'Perdida' },
  { value: 'rescheduled', label: 'Reprogramada' },
  { value: 'cancelled', label: 'Cancelada' },
  { value: 'canceled', label: 'Cancelada' },
  { value: 'invalid', label: 'Inválida' }
]

const paymentProviderOptions: ContactAdvancedOption[] = [
  { value: 'highlevel', label: 'HighLevel' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'conekta', label: 'Conekta' },
  { value: 'rebill', label: 'Rebill' },
  { value: 'mercadopago', label: 'Mercado Pago' },
  { value: 'clip', label: 'Clip' },
  { value: 'gigstack', label: 'Gigstack' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'manual', label: 'Manual' }
]

const paymentMethodOptions: ContactAdvancedOption[] = [
  { value: 'card', label: 'Tarjeta' },
  { value: 'credit_card', label: 'Tarjeta de crédito' },
  { value: 'debit_card', label: 'Tarjeta de débito' },
  { value: 'saved_card', label: 'Tarjeta guardada' },
  { value: 'stripe_saved_card', label: 'Tarjeta guardada de Stripe' },
  { value: 'conekta_subscription', label: 'Tarjeta guardada de Conekta' },
  { value: 'mercadopago_subscription', label: 'Autorización de Mercado Pago' },
  { value: 'cash', label: 'Efectivo' },
  { value: 'transfer', label: 'Transferencia' },
  { value: 'bank_transfer', label: 'Transferencia bancaria' },
  { value: 'oxxo', label: 'OXXO' },
  { value: 'spei', label: 'SPEI' },
  { value: 'link', label: 'Link de pago' },
  { value: 'payment_link', label: 'Link de pago' },
  { value: 'subscription', label: 'Suscripción' },
  { value: 'installment', label: 'Parcialidad' }
]

const sourcePlatformOptions: ContactAdvancedOption[] = [
  { value: 'facebook', label: 'Facebook' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'google', label: 'Google' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'bing', label: 'Bing / Microsoft' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'twitter', label: 'X / Twitter' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'directo', label: 'Directo' },
  { value: 'otro', label: 'Otro' }
]

const trackingChannelOptions: ContactAdvancedOption[] = [
  { value: 'paid', label: 'Pagado' },
  { value: 'organic', label: 'Orgánico' },
  { value: 'direct', label: 'Directo' },
  { value: 'referral', label: 'Referido' },
  { value: 'social', label: 'Red social' },
  { value: 'email', label: 'Correo' },
  { value: 'whatsapp', label: 'WhatsApp' }
]

const metaPlacementOptions: ContactAdvancedOption[] = [
  { value: 'feed', label: 'Feed' },
  { value: 'stories', label: 'Stories' },
  { value: 'reels', label: 'Reels' },
  { value: 'search', label: 'Búsqueda' },
  { value: 'explore', label: 'Explorar' },
  { value: 'marketplace', label: 'Marketplace' },
  { value: 'messenger', label: 'Messenger' },
  { value: 'audience_network', label: 'Audience Network' }
]

const matchTypeOptions: ContactAdvancedOption[] = [
  { value: 'exact', label: 'Exacta' },
  { value: 'phrase', label: 'Frase' },
  { value: 'broad', label: 'Amplia' },
  { value: 'content', label: 'Contenido' }
]

const trackingSourceOptions: ContactAdvancedOption[] = [
  { value: 'external_pixel', label: 'Pixel externo' },
  { value: 'site', label: 'Sitio de Ristak' },
  { value: 'form', label: 'Formulario' },
  { value: 'public_checkout', label: 'Checkout público' },
  { value: 'whatsapp', label: 'WhatsApp' }
]

const deviceOptions: ContactAdvancedOption[] = [
  { value: 'desktop', label: 'Computadora' },
  { value: 'mobile', label: 'Celular' },
  { value: 'tablet', label: 'Tablet' }
]

const browserOptions: ContactAdvancedOption[] = [
  { value: 'chrome', label: 'Chrome' },
  { value: 'safari', label: 'Safari' },
  { value: 'edge', label: 'Edge' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'opera', label: 'Opera' },
  { value: 'samsung', label: 'Samsung Internet' }
]

const operatingSystemOptions: ContactAdvancedOption[] = [
  { value: 'ios', label: 'iOS' },
  { value: 'android', label: 'Android' },
  { value: 'macos', label: 'macOS' },
  { value: 'windows', label: 'Windows' },
  { value: 'linux', label: 'Linux' }
]

const automationStatusOptions: ContactAdvancedOption[] = [
  { value: 'active', label: 'Activa' },
  { value: 'waiting', label: 'En espera' },
  { value: 'completed', label: 'Finalizada' },
  { value: 'exited', label: 'Salió del flujo' },
  { value: 'paused', label: 'Pausada' },
  { value: 'cancelled', label: 'Cancelada' },
  { value: 'canceled', label: 'Cancelada' },
  { value: 'failed', label: 'Fallida' }
]

const automationWaitKindOptions: ContactAdvancedOption[] = [
  { value: 'delay', label: 'Espera por tiempo' },
  { value: 'until', label: 'Espera hasta fecha' },
  { value: 'reply', label: 'Esperando respuesta' },
  { value: 'appointment', label: 'Esperando cita' },
  { value: 'payment', label: 'Esperando pago' },
  { value: 'webhook', label: 'Esperando webhook' }
]

const googleSyncStatusOptions: ContactAdvancedOption[] = [
  { value: 'pending', label: 'Pendiente' },
  { value: 'synced', label: 'Sincronizada' },
  { value: 'failed', label: 'Fallida' },
  { value: 'deleted', label: 'Eliminada' }
]

const paymentFlowStateOptions: ContactAdvancedOption[] = [
  { value: 'pending', label: 'Pendiente' },
  { value: 'first_payment_pending', label: 'Esperando primer pago' },
  { value: 'card_setup_pending', label: 'Esperando tarjeta' },
  { value: 'installment_plan_active', label: 'Plan activo' },
  { value: 'completed', label: 'Completado' },
  { value: 'cancelled', label: 'Cancelado' },
  { value: 'canceled', label: 'Cancelado' },
  { value: 'failed', label: 'Fallido' }
]

const paymentPlanStatusOptions: ContactAdvancedOption[] = [
  { value: 'active', label: 'Activo' },
  { value: 'pending', label: 'Pendiente' },
  { value: 'paused', label: 'Pausado' },
  { value: 'completed', label: 'Completado' },
  { value: 'cancelled', label: 'Cancelado' },
  { value: 'canceled', label: 'Cancelado' },
  { value: 'failed', label: 'Fallido' },
  { value: 'expired', label: 'Expirado' }
]

const installmentStatusOptions: ContactAdvancedOption[] = [
  { value: 'pending', label: 'Pendiente' },
  { value: 'scheduled', label: 'Programada' },
  { value: 'due', label: 'Vencida' },
  { value: 'paid', label: 'Pagada' },
  { value: 'failed', label: 'Fallida' },
  { value: 'cancelled', label: 'Cancelada' },
  { value: 'canceled', label: 'Cancelada' }
]

export const CONTACT_ADVANCED_FIELD_GROUPS: ContactAdvancedFieldGroup[] = [
  {
    label: 'Contacto',
    fields: [
      { key: 'first_name', label: 'Nombre', type: 'text' },
      { key: 'last_name', label: 'Apellidos', type: 'text' },
      { key: 'full_name', label: 'Nombre completo', type: 'text' },
      { key: 'email', label: 'Correo electrónico', type: 'text' },
      { key: 'phone', label: 'Teléfono', type: 'text' },
      { key: 'source', label: 'Fuente de contacto', type: 'text' },
      { key: 'status', label: 'Condición comercial', type: 'select', options: statusOptions },
      { key: 'priority', label: 'Prioridad', type: 'select', options: priorityOptions },
      { key: 'created_at', label: 'Creada', type: 'date' },
      { key: 'updated_at', label: 'Actualizado', type: 'date' },
      { key: 'assigned_user_id', label: 'Propietario', type: 'text', catalog: 'users', placeholder: 'Buscar usuario' },
      { key: 'visitor_id', label: 'Visitor ID', type: 'text' },
      { key: 'ghl_contact_id', label: 'ID de contacto potencial', type: 'text' },
      { key: 'stripe_customer_id', label: 'ID de Stripe', type: 'text' },
      { key: 'conekta_customer_id', label: 'ID de Conekta', type: 'text' },
      { key: 'preferred_whatsapp_phone_number_id', label: 'Número de WhatsApp asignado', type: 'text' }
    ]
  },
  {
    label: 'Etiquetas y campos',
    fields: [
      { key: 'tags', label: 'Etiquetas', type: 'tags' },
      { key: 'custom_field', label: 'Campo personalizado', type: 'custom_field' }
    ]
  },
  {
    label: 'Citas y asistencia',
    fields: [
      { key: 'has_any_appointment', label: 'Tiene alguna cita', type: 'boolean' },
      { key: 'has_active_appointment', label: 'Tiene cita activa', type: 'boolean' },
      { key: 'has_future_appointment', label: 'Tiene cita futura', type: 'boolean' },
      { key: 'has_past_appointment', label: 'Tiene cita pasada', type: 'boolean' },
      { key: 'has_attended_appointment', label: 'Tiene asistencia', type: 'boolean' },
      { key: 'has_cancelled_appointment', label: 'Tiene cita cancelada', type: 'boolean' },
      { key: 'has_no_show_appointment', label: 'Tiene inasistencia', type: 'boolean' },
      { key: 'has_confirmation_badge', label: 'Tiene confirmación vigente', type: 'boolean' },
      { key: 'appointments_count', label: 'Cantidad de citas', type: 'number' },
      { key: 'active_appointments_count', label: 'Cantidad de citas activas', type: 'number' },
      { key: 'future_appointments_count', label: 'Cantidad de citas futuras', type: 'number' },
      { key: 'past_appointments_count', label: 'Cantidad de citas pasadas', type: 'number' },
      { key: 'attended_appointments_count', label: 'Cantidad de asistencias', type: 'number' },
      { key: 'cancelled_appointments_count', label: 'Cantidad de citas canceladas', type: 'number' },
      { key: 'no_show_appointments_count', label: 'Cantidad de inasistencias', type: 'number' },
      { key: 'appointment_id', label: 'ID de cita', type: 'text' },
      { key: 'appointment_date', label: 'Fecha de cualquier cita', type: 'date' },
      { key: 'active_appointment_date', label: 'Fecha de cita activa', type: 'date' },
      { key: 'next_appointment_date', label: 'Próxima cita', type: 'date' },
      { key: 'last_appointment_date', label: 'Última cita', type: 'date' },
      { key: 'appointment_end_date', label: 'Fin de cita', type: 'date' },
      { key: 'appointment_created_at', label: 'Cita creada', type: 'date' },
      { key: 'appointment_updated_at', label: 'Cita actualizada', type: 'date' },
      { key: 'appointment_confirmation_until', label: 'Confirmación vigente hasta', type: 'date' },
      { key: 'contact_appointment_date', label: 'Última cita registrada', type: 'date' },
      { key: 'appointment_status', label: 'Estado de cita', type: 'select', options: appointmentStatusOptions },
      { key: 'appointment_calendar', label: 'Calendario de cita', type: 'text', catalog: 'calendars', placeholder: 'Buscar calendario' },
      { key: 'appointment_assigned_user', label: 'Usuario asignado a cita', type: 'text', catalog: 'users', placeholder: 'Buscar usuario' },
      { key: 'appointment_title', label: 'Título de cita', type: 'text' },
      { key: 'appointment_notes', label: 'Notas de cita', type: 'text' },
      { key: 'appointment_address', label: 'Dirección de cita', type: 'text' },
      { key: 'appointment_google_event_id', label: 'ID de Google Calendar', type: 'text' },
      { key: 'appointment_google_sync_status', label: 'Estado de Google Calendar', type: 'select', options: googleSyncStatusOptions }
    ]
  },
  {
    label: 'Pagos y cobros',
    fields: [
      { key: 'has_payments', label: 'Tiene pagos', type: 'boolean' },
      { key: 'has_successful_payment', label: 'Tiene pagos exitosos', type: 'boolean' },
      { key: 'has_failed_payment', label: 'Tiene pagos fallidos', type: 'boolean' },
      { key: 'has_saved_payment_method', label: 'Tiene tarjeta guardada', type: 'boolean' },
      { key: 'payments_count', label: 'Cantidad de pagos', type: 'number' },
      { key: 'successful_payments_count', label: 'Cantidad de pagos exitosos', type: 'number' },
      { key: 'failed_payments_count', label: 'Cantidad de pagos fallidos', type: 'number' },
      { key: 'total_paid', label: 'Total pagado', type: 'number' },
      { key: 'average_payment_amount', label: 'Pago promedio', type: 'number' },
      { key: 'last_payment_date', label: 'Último pago exitoso', type: 'date' },
      { key: 'payment_date', label: 'Fecha de pago', type: 'date' },
      { key: 'payment_created_at', label: 'Pago creado', type: 'date' },
      { key: 'payment_amount', label: 'Importe de pago', type: 'number' },
      { key: 'payment_id', label: 'Pago específico', type: 'text', catalog: 'payments', placeholder: 'Buscar pago' },
      { key: 'public_payment_id', label: 'ID público de pago', type: 'text' },
      { key: 'payment_title', label: 'Concepto del pago', type: 'text' },
      { key: 'payment_description', label: 'Descripción del pago', type: 'text' },
      { key: 'payment_reference', label: 'Referencia de pago', type: 'text' },
      { key: 'payment_status', label: 'Estado de pago', type: 'select', options: paymentStatusOptions },
      { key: 'payment_provider', label: 'Proveedor de pago', type: 'select', options: paymentProviderOptions },
      { key: 'payment_mode', label: 'Modo de pago', type: 'select', options: paymentModeOptions },
      { key: 'payment_method', label: 'Método de pago', type: 'select', options: paymentMethodOptions },
      { key: 'payment_currency', label: 'Moneda del pago', type: 'text' }
    ]
  },
  {
    label: 'Planes y parcialidades',
    fields: [
      { key: 'has_payment_plan', label: 'Tiene plan de pagos', type: 'boolean' },
      { key: 'has_pending_installment', label: 'Tiene parcialidad pendiente', type: 'boolean' },
      { key: 'has_overdue_installment', label: 'Tiene parcialidad vencida', type: 'boolean' },
      { key: 'payment_plan_id', label: 'Plan de pago específico', type: 'text', catalog: 'payment_plans', placeholder: 'Buscar plan de pago' },
      { key: 'payment_plan_status', label: 'Estado del plan de pago', type: 'select', options: paymentPlanStatusOptions },
      { key: 'payment_flow_state', label: 'Estado del plan por parcialidades', type: 'select', options: paymentFlowStateOptions },
      { key: 'payment_flow_provider', label: 'Proveedor del plan', type: 'select', options: paymentProviderOptions },
      { key: 'payment_flow_total', label: 'Total del plan', type: 'number' },
      { key: 'payment_flow_created_at', label: 'Plan creado', type: 'date' },
      { key: 'installment_status', label: 'Estado de parcialidad', type: 'select', options: installmentStatusOptions },
      { key: 'installment_due_date', label: 'Fecha de parcialidad', type: 'date' },
      { key: 'installment_amount', label: 'Importe de parcialidad', type: 'number' },
      { key: 'installment_method', label: 'Método de parcialidad', type: 'select', options: paymentMethodOptions }
    ]
  },
  {
    label: 'Atribución, UTM y tracking',
    fields: [
      { key: 'attribution_url', label: 'Primera atribución', type: 'text' },
      { key: 'attribution_session_source', label: 'Fuente de atribución', type: 'text' },
      { key: 'attribution_medium', label: 'Medio de atribución', type: 'text' },
      { key: 'attribution_ctwa_clid', label: 'ID de clic de WhatsApp/Facebook', type: 'text' },
      { key: 'landing_page', label: 'Página de entrada', type: 'text' },
      { key: 'referrer_url', label: 'URL referida', type: 'text' },
      { key: 'utm_source', label: 'Fuente UTM', type: 'text' },
      { key: 'utm_medium', label: 'Medio / conjunto', type: 'text' },
      { key: 'utm_campaign', label: 'Campaña', type: 'text' },
      { key: 'utm_content', label: 'Contenido / anuncio', type: 'text' },
      { key: 'utm_term', label: 'Término UTM', type: 'text' },
      { key: 'source_platform', label: 'Plataforma', type: 'select', options: sourcePlatformOptions },
      { key: 'channel', label: 'Canal de origen', type: 'select', options: trackingChannelOptions },
      { key: 'site_source_name', label: 'Fuente del sitio', type: 'text' },
      { key: 'device_type', label: 'Dispositivo', type: 'select', options: deviceOptions },
      { key: 'browser', label: 'Navegador', type: 'select', options: browserOptions },
      { key: 'os', label: 'Sistema operativo', type: 'select', options: operatingSystemOptions },
      { key: 'tracking_source', label: 'Fuente técnica de tracking', type: 'select', options: trackingSourceOptions },
      { key: 'event_name', label: 'Evento registrado', type: 'text' },
      { key: 'session_started_at', label: 'Fecha de sesión', type: 'date' },
      { key: 'session_created_at', label: 'Registro de sesión', type: 'date' },
      { key: 'gclid', label: 'ID de clic de Google', type: 'text' },
      { key: 'fbclid', label: 'ID de clic de Facebook', type: 'text' },
      { key: 'msclkid', label: 'ID de clic de Microsoft', type: 'text' },
      { key: 'ttclid', label: 'ID de clic de TikTok', type: 'text' },
      { key: 'wbraid', label: 'WBRAID', type: 'text' },
      { key: 'gbraid', label: 'GBRAID', type: 'text' },
      { key: 'network', label: 'Red de anuncio', type: 'text' },
      { key: 'keyword', label: 'Palabra clave', type: 'text' },
      { key: 'search_query', label: 'Búsqueda', type: 'text' },
      { key: 'match_type', label: 'Tipo de coincidencia', type: 'select', options: matchTypeOptions },
      { key: 'geo_city', label: 'Ciudad', type: 'text' },
      { key: 'geo_region', label: 'Región', type: 'text' },
      { key: 'geo_country', label: 'País', type: 'text' },
      { key: 'site_id', label: 'ID de sitio', type: 'text' },
      { key: 'site_name', label: 'Nombre de sitio', type: 'text' },
      { key: 'site_type', label: 'Tipo de sitio', type: 'text' },
      { key: 'form_site_id', label: 'ID de formulario', type: 'text' },
      { key: 'form_site_name', label: 'Nombre de formulario', type: 'text' },
      { key: 'conversion_type', label: 'Tipo de conversión', type: 'text' }
    ]
  },
  {
    label: 'Anuncios Meta',
    fields: [
      { key: 'campaign_name', label: 'Campaña de anuncio', type: 'text', catalog: 'campaigns', placeholder: 'Buscar campaña' },
      { key: 'campaign_id', label: 'ID de campaña', type: 'text', catalog: 'campaigns', placeholder: 'Buscar campaña por nombre o ID' },
      { key: 'adset_name', label: 'Conjunto de anuncios', type: 'text', catalog: 'adsets', placeholder: 'Buscar conjunto de anuncios' },
      { key: 'adset_id', label: 'ID de conjunto', type: 'text', catalog: 'adsets', placeholder: 'Buscar conjunto por nombre o ID' },
      { key: 'ad_name', label: 'Anuncio', type: 'text', catalog: 'ads', placeholder: 'Buscar anuncio' },
      { key: 'ad_id', label: 'ID de anuncio', type: 'text', catalog: 'ads', placeholder: 'Buscar anuncio por nombre o ID' },
      { key: 'attribution_ad_name', label: 'Anuncio de atribución', type: 'text', catalog: 'ads', placeholder: 'Buscar anuncio' },
      { key: 'attribution_ad_id', label: 'ID de anuncio de atribución', type: 'text', catalog: 'ads', placeholder: 'Buscar anuncio por nombre o ID' },
      { key: 'placement', label: 'Ubicación del anuncio', type: 'select', options: metaPlacementOptions },
      { key: 'creative_id', label: 'ID de creativo', type: 'text' },
      { key: 'creative_type', label: 'Tipo de creativo', type: 'text' },
      { key: 'ad_position', label: 'Posición del anuncio', type: 'text' }
    ]
  },
  {
    label: 'Automatizaciones',
    fields: [
      { key: 'active_automation', label: 'Está en automatización activa', type: 'boolean' },
      { key: 'automation_id', label: 'Automatización específica', type: 'text', catalog: 'automations', placeholder: 'Buscar automatización' },
      { key: 'automation_name', label: 'Nombre de automatización', type: 'text', catalog: 'automations', placeholder: 'Buscar automatización' },
      { key: 'automation_status', label: 'Estado en automatización', type: 'select', options: automationStatusOptions },
      { key: 'automation_current_step', label: 'Paso actual de automatización', type: 'text' },
      { key: 'automation_wait_kind', label: 'Tipo de espera', type: 'select', options: automationWaitKindOptions },
      { key: 'automation_entered_at', label: 'Entró a automatización', type: 'date' },
      { key: 'automation_updated_at', label: 'Automatización actualizada', type: 'date' },
      { key: 'automation_resume_at', label: 'Se reanuda en', type: 'date' }
    ]
  }
]

export const CONTACT_ADVANCED_SORT_OPTIONS: Array<ContactAdvancedOption & { sort?: ContactAdvancedSort | null }> = [
  { value: '', label: 'Sin orden especial', sort: null },
  { value: 'priority_desc', label: 'Prioridad alta a menor', sort: { by: 'priority', order: 'DESC' } },
  { value: 'priority_asc', label: 'Prioridad menor a alta', sort: { by: 'priority', order: 'ASC' } },
  { value: 'created_at_desc', label: 'Más recientes primero', sort: { by: 'created_at', order: 'DESC' } },
  { value: 'created_at_asc', label: 'Más antiguos primero', sort: { by: 'created_at', order: 'ASC' } },
  { value: 'total_paid_desc', label: 'Mayor total pagado', sort: { by: 'total_paid', order: 'DESC' } },
  { value: 'purchases_count_desc', label: 'Más pagos exitosos', sort: { by: 'purchases_count', order: 'DESC' } },
  { value: 'payments_count_desc', label: 'Más pagos registrados', sort: { by: 'payments_count', order: 'DESC' } },
  { value: 'failed_payments_count_desc', label: 'Más pagos fallidos', sort: { by: 'failed_payments_count', order: 'DESC' } },
  { value: 'last_purchase_date_desc', label: 'Último pago más reciente', sort: { by: 'last_purchase_date', order: 'DESC' } },
  { value: 'appointments_count_desc', label: 'Más citas', sort: { by: 'appointments_count', order: 'DESC' } },
  { value: 'next_appointment_date_asc', label: 'Próxima cita primero', sort: { by: 'next_appointment_date', order: 'ASC' } },
  { value: 'last_appointment_date_desc', label: 'Última cita más reciente', sort: { by: 'last_appointment_date', order: 'DESC' } }
]

const fieldMap = new Map(CONTACT_ADVANCED_FIELD_GROUPS.flatMap(group => group.fields.map(field => [field.key, field])))
const allOperatorValues = new Set([
  ...textOperators,
  ...numberOperators,
  ...dateOperators,
  ...booleanOperators,
  ...tagOperators,
  ...selectOperators
].map(option => option.value))

export const getContactAdvancedField = (fieldKey: string) => fieldMap.get(fieldKey)

export const getContactAdvancedOperators = (field?: ContactAdvancedField): ContactAdvancedOption[] => {
  if (!field) return textOperators
  if (field.catalog) return selectOperators
  if (field.type === 'number') return numberOperators
  if (field.type === 'date') return dateOperators
  if (field.type === 'boolean') return booleanOperators
  if (field.type === 'tags') return tagOperators
  if (field.type === 'select') return selectOperators
  if (field.type === 'custom_field') return textOperators
  return textOperators
}

export const getDefaultOperatorForContactAdvancedField = (field?: ContactAdvancedField): ContactAdvancedOperator => {
  const operator = getContactAdvancedOperators(field)[0]?.value
  return (operator || 'contains') as ContactAdvancedOperator
}

export const operatorNeedsContactAdvancedValue = (operator: ContactAdvancedOperator) =>
  !['empty', 'not_empty', 'yes', 'no'].includes(operator)

export const operatorUsesContactAdvancedRange = (operator: ContactAdvancedOperator) => operator === 'between'

export const createContactAdvancedRule = (fieldKey = 'tags'): ContactAdvancedRule => {
  const field = getContactAdvancedField(fieldKey) || CONTACT_ADVANCED_FIELD_GROUPS[0].fields[0]
  return {
    id: `rule_${Date.now()}_${idSuffix()}`,
    field: field.key,
    operator: getDefaultOperatorForContactAdvancedField(field),
    value: '',
    valueTo: ''
  }
}

export const createContactAdvancedGroup = (fieldKey = 'tags'): ContactAdvancedGroup => ({
  id: `group_${Date.now()}_${idSuffix()}`,
  mode: 'all',
  negate: false,
  rules: [createContactAdvancedRule(fieldKey)]
})

export const createDefaultContactAdvancedConfig = (): ContactAdvancedFilterConfig => ({
  version: 1,
  groupMode: 'all',
  groups: [],
  sort: null
})

export const normalizeContactAdvancedConfig = (value: unknown): ContactAdvancedFilterConfig => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return createDefaultContactAdvancedConfig()
  const raw = value as Partial<ContactAdvancedFilterConfig>
  const groups = Array.isArray(raw.groups)
    ? raw.groups.map((group, groupIndex) => {
        const rawGroup = group as Partial<ContactAdvancedGroup>
        const rules = Array.isArray(rawGroup.rules)
          ? rawGroup.rules.map((rule, ruleIndex) => {
              const rawRule = rule as Partial<ContactAdvancedRule>
              const field = getContactAdvancedField(String(rawRule.field || '')) || CONTACT_ADVANCED_FIELD_GROUPS[0].fields[0]
              const operatorValues = field.type === 'custom_field'
                ? allOperatorValues
                : new Set(getContactAdvancedOperators(field).map(option => option.value))
              const operator = operatorValues.has(String(rawRule.operator || '') as ContactAdvancedOperator)
                ? rawRule.operator as ContactAdvancedOperator
                : getDefaultOperatorForContactAdvancedField(field)
              return {
                id: String(rawRule.id || `rule_${groupIndex}_${ruleIndex}`),
                field: field.key,
                operator,
                value: rawRule.value ?? '',
                valueTo: rawRule.valueTo ?? '',
                customKey: rawRule.customKey ? String(rawRule.customKey) : '',
                valueType: rawRule.valueType ? rawRule.valueType as ContactAdvancedFieldType : undefined
              }
            })
          : []

        return {
          id: String(rawGroup.id || `group_${groupIndex}`),
          mode: (rawGroup.mode === 'any' ? 'any' : 'all') as ContactAdvancedGroup['mode'],
          negate: Boolean(rawGroup.negate),
          rules
        }
      })
    : []

  const sort = raw.sort && typeof raw.sort === 'object' && !Array.isArray(raw.sort)
    ? {
        by: String(raw.sort.by || ''),
        order: raw.sort.order === 'ASC' ? 'ASC' : 'DESC'
      } as ContactAdvancedSort
    : null

  return {
    version: 1,
    groupMode: raw.groupMode === 'any' ? 'any' : 'all',
    groups,
    sort: sort?.by ? sort : null
  }
}

export const countContactAdvancedRules = (config: ContactAdvancedFilterConfig) =>
  normalizeContactAdvancedConfig(config).groups.reduce((count, group) => count + group.rules.length, 0)

export const hasActiveContactAdvancedConfig = (config: ContactAdvancedFilterConfig) => {
  const normalized = normalizeContactAdvancedConfig(config)
  return countContactAdvancedRules(normalized) > 0 || Boolean(normalized.sort?.by)
}

export const contactAdvancedSortValue = (sort?: ContactAdvancedSort | null) => {
  if (!sort?.by) return ''
  const match = CONTACT_ADVANCED_SORT_OPTIONS.find(option => option.sort?.by === sort.by && option.sort.order === sort.order)
  return match?.value || ''
}

export const serializeContactAdvancedConfig = (config: ContactAdvancedFilterConfig) => {
  const normalized = normalizeContactAdvancedConfig(config)
  if (!hasActiveContactAdvancedConfig(normalized)) return ''
  return JSON.stringify(normalized)
}

export const parseContactAdvancedConfig = (raw: string | null | undefined): ContactAdvancedFilterConfig => {
  if (!raw) return createDefaultContactAdvancedConfig()
  try {
    return normalizeContactAdvancedConfig(JSON.parse(raw))
  } catch {
    return createDefaultContactAdvancedConfig()
  }
}
