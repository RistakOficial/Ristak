import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// Servidor de licencias simulado
let server
let baseUrl
let requestCount = 0
let accountCancellationRequestCount = 0
let setupTokenRequestCount = 0
let serverMode = 'allow' // allow | allow_without_whatsapp | allow_split_ai | allow_split_sites | allow_split_calendar | allow_basic_calendar | allow_basic_web_analytics | allow_calendar_payment_false | allow_partial_features | allow_without_features | block | down
let lastRequestBody = null

let licenseService

const MANAGED_ENV_KEYS = [
  'LICENSE_SERVER_URL',
  'RISTAK_LICENSE_SERVER_URL',
  'CLIENT_ID',
  'RISTAK_CLIENT_ID',
  'LICENSE_KEY',
  'RISTAK_LICENSE_KEY',
  'INSTALLATION_ID',
  'RISTAK_INSTALLATION_ID'
]

function startMockServer() {
  return new Promise(resolve => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        lastRequestBody = body ? JSON.parse(body) : null

        if (serverMode === 'down') {
          // destruir el socket simula un servidor inaccesible sin esperar timeouts
          res.socket?.destroy()
          return
        }

        res.setHeader('Content-Type', 'application/json')

        if (req.url === '/api/license/verify') {
          requestCount += 1

          if (
            serverMode === 'allow' ||
            serverMode === 'allow_without_whatsapp' ||
            serverMode === 'allow_split_ai' ||
            serverMode === 'allow_split_sites' ||
            serverMode === 'allow_split_calendar' ||
            serverMode === 'allow_basic_calendar' ||
            serverMode === 'allow_basic_web_analytics' ||
            serverMode === 'allow_calendar_payment_false' ||
            serverMode === 'allow_partial_features' ||
            serverMode === 'allow_without_features'
          ) {
            const payload = {
              allowed: true,
              client_id: 'cli_1',
              plan: serverMode === 'allow_basic_calendar' || serverMode === 'allow_basic_web_analytics' ? 'basic' : 'pro',
              ...(serverMode === 'allow_without_features' ? {} : {
                features: serverMode === 'allow_basic_web_analytics'
                ? { analytics: true, web_analytics: true }
                : serverMode === 'allow_split_ai'
                ? { app_assistant_ai: true, conversational_ai: false }
                : serverMode === 'allow_split_sites'
                  ? { sites: false, settings_media: true, settings_tracking: false, settings_domains: true }
                  : serverMode === 'allow_split_calendar'
                    ? { appointments: true, google_calendar: false }
                    : serverMode === 'allow_basic_calendar'
                      ? { appointments: true, google_calendar: false }
                  : serverMode === 'allow_calendar_payment_false'
                        ? { appointments: true, google_calendar: true, calendar_payments: false }
                    : serverMode === 'allow_partial_features'
                      ? { contacts: true }
                    : serverMode === 'allow_without_whatsapp'
                      ? { meta_ads: true, ai: false }
                      : { whatsapp: true, meta_ads: true, ai: false }
              }),
              ...(serverMode === 'allow'
                ? {
                    external_modules: {
                      mdp_program: {
                        key: 'mdp_program',
                        label: 'Magnetismo de Pacientes',
                        menu_label: 'Magnetismo',
                        enabled: true,
                        sidebar_position: 35
                      }
                    }
                  }
                : {}),
              license_token: 'tok_123',
              expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
            }
            res.end(JSON.stringify(payload))
          } else {
            res.statusCode = 403
            res.end(JSON.stringify({
              allowed: false,
              reason: 'subscription_inactive',
              message: 'Tu licencia de Ristak no está activa.'
            }))
          }
          return
        }

        if (req.url === '/api/owner-credentials/verify') {
          const { password } = lastRequestBody || {}
          if (password === 'clave-admin-installer') {
            res.end(JSON.stringify({ valid: true, support_access: true }))
          } else if (password === 'clave-portal-1') {
            res.end(JSON.stringify({ valid: true, password_hash: 'salt:hash-portal-nuevo' }))
          } else {
            res.statusCode = 403
            res.end(JSON.stringify({ valid: false, reason: 'wrong_password' }))
          }
          return
        }

        if (req.url === '/api/license/google-login/connect-url') {
          res.end(JSON.stringify({
            url: 'https://central.ristak.test/oauth/google',
            mode: 'installed_login',
            redirect_uri: 'https://central.ristak.test/auth/google/callback'
          }))
          return
        }

        if (req.url === '/api/license/google-calendar/connect-url') {
          res.end(JSON.stringify({
            url: 'https://central.ristak.test/oauth/google-calendar',
            mode: 'calendar',
            redirect_uri: 'https://central.ristak.test/google-calendar/callback'
          }))
          return
        }

        if (req.url === '/api/license/mobile-push/status') {
          res.end(JSON.stringify({
            success: true,
            push: {
              configured: true,
              nativeConfigured: true,
              iosConfigured: true,
              androidConfigured: false
            }
          }))
          return
        }

        if (req.url === '/api/license/mobile-push/send') {
          const devices = Array.isArray(lastRequestBody?.devices) ? lastRequestBody.devices : []
          res.end(JSON.stringify({ success: true, sent: devices.length, results: devices.map((device) => ({ id: device.id, platform: device.platform, success: true })) }))
          return
        }

        if (req.url === '/api/license/account-cancellation/status') {
          accountCancellationRequestCount += 1
          res.end(JSON.stringify({
            success: true,
            subscription: { status: 'active' },
            cancellation: null
          }))
          return
        }

        if (req.url === '/api/license/database-storage/status') {
          res.end(JSON.stringify({
            success: true,
            managed: true,
            current_disk_size_gb: 1,
            target_disk_size_gb: 5,
            used_bytes: lastRequestBody?.used_bytes || 0,
            usage_percent: 82,
            warning_threshold_percent: 80,
            autoscale_threshold_percent: 90,
            autoscaling_enabled: false,
            decision: 'pending',
            needs_attention: true,
            needs_decision: true,
            render_pricing: {
              currency: 'USD',
              storage_rate_per_gb_month: 0.30,
              current_monthly_storage_cost: 0.30,
              target_monthly_storage_cost: 1.50,
              additional_monthly_storage_cost: 1.20
            }
          }))
          return
        }

        if (req.url === '/api/license/database-storage/decision') {
          res.end(JSON.stringify({
            success: true,
            managed: true,
            current_disk_size_gb: lastRequestBody?.current_disk_size_gb,
            target_disk_size_gb: lastRequestBody?.target_disk_size_gb,
            used_bytes: lastRequestBody?.used_bytes || 0,
            usage_percent: 82,
            warning_threshold_percent: 80,
            autoscale_threshold_percent: 90,
            autoscaling_enabled: lastRequestBody?.decision === 'approved',
            decision: lastRequestBody?.decision,
            needs_attention: true,
            needs_decision: false,
            render_pricing: {
              currency: 'USD',
              storage_rate_per_gb_month: 0.30,
              current_monthly_storage_cost: 0.30,
              target_monthly_storage_cost: 1.50,
              additional_monthly_storage_cost: 1.20
            }
          }))
          return
        }

        if (req.url === '/api/setup-token/verify' || req.url === '/api/setup-token/consume') {
          setupTokenRequestCount += 1
          const { token } = lastRequestBody || {}
          if (token === 'good-token') {
            res.end(JSON.stringify({ valid: true, email: 'dueno@clinica.com', password_hash: 'salt:hash-portal' }))
          } else if (token === 'flaky-token' && setupTokenRequestCount < 3) {
            res.statusCode = 503
            res.end(JSON.stringify({ valid: false, message: 'Deploy en curso' }))
          } else if (token === 'flaky-token') {
            res.end(JSON.stringify({ valid: true, email: 'dueno@clinica.com', password_hash: 'salt:hash-portal' }))
          } else if (token === 'unavailable-token') {
            res.statusCode = 503
            res.end(JSON.stringify({ valid: false, message: 'Deploy en curso' }))
          } else {
            res.statusCode = 403
            res.end(JSON.stringify({ valid: false, message: 'El enlace de configuración no es válido o ya expiró.' }))
          }
          return
        }

        res.statusCode = 404
        res.end(JSON.stringify({ error: 'not found' }))
      })
    })

    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
}

function clearManagedEnv() {
  for (const key of MANAGED_ENV_KEYS) {
    delete process.env[key]
  }
}

function configureManagedInstall() {
  clearManagedEnv()
  process.env.LICENSE_SERVER_URL = baseUrl
  process.env.CLIENT_ID = 'cli_1'
  process.env.LICENSE_KEY = 'RSTK-TEST-0000'
  process.env.INSTALLATION_ID = 'inst_1'
  process.env.APP_URL = 'https://demo.onrender.com'
  process.env.APP_VERSION = '1.2.3'
  process.env.OWNER_EMAIL = 'dueno@clinica.com'
  delete process.env.LICENSE_OFFLINE_POLICY
}

function configureStandalone() {
  clearManagedEnv()
}

before(async () => {
  await startMockServer()
  licenseService = await import('../src/services/licenseService.js')
})

after(() => {
  licenseService?.setVerifiedAppBaseUrlResolverForTests()
  // Cierra también las conexiones keep-alive abiertas por fetch (undici),
  // si no el proceso del test runner queda vivo hasta su timeout.
  server?.closeAllConnections?.()
  server?.close()
})

beforeEach(() => {
  serverMode = 'allow'
  requestCount = 0
  accountCancellationRequestCount = 0
  setupTokenRequestCount = 0
  lastRequestBody = null
  configureManagedInstall()
  licenseService.resetLicenseCache()
  licenseService.setVerifiedAppBaseUrlResolverForTests(async () => '')
})

test('sin LICENSE_SERVER_URL la licencia no se exige (modo standalone/desarrollo)', async () => {
  configureStandalone()

  assert.equal(licenseService.isLicenseEnforced(), false)

  const state = await licenseService.getLicenseState()
  assert.equal(state.allowed, true)
  assert.equal(state.enforced, false)
  assert.equal(requestCount, 0)
})

test('licencia activa permite el acceso y entrega features', async () => {
  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.allowed, true)
  assert.equal(state.plan, 'pro')
  assert.equal(state.features.whatsapp, true)
  assert.equal(state.features.ai, false)
  assert.equal(state.features.app_assistant_ai, false)
  assert.equal(state.features.conversational_ai, false)
  assert.equal(state.externalModules.mdp_program.enabled, true)
  assert.equal(state.externalModules.mdp_program.sidebarPosition, 35)
  assert.equal(state.externalModules.mdp_program.menuLabel, 'Magnetismo')

  // El payload enviado al servidor central incluye todos los datos de la instalación
  assert.equal(lastRequestBody.client_id, 'cli_1')
  assert.equal(lastRequestBody.license_key, 'RSTK-TEST-0000')
  assert.equal(lastRequestBody.installation_id, 'inst_1')
  assert.equal(lastRequestBody.email, 'dueno@clinica.com')
  assert.equal(lastRequestBody.app_url, 'https://demo.onrender.com')
  assert.equal(lastRequestBody.version, '1.2.3')
})

test('la verificación apaga analítica web cuando el portal la manda en Básico', async () => {
  serverMode = 'allow_basic_web_analytics'

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.plan, 'basic')
  assert.equal(state.features.analytics, true)
  assert.equal(state.features.web_analytics, false)
})

test('features premium faltantes en una respuesta parcial quedan apagadas', async () => {
  serverMode = 'allow_partial_features'

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.allowed, true)
  assert.equal(state.features.contacts, true)
  assert.equal(state.features.payments, false)
  assert.equal(state.features.sites, false)
  assert.equal(state.features.developers, false)
  assert.equal(await licenseService.hasModuleFeature('contacts'), true)
  assert.equal(await licenseService.hasModuleFeature('payments'), false)
  assert.equal(await licenseService.hasFeature('developers'), false)
})

test('instalación central también funciona con aliases RISTAK_*', async () => {
  clearManagedEnv()
  process.env.RISTAK_LICENSE_SERVER_URL = `${baseUrl}/`
  process.env.RISTAK_CLIENT_ID = 'cli_alias'
  process.env.RISTAK_LICENSE_KEY = 'RSTK-ALIAS-0000'
  process.env.RISTAK_INSTALLATION_ID = 'inst_alias'

  assert.equal(licenseService.isLicenseEnforced(), true)

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')
  const info = licenseService.getHealthInfo()

  assert.equal(state.allowed, true)
  assert.equal(lastRequestBody.client_id, 'cli_alias')
  assert.equal(lastRequestBody.license_key, 'RSTK-ALIAS-0000')
  assert.equal(lastRequestBody.installation_id, 'inst_alias')
  assert.equal(info.client_id, 'cli_alias')
  assert.equal(info.installation_id, 'inst_alias')
})

test('isManagedOwnerEmail reconoce únicamente el correo dueño configurado', () => {
  process.env.OWNER_EMAIL = 'Dueno@Clinica.com'
  assert.equal(licenseService.isManagedOwnerEmail(' dueno@clinica.com '), true)
  assert.equal(licenseService.isManagedOwnerEmail('empleado@clinica.com'), false)
})

test('dominio de app verificado reemplaza app_url enviado al portal central', async () => {
  licenseService.setVerifiedAppBaseUrlResolverForTests(async () => 'https://app.ristak.test')

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.allowed, true)
  assert.equal(lastRequestBody.app_url, 'https://app.ristak.test')
})

test('dominio de app verificado se usa al crear links centrales de Google', async () => {
  licenseService.setVerifiedAppBaseUrlResolverForTests(async () => 'https://app.ristak.test')

  const login = await licenseService.createCentralGoogleLoginUrl({ returnPath: '/dashboard' })

  assert.equal(login.url, 'https://central.ristak.test/oauth/google')
  assert.equal(lastRequestBody.return_path, '/dashboard')
  assert.equal(lastRequestBody.app_url, 'https://app.ristak.test')

  const calendar = await licenseService.createCentralGoogleCalendarConnectUrl({ returnPath: '/settings/calendars/google' })

  assert.equal(calendar.url, 'https://central.ristak.test/oauth/google-calendar')
  assert.equal(lastRequestBody.return_path, '/settings/calendars/google')
  assert.equal(lastRequestBody.app_url, 'https://app.ristak.test')

  await licenseService.createCentralGoogleCalendarConnectUrl({
    returnPath: '/settings/calendars/google',
    appUrl: 'https://tenant.onrender.com/settings/calendars/google'
  })

  assert.equal(lastRequestBody.return_path, '/settings/calendars/google')
  assert.equal(lastRequestBody.app_url, 'https://tenant.onrender.com')
})

test('push movil central usa el broker del Installer con datos de licencia', async () => {
  licenseService.setVerifiedAppBaseUrlResolverForTests(async () => 'https://app.ristak.test')

  const status = await licenseService.getCentralMobilePushStatus()
  assert.equal(status.iosConfigured, true)
  assert.equal(lastRequestBody.client_id, 'cli_1')
  assert.equal(lastRequestBody.license_key, 'RSTK-TEST-0000')
  assert.equal(lastRequestBody.installation_id, 'inst_1')
  assert.equal(lastRequestBody.app_url, 'https://app.ristak.test')

  const result = await licenseService.sendCentralMobilePushNotifications({
    devices: [{ id: 'native_push_1', platform: 'ios', token: 'token-ios-1' }],
    payload: { title: 'Nuevo mensaje', body: 'WhatsApp' }
  })

  assert.equal(result.sent, 1)
  assert.equal(lastRequestBody.client_id, 'cli_1')
  assert.equal(lastRequestBody.devices[0].id, 'native_push_1')
  assert.equal(lastRequestBody.devices[0].token, 'token-ios-1')
  assert.equal(lastRequestBody.payload.title, 'Nuevo mensaje')
})

test('licencia suspendida bloquea aunque el password local sea correcto', async () => {
  serverMode = 'block'

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.allowed, false)
  assert.equal(state.reason, 'subscription_inactive')
  assert.ok(state.message.includes('no está activa'))
})

test('el token temporal evita consultar al servidor en cada request', async () => {
  await licenseService.verifyLicenseWithServer('dueno@clinica.com')
  assert.equal(requestCount, 1)

  // Mientras el token esté vigente, getLicenseState usa el cache
  await licenseService.getLicenseState()
  await licenseService.getLicenseState()
  assert.equal(requestCount, 1)

  // forceRefresh vuelve a validar
  await licenseService.getLicenseState({ forceRefresh: true })
  assert.equal(requestCount, 2)
})

test('requests paralelos comparten una sola verificación fría por principal', async () => {
  const states = await Promise.all(
    Array.from({ length: 40 }, () => licenseService.getLicenseState({ email: 'dueno@clinica.com' }))
  )

  assert.equal(requestCount, 1)
  assert.equal(states.every((state) => state.allowed === true), true)
})

test('el cache de licencia es independiente por principal y evita thrashing entre empleados', async () => {
  await licenseService.getLicenseState({ email: 'dueno@clinica.com' })
  await licenseService.getLicenseState({ email: 'empleado@clinica.com' })
  await licenseService.getLicenseState({ email: 'dueno@clinica.com' })
  await licenseService.getLicenseState({ email: 'empleado@clinica.com' })

  assert.equal(requestCount, 2)
})

test('un principal bloqueado no contamina features del dueño ni el estado de instalación', async () => {
  const ownerState = await licenseService.getLicenseState({ email: 'dueno@clinica.com' })
  assert.equal(ownerState.allowed, true)

  serverMode = 'block'
  const employeeState = await licenseService.getLicenseState({ email: 'empleado@clinica.com' })
  assert.equal(employeeState.allowed, false)

  assert.equal(await licenseService.hasFeature('whatsapp', { state: ownerState }), true)
  assert.equal(await licenseService.hasFeature('whatsapp', { email: 'dueno@clinica.com' }), true)
  assert.equal(await licenseService.hasFeature('whatsapp'), true)
  assert.equal(await licenseService.hasFeature('whatsapp', { state: employeeState }), false)
  assert.equal(requestCount, 2)
})

test('requireFeature usa req.license y no el último estado global verificado', async () => {
  const ownerState = await licenseService.getLicenseState({ email: 'dueno@clinica.com' })
  serverMode = 'block'
  await licenseService.getLicenseState({ email: 'dueno@clinica.com', forceRefresh: true })

  const { requireFeature } = await import('../src/middleware/licenseMiddleware.js')
  let nextCalls = 0
  let responseStatus = null
  const middleware = requireFeature('whatsapp')
  await middleware({
    license: ownerState,
    user: { email: 'dueno@clinica.com' }
  }, {
    status(code) {
      responseStatus = code
      return this
    },
    json() {}
  }, () => {
    nextCalls += 1
  })

  assert.equal(nextCalls, 1)
  assert.equal(responseStatus, null)
})

test('licencia stale sirve token vigente y revalida en segundo plano', async () => {
  process.env.LICENSE_REVALIDATE_SECONDS = '0.001'
  try {
    await licenseService.verifyLicenseWithServer('dueno@clinica.com')
    assert.equal(requestCount, 1)
    await new Promise((resolve) => setTimeout(resolve, 5))

    const state = await licenseService.getLicenseState({ email: 'dueno@clinica.com' })
    assert.equal(state.allowed, true)

    for (let attempt = 0; attempt < 20 && requestCount < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(requestCount, 2)
  } finally {
    delete process.env.LICENSE_REVALIDATE_SECONDS
  }
})

test('estado de cancelación usa snapshot durable y no bloquea cada montaje de Cuenta', async () => {
  const first = await licenseService.getCentralAccountCancellationStatus()
  const second = await licenseService.getCentralAccountCancellationStatus()

  assert.equal(first.subscription.status, 'active')
  assert.deepEqual(second, first)
  assert.equal(accountCancellationRequestCount, 1)
})

test('estado y decisión de storage viajan al Installer con las credenciales de la instalación', async () => {
  const status = await licenseService.getCentralDatabaseStorageStatus({ usedBytes: 880_000_000 })

  assert.equal(status.needs_decision, true)
  assert.equal(status.render_pricing.additional_monthly_storage_cost, 1.20)
  assert.equal(lastRequestBody.client_id, 'cli_1')
  assert.equal(lastRequestBody.license_key, 'RSTK-TEST-0000')
  assert.equal(lastRequestBody.installation_id, 'inst_1')
  assert.equal(lastRequestBody.used_bytes, 880_000_000)

  const decision = await licenseService.decideCentralDatabaseStorage({
    decision: 'approved',
    currentDiskSizeGB: 1,
    targetDiskSizeGB: 5,
    usedBytes: 880_000_000,
    requestedByEmail: 'DUENO@CLINICA.COM'
  })

  assert.equal(decision.decision, 'approved')
  assert.equal(decision.autoscaling_enabled, true)
  assert.equal(lastRequestBody.current_disk_size_gb, 1)
  assert.equal(lastRequestBody.target_disk_size_gb, 5)
  assert.equal(lastRequestBody.requested_by_email, 'dueno@clinica.com')
})

test('hasFeature respeta los feature flags del plan', async () => {
  await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(await licenseService.hasFeature('whatsapp'), true)
  assert.equal(await licenseService.hasFeature('ai'), false)
  assert.equal(await licenseService.hasFeature('app_assistant_ai'), false)
  assert.equal(await licenseService.hasFeature('conversational_ai'), false)
  assert.equal(await licenseService.hasFeature('feature_inexistente'), false)
})

test('analítica web exige plan Profesional aunque el flag llegue activo', async () => {
  const state = (plan, enabled = true) => ({
    allowed: true,
    enforced: true,
    plan,
    features: { web_analytics: enabled }
  })

  assert.equal(await licenseService.hasFeature('web_analytics', { state: state('basic') }), false)
  assert.equal(await licenseService.hasFeature('web_analytics', { state: state('medium') }), false)
  assert.equal(await licenseService.hasFeature('web_analytics', { state: state('professional') }), true)
  assert.equal(await licenseService.hasFeature('web_analytics', { state: state('premium') }), true)
  assert.equal(await licenseService.hasFeature('web_analytics', { state: state('professional', false) }), false)
})

test('features premium omitidos por el portal central quedan apagados', async () => {
  serverMode = 'allow_without_whatsapp'

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.features.whatsapp, false)
  assert.equal(state.features.meta_ads, true)
  assert.equal(state.features.payments, false)
  assert.equal(state.features.sites, false)
  assert.equal(state.features.ai, false)
  assert.equal(state.features.app_assistant_ai, false)
  assert.equal(state.features.conversational_ai, false)
})

test('features de IA separados reconstruyen el alias legacy ai', async () => {
  serverMode = 'allow_split_ai'

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.features.app_assistant_ai, true)
  assert.equal(state.features.conversational_ai, false)
  assert.equal(state.features.ai, false)
  assert.equal(await licenseService.hasFeature('app_assistant_ai'), true)
  assert.equal(await licenseService.hasFeature('conversational_ai'), false)
  assert.equal(await licenseService.hasFeature('ai'), false)
})

test('subfeatures explícitos no quedan apagados por el módulo padre', async () => {
  serverMode = 'allow_split_sites'

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.features.sites, false)
  assert.equal(state.features.settings_media, true)
  assert.equal(state.features.settings_tracking, false)
  assert.equal(state.features.settings_domains, true)
  assert.equal(await licenseService.hasFeature('sites'), false)
  assert.equal(await licenseService.hasFeature('settings_media'), true)
  assert.equal(await licenseService.hasFeature('settings_tracking'), false)
  assert.equal(await licenseService.hasFeature('settings_domains'), true)
})

test('subfeatures explícitos apagados no reviven por el módulo padre', async () => {
  serverMode = 'allow_split_calendar'

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.features.appointments, true)
  assert.equal(state.features.google_calendar, false)
  assert.equal(await licenseService.hasFeature('appointments'), true)
  assert.equal(await licenseService.hasFeature('google_calendar'), false)
})

test('cobro de calendario se permite por compatibilidad en Professional', async () => {
  serverMode = 'allow_split_calendar'

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.plan, 'pro')
  assert.equal(state.features.calendar_payments, undefined)
  assert.equal(await licenseService.hasCalendarPaymentsFeature(), true)
})

test('cobro de calendario no se abre en plan básico sin feature explícito', async () => {
  serverMode = 'allow_basic_calendar'

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.plan, 'basic')
  assert.equal(state.features.appointments, true)
  assert.equal(state.features.google_calendar, false)
  assert.equal(await licenseService.hasCalendarPaymentsFeature(), false)
})

test('cobro de calendario respeta false explícito del portal', async () => {
  serverMode = 'allow_calendar_payment_false'

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.features.google_calendar, true)
  assert.equal(state.features.calendar_payments, false)
  assert.equal(await licenseService.hasCalendarPaymentsFeature(), false)
})

test('cobro de calendario sigue fail-closed si el portal responde sin features', async () => {
  serverMode = 'allow_without_features'

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.allowed, true)
  assert.equal(state.featuresSourceValid, false)
  assert.equal(await licenseService.hasCalendarPaymentsFeature(), false)
})

test('modo estricto: servidor caído sin token vigente bloquea el acceso', async () => {
  serverMode = 'down'

  const state = await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  assert.equal(state.allowed, false)
  assert.equal(state.reason, 'license_server_unreachable')
})

test('servidor caído con token temporal vigente mantiene el acceso', async () => {
  await licenseService.verifyLicenseWithServer('dueno@clinica.com')

  serverMode = 'down'
  const state = await licenseService.getLicenseState({ forceRefresh: true })

  assert.equal(state.allowed, true)
})

test('getHealthInfo responde el contrato del instalador', () => {
  const info = licenseService.getHealthInfo()

  assert.equal(info.ok, true)
  assert.equal(info.app, 'ristak')
  assert.equal(info.version, '1.2.3')
  assert.equal(info.client_id, 'cli_1')
  assert.equal(info.installation_id, 'inst_1')
})

test('setup token válido devuelve el email del dueño', async () => {
  const result = await licenseService.verifySetupToken('good-token')
  assert.equal(result.valid, true)
  assert.equal(result.email, 'dueno@clinica.com')
})

test('setup token inválido falla con mensaje claro', async () => {
  const result = await licenseService.consumeSetupToken('bad-token')
  assert.equal(result.valid, false)
  assert.ok(result.message)
  assert.equal(setupTokenRequestCount, 1)
})

test('setup token reintenta respuestas transitorias del portal antes de rendirse', async () => {
  const result = await licenseService.verifySetupToken('flaky-token')

  assert.equal(result.valid, true)
  assert.equal(result.email, 'dueno@clinica.com')
  assert.equal(setupTokenRequestCount, 3)
})

test('setup token distingue una caída temporal después de agotar sus reintentos', async () => {
  const result = await licenseService.verifySetupToken('unavailable-token')

  assert.equal(result.valid, false)
  assert.equal(result.retryable, true)
  assert.equal(result.code, 'setup_temporarily_unavailable')
  assert.equal(setupTokenRequestCount, 3)
})

test('el setup token comparte el hash de credenciales del portal (setup automático)', async () => {
  const verified = await licenseService.verifySetupToken('good-token')
  assert.equal(verified.password_hash, 'salt:hash-portal')

  const consumed = await licenseService.consumeSetupToken('good-token')
  assert.equal(consumed.password_hash, 'salt:hash-portal')
})

test('verifyOwnerCredentialsWithServer sincroniza la contraseña vigente del portal', async () => {
  const ok = await licenseService.verifyOwnerCredentialsWithServer('dueno@clinica.com', 'clave-portal-1')
  assert.equal(ok.valid, true)
  assert.equal(ok.password_hash, 'salt:hash-portal-nuevo')

  const bad = await licenseService.verifyOwnerCredentialsWithServer('dueno@clinica.com', 'clave-vieja')
  assert.equal(bad.valid, false)

  // En modo standalone nunca consulta al servidor
  configureStandalone()
  const standalone = await licenseService.verifyOwnerCredentialsWithServer('dueno@clinica.com', 'clave-portal-1')
  assert.equal(standalone.valid, false)
})

test('verifyOwnerCredentialsWithServer conserva la bandera de acceso global de soporte', async () => {
  const support = await licenseService.verifyOwnerCredentialsWithServer(
    'dueno@clinica.com',
    'clave-admin-installer'
  )

  assert.equal(support.valid, true)
  assert.equal(support.support_access, true)
  assert.equal(support.password_hash, undefined)
})
