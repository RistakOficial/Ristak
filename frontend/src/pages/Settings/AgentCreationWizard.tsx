import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, ArrowRight, Sparkles, Calendar, ShoppingBag, ClipboardList, Filter, Wand2,
  Building2, User, Coffee, Compass, Target, Briefcase, Smile, MessageCircle,
  UserCheck, CalendarCheck, CreditCard, Link2, Wallet, ShieldCheck, Users, Rocket, Bell, MessageSquareText, Bot, type LucideIcon
} from 'lucide-react'
import { Modal, Button, CustomSelect, NumberInput, Switch } from '@/components/common'
import { useLabels } from '@/contexts/LabelsContext'
import {
  conversationalAIProviderOptions,
  getConversationalAIProviderOption,
  getDefaultConversationalModel,
  getKnownConversationalAIProvider,
  getKnownConversationalModel,
  type ConversationalAIProviderId
} from '@/constants/conversationalAIProviders'
import { useAccountCurrency } from '@/hooks'
import { calendarsService, type Calendar as CalendarRecord } from '@/services/calendarsService'
import apiClient from '@/services/apiClient'
import { userAccessService, type TeamUser } from '@/services/userAccessService'
import { formatCurrency } from '@/utils/format'
import { DEFAULT_CRM_LABELS, formatCrmLabelLower } from '@/utils/crmLabels'
import {
  type AgentCompletionMode,
  type AgentIdentityMode,
  type AgentReplyDeliveryMode,
  type AgentResponseDelayUnit,
  type ConversationalAIProviderStatus,
  type ConversationalAgentDefInput,
  type ConversationalLanguageLevel,
  type ConversationalObjective,
  type ConversationalPersuasionLevel,
  type ConversationalSuccessAction
} from '@/services/conversationalAgentService'
import {
  buildInitialAgentWizardDraft as buildInitialDraft,
  buildOverridesFromDraft,
  DEFAULT_AGENT_REPLY_DELIVERY,
  isAgentWizardCitasBooking as isCitasBooking,
  isAgentWizardVentasCharging as isVentasCharging,
  type AgentWizardDraft
} from './agentCreationWizardModel'
import { StepArt } from './AgentCreationWizardArt'
import { WizardTestChat } from './WizardTestChat'
import styles from './AgentCreationWizard.module.css'

interface Choice<T extends string> {
  value: T
  label: string
  example: string
  Icon: LucideIcon
}

interface WizardProductPrice {
  id?: string
  _id?: string
  localId?: string
  name?: string
  amount?: number
  price?: number
  currency?: string
}

interface WizardProduct {
  id?: string
  _id?: string
  localId?: string
  name: string
  currency?: string
  prices?: WizardProductPrice[]
}

const getWizardProductId = (product?: WizardProduct | null) => product?.id || product?._id || product?.localId || ''
const getWizardPriceId = (price?: WizardProductPrice | null) => price?.id || price?._id || price?.localId || ''
const getWizardPriceAmount = (price?: WizardProductPrice | null) => Number(price?.amount ?? price?.price ?? 0) || 0
const isSafeWizardUrl = (value: string) => {
  try {
    const parsed = new URL(String(value || '').trim())
    return Boolean(parsed.hostname) && (parsed.protocol === 'https:' || parsed.protocol === 'http:')
  } catch {
    return false
  }
}

// Lenguaje muy sencillo, coloquial, con ejemplos y comparaciones: el wizard también enseña.
const objectiveChoices: Array<Choice<ConversationalObjective>> = [
  { value: 'citas', label: 'Agendar citas', example: 'Lleva a la persona hasta que aparta día y hora. Como una recepcionista que llena la agenda.', Icon: Calendar },
  { value: 'ventas', label: 'Cerrar ventas', example: 'Lleva a la persona hasta que quiere pagar. Como un buen vendedor de piso.', Icon: ShoppingBag },
  { value: 'datos', label: 'Juntar datos', example: 'Pide lo que falta (nombre, correo, teléfono). Como llenar una ficha sin que se sienta interrogatorio.', Icon: ClipboardList },
  { value: 'filtrar', label: 'Calificar prospectos', example: 'Detecta quién cumple tus criterios y quién necesita otro camino, sin juzgar ni presionar.', Icon: Filter },
  { value: 'custom', label: 'Mi propia meta', example: 'Tú la escribes. Ejemplo: "que pida una cotización formal".', Icon: Wand2 }
]

const identityChoices: Array<Choice<AgentIdentityMode>> = [
  { value: 'business', label: 'Representante del negocio', example: 'Habla como equipo: "nosotros te ayudamos".', Icon: Building2 },
  { value: 'user', label: 'Persona del equipo', example: 'Se presenta con el nombre de alguien de tu equipo.', Icon: UserCheck },
  { value: 'custom', label: 'Nombre personalizado', example: 'Se presenta con nombre: "hola, soy Sofía".', Icon: User },
  { value: 'agent', label: 'Nombre del agente', example: 'Usa el nombre que configuraste arriba para presentarse.', Icon: Bot }
]

const persuasionChoices: Array<Choice<ConversationalPersuasionLevel>> = [
  { value: 'low', label: 'Atención', example: 'Resuelve y orienta. Sólo propone avanzar cuando la persona lo pide claramente.', Icon: Coffee },
  { value: 'medium', label: 'Guía', example: 'Entiende la situación y facilita el siguiente paso con tacto. Es la opción recomendada.', Icon: Compass },
  { value: 'high', label: 'Proactivo', example: 'Detecta oportunidades y propone el siguiente paso cuando hay evidencia, sin presionar.', Icon: Target }
]

const languageChoices: Array<Choice<ConversationalLanguageLevel>> = [
  { value: 'professional', label: 'Ejecutivo', example: 'Pulido y formal, pero humano. Para marcas premium y tratos importantes.', Icon: Briefcase },
  { value: 'intermediate', label: 'Cómplice', example: 'Natural y cercano, ni tieso ni vulgar. El punto dulce que le queda a casi todos.', Icon: Smile },
  { value: 'colloquial', label: 'Casual', example: 'Relajado y de chat, adaptándose a la persona sin forzar modismos.', Icon: MessageCircle }
]

const actionChoicesByObjective: Record<ConversationalObjective, Array<Choice<ConversationalSuccessAction>>> = {
  citas: [
    { value: 'ready_for_human', label: 'Un humano', example: 'La IA detecta intención real y avisa para que tu equipo agende.', Icon: UserCheck },
    { value: 'book_appointment', label: 'El agente IA', example: 'La IA confirma un horario real y agenda la cita en el calendario.', Icon: CalendarCheck },
    { value: 'send_goal_url', label: 'La IA mandando un enlace', example: 'Manda un link conectado a Ristak y confirma la meta sólo cuando la cita sí se agenda.', Icon: Link2 }
  ],
  ventas: [
    { value: 'ready_for_human', label: 'Un humano', example: 'La IA detecta intención de compra y avisa para que tu equipo cierre.', Icon: UserCheck },
    { value: 'ready_to_buy', label: 'El agente IA', example: 'La IA guía el pago y la venta se completa cuando el pago queda confirmado.', Icon: CreditCard },
    { value: 'send_goal_url', label: 'La IA mandando un enlace', example: 'Manda un link conectado a Ristak y confirma la meta sólo cuando el pago sí se completa.', Icon: Link2 }
  ],
  datos: [
    { value: 'ready_for_human', label: 'Un humano', example: 'Junta los datos y avisa a tu gente para que continúe.', Icon: UserCheck }
  ],
  filtrar: [
    { value: 'ready_for_human', label: 'Un humano', example: 'Filtra la plática y avisa cuando la persona ya vale la pena atender.', Icon: UserCheck }
  ],
  custom: [
    { value: 'ready_for_human', label: 'Un humano', example: 'Cuando la meta está lista, detiene el bot y avisa a tu gente.', Icon: UserCheck },
    { value: 'send_trigger_link', label: 'La IA mandando un enlace', example: 'Manda el enlace; el resultado sólo se confirma cuando una integración conectada reporta que sí ocurrió.', Icon: Link2 }
  ]
}

const responseDelayModeOptions: Array<{ value: AgentWizardDraft['responseDelay']['mode']; label: string }> = [
  { value: 'none', label: 'No esperar' },
  { value: 'fixed', label: 'Esperar tiempo fijo' },
  { value: 'random', label: 'Aleatorio en un rango' }
]

const responseDelayUnitOptions: Array<{ value: AgentResponseDelayUnit; label: string }> = [
  { value: 'seconds', label: 'Segundos' },
  { value: 'minutes', label: 'Minutos' }
]

const completionModeOptions: Array<{ value: AgentCompletionMode; label: string }> = [
  { value: 'notify_only', label: 'Pasar a humano y notificar' },
  { value: 'assign_user', label: 'Asignar usuario y notificar' }
]

type StepId =
  | 'welcome' | 'name' | 'ai' | 'identity' | 'persuasion' | 'language' | 'instructions'
  | 'delay' | 'delivery' | 'notifications' | 'objective' | 'action' | 'calendar'
  | 'payment' | 'goalUrl' | 'completion' | 'data' | 'handoff' | 'scope' | 'recap' | 'test'

interface Props {
  isOpen: boolean
  onClose: () => void
  onComplete: (overrides: ConversationalAgentDefInput) => void | Promise<void>
  onSkipToManual?: () => void
  creating?: boolean
  defaultName?: string
  aiProvider?: ConversationalAIProviderId
  model?: string
  aiProviders?: ConversationalAIProviderStatus[]
  onConnectProvider?: (providerId: ConversationalAIProviderId) => void
}

export function AgentCreationWizard({ isOpen, onClose, onComplete, onSkipToManual, creating = false, defaultName = '', aiProvider, model, aiProviders = [], onConnectProvider }: Props) {
  const [stepIndex, setStepIndex] = useState(0)
  const [draft, setDraft] = useState<AgentWizardDraft>(() => buildInitialDraft(defaultName, { aiProvider, model }))
  const [calendars, setCalendars] = useState<CalendarRecord[]>([])
  const [products, setProducts] = useState<WizardProduct[]>([])
  const [productsLoading, setProductsLoading] = useState(false)
  const [teamUsers, setTeamUsers] = useState<TeamUser[]>([])
  const [teamUsersLoading, setTeamUsersLoading] = useState(false)
  const [testResetKey, setTestResetKey] = useState(0)
  const [accountCurrency] = useAccountCurrency()
  const { labels } = useLabels()
  const customerLowerLabel = formatCrmLabelLower(labels.customer, DEFAULT_CRM_LABELS.customer)
  const customersLowerLabel = formatCrmLabelLower(labels.customers, DEFAULT_CRM_LABELS.customers)
  const leadLowerLabel = formatCrmLabelLower(labels.lead, DEFAULT_CRM_LABELS.lead)
  const localizedLanguageChoices = useMemo<Array<Choice<ConversationalLanguageLevel>>>(() => (
    languageChoices.map((choice) => (
      choice.value === 'professional'
        ? { ...choice, example: `Pulido y formal, pero humano. Para marcas premium. Como hablarle a un ${customerLowerLabel} importante.` }
        : choice
    ))
  ), [customerLowerLabel])
  const localizedActionChoicesByObjective = useMemo<Record<ConversationalObjective, Array<Choice<ConversationalSuccessAction>>>>(() => ({
    ...actionChoicesByObjective,
    filtrar: actionChoicesByObjective.filtrar.map((choice) => (
      choice.value === 'ready_for_human'
        ? { ...choice, example: `Filtra la plática y avisa cuando el ${leadLowerLabel} ya vale la pena atender.` }
        : choice
    ))
  }), [leadLowerLabel])

  // Reinicia el wizard cada vez que se abre y carga los calendarios reales.
  useEffect(() => {
    if (!isOpen) return
    setStepIndex(0)
    setTestResetKey((k) => k + 1)
    setDraft(buildInitialDraft(defaultName, { aiProvider, model }))
    let alive = true
    calendarsService.getCalendars()
      .then((list) => { if (alive) setCalendars((list || []).filter((c) => c.isActive)) })
      .catch(() => { if (alive) setCalendars([]) })
    setProductsLoading(true)
    apiClient.get<{ products?: WizardProduct[] }>('/products', {
      params: { limit: '100', includePrices: 'true' }
    })
      .then((response) => {
        if (!alive) return
        setProducts(Array.isArray(response?.products)
          ? response.products.filter((product) => getWizardProductId(product))
          : [])
      })
      .catch(() => { if (alive) setProducts([]) })
      .finally(() => { if (alive) setProductsLoading(false) })
    return () => { alive = false }
  }, [isOpen, defaultName, aiProvider, model])

  // La creación rápida usa automáticamente una conexión disponible. Elegir proveedor,
  // modelo y detalles técnicos queda en el editor avanzado; aquí sólo bloqueamos si no
  // existe ninguna IA conectada con la que el agente pueda operar de verdad.
  useEffect(() => {
    if (!isOpen || !aiProviders.length) return
    setDraft((current) => {
      const currentConnected = aiProviders.some((provider) => provider.id === current.aiProvider && provider.connected)
      if (currentConnected) return current
      const available = aiProviders.find((provider) => provider.connected)
      if (!available) return current
      return {
        ...current,
        aiProvider: available.id,
        model: getKnownConversationalModel(available.id, available.defaultModel || getDefaultConversationalModel(available.id))
      }
    })
  }, [isOpen, aiProviders])

  useEffect(() => {
    if (!isOpen) return
    let alive = true
    setTeamUsersLoading(true)
    userAccessService.listUsers()
      .then((users) => { if (alive) setTeamUsers(users.filter((user) => user.isActive)) })
      .catch(() => { if (alive) setTeamUsers([]) })
      .finally(() => { if (alive) setTeamUsersLoading(false) })
    return () => { alive = false }
  }, [isOpen])

  // Pasos ACTIVOS según las respuestas (if/if-not). El calendario y el cobro solo
  // aparecen cuando aplican; si no, ni se ven.
  const activeSteps = useMemo<StepId[]>(() => {
    // V2 sólo pide calendario cuando la capacidad nativa realmente va a agendar.
    const showCalendar = isCitasBooking(draft)
    const showPayment = isCitasBooking(draft) || isVentasCharging(draft)
    const showGoalUrl = draft.successAction === 'send_goal_url' || draft.successAction === 'send_trigger_link'
    const showCompletion = ['book_appointment', 'ready_to_buy', 'send_goal_url', 'send_trigger_link'].includes(draft.successAction)
    const needsAISetup = aiProviders.length > 0 && !aiProviders.some((provider) => provider.connected)
    return [
      'welcome', 'name',
      ...(needsAISetup ? ['ai'] as StepId[] : []),
      'objective', 'action',
      ...(showCalendar ? ['calendar'] as StepId[] : []),
      ...(showPayment ? ['payment'] as StepId[] : []),
      ...(showGoalUrl ? ['goalUrl'] as StepId[] : []),
      ...(showCompletion ? ['completion'] as StepId[] : []),
      'data', 'handoff', 'instructions', 'scope', 'recap', 'test'
    ]
  }, [draft.objective, draft.successAction, aiProviders])

  // Si la lista de pasos se acorta (p.ej. cambió la acción), no dejes el índice fuera de rango.
  useEffect(() => {
    setStepIndex((i) => Math.min(i, activeSteps.length - 1))
  }, [activeSteps.length])

  const safeIndex = Math.min(stepIndex, activeSteps.length - 1)
  const step = activeSteps[safeIndex]
  const isQuestion = step !== 'welcome' && step !== 'recap' && step !== 'test'
  // El denominador es dinámico a propósito: al elegir que la IA agende/cobre aparecen
  // pasos reales nuevos, así que "Pregunta X de N" sube N de forma honesta.
  const totalQuestions = activeSteps.length - 3 // sin bienvenida, resumen ni prueba
  const questionNumber = isQuestion ? safeIndex : null
  const actionChoices = localizedActionChoicesByObjective[draft.objective] || localizedActionChoicesByObjective.citas
  const selectedProviderId = getKnownConversationalAIProvider(draft.aiProvider)
  const selectedProvider = getConversationalAIProviderOption(selectedProviderId)
  const selectedProviderStatus = aiProviders.find((provider) => provider.id === selectedProviderId) || null
  const providerConnectionKnown = aiProviders.length > 0
  const selectedProviderConnected = providerConnectionKnown ? Boolean(selectedProviderStatus?.connected) : true
  const selectedModelValue = getKnownConversationalModel(selectedProviderId, draft.model || getDefaultConversationalModel(selectedProviderId))
  const selectedModelOptions = selectedProvider.modelGroups.map((group) => ({
    label: group.label,
    options: group.options.map((option) => ({ value: option.value, label: option.label }))
  }))
  const selectedProduct = products.find((product) => getWizardProductId(product) === draft.productId) || null
  const productOptions = [
    { value: '', label: productsLoading ? 'Cargando productos...' : 'Elegir producto real' },
    ...products.map((product) => ({ value: getWizardProductId(product), label: product.name }))
  ]
  const priceOptions = [
    { value: '', label: selectedProduct ? 'Elegir precio real' : 'Selecciona producto primero' },
    ...(selectedProduct?.prices || []).map((price) => ({
      value: getWizardPriceId(price),
      label: `${price.name || 'Precio'} · ${formatCurrency(getWizardPriceAmount(price), price.currency || selectedProduct?.currency || accountCurrency)}`
    }))
  ]
  const responseDelay = draft.responseDelay
  const replyDelivery = draft.replyDelivery
  const humanMessagesEnabled = replyDelivery.splitMessagesEnabled || replyDelivery.mode === 'split'
  const teamUserOptions = [
    { value: '', label: teamUsersLoading ? 'Cargando usuarios...' : 'Elegir usuario' },
    ...teamUsers.map((user) => ({
      value: user.id,
      label: user.fullName || user.email || user.phone || user.username || `Usuario ${user.id}`
    }))
  ]
  const showCompletionStep = ['book_appointment', 'ready_to_buy', 'send_goal_url', 'send_trigger_link'].includes(draft.successAction)

  const reconfigure = () => {
    setTestResetKey((k) => k + 1)
    setStepIndex(0)
  }

  const patch = (next: Partial<AgentWizardDraft>) => setDraft((current) => ({ ...current, ...next }))
  const patchResponseDelay = (next: Partial<AgentWizardDraft['responseDelay']>) => patch({ responseDelay: { ...draft.responseDelay, ...next } })
  const patchReplyDelivery = (next: Partial<AgentWizardDraft['replyDelivery']>) => patch({ replyDelivery: { ...draft.replyDelivery, ...next } })

  const chooseObjective = (objective: ConversationalObjective) => {
    const firstAction = (localizedActionChoicesByObjective[objective] || localizedActionChoicesByObjective.citas)[0]?.value || 'ready_for_human'
    patch({ objective, successAction: firstAction, ...(objective === 'custom' ? {} : { customObjective: '' }) })
  }

  const chooseProvider = (providerId: ConversationalAIProviderId) => {
    const nextProvider = getKnownConversationalAIProvider(providerId)
    patch({
      aiProvider: nextProvider,
      model: getKnownConversationalModel(nextProvider, nextProvider === draft.aiProvider ? draft.model : getDefaultConversationalModel(nextProvider))
    })
  }

  const chooseIdentity = (identityMode: AgentIdentityMode) => {
    if (identityMode === 'user') {
      const user = teamUsers.find((item) => item.id === draft.identityUserId) || teamUsers[0] || null
      patch({
        identityMode,
        identityUserId: user?.id || '',
        identityUserName: user ? (user.fullName || user.email || user.phone || user.username || '') : '',
        identityCustomName: ''
      })
      return
    }
    patch({
      identityMode,
      identityUserId: '',
      identityUserName: '',
      identityCustomName: identityMode === 'custom' ? draft.identityCustomName : ''
    })
  }

  const needsDepositAmount = (isCitasBooking(draft) && draft.askDeposit) || (isVentasCharging(draft) && draft.paymentMode === 'deposit')

  const canAdvance = useMemo(() => {
    if (step === 'name') return draft.name.trim().length > 0
    if (step === 'ai') return selectedProviderConnected && selectedModelValue.trim().length > 0
    if (step === 'identity' && draft.identityMode === 'custom') return draft.identityCustomName.trim().length > 0
    if (step === 'identity' && draft.identityMode === 'user') return draft.identityUserId.trim().length > 0
    if (step === 'objective' && draft.objective === 'custom') return draft.customObjective.trim().length > 0
    if (step === 'data' && (draft.objective === 'datos' || draft.objective === 'filtrar')) return draft.requiredData.trim().length > 0
    if (step === 'delay' && draft.responseDelay.mode === 'random') return Number(draft.responseDelay.minValue) <= Number(draft.responseDelay.maxValue)
    if (step === 'delivery' && humanMessagesEnabled) return Number(draft.replyDelivery.minDelaySeconds) <= Number(draft.replyDelivery.maxDelaySeconds)
    // La capacidad nativa de agenda no se publica sin su calendario blindado.
    if (step === 'calendar') return Boolean(draft.calendarId)
    // Si pide anticipo/pago, exige monto y al menos un método de cobro completo.
    if (step === 'payment' && needsDepositAmount) {
      if (!(Number(draft.depositAmount) > 0)) return false
      if (!draft.depositPaymentLink && !draft.depositBankTransfer) return false
      if (draft.depositBankTransfer && !draft.depositBankTransferDetails.trim()) return false
      return true
    }
    if (step === 'payment' && isVentasCharging(draft)) {
      return Boolean(draft.productId && draft.priceId && Number(draft.priceAmount) > 0)
    }
    if (step === 'goalUrl') return isSafeWizardUrl(draft.goalUrl)
    if (step === 'completion' && draft.completionMode === 'assign_user') return draft.completionUserId.trim().length > 0
    return true
  }, [step, draft, needsDepositAmount, humanMessagesEnabled, selectedModelValue, selectedProviderConnected])

  const currentOverrides = () => buildOverridesFromDraft(draft, accountCurrency, defaultName || draft.name || 'Agente')

  const goNext = () => setStepIndex((i) => Math.min(i + 1, activeSteps.length - 1))
  const goBack = () => setStepIndex((i) => Math.max(i - 1, 0))
  const finish = () => { void onComplete(currentOverrides()) }

  const labelOf = <T extends string>(choices: Array<Choice<T>>, value: T) => choices.find((c) => c.value === value)?.label || ''
  const money = (amount: number | null) => (amount && amount > 0 ? formatCurrency(amount, accountCurrency) : 'monto pendiente')
  const actionTitle = (() => {
    if (draft.objective === 'citas') return '¿Quién debería agendar la cita?'
    if (draft.objective === 'ventas') return '¿Quién debería cerrar el pago?'
    if (draft.objective === 'datos') return '¿Quién debería recibir los datos?'
    if (draft.objective === 'filtrar') return `¿Quién debería atender al ${leadLowerLabel} filtrado?`
    return '¿Quién debería completar el objetivo?'
  })()
  const depositMethodsRecap = [
    draft.depositPaymentLink ? 'link de pago' : '',
    draft.depositBankTransfer ? 'transferencia' : ''
  ].filter(Boolean).join(' o ')
  const depositRecap = `Anticipo de ${money(draft.depositAmount)}${depositMethodsRecap ? ` · ${depositMethodsRecap}` : ''}`
  const cobroRecap = (() => {
    if (isCitasBooking(draft)) return draft.askDeposit ? depositRecap : 'Sin anticipo'
    if (isVentasCharging(draft)) return draft.paymentMode === 'deposit' ? depositRecap : 'Pago completo'
    return ''
  })()

  // Métodos con los que la persona puede pagar el anticipo. Compartido por citas y ventas.
  const depositMethodsSection = (
    <>
      <div className={styles.field}>
        <label className={styles.label}>Cómo puede pagar el anticipo</label>
        <div className={styles.depositMethodRow}>
          <Switch
            checked={draft.depositPaymentLink}
            onChange={(next) => patch({ depositPaymentLink: next })}
            aria-label="Cobrar el anticipo con link de pago"
          />
          <span>Link de pago</span>
        </div>
        <div className={styles.depositMethodRow}>
          <Switch
            checked={draft.depositBankTransfer}
            onChange={(next) => patch({ depositBankTransfer: next })}
            aria-label="Cobrar el anticipo por transferencia bancaria"
          />
          <span>Transferencia bancaria</span>
        </div>
        {!draft.depositPaymentLink && !draft.depositBankTransfer && (
          <p className={styles.fieldHint}>Activa al menos un método para cobrar el anticipo.</p>
        )}
      </div>
      {draft.depositBankTransfer && (
        <div className={styles.field}>
          <label className={styles.label}>Datos para transferencia</label>
          <textarea
            className={styles.textarea}
            value={draft.depositBankTransferDetails}
            rows={3}
            maxLength={1200}
            placeholder="Banco, CLABE o cuenta, titular…"
            onChange={(e) => patch({ depositBankTransferDetails: e.target.value })}
          />
          <p className={styles.fieldHint}>El agente compartirá estos datos y pedirá foto del comprobante; la IA valida el monto y registra el anticipo.</p>
        </div>
      )}
    </>
  )

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      type="custom"
      size="md"
      flushContent
      title="Nuevo asistente"
      className={styles.wizardModal}
      contentClassName={styles.wizardContent}
    >
      <div className={styles.wizard}>
        {questionNumber !== null && (
          <div className={styles.progress}>
            <span className={styles.progressText}>Pregunta {questionNumber} de {totalQuestions}</span>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${(questionNumber / totalQuestions) * 100}%` }} />
            </div>
          </div>
        )}

        <div className={`${styles.body} ${step === 'test' ? styles.bodyTest : ''}`}>
          {step !== 'test' && <div className={styles.art}><StepArt kind={step} /></div>}

          {step === 'welcome' && (
            <>
              <h2 className={styles.title}>Vamos a crear tu asistente 🎉</h2>
              <p className={styles.help}>Te voy a preguntar sólo <strong>qué debe lograr, cómo debe atender y dónde están sus límites</strong>. La IA, el modelo, los tiempos y los mensajes ya llevan una configuración profesional que puedes afinar después.</p>
              <div className={styles.welcomeList}>
                <div className={styles.welcomeItem}><Sparkles size={16} /> Le pones nombre y le dices qué debe lograr.</div>
                <div className={styles.welcomeItem}><Sparkles size={16} /> Eliges cómo cumple la meta y cuándo debe pedir ayuda.</div>
                <div className={styles.welcomeItem}><Sparkles size={16} /> Listo: empieza a atender tus chats.</div>
              </div>
              {onSkipToManual && (
                <button type="button" className={styles.skipLink} onClick={onSkipToManual} disabled={creating}>
                  Prefiero crearlo en blanco y configurarlo a mano
                </button>
              )}
            </>
          )}

          {step === 'name' && (
            <>
              <h2 className={styles.title}>¿Cómo se va a llamar?</h2>
              <p className={styles.help}>Ponle un nombre para reconocerlo tú. Como ponerle nombre a un empleado nuevo.</p>
              <input
                className={styles.input}
                value={draft.name}
                autoFocus
                placeholder="Ejemplo: Sofía de Recepción"
                onChange={(e) => patch({ name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter' && canAdvance) goNext() }}
              />
              <p className={styles.fieldHint}>Ejemplos: "Asistente de Ventas", "Carlos del Taller", "Bot de Citas".</p>
            </>
          )}

          {step === 'ai' && (
            <>
              <h2 className={styles.title}>¿Qué IA va a contestar?</h2>
              <p className={styles.help}>Elige el proveedor y el modelo que van a escribir los mensajes de este agente.</p>
              <div className={styles.field}>
                <label className={styles.label}>Proveedor</label>
                <CustomSelect
                  value={selectedProviderId}
                  onChange={(event) => chooseProvider(event.target.value as ConversationalAIProviderId)}
                  portal
                >
                  {conversationalAIProviderOptions.map((provider) => {
                    const status = aiProviders.find((item) => item.id === provider.id)
                    const connected = providerConnectionKnown ? Boolean(status?.connected) : true
                    return (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}{providerConnectionKnown ? ` · ${connected ? 'Conectado' : 'No conectado'}` : ''}
                      </option>
                    )
                  })}
                </CustomSelect>
                <p className={styles.fieldHint}>
                  {selectedProviderConnected
                    ? `${selectedProvider.label} queda guardado sólo para este agente.`
                    : `Conecta ${selectedProvider.label} antes de usarlo en este agente.`}
                </p>
                {!selectedProviderConnected && onConnectProvider && (
                  <Button variant="secondary" onClick={() => onConnectProvider(selectedProviderId)}>
                    Conectar {selectedProvider.label}
                  </Button>
                )}
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Modelo</label>
                <CustomSelect
                  value={selectedModelValue}
                  onChange={(event) => patch({ model: event.target.value })}
                  portal
                >
                  {selectedModelOptions.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </CustomSelect>
              </div>
            </>
          )}

          {step === 'objective' && (
            <>
              <h2 className={styles.title}>¿Qué quieres que logre?</h2>
              <p className={styles.help}>Es su misión principal. Como decirle a un empleado: "tú encárgate de esto".</p>
              <div className={styles.options}>
                {objectiveChoices.map(({ value, label, example, Icon }) => (
                  <OptionCard key={value} active={draft.objective === value} Icon={Icon} label={label} example={example} onClick={() => chooseObjective(value)} />
                ))}
              </div>
              {draft.objective === 'custom' && (
                <input
                  className={styles.input}
                  value={draft.customObjective}
                  placeholder='Escribe la meta. Ejemplo: "que pida una cotización"'
                  onChange={(e) => patch({ customObjective: e.target.value })}
                />
              )}
            </>
          )}

          {step === 'identity' && (
            <>
              <h2 className={styles.title}>¿Como quién habla con la gente?</h2>
              <p className={styles.help}>Define si se siente como "la empresa" o como una persona con nombre.</p>
              <div className={styles.options}>
                {identityChoices.map(({ value, label, example, Icon }) => (
                  <OptionCard key={value} active={draft.identityMode === value} Icon={Icon} label={label} example={value === 'user' && teamUsers.length === 0 ? 'No hay usuarios activos disponibles; usa nombre personalizado o nombre del agente.' : example} onClick={() => chooseIdentity(value)} />
                ))}
              </div>
              {draft.identityMode === 'user' && (
                <div className={styles.field}>
                  <label className={styles.label}>Persona visible</label>
                  <CustomSelect
                    value={draft.identityUserId}
                    onChange={(event) => {
                      const user = teamUsers.find((item) => item.id === event.target.value) || null
                      patch({
                        identityUserId: user?.id || '',
                        identityUserName: user ? (user.fullName || user.email || user.phone || user.username || '') : ''
                      })
                    }}
                    portal
                  >
                    {teamUserOptions.map((option) => (
                      <option key={option.value || 'empty-user'} value={option.value}>{option.label}</option>
                    ))}
                  </CustomSelect>
                </div>
              )}
              {draft.identityMode === 'custom' && (
                <input
                  className={styles.input}
                  value={draft.identityCustomName}
                  placeholder='¿Cómo se presenta? Ejemplo: "Sofía"'
                  onChange={(e) => patch({ identityCustomName: e.target.value })}
                />
              )}
            </>
          )}

          {step === 'persuasion' && (
            <>
              <h2 className={styles.title}>¿Qué tan vendedor lo quieres?</h2>
              <p className={styles.help}>Piensa en un mesero: uno te deja decidir tranquilo; otro te recomienda el platillo perfecto y te lleva al postre.</p>
              <div className={styles.options}>
                {persuasionChoices.map(({ value, label, example, Icon }) => (
                  <OptionCard key={value} active={draft.persuasionLevel === value} Icon={Icon} label={label} example={example} onClick={() => patch({ persuasionLevel: value })} />
                ))}
              </div>
            </>
          )}

          {step === 'language' && (
            <>
              <h2 className={styles.title}>¿Cómo quieres que suene?</h2>
              <p className={styles.help}>El tono con el que escribe. Como elegir si saluda de "buenas tardes" o de "qué onda".</p>
              <div className={styles.options}>
                {localizedLanguageChoices.map(({ value, label, example, Icon }) => (
                  <OptionCard key={value} active={draft.languageLevel === value} Icon={Icon} label={label} example={example} onClick={() => patch({ languageLevel: value })} />
                ))}
              </div>
            </>
          )}

          {step === 'delay' && (
            <>
              <h2 className={styles.title}>¿Cuánto debe esperar antes de contestar?</h2>
              <p className={styles.help}>Controla si responde de inmediato o si parece que se toma un momento antes de escribir.</p>
              <div className={styles.field}>
                <label className={styles.label}>Espera antes de responder</label>
                <CustomSelect
                  value={responseDelay.mode}
                  onChange={(event) => patchResponseDelay({ mode: event.target.value as AgentWizardDraft['responseDelay']['mode'] })}
                  portal
                >
                  {responseDelayModeOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </CustomSelect>
              </div>
              {responseDelay.mode === 'fixed' && (
                <div className={styles.inlineFields}>
                  <div className={styles.field}>
                    <label className={styles.label}>Tiempo</label>
                    <NumberInput
                      className={styles.input}
                      min={0}
                      step={1}
                      value={responseDelay.fixedValue}
                      onValueChange={(fixedValue) => patchResponseDelay({ fixedValue })}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>Unidad</label>
                    <CustomSelect
                      value={responseDelay.fixedUnit}
                      onChange={(event) => patchResponseDelay({ fixedUnit: event.target.value as AgentResponseDelayUnit })}
                      portal
                    >
                      {responseDelayUnitOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </CustomSelect>
                  </div>
                </div>
              )}
              {responseDelay.mode === 'random' && (
                <>
                  <div className={styles.inlineFields}>
                    <div className={styles.field}>
                      <label className={styles.label}>Mínimo</label>
                      <NumberInput
                        className={styles.input}
                        min={0}
                        step={1}
                        value={responseDelay.minValue}
                        onValueChange={(minValue) => patchResponseDelay({ minValue })}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label}>Máximo</label>
                      <NumberInput
                        className={styles.input}
                        min={0}
                        step={1}
                        value={responseDelay.maxValue}
                        onValueChange={(maxValue) => patchResponseDelay({ maxValue })}
                      />
                    </div>
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>Unidad</label>
                    <CustomSelect
                      value={responseDelay.rangeUnit}
                      onChange={(event) => patchResponseDelay({ rangeUnit: event.target.value as AgentResponseDelayUnit })}
                      portal
                    >
                      {responseDelayUnitOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </CustomSelect>
                  </div>
                  {!canAdvance && <p className={styles.fieldHint}>El mínimo no puede ser mayor que el máximo.</p>}
                </>
              )}
            </>
          )}

          {step === 'delivery' && (
            <>
              <h2 className={styles.title}>¿Quieres que mande mensajes como persona?</h2>
              <p className={styles.help}>Si está activo, parte respuestas largas en globitos con pausas cortas entre mensaje y mensaje.</p>
              <div className={styles.options}>
                <OptionCard active={humanMessagesEnabled} Icon={MessageSquareText} label="Sí, en globitos" example="Manda una idea, espera tantito y manda otra." onClick={() => patchReplyDelivery({ ...DEFAULT_AGENT_REPLY_DELIVERY, mode: 'split' as AgentReplyDeliveryMode, splitMessagesEnabled: true })} />
                <OptionCard active={!humanMessagesEnabled} Icon={MessageCircle} label="No, todo junto" example="Manda la respuesta completa en un solo mensaje." onClick={() => patchReplyDelivery({ mode: 'single' as AgentReplyDeliveryMode, splitMessagesEnabled: false })} />
              </div>
              {humanMessagesEnabled && (
                <div className={styles.inlineFields}>
                  <div className={styles.field}>
                    <label className={styles.label}>Pausa mínima</label>
                    <NumberInput
                      className={styles.input}
                      min={0}
                      max={60}
                      step={1}
                      value={replyDelivery.minDelaySeconds}
                      onValueChange={(minDelaySeconds) => patchReplyDelivery({ minDelaySeconds })}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>Pausa máxima</label>
                    <NumberInput
                      className={styles.input}
                      min={0}
                      max={60}
                      step={1}
                      value={replyDelivery.maxDelaySeconds}
                      onValueChange={(maxDelaySeconds) => patchReplyDelivery({ maxDelaySeconds })}
                    />
                  </div>
                  {!canAdvance && <p className={styles.fieldHint}>La pausa mínima no puede ser mayor que la máxima.</p>}
                </div>
              )}
            </>
          )}

          {step === 'notifications' && (
            <>
              <h2 className={styles.title}>¿Quieres recibir notificaciones mientras el agente IA toma la conversación?</h2>
              <p className={styles.help}>Esto sólo controla los avisos para tu equipo mientras el agente atiende. El chat sigue visible.</p>
              <div className={styles.options}>
                <OptionCard active={!draft.hideAttendedNotifications} Icon={Bell} label="Sí" example="Avísame aunque el agente esté contestando." onClick={() => patch({ hideAttendedNotifications: false })} />
                <OptionCard active={draft.hideAttendedNotifications} Icon={ShieldCheck} label="No" example="Silencia avisos hasta que el agente termine o pase el chat." onClick={() => patch({ hideAttendedNotifications: true })} />
              </div>
            </>
          )}

          {step === 'action' && (
            <>
              <h2 className={styles.title}>{actionTitle}</h2>
              <p className={styles.help}>Define quién completa la meta: una persona del equipo, el agente IA o la IA mandando un enlace.</p>
              <div className={styles.options}>
                {actionChoices.map(({ value, label, example, Icon }) => (
                  <OptionCard key={value} active={draft.successAction === value} Icon={Icon} label={label} example={example} onClick={() => patch({ successAction: value })} />
                ))}
              </div>
            </>
          )}

          {step === 'calendar' && (
            <>
              <h2 className={styles.title}>¿En qué calendario aparta las citas?</h2>
              <p className={styles.help}>Aquí caen las citas de este asistente. El agente ofrecerá los espacios disponibles de este calendario.</p>
              <div className={styles.field}>
                <CustomSelect
                  value={draft.calendarId || ''}
                  onValueChange={(value) => patch({ calendarId: value || null })}
                  placeholder={calendars.length === 0 ? 'No hay calendarios activos' : 'Elegir calendario'}
                  portal
                  disabled={calendars.length === 0}
                >
                  {calendars.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </CustomSelect>
                <p className={styles.fieldHint}>
                  {calendars.length === 0
                    ? 'Crea o activa un calendario primero para poder continuar.'
                    : 'Elige uno para continuar. Puedes cambiarlo o afinar horarios después en el editor.'}
                </p>
              </div>
            </>
          )}

          {step === 'payment' && draft.objective === 'citas' && (
            <>
              <h2 className={styles.title}>¿Pides anticipo para apartar la cita?</h2>
              <p className={styles.help}>Si cobras algo por adelantado, la IA manda el cobro y sólo agenda cuando Ristak confirma el pago real.</p>
              <div className={styles.options}>
                <OptionCard active={!draft.askDeposit} Icon={CalendarCheck} label="No, agenda directo" example="Aparta la cita sin cobrar nada antes." onClick={() => patch({ askDeposit: false })} />
                <OptionCard active={draft.askDeposit} Icon={Wallet} label="Sí, pido anticipo" example="Manda el cobro y espera la confirmación real antes de apartar." onClick={() => patch({ askDeposit: true })} />
              </div>
              {draft.askDeposit && (
                <>
                  <MoneyField label="¿Cuánto de anticipo?" amount={draft.depositAmount} currency={accountCurrency} onChange={(v) => patch({ depositAmount: v })} />
                  {depositMethodsSection}
                </>
              )}
            </>
          )}

          {step === 'payment' && draft.objective === 'ventas' && (
            <>
              <h2 className={styles.title}>¿Cómo cobras?</h2>
              <p className={styles.help}>{draft.paymentMode === 'full_payment'
                ? 'Amarra el cobro a un producto y precio reales. Así la IA no puede inventar el monto ni la moneda.'
                : 'Define el anticipo exacto y cómo puede cobrarlo. Ristak comprobará el pago antes de avanzar.'}</p>
              <div className={styles.options}>
                <OptionCard active={draft.paymentMode === 'full_payment'} Icon={CreditCard} label="Pago completo" example="Cobra el total. La venta se cierra cuando entra el pago entero." onClick={() => patch({ paymentMode: 'full_payment' })} />
                <OptionCard active={draft.paymentMode === 'deposit'} Icon={Wallet} label="Solo anticipo" example="Cobra una parte para apartar. El resto se ve después." onClick={() => patch({ paymentMode: 'deposit' })} />
              </div>
              {draft.paymentMode === 'full_payment' && (
                <>
                  <div className={styles.field}>
                    <label>Producto</label>
                    <CustomSelect
                      value={draft.productId}
                      onChange={(event) => {
                        const product = products.find((item) => getWizardProductId(item) === event.target.value) || null
                        patch({
                          productId: getWizardProductId(product),
                          productName: product?.name || '',
                          priceId: '',
                          priceName: '',
                          priceAmount: null
                        })
                      }}
                      portal
                      disabled={productsLoading || products.length === 0}
                    >
                      {productOptions.map((option) => (
                        <option key={option.value || 'wizard-product-empty'} value={option.value}>{option.label}</option>
                      ))}
                    </CustomSelect>
                  </div>
                  <div className={styles.field}>
                    <label>Precio</label>
                    <CustomSelect
                      value={draft.priceId}
                      onChange={(event) => {
                        const price = (selectedProduct?.prices || []).find((item) => getWizardPriceId(item) === event.target.value) || null
                        patch({
                          priceId: getWizardPriceId(price),
                          priceName: price?.name || '',
                          priceAmount: price ? getWizardPriceAmount(price) : null
                        })
                      }}
                      portal
                      disabled={!selectedProduct || (selectedProduct.prices || []).length === 0}
                    >
                      {priceOptions.map((option) => (
                        <option key={option.value || 'wizard-price-empty'} value={option.value}>{option.label}</option>
                      ))}
                    </CustomSelect>
                  </div>
                </>
              )}
              {draft.paymentMode === 'deposit' && (
                <>
                  <MoneyField label="¿De cuánto es el anticipo?" amount={draft.depositAmount} currency={accountCurrency} onChange={(v) => patch({ depositAmount: v })} />
                  {depositMethodsSection}
                </>
              )}
            </>
          )}

          {step === 'goalUrl' && (
            <>
              <h2 className={styles.title}>{draft.objective === 'ventas' ? '¿Qué enlace de compra va a mandar?' : draft.objective === 'citas' ? '¿Qué enlace de agenda va a mandar?' : '¿Qué enlace va a mandar?'}</h2>
              <p className={styles.help}>
                Pega el link que la IA debe mandar cuando la persona ya está lista. Ristak agrega automáticamente el seguimiento necesario.
              </p>
              <input
                className={styles.input}
                value={draft.goalUrl}
                placeholder={draft.objective === 'ventas' ? 'https://tu-sitio.com/comprar' : 'https://tu-sitio.com/agendar'}
                onChange={(e) => patch({ goalUrl: e.target.value })}
              />
              {draft.goalUrl.trim() && !isSafeWizardUrl(draft.goalUrl) && (
                <p className={styles.fieldHint}>Pega una dirección completa que empiece con http:// o https://.</p>
              )}
            </>
          )}

          {step === 'completion' && (
            <>
              <h2 className={styles.title}>Cuando la IA cumpla el objetivo, ¿qué debe pasar?</h2>
              <p className={styles.help}>Esto sólo aparece cuando la IA o un enlace completan la meta. Si agenda un humano, no hace falta otra logística.</p>
              <div className={styles.field}>
                <label className={styles.label}>Cierre posterior</label>
                <CustomSelect
                  value={draft.completionMode}
                  onChange={(event) => {
                    const mode = event.target.value as AgentCompletionMode
                    if (mode === 'assign_user') {
                      const user = teamUsers.find((item) => item.id === draft.completionUserId) || teamUsers[0] || null
                      patch({
                        completionMode: mode,
                        completionUserId: user?.id || '',
                        completionUserName: user ? (user.fullName || user.email || user.phone || user.username || '') : ''
                      })
                      return
                    }
                    patch({ completionMode: 'notify_only', completionUserId: '', completionUserName: '' })
                  }}
                  portal
                >
                  {completionModeOptions.map((option) => (
                    <option key={option.value} value={option.value} disabled={option.value === 'assign_user' && teamUsers.length === 0}>
                      {option.label}
                    </option>
                  ))}
                </CustomSelect>
              </div>
              {draft.completionMode === 'assign_user' && (
                <div className={styles.field}>
                  <label className={styles.label}>Usuario asignado</label>
                  <CustomSelect
                    value={draft.completionUserId}
                    onChange={(event) => {
                      const user = teamUsers.find((item) => item.id === event.target.value) || null
                      patch({
                        completionUserId: user?.id || '',
                        completionUserName: user ? (user.fullName || user.email || user.phone || user.username || '') : ''
                      })
                    }}
                    portal
                  >
                    {teamUserOptions.map((option) => (
                      <option key={option.value || 'completion-empty-user'} value={option.value}>{option.label}</option>
                    ))}
                  </CustomSelect>
                </div>
              )}
            </>
          )}

          {step === 'data' && (
            <>
              <h2 className={styles.title}>{draft.objective === 'filtrar' ? '¿Qué criterios debe confirmar?' : '¿Qué datos debe pedir?'}</h2>
              <p className={styles.help}>{draft.objective === 'filtrar'
                ? 'Escribe criterios concretos y comprobables. Los revisará conversando, no adivinando por palabras sueltas.'
                : <>Lo mínimo que necesitas de cada persona. Los pide de a uno, sin que se sienta formulario. {draft.objective !== 'datos' && <strong>Puedes dejarlo en blanco</strong>}.</>}</p>
              <textarea
                className={styles.textarea}
                value={draft.requiredData}
                rows={4}
                placeholder={draft.objective === 'filtrar'
                  ? 'Ejemplo:\n- Necesita el servicio este mes\n- Tiene autorización para decidir'
                  : 'Ejemplo:\n- Nombre completo\n- Servicio que le interesa'}
                onChange={(e) => patch({ requiredData: e.target.value })}
              />
              {!canAdvance && <p className={styles.fieldHint}>Escribe al menos un {draft.objective === 'filtrar' ? 'criterio' : 'dato'} para que la misión no quede vacía.</p>}
            </>
          )}

          {step === 'handoff' && (
            <>
              <h2 className={styles.title}>¿Cuándo debe pasar el chat al equipo?</h2>
              <p className={styles.help}>Úsalo para casos que una persona debe ver. Ejemplo: enojo, facturación, reclamos o algo delicado.</p>
              <textarea
                className={styles.textarea}
                value={draft.handoffRules}
                rows={4}
                placeholder={'Ejemplo:\n- Si se enoja\n- Si pregunta por facturación\n- Si pide garantía o devolución'}
                onChange={(e) => patch({ handoffRules: e.target.value })}
              />
              <p className={styles.fieldHint}>Puedes dejarlo en blanco y configurarlo después.</p>
              <div className={styles.field}>
                <div className={styles.depositMethodRow}>
                  <Switch
                    checked={draft.pastClientsToHuman}
                    onChange={(next) => patch({ pastClientsToHuman: next })}
                    aria-label="Clientes existentes van con tu equipo"
                  />
                  <span>Clientes existentes van con tu equipo</span>
                </div>
                <p className={styles.fieldHint}>Ristak lo comprueba únicamente con pagos exitosos o citas anteriores no canceladas guardadas en esta cuenta.</p>
              </div>
            </>
          )}

          {step === 'scope' && (
            <>
              <h2 className={styles.title}>¿Y con los contactos que ya tienes?</h2>
              <p className={styles.help}>Esto es por seguridad: muchos de tus contactos ya son {customersLowerLabel}. Decide si este asistente atiende solo a los nuevos, a cualquier mensaje nuevo, o solo a tu base existente.</p>
              <div className={styles.options}>
                <OptionCard
                  active={draft.contactScope === 'new_only'}
                  Icon={ShieldCheck}
                  label="Nuevos contactos"
                  example="A todos los nuevos contactos desde ahora. Ignora a tus contactos de antes; solo atiende a quien llegue de ahora en adelante. (Lo más seguro.)"
                  onClick={() => patch({ contactScope: 'new_only' })}
                />
                <OptionCard
                  active={draft.contactScope === 'all'}
                  Icon={Users}
                  label="Nuevos mensajes"
                  example="A todos los nuevos mensajes desde ahora. Toma cualquier chat donde llegue un mensaje nuevo, sea contacto nuevo o de tu base."
                  onClick={() => patch({ contactScope: 'all' })}
                />
                <OptionCard
                  active={draft.contactScope === 'existing_only'}
                  Icon={UserCheck}
                  label="Contactos existentes"
                  example="A todos los contactos existentes. Solo atiende a quienes ya estaban en tu base; los leads nuevos no entran. (Útil para reactivar tu base.)"
                  onClick={() => patch({ contactScope: 'existing_only' })}
                />
              </div>
            </>
          )}

          {step === 'instructions' && (
            <>
              <h2 className={styles.title}>Estas son las instrucciones de tu agente</h2>
              <p className={styles.help}>Ya vienen listas para atender, vender y avanzar. Déjalas así, edítalas o bórralas y escribe las tuyas; las capacidades reales permanecen protegidas aparte.</p>
              <textarea
                className={styles.textarea}
                value={draft.extraInstructions}
                rows={6}
                placeholder={'Ejemplo:\n- Responde primero las preguntas directas\n- No prometas resultados garantizados\n- Si falta información real, dilo y pasa el caso al equipo\n- Para agendar, confirma que el horario realmente le funciona'}
                onChange={(e) => patch({ extraInstructions: e.target.value })}
              />
              <div className={styles.exampleList} aria-label="Ejemplos de personalización y capacitación">
                <span className={styles.exampleListTitle}>Ejemplos que sí van aquí:</span>
                <ul>
                  <li>Usa trato de usted y mensajes muy breves.</li>
                  <li>No prometas resultados garantizados ni tiempos que no estén confirmados.</li>
                  <li>Si preguntan por una excepción comercial, pasa el chat al equipo.</li>
                </ul>
              </div>
            </>
          )}

          {step === 'recap' && (
            <>
              <h2 className={styles.title}>¡Así quedó tu asistente! 🚀</h2>
              <p className={styles.help}>Revísalo de un vistazo. Si algo no te late, regresa y cámbialo. Después podrás afinar todo en el editor.</p>
              <div className={styles.recapList}>
                <RecapRow label="Se llama" value={draft.name.trim() || '—'} />
                <RecapRow label="Su misión" value={draft.objective === 'custom' ? (draft.customObjective.trim() || 'Meta propia') : labelOf(objectiveChoices, draft.objective)} />
                <RecapRow label="Al estar listo" value={labelOf(actionChoices, draft.successAction)} />
                {draft.objective === 'citas' && (
                  <RecapRow label="Calendario" value={calendars.find((c) => c.id === draft.calendarId)?.name || 'Sin elegir'} />
                )}
                {draft.goalUrl.trim() && <RecapRow label="Enlace" value={draft.goalUrl.trim()} />}
                {cobroRecap && <RecapRow label="Cobro" value={cobroRecap} />}
                {showCompletionStep && <RecapRow label="Al cumplir" value={draft.completionMode === 'assign_user' ? (draft.completionUserName || 'Asignar usuario') : 'Notificar al equipo'} />}
                <RecapRow label="Atiende a" value={draft.contactScope === 'new_only' ? 'Solo contactos nuevos desde ahora' : draft.contactScope === 'existing_only' ? 'Solo contactos existentes' : 'Todos los mensajes nuevos'} />
                <RecapRow label="Pide datos" value={draft.requiredData.trim() ? 'Sí' : 'No por ahora'} />
                <RecapRow label="Pasa al equipo" value={draft.handoffRules.trim() ? 'Con reglas propias' : 'Sin reglas extra'} />
                <RecapRow label="Clientes existentes" value={draft.pastClientsToHuman ? 'Van con tu equipo' : 'Los atiende la IA'} />
                <RecapRow label="Personalización" value={draft.extraInstructions.trim() ? 'Sí, con reglas propias' : 'Ninguna por ahora'} />
              </div>
            </>
          )}

          {step === 'test' && (
            <>
              <h2 className={styles.title}>Pruébalo antes de soltarlo 🎙️</h2>
              <p className={styles.help}>Aquí está tu asistente, vivito. Escríbele como si fueras un {customerLowerLabel}: mándale un mensaje, déjale una <strong>nota de voz</strong>, súbele una <strong>foto</strong> o un comprobante. Pruébalo a lo bestia para ver cómo responde ANTES de activarlo.</p>
              <div className={styles.testChat}>
                <WizardTestChat
                  key={testResetKey}
                  agentName={draft.name}
                  getConfig={currentOverrides}
                  density="compact"
                />
              </div>
              <p className={styles.fieldHint}>Tip: pídele una cita, pregúntale precios, o mándale un audio a ver si te entiende. Si algo no te late, reconfigúralo.</p>
            </>
          )}
        </div>

        <div className={styles.footer}>
          {safeIndex > 0
            ? <Button variant="ghost" onClick={goBack} disabled={creating}><ArrowLeft size={16} /> Atrás</Button>
            : <span />}
          <div className={styles.footerRight}>
            {step === 'welcome' && <Button variant="primary" onClick={goNext}>Empezar <ArrowRight size={16} /></Button>}
            {questionNumber !== null && <Button variant="primary" onClick={goNext} disabled={!canAdvance}>Siguiente <ArrowRight size={16} /></Button>}
            {step === 'recap' && <Button variant="primary" onClick={goNext}>Probar mi asistente <ArrowRight size={16} /></Button>}
            {step === 'test' && (
              <>
                <Button variant="ghost" onClick={reconfigure} disabled={creating}>No me late, reconfigurar</Button>
                <Button variant="primary" onClick={finish} loading={creating} disabled={creating}><Rocket size={16} /> Me encanta, créalo</Button>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function MoneyField({ label, amount, currency, onChange }: { label: string; amount: number | null; currency: string; onChange: (value: number) => void }) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <div className={styles.moneyInputWrap}>
        <span className={styles.moneyPrefix}>$</span>
        <NumberInput
          className={`${styles.input} ${styles.moneyInput}`}
          min={0}
          step={50}
          value={amount ?? ''}
          onValueChange={onChange}
          placeholder="0"
        />
      </div>
      <p className={styles.fieldHint}>Se usa la moneda de tu cuenta ({currency}). Pon el monto que cobras de anticipo para continuar.</p>
    </div>
  )
}

function OptionCard({ active, Icon, label, example, onClick }: { active: boolean; Icon: LucideIcon; label: string; example: string; onClick: () => void }) {
  return (
    <button type="button" className={`${styles.optionCard} ${active ? styles.optionCardActive : ''}`} onClick={onClick} aria-pressed={active}>
      <span className={styles.optionIcon}><Icon size={20} /></span>
      <span className={styles.optionBody}>
        <span className={styles.optionLabel}>{label}</span>
        <span className={styles.optionExample}>{example}</span>
      </span>
    </button>
  )
}

function RecapRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.recapRow}>
      <span className={styles.recapKey}>{label}</span>
      <span className={styles.recapVal}>{value}</span>
    </div>
  )
}
