import crypto from 'crypto'

/**
 * Bridge desmontable Ristak -> Magnetismo de Pacientes.
 *
 * Ristak solo muestra una experiencia embebida cuando la licencia trae
 * mdp_program=true. El menu real y los launch tokens los emite MDP.
 * Para retirar esta integracion, borrar este archivo, routes/mdpProgram.routes.js,
 * pages/MDPProgram y las referencias documentadas en docs/mdp-program-bridge.md.
 */

function cleanBaseUrl(value = '') {
  const raw = String(value || '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : ''
  } catch {
    return ''
  }
}

function bridgeConfig() {
  return {
    apiUrl: cleanBaseUrl(process.env.MDP_PROGRAM_API_URL || process.env.MDP_API_URL || process.env.MAGNETISMO_API_URL),
    secret: String(process.env.MDP_PROGRAM_BRIDGE_SECRET || process.env.RISTAK_APP_BRIDGE_SECRET || '').trim()
  }
}

function sign(rawBody, secret) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`
}

export async function getMdpProgramNavigationForUser(user = {}) {
  const config = bridgeConfig()
  if (!config.apiUrl || !config.secret) {
    return {
      configured: false,
      program: { id: 'mdp', title: 'Magnetismo de Pacientes' },
      items: []
    }
  }

  const body = {
    email: user.email || '',
    name: user.full_name || user.username || user.email || ''
  }
  const raw = JSON.stringify(body)
  const response = await fetch(`${config.apiUrl}/api/ristak/navigation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ristak-signature': sign(raw, config.secret)
    },
    body: raw
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    const error = new Error(data?.error || data?.message || 'No se pudo cargar Magnetismo de Pacientes.')
    error.status = response.status
    throw error
  }

  return {
    configured: true,
    program: data.program || { id: 'mdp', title: 'Magnetismo de Pacientes' },
    user: data.user || null,
    items: Array.isArray(data.items) ? data.items : []
  }
}
