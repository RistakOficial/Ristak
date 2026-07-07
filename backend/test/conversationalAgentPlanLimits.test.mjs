import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db } from '../src/config/database.js'
import {
  CONVERSATIONAL_AGENT_LIMIT_REACHED_CODE,
  createConversationalAgent
} from '../src/services/conversationalAgentService.js'
import { resetLicenseCache, setVerifiedAppBaseUrlResolverForTests } from '../src/services/licenseService.js'

let server
let baseUrl

const ENV_KEYS = [
  'LICENSE_SERVER_URL',
  'CLIENT_ID',
  'LICENSE_KEY',
  'INSTALLATION_ID',
  'APP_URL'
]
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

function startLicenseServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        if (req.url !== '/api/license/verify') {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'not_found' }))
          return
        }

        res.end(JSON.stringify({
          allowed: true,
          client_id: 'cli_basic_agent_limit',
          plan: 'basic',
          features: {
            ai_agent: true,
            app_assistant_ai: false,
            conversational_ai: true
          },
          limits: {
            conversational_agents: {
              max_agents: 1
            }
          },
          license_token: 'tok_basic_agent_limit',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
        }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
}

before(async () => {
  await startLicenseServer()
  process.env.LICENSE_SERVER_URL = baseUrl
  process.env.CLIENT_ID = 'cli_basic_agent_limit'
  process.env.LICENSE_KEY = 'lic_basic_agent_limit'
  process.env.INSTALLATION_ID = 'inst_basic_agent_limit'
  process.env.APP_URL = 'https://basic-agent-limit.test'
  setVerifiedAppBaseUrlResolverForTests(async () => 'https://basic-agent-limit.test')
})

beforeEach(async () => {
  resetLicenseCache()
  await db.run('DELETE FROM conversational_agent_state').catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_events').catch(() => undefined)
  await db.run('DELETE FROM conversational_agents').catch(() => undefined)
})

after(async () => {
  resetLicenseCache()
  setVerifiedAppBaseUrlResolverForTests()
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = previousEnv[key]
    }
  }
  await new Promise((resolve) => server.close(resolve))
})

test('bloquea crear un segundo agente conversacional cuando la licencia limita a 1', async () => {
  const first = await createConversationalAgent({
    name: 'Agente permitido',
    enabled: false
  })

  assert.ok(first.id)

  await assert.rejects(
    () => createConversationalAgent({
      name: 'Agente bloqueado',
      enabled: false
    }),
    (error) => {
      assert.equal(error.code, CONVERSATIONAL_AGENT_LIMIT_REACHED_CODE)
      assert.equal(error.statusCode, 403)
      assert.equal(error.limit.maxAgents, 1)
      assert.equal(error.limit.currentTotal, 1)
      assert.match(error.message, /máximo 1 agente conversacional/)
      return true
    }
  )

  const count = await db.get('SELECT COUNT(*) AS total FROM conversational_agents')
  assert.equal(Number(count.total), 1)
})
