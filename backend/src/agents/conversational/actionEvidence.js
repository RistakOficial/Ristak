import { DateTime } from 'luxon'

const SUCCESS_PAYMENT_STATUSES = new Set([
  'paid',
  'succeeded',
  'completed',
  'complete',
  'fulfilled',
  'success',
  'captured',
  'approved',
  'accredited'
])

const NON_LIVE_PAYMENT_MODES = new Set(['test', 'sandbox', 'demo', 'preview', 'simulation', 'simulated'])

// Una confirmacion puede llegar de forma asincrona en WhatsApp/correo, pero no
// puede convertirse en una autorizacion permanente. Siete dias conserva chats
// reales que tardan en responder y, al mismo tiempo, impide reciclar decisiones
// de conversaciones antiguas para una cita nueva.
const APPOINTMENT_CONFIRMATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const APPOINTMENT_OFFER_CONFIRMATION_MAX_GAP_MS = 7 * 24 * 60 * 60 * 1000
const MESSAGE_TIMESTAMP_CLOCK_SKEW_MS = 5 * 60 * 1000

const GENERIC_CONCEPT_WORDS = new Set([
  'abono', 'anticipo', 'cobro', 'compra', 'de', 'del', 'el', 'la', 'liquidacion',
  'para', 'pago', 'por', 'primer', 'primero', 'reserva', 'servicio', 'un', 'una'
])

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\bp\s*\.\s*m\s*\.?\b/g, 'pm')
    .replace(/\ba\s*\.\s*m\s*\.?\b/g, 'am')
    .replace(/[^a-z0-9:/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeCurrency(value) {
  const currency = String(value || '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(currency) ? currency : ''
}

function normalizeAmount(value) {
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null
}

function amountsMatch(left, right) {
  const a = normalizeAmount(left)
  const b = normalizeAmount(right)
  return a !== null && b !== null && Math.abs(a - b) < 0.005
}

function phraseAppears(text, phrase) {
  const cleanText = ` ${normalizeText(text)} `
  const cleanPhrase = normalizeText(phrase)
  return Boolean(cleanPhrase) && cleanText.includes(` ${cleanPhrase} `)
}

function significantConceptTokens(value) {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 1 && !GENERIC_CONCEPT_WORDS.has(token))
}

function conceptMatchesLabel(concept, label) {
  if (phraseAppears(concept, label)) return true
  const conceptTokens = new Set(significantConceptTokens(concept))
  const labelTokens = significantConceptTokens(label)
  return labelTokens.length > 0 && labelTokens.every((token) => conceptTokens.has(token))
}

function conceptMatchesCandidate(concept, candidate) {
  const labels = (candidate.labels || []).filter(Boolean)
  if (!labels.length) return false
  if (candidate.primaryLabel) return conceptMatchesLabel(concept, candidate.primaryLabel)
  return labels.some((label) => conceptMatchesLabel(concept, label))
}

function timestampToMs(value) {
  const raw = String(value || '').trim()
  if (!raw) return 0
  // SQLite guarda UTC sin sufijo; no permitimos que la zona local del proceso
  // cambie la edad de la evidencia al interpretarlo.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

async function readMessageRows(database, sql, params, source) {
  try {
    const rows = await database.all(sql, params)
    return (rows || []).map((row) => ({
      id: row.id || null,
      direction: normalizeText(row.direction),
      text: [row.subject, row.message_text].filter(Boolean).join('\n').trim(),
      timestamp: row.message_timestamp || row.created_at || null,
      source
    }))
  } catch {
    return []
  }
}

export async function loadRecentConversationMessages(database, contactId, { limitPerChannel = 50 } = {}) {
  if (!database || !contactId) return []
  const params = [contactId, limitPerChannel]
  const [whatsapp, email, social] = await Promise.all([
    readMessageRows(database, `
      SELECT id, direction, message_text, NULL AS subject, message_timestamp, created_at
      FROM whatsapp_api_messages
      WHERE contact_id = ?
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT ?
    `, params, 'whatsapp'),
    readMessageRows(database, `
      SELECT id, direction, message_text, subject, message_timestamp, created_at
      FROM email_messages
      WHERE contact_id = ?
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT ?
    `, params, 'email'),
    readMessageRows(database, `
      SELECT id, direction, message_text, NULL AS subject, message_timestamp, created_at
      FROM meta_social_messages
      WHERE contact_id = ?
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT ?
    `, params, 'social')
  ])

  return [...whatsapp, ...email, ...social]
    .filter((message) => message.text && ['inbound', 'outbound'].includes(message.direction))
    .sort((left, right) => timestampToMs(left.timestamp) - timestampToMs(right.timestamp))
}

function isExplicitAffirmative(value) {
  const text = normalizeText(value)
  if (!text) return false
  if (/\b(no|negativo|cancelar|cancela|otro horario|otra hora|no puedo|no me queda|mejor no)\b/.test(text)) return false
  return /(^|\b)(si|confirmo|confirmado|acepto|de acuerdo|esta bien|me queda bien|perfecto|va|adelante|agendalo|agendame|agenda la|reservalo|reservame|reserva la|quiero ese|quiero esa|quiero la cita|ese horario|esa hora|ahi esta bien|puedes agendar)(\b|$)/.test(text)
}

function buildSlotFingerprint(startTime, timezone) {
  const slot = DateTime.fromISO(String(startTime || ''), { setZone: true }).setZone(timezone)
  if (!slot.isValid) return null

  const hour24 = slot.hour
  const hour12 = hour24 % 12 || 12
  const minute = String(slot.minute).padStart(2, '0')
  const meridiem = hour24 >= 12 ? 'pm' : 'am'
  const dayPeriod = hour24 < 12 ? 'manana' : (hour24 < 19 ? 'tarde' : 'noche')
  const localized = slot.setLocale('es-MX')

  return {
    iso: String(startTime),
    exactDateTokens: [
      slot.toFormat('yyyy-MM-dd'),
      slot.toFormat('d/M/yyyy'),
      slot.toFormat('dd/MM/yyyy'),
      localized.toFormat("d 'de' LLLL"),
      localized.toFormat("d 'de' LLLL 'de' yyyy"),
      localized.toFormat("cccc d 'de' LLLL"),
      localized.toFormat("cccc d 'de' LLLL 'de' yyyy")
    ].map(normalizeText),
    timeTokens: [
      `${String(hour24).padStart(2, '0')}:${minute}`,
      `${hour24}:${minute}`,
      `${hour12}:${minute} ${meridiem}`,
      `${hour12} ${meridiem}`,
      `a las ${hour12}:${minute}`,
      `a las ${hour12}`,
      `las ${hour12}:${minute}`,
      `las ${hour12}`,
      `${hour12} de la ${dayPeriod}`
    ].map(normalizeText),
    bareHour: String(hour12)
  }
}

function messageHasExactDate(text, fingerprint) {
  const clean = ` ${normalizeText(text)} `
  return fingerprint.exactDateTokens.some((token) => token && clean.includes(` ${token} `))
}

function messageHasTime(text, fingerprint) {
  const clean = ` ${normalizeText(text)} `
  if (fingerprint.timeTokens.some((token) => token && clean.includes(` ${token} `))) return true
  return new RegExp(`^(?:si\\s+)?(?:la\\s+de\\s+las\\s+|a\\s+las\\s+|las\\s+)?${fingerprint.bareHour}(?:\\s*(?:am|pm))?$`).test(clean.trim())
}

function messageMentionsSlot(text, fingerprint) {
  if (String(text || '').includes(fingerprint.iso)) return true
  return messageHasExactDate(text, fingerprint) && messageHasTime(text, fingerprint)
}

function isRecentMessageEvidence(message, nowMs) {
  const timestampMs = timestampToMs(message?.timestamp)
  if (!timestampMs) return false
  if (timestampMs > nowMs + MESSAGE_TIMESTAMP_CLOCK_SKEW_MS) return false
  return nowMs - timestampMs <= APPOINTMENT_CONFIRMATION_MAX_AGE_MS
}

function offerAndConfirmationAreLinked(offer, confirmation, nowMs) {
  if (!isRecentMessageEvidence(offer, nowMs) || !isRecentMessageEvidence(confirmation, nowMs)) return false
  const offerMs = timestampToMs(offer.timestamp)
  const confirmationMs = timestampToMs(confirmation.timestamp)
  return confirmationMs >= offerMs && confirmationMs - offerMs <= APPOINTMENT_OFFER_CONFIRMATION_MAX_GAP_MS
}

function offersMultipleTimes(text) {
  const clean = normalizeText(text)
  const explicitTimes = new Set([
    ...(clean.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g) || []),
    ...(clean.match(/\b(?:[1-9]|1[0-2])\s*(?:am|pm)\b/g) || []),
    ...(clean.match(/\ba las\s+(?:[1-9]|1[0-2])\b/g) || [])
  ])
  return explicitTimes.size > 1 || /\b(?:o|y)\s+(?:a\s+las\s+|las\s+)?(?:[1-9]|1[0-2])(?::[0-5]\d)?(?:\s*(?:am|pm))?\b/.test(clean)
}

export async function verifyAppointmentConfirmationEvidence({
  database,
  contactId,
  startTime,
  timezone,
  dryRun = false,
  messages = null,
  nowMs = Date.now()
}) {
  if (dryRun) {
    return {
      ok: true,
      simulated: true,
      evidenceVerified: false,
      note: 'La simulación no agenda nada; en vivo se exigirá confirmación explícita guardada en la conversación.'
    }
  }

  const fingerprint = buildSlotFingerprint(startTime, timezone)
  if (!fingerprint) {
    return { ok: false, actionCompleted: false, invalidSlot: true, error: 'No se pudo interpretar el horario solicitado.' }
  }

  const history = (Array.isArray(messages)
    ? messages.map((message) => ({ ...message, direction: normalizeText(message.direction) }))
    : await loadRecentConversationMessages(database, contactId))
    .sort((left, right) => timestampToMs(left.timestamp) - timestampToMs(right.timestamp))

  const verificationNowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const confirmation = history[index]
    if (confirmation.direction !== 'inbound' || !isExplicitAffirmative(confirmation.text)) continue
    if (!isRecentMessageEvidence(confirmation, verificationNowMs)) continue

    // La persona puede escribir el slot completo sin una oferta previa. En ese
    // caso exigimos fecha concreta y hora, no solamente "viernes a las 3".
    if (messageMentionsSlot(confirmation.text, fingerprint)) {
      return {
        ok: true,
        evidenceVerified: true,
        confirmationMessageId: confirmation.id || null,
        confirmationTimestamp: confirmation.timestamp || null
      }
    }

    const previous = history[index - 1]
    if (!previous || previous.direction !== 'outbound' || !messageMentionsSlot(previous.text, fingerprint)) continue
    if (!offerAndConfirmationAreLinked(previous, confirmation, verificationNowMs)) continue
    if (offersMultipleTimes(previous.text) && !messageHasTime(confirmation.text, fingerprint)) continue

    return {
      ok: true,
      evidenceVerified: true,
      confirmationMessageId: confirmation.id || null,
      confirmationTimestamp: confirmation.timestamp || null,
      offerMessageId: previous.id || null
    }
  }

  return {
    ok: false,
    actionCompleted: false,
    confirmationRequired: true,
    transferRequired: false,
    error: 'No existe una confirmación explícita y verificable de ese día y horario en la conversación. No se agendó nada: confirma el slot exacto con la persona antes de volver a intentarlo.'
  }
}

export async function revalidateAppointmentSlot({
  calendarId,
  requestedStartTime,
  windowStart,
  windowEnd,
  lookupSlots
}) {
  let availability
  try {
    availability = await lookupSlots(calendarId, windowStart, windowEnd, null, {
      ignoreAppointmentConflicts: true
    })
  } catch (error) {
    return {
      ok: false,
      actionCompleted: false,
      availabilityCheckFailed: true,
      transferRequired: true,
      retryable: true,
      technicalError: error?.message || String(error),
      error: 'No se pudo revalidar la disponibilidad real del calendario. No se agendó nada. Reintenta la consulta y, si sigue fallando, pasa la conversación a una persona.'
    }
  }

  if (!Array.isArray(availability)) {
    return {
      ok: false,
      actionCompleted: false,
      availabilityCheckFailed: true,
      transferRequired: true,
      retryable: true,
      error: 'El calendario devolvió una respuesta inválida al revalidar el horario. No se agendó nada; pasa la conversación a una persona si el problema continúa.'
    }
  }

  const requestedMs = new Date(requestedStartTime).getTime()
  const bookableSlots = availability.flatMap((day) => (
    Array.isArray(day?.slots) ? day.slots : []
  )).map((iso) => ({ iso, ms: new Date(iso).getTime() }))
    .filter((slot) => Number.isFinite(slot.ms))

  const matched = bookableSlots.find((slot) => Math.abs(slot.ms - requestedMs) < 60000)
  if (!matched) {
    return {
      ok: false,
      actionCompleted: false,
      invalidSlot: true,
      error: 'Ese horario no aparece como slot real y disponible del calendario. No se agendó nada; consulta get_free_slots y ofrece únicamente un horario devuelto por la herramienta.'
    }
  }

  return { ok: true, matchedStartTime: matched.iso }
}

async function loadProductPrices(database) {
  try {
    return await database.all(`
      SELECT
        p.id AS product_id,
        p.ghl_product_id,
        p.name AS product_name,
        p.currency AS product_currency,
        pp.id AS price_id,
        pp.ghl_price_id,
        pp.name AS price_name,
        pp.amount,
        pp.currency
      FROM products p
      INNER JOIN product_prices pp ON pp.product_id = p.id
      WHERE p.is_active = 1
      ORDER BY p.name ASC, pp.created_at DESC
      LIMIT 500
    `)
  } catch {
    return []
  }
}

function rowMatchesConfiguredIds(row, sales) {
  const productId = String(sales.productId || '').trim()
  const priceId = String(sales.priceId || '').trim()
  if (productId && ![row.product_id, row.ghl_product_id].map(String).includes(productId)) return false
  if (priceId && ![row.price_id, row.ghl_price_id].map(String).includes(priceId)) return false
  return true
}

function paymentCandidateFromRow(row, accountCurrency) {
  return {
    source: 'product_price',
    productId: row.product_id || null,
    priceId: row.price_id || null,
    amount: normalizeAmount(row.amount),
    currency: normalizeCurrency(row.currency || row.product_currency || accountCurrency),
    primaryLabel: row.product_name || null,
    labels: [row.product_name, row.price_name].filter(Boolean)
  }
}

function requestedAmountMatchesCandidate(amount, candidate) {
  if (candidate.mode === 'range') {
    const min = normalizeAmount(candidate.minAmount)
    const max = normalizeAmount(candidate.maxAmount)
    return (!min || amount >= min) && (!max || amount <= max)
  }
  return amountsMatch(amount, candidate.amount)
}

function describeExpectedAmounts(candidates) {
  const labels = []
  for (const candidate of candidates) {
    if (candidate.mode === 'range') {
      const min = normalizeAmount(candidate.minAmount)
      const max = normalizeAmount(candidate.maxAmount)
      if (min && max) labels.push(`${min}-${max}`)
      else if (min) labels.push(`desde ${min}`)
      else if (max) labels.push(`hasta ${max}`)
    } else if (candidate.amount) {
      labels.push(String(candidate.amount))
    }
  }
  return [...new Set(labels)].slice(0, 5).join(', ')
}

export async function validatePaymentRequestAgainstCatalog({
  database,
  config = {},
  accountCurrency,
  amount,
  currency,
  concept
}) {
  const trustedAccountCurrency = normalizeCurrency(accountCurrency)
  const requestedAmount = normalizeAmount(amount)
  const explicitCurrency = normalizeCurrency(currency)
  const requestedConcept = String(concept || '').trim()
  if (!trustedAccountCurrency) {
    return {
      ok: false,
      actionCompleted: false,
      transferRequired: true,
      error: 'No se pudo leer la moneda configurada en la cuenta. No se creó ni envió ningún link; revisa la configuración o pasa a una persona.'
    }
  }
  if (!requestedAmount || !requestedConcept) {
    return { ok: false, actionCompleted: false, error: 'Monto y concepto son obligatorios. No se creó ni envió ningún link.' }
  }
  if (currency && !explicitCurrency) {
    return { ok: false, actionCompleted: false, error: 'La moneda indicada no es un código ISO válido. No se creó ni envió ningún link.' }
  }
  if (explicitCurrency && explicitCurrency !== trustedAccountCurrency) {
    return {
      ok: false,
      actionCompleted: false,
      currencyMismatch: true,
      expectedCurrency: trustedAccountCurrency,
      error: `La moneda solicitada (${explicitCurrency}) no coincide con la moneda de la cuenta (${trustedAccountCurrency}). No se creó ni envió ningún link.`
    }
  }

  const workflow = config.goalWorkflow || {}
  const sales = workflow.sales || {}
  const deposit = workflow.deposit || {}
  const paymentMode = String(sales.paymentMode || sales.payment_mode || '').trim() === 'deposit'
    ? 'deposit'
    : 'full_payment'
  const rows = await loadProductPrices(database)
  const hasConfiguredIds = Boolean(String(sales.productId || '').trim() || String(sales.priceId || '').trim())
  const scopedRows = rows.filter((row) => rowMatchesConfiguredIds(row, sales))
  const configuredRows = hasConfiguredIds ? scopedRows : []
  const workflowLabels = [sales.productName, sales.priceName].filter(Boolean)
  const hasFixedWorkflowCharge = Boolean(normalizeAmount(sales.amount) && workflowLabels.length)
  const labelsFromCatalog = configuredRows.flatMap((row) => [row.product_name, row.price_name]).filter(Boolean)
  const candidates = []

  if (paymentMode === 'deposit') {
    const mode = String(deposit.mode || 'fixed').trim() === 'range' ? 'range' : 'fixed'
    candidates.push({
      source: 'workflow_deposit',
      mode,
      amount: normalizeAmount(deposit.amount),
      minAmount: normalizeAmount(deposit.minAmount),
      maxAmount: normalizeAmount(deposit.maxAmount),
      currency: normalizeCurrency(deposit.currency || sales.currency || trustedAccountCurrency),
      primaryLabel: sales.productName || configuredRows[0]?.product_name || null,
      labels: [...workflowLabels, ...labelsFromCatalog]
    })
  } else if (configuredRows.length) {
    candidates.push(...configuredRows.map((row) => paymentCandidateFromRow(row, trustedAccountCurrency)))
  } else if (hasFixedWorkflowCharge) {
    candidates.push({
      source: 'workflow_sales',
      mode: 'fixed',
      amount: normalizeAmount(sales.amount),
      currency: normalizeCurrency(sales.currency || trustedAccountCurrency),
      primaryLabel: sales.productName || null,
      labels: workflowLabels
    })
  }

  if (!hasConfiguredIds && !hasFixedWorkflowCharge && paymentMode === 'full_payment') {
    candidates.push(...rows.map((row) => paymentCandidateFromRow(row, trustedAccountCurrency)))
  }

  const usableCandidates = candidates.filter((candidate) => {
    const hasAmount = candidate.mode === 'range'
      ? Boolean(candidate.minAmount || candidate.maxAmount)
      : Boolean(candidate.amount)
    return hasAmount && candidate.currency && (candidate.labels || []).length > 0
  })

  if (!usableCandidates.length) {
    return {
      ok: false,
      actionCompleted: false,
      transferRequired: true,
      catalogValidationFailed: true,
      error: 'No hay un producto, precio o anticipo configurado que permita comprobar monto, moneda y concepto. No se creó ni envió ningún link; configura el cobro o pasa a una persona.'
    }
  }

  const correctCurrency = usableCandidates.filter((candidate) => candidate.currency === trustedAccountCurrency)
  const correctAmount = correctCurrency.filter((candidate) => requestedAmountMatchesCandidate(requestedAmount, candidate))
  const matched = correctAmount.find((candidate) => conceptMatchesCandidate(requestedConcept, candidate))
  if (!matched) {
    const expectedAmounts = describeExpectedAmounts(correctCurrency)
    const amountMismatch = correctCurrency.length > 0 && correctAmount.length === 0
    const conceptMismatch = correctAmount.length > 0
    const configuredCurrencyMismatch = correctCurrency.length === 0
    return {
      ok: false,
      actionCompleted: false,
      amountMismatch,
      conceptMismatch,
      currencyMismatch: configuredCurrencyMismatch,
      expectedCurrency: trustedAccountCurrency,
      expectedAmounts: expectedAmounts || null,
      error: amountMismatch
        ? `El monto solicitado (${requestedAmount} ${trustedAccountCurrency}) no coincide con el cobro configurado${expectedAmounts ? ` (${expectedAmounts} ${trustedAccountCurrency})` : ''}. No se creó ni envió ningún link.`
        : configuredCurrencyMismatch
          ? `El producto o precio configurado no usa la moneda de la cuenta (${trustedAccountCurrency}). No se creó ni envió ningún link; corrige la configuración antes de cobrar.`
          : 'El concepto no coincide con el producto o precio real configurado. No se creó ni envió ningún link; usa el nombre del producto correcto o pasa a una persona.'
    }
  }

  return {
    ok: true,
    trusted: {
      amount: requestedAmount,
      currency: trustedAccountCurrency,
      concept: requestedConcept,
      source: matched.source,
      productId: matched.productId || null,
      priceId: matched.priceId || null
    }
  }
}

export async function findVerifiedPaymentEvidence({
  database,
  contactId,
  requirement = {},
  accountCurrency,
  agentId = null
}) {
  if (!database || !contactId) return { ok: false, reason: 'missing_contact' }
  const requiredCurrency = normalizeCurrency(requirement.currency || accountCurrency)
  if (!requiredCurrency) return { ok: false, reason: 'missing_currency' }

  const stateParams = [contactId]
  let stateSql = `
    SELECT activated_at, created_at
    FROM conversational_agent_state
    WHERE contact_id = ?`
  if (agentId) {
    stateSql += ' AND agent_id = ?'
    stateParams.push(agentId)
  }
  stateSql += `
    ORDER BY COALESCE(activated_at, created_at) DESC
    LIMIT 1`

  const [state, payments] = await Promise.all([
    database.get(stateSql, stateParams).catch(() => null),
    database.all(`
      SELECT id, amount, currency, status, payment_mode, payment_provider,
             title, description, reference, paid_at, date, created_at
      FROM payments
      WHERE contact_id = ?
      ORDER BY COALESCE(paid_at, date, created_at) DESC
      LIMIT 100
    `, [contactId]).catch(() => [])
  ])

  const stateStartMs = timestampToMs(state?.activated_at || state?.created_at)
  const fallbackStartMs = Date.now() - 30 * 24 * 60 * 60 * 1000
  const evidenceStartMs = stateStartMs ? stateStartMs - 24 * 60 * 60 * 1000 : fallbackStartMs
  const mode = String(requirement.mode || 'fixed').trim() === 'range' ? 'range' : 'fixed'
  const minAmount = normalizeAmount(requirement.minAmount)
  const maxAmount = normalizeAmount(requirement.maxAmount)
  const fixedAmount = normalizeAmount(requirement.amount)
  const labels = (requirement.labels || []).filter(Boolean)

  const match = (payments || []).find((payment) => {
    const status = normalizeText(payment.status)
    const paymentMode = normalizeText(payment.payment_mode)
    const paymentCurrency = normalizeCurrency(payment.currency || accountCurrency)
    const paymentTimestamp = timestampToMs(payment.paid_at || payment.date || payment.created_at)
    if (!SUCCESS_PAYMENT_STATUSES.has(status) || NON_LIVE_PAYMENT_MODES.has(paymentMode)) return false
    if (paymentCurrency !== requiredCurrency || paymentTimestamp < evidenceStartMs) return false
    const paymentAmount = normalizeAmount(payment.amount)
    const amountMatches = mode === 'range'
      ? Boolean(paymentAmount) && (!minAmount || paymentAmount >= minAmount) && (!maxAmount || paymentAmount <= maxAmount)
      : amountsMatch(paymentAmount, fixedAmount)
    if (!amountMatches) return false
    if (!labels.length) return true
    const paymentConcept = [payment.title, payment.description].filter(Boolean).join(' ')
    if (requirement.primaryLabel) return conceptMatchesLabel(paymentConcept, requirement.primaryLabel)
    return labels.some((label) => conceptMatchesLabel(paymentConcept, label))
  })

  if (!match) return { ok: false, reason: 'no_verified_payment' }
  return {
    ok: true,
    evidence: {
      paymentId: match.id,
      amount: normalizeAmount(match.amount),
      currency: normalizeCurrency(match.currency || accountCurrency),
      status: normalizeText(match.status),
      provider: match.payment_provider || null,
      paidAt: match.paid_at || match.date || match.created_at || null
    }
  }
}
