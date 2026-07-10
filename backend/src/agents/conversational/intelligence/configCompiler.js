import { createHash } from 'node:crypto'

const POLICY_VERSION = 1

const OBJECTIVE_DESCRIPTIONS = {
  citas: 'Ayudar a la persona a reservar una cita real o entregar el caso al equipo cuando corresponda.',
  ventas: 'Ayudar a la persona a tomar una decisión informada y completar el paso de compra permitido.',
  datos: 'Recopilar únicamente los datos configurados y confirmar que quedaron completos.',
  filtrar: 'Determinar si el contacto cumple criterios configurados y dirigirlo al siguiente paso correcto.',
  custom: 'Cumplir la meta personalizada configurada por el negocio.'
}

const SUCCESS_EVIDENCE = {
  book_appointment: ['La herramienta book_appointment confirmó una cita real.'],
  ready_to_buy: ['Se envió un enlace de pago verificado; el pago sigue pendiente hasta confirmación real.'],
  ready_for_human: ['La persona aceptó avanzar o pidió atención humana y el traspaso quedó registrado.'],
  send_goal_url: ['Se envió el enlace configurado; la meta sigue pendiente hasta webhook verificable.'],
  send_trigger_link: ['Se envió el enlace configurado; la meta sigue pendiente hasta interacción verificable.'],
  internal_signal: ['El estado interno configurado quedó confirmado por una acción real.'],
  none: ['La conversación terminó de forma útil y respetuosa sin inventar una conversión.']
}

const READ_TOOLS = [
  'get_business_profile',
  'list_products',
  'get_contact_profile',
  'list_calendars',
  'get_free_slots'
]

const WRITE_TOOLS_BY_ACTION = {
  book_appointment: ['save_contact_data', 'book_appointment', 'send_to_human'],
  ready_to_buy: ['save_contact_data', 'create_payment_link', 'send_to_human'],
  ready_for_human: ['save_contact_data', 'mark_ready_to_advance', 'send_to_human'],
  send_goal_url: ['save_contact_data', 'send_goal_url', 'send_to_human'],
  send_trigger_link: ['save_contact_data', 'send_trigger_link', 'send_to_human'],
  internal_signal: ['save_contact_data', 'mark_ready_to_advance', 'send_to_human'],
  none: ['save_contact_data', 'send_to_human']
}

const POLICY_HIERARCHY = [
  'Seguridad, legalidad e integridad de la plataforma.',
  'Permisos, límites y licencia de la cuenta.',
  'Resultados confirmados por base de datos, herramientas e integraciones.',
  'Objetivo, workflow y criterio verificable de éxito del agente.',
  'Reglas particulares del negocio.',
  'Tono, personalidad y preferencias de estilo.',
  'Hipótesis probabilísticas del análisis conversacional.'
]

function cleanText(value, maxLength = 8000) {
  return String(value ?? '').replace(/\r/g, '').trim().slice(0, maxLength)
}

function cleanId(value) {
  return cleanText(value, 180)
}

function textItems(value, maxItems = 30) {
  const text = cleanText(value, 5000)
  if (!text) return []
  return [...new Set(text
    .split(/\n|;|\u2022|\|/)
    .map((item) => item.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean))]
    .slice(0, maxItems)
}

function addIssue(target, code, message, field, severity = 'warning') {
  target.push({ code, message, field, severity })
}

function detectInstructionConflicts(config, issues) {
  const rules = cleanText(config.extraInstructions, 8000)
  if (!rules) return

  if (/(?:ignora|omite|desobedece).{0,40}(?:reglas|instrucciones|sistema|seguridad)/i.test(rules)) {
    addIssue(issues, 'unsafe_instruction_override', 'La capacitación intenta anular reglas superiores; esa parte no se aplicará.', 'extraInstructions', 'error')
  }
  if (/(?:di|afirma|finge).{0,30}(?:que eres humano|ser humano|persona real)/i.test(rules)) {
    addIssue(issues, 'human_impersonation', 'El agente no puede fingir ser humano cuando se le pregunta directamente.', 'extraInstructions', 'error')
  }
  if (/(?:inventa|fabrica|simula).{0,30}(?:precio|horario|resultado|pago|cita|dato)/i.test(rules)) {
    addIssue(issues, 'fabricated_business_data', 'El agente nunca puede inventar datos ni resultados del negocio.', 'extraInstructions', 'error')
  }
  if (config.successAction === 'book_appointment' && /(?:nunca|no).{0,20}(?:agend|reserv)/i.test(rules)) {
    addIssue(issues, 'objective_rule_conflict', 'El objetivo pide agendar, pero la capacitación dice que no se agende.', 'extraInstructions', 'error')
  }
  if (config.successAction === 'ready_to_buy' && /(?:nunca|no).{0,20}(?:cobr|pago|venta|vender)/i.test(rules)) {
    addIssue(issues, 'objective_rule_conflict', 'El objetivo pide avanzar al pago, pero la capacitación lo prohíbe.', 'extraInstructions', 'error')
  }
}

function validateWorkflow(config, issues) {
  const workflow = config.goalWorkflow || {}
  if (config.objective === 'custom' && !cleanText(config.customObjective, 2000)) {
    addIssue(issues, 'missing_custom_objective', 'Describe el resultado que debe lograr este agente.', 'customObjective', 'error')
  }

  if (config.objective === 'citas') {
    // El calendario es requisito del objetivo de citas sin importar quién agende
    // (humano, IA o enlace): de ahí salen los espacios que el agente ofrece.
    const calendarId = cleanId(workflow.appointments?.calendarId || config.defaultCalendarId)
    if (!calendarId) addIssue(issues, 'missing_calendar', 'Elige el calendario para las citas: el agente lo necesita para ofrecer los espacios disponibles.', 'goalWorkflow.appointments.calendarId', 'error')
  }

  if (workflow.deposit?.enabled === true || workflow.sales?.paymentMode === 'deposit') {
    const methods = workflow.deposit?.methods || {}
    const paymentLink = methods.paymentLink === undefined ? true : Boolean(methods.paymentLink)
    const bankTransfer = Boolean(methods.bankTransfer)
    if (!paymentLink && !bankTransfer) {
      addIssue(issues, 'missing_deposit_method', 'Activa al menos un método para cobrar el anticipo (link de pago o transferencia).', 'goalWorkflow.deposit.methods', 'error')
    }
    if (bankTransfer && !cleanText(workflow.deposit?.bankTransferDetails, 1200)) {
      addIssue(issues, 'missing_transfer_details', 'Escribe los datos de transferencia que el agente compartirá para el anticipo.', 'goalWorkflow.deposit.bankTransferDetails', 'error')
    }
  }

  if (config.successAction === 'ready_to_buy') {
    const sales = workflow.sales || {}
    if (!cleanId(sales.priceId) && !cleanId(sales.productId) && !(Number(sales.amount) > 0)) {
      addIssue(issues, 'unbound_sale_offer', 'No hay producto, precio ni monto fijo configurado; el agente sólo podrá cobrar ofertas verificadas del catálogo.', 'goalWorkflow.sales', 'warning')
    }
  }

  if (config.successAction === 'send_goal_url') {
    const url = config.objective === 'ventas' ? workflow.sales?.url : workflow.appointments?.url
    if (!cleanText(url, 2000)) addIssue(issues, 'missing_goal_url', 'Configura el enlace que se enviará para cumplir el objetivo.', 'goalWorkflow', 'error')
  }

  if (workflow.deposit?.enabled === true) {
    const deposit = workflow.deposit
    const validFixed = deposit.mode !== 'range' && Number(deposit.amount) > 0
    const validRange = deposit.mode === 'range' && Number(deposit.minAmount) > 0 && Number(deposit.maxAmount) >= Number(deposit.minAmount)
    if (!validFixed && !validRange) addIssue(issues, 'invalid_deposit', 'El anticipo configurado no tiene un monto o rango válido.', 'goalWorkflow.deposit', 'error')
  }

  if (workflow.completion?.mode === 'assign_user' && !cleanId(workflow.completion?.userId)) {
    addIssue(issues, 'missing_completion_owner', 'Selecciona quién recibirá la conversación al completar el objetivo.', 'goalWorkflow.completion.userId', 'error')
  }
}

function policyHash(policy) {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex')
}

export function compileConversationalAgentPolicy(config = {}, { businessProfile = null } = {}) {
  const objective = ['citas', 'ventas', 'datos', 'filtrar', 'custom'].includes(config.objective)
    ? config.objective
    : 'custom'
  const successAction = Object.prototype.hasOwnProperty.call(SUCCESS_EVIDENCE, config.successAction)
    ? config.successAction
    : 'ready_for_human'
  const issues = []

  validateWorkflow({ ...config, objective, successAction }, issues)
  detectInstructionConflicts({ ...config, successAction }, issues)

  const requiredData = textItems(config.requiredData)
  const qualification = config.goalWorkflow?.qualification || {}
  const permissions = {
    readTools: READ_TOOLS,
    writeTools: [...new Set([
      ...(WRITE_TOOLS_BY_ACTION[successAction] || WRITE_TOOLS_BY_ACTION.ready_for_human),
      'discard_conversation',
      'stay_silent'
    ])],
    requiresRealToolConfirmation: [
      'book_appointment',
      'create_payment_link',
      'send_goal_url',
      'send_trigger_link',
      'mark_ready_to_advance'
    ]
  }

  const policy = {
    version: POLICY_VERSION,
    agentId: cleanId(config.id) || null,
    agentName: cleanText(config.name, 120) || 'Agente',
    hierarchy: POLICY_HIERARCHY,
    objective: {
      type: objective,
      description: objective === 'custom'
        ? cleanText(config.customObjective, 2000)
        : OBJECTIVE_DESCRIPTIONS[objective],
      successAction,
      successEvidence: SUCCESS_EVIDENCE[successAction]
    },
    identity: {
      mode: cleanId(config.identityMode) || 'business',
      customName: cleanText(config.identityCustomName || config.identityUserName, 160)
    },
    communication: {
      persuasion: ['low', 'medium', 'high'].includes(config.persuasionLevel) ? config.persuasionLevel : 'medium',
      language: ['professional', 'intermediate', 'colloquial'].includes(config.languageLevel) ? config.languageLevel : 'intermediate',
      allowEmojis: config.allowEmojis === true,
      principles: [
        'Responder preguntas directas antes de intentar avanzar.',
        'Hacer una sola pregunta principal por mensaje.',
        'No repetir datos ya conocidos.',
        'No presionar, avergonzar ni manipular.',
        'Tratar inferencias como hipótesis, nunca como hechos.'
      ]
    },
    business: {
      profileReady: businessProfile?.ready === true || businessProfile?.status === 'ready',
      name: cleanText(businessProfile?.businessName || businessProfile?.profile?.businessName, 200),
      rules: cleanText(config.extraInstructions, 8000),
      handoffRules: cleanText(config.handoffRules, 4000)
    },
    qualification: {
      requiredData,
      questions: textItems(qualification.questions),
      qualifies: textItems(qualification.qualifies),
      disqualifies: textItems(qualification.disqualifies)
    },
    followUp: {
      enabled: config.followUp?.enabled === true,
      strategy: cleanText(config.followUp?.strategy, 5000),
      maximumAttempts: [config.followUp?.first?.enabled, config.followUp?.second?.enabled].filter(Boolean).length
    },
    permissions,
    validation: {
      valid: !issues.some((issue) => issue.severity === 'error'),
      errors: issues.filter((issue) => issue.severity === 'error'),
      warnings: issues.filter((issue) => issue.severity !== 'error')
    }
  }

  return { ...policy, hash: policyHash(policy) }
}

export function summarizeCompiledPolicy(policy = {}) {
  return {
    version: policy.version || POLICY_VERSION,
    hash: policy.hash || '',
    objective: policy.objective || null,
    qualification: policy.qualification || null,
    permissions: policy.permissions || null,
    validation: policy.validation || { valid: true, errors: [], warnings: [] }
  }
}
