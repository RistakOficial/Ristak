const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const READ_METHODS = new Set(['GET', 'HEAD'])

function normalizeMethod(method = '') {
  return String(method || '').trim().toUpperCase()
}

function normalizePath(value = '') {
  const raw = String(value || '')
  const [path] = raw.split('?')
  if (!path || path === '/') return path || '/'
  return path.replace(/\/+$/, '') || '/'
}

function requestPath(req = {}) {
  return normalizePath(req.path || req.originalUrl || req.url || '')
}

function startsWithAny(path, prefixes) {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => pattern.test(path))
}

export function isHealthRequest(req = {}) {
  const path = requestPath(req)
  return path === '/health' || path === '/api/health'
}

export function classifyDeployDrainRequest(req = {}) {
  const method = normalizeMethod(req.method)
  const path = requestPath(req)
  const isMutation = MUTATION_METHODS.has(method)

  if (isHealthRequest(req)) return 'health'

  if (matchesAny(path, [
    /^\/(?:api\/)?media\/upload$/,
    /^\/(?:api\/)?media\/assets\/[^/]+\/replace$/
  ]) && isMutation) {
    return 'http:media-upload'
  }

  if (READ_METHODS.has(method) && (
    path === '/snip.js' ||
    path === '/api/tracking/snip.js' ||
    (!path.startsWith('/api') && !path.startsWith('/webhook') && !path.startsWith('/webhooks'))
  )) {
    return 'http:public-read'
  }

  if (startsWithAny(path, ['/webhook', '/webhooks'])) {
    return 'http:webhook'
  }

  if (matchesAny(path, [
    /^\/api\/stripe\/webhook$/,
    /^\/api\/conekta\/webhook$/,
    /^\/api\/mercadopago\/webhook$/
  ])) {
    return 'http:payment-webhook'
  }

  if (matchesAny(path, [
    /^\/(?:api\/tracking\/)?(?:collect|video-event|sync-visitor|link-visitor)$/,
    /^\/api\/sites\/public\/(?:submit|meta-event)$/
  ]) && isMutation) {
    return 'http:tracking'
  }

  if (path.startsWith('/api/calendars/public/') && READ_METHODS.has(method)) {
    return 'http:appointments-read'
  }

  if (READ_METHODS.has(method) && matchesAny(path, [
    /^\/api\/mercadopago\/connect\/callback$/,
    /^\/api\/oauth\/authorize$/
  ])) {
    return 'http:integration-callback'
  }

  if (path.startsWith('/api/calendars') && isMutation) {
    return 'http:appointments'
  }

  if (matchesAny(path, [
    /^\/api\/stripe\/public\/payments\/[^/]+\/intent$/,
    /^\/api\/mercadopago\/public\/payments\/[^/]+\/(?:preference|card)$/,
    /^\/api\/conekta\/public\/payments\/[^/]+\/card$/
  ]) && isMutation) {
    return 'http:public-payment'
  }

  if (isMutation && (
    startsWithAny(path, [
      '/api/transactions',
      '/api/subscriptions',
      '/api/stripe/payment-links',
      '/api/stripe/payment-plans',
      '/api/stripe/saved-card-payments',
      '/api/mercadopago/payment-links',
      '/api/mercadopago/payment-plans',
      '/api/conekta/payment-links',
      '/api/conekta/payment-plans',
      '/api/conekta/saved-card-payments',
      '/api/highlevel/invoices',
      '/api/highlevel/payment-flows',
      '/api/highlevel/text2pay',
      '/api/highlevel/products',
      '/api/highlevel/conversations',
      '/api/contacts',
      '/api/contact-tags',
      '/api/automations',
      '/api/appointment-reminders',
      '/api/chat-events',
      '/api/conversational-agent',
      '/api/ai-agent',
      '/api/whatsapp-api',
      '/api/email',
      '/api/push'
    ])
  )) {
    return 'http:business-mutation'
  }

  if (startsWithAny(path, ['/api/meta', '/api/highlevel']) && READ_METHODS.has(method)) {
    return 'http:integration-read'
  }

  if (READ_METHODS.has(method) && path.startsWith('/api/')) {
    return 'http:api-read'
  }

  if (isMutation && path.startsWith('/api/')) {
    return 'http:api-mutation'
  }

  return null
}

export function shouldAllowDuringDeployDrain(req = {}) {
  return !isHealthRequest(req)
}
