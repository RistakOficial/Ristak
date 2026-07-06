import test from 'node:test'
import assert from 'node:assert/strict'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { publicSiteHostMiddleware } from '../src/controllers/sitesController.js'
import {
  isMetaPrivacyPolicyPath,
  renderMetaPrivacyPolicyHtmlFromContext
} from '../src/services/publicMetaPrivacyPolicyService.js'

const BUSINESS_PROFILE_KEY = 'account_business_profile'

function createResponseStub() {
  const state = {
    headers: {},
    statusCode: null,
    contentType: '',
    body: null
  }

  return {
    state,
    set(key, value) {
      state.headers[key] = value
      return this
    },
    status(code) {
      state.statusCode = code
      return this
    },
    type(value) {
      state.contentType = value
      return this
    },
    send(body) {
      state.body = body
      return this
    },
    json(payload) {
      state.body = payload
      return this
    }
  }
}

test('meta privacy route matcher reserves only /meta-privacy', () => {
  assert.equal(isMetaPrivacyPolicyPath('/meta-privacy'), true)
  assert.equal(isMetaPrivacyPolicyPath('/META-PRIVACY/'), true)
  assert.equal(isMetaPrivacyPolicyPath('/meta-privacy?ref=meta'), true)
  assert.equal(isMetaPrivacyPolicyPath('/meta-privacy/details'), false)
  assert.equal(isMetaPrivacyPolicyPath('/privacy'), false)
})

test('meta privacy policy renders configured business data and escapes user content', () => {
  const html = renderMetaPrivacyPolicyHtmlFromContext({
    businessName: 'Clinica <Demo>',
    email: 'privacy@example.test',
    phone: '+52 656 000 0000',
    address: 'Av. Meta & Calle 1',
    currentWebsiteUrl: 'https://demo.onrender.com/',
    websiteUrl: 'https://clinica.example.test/',
    lastUpdated: 'July 6, 2026'
  })

  assert.match(html, /Privacy Policy/)
  assert.match(html, /Clinica &lt;Demo&gt;/)
  assert.doesNotMatch(html, /Clinica <Demo>/)
  assert.match(html, /mailto:privacy@example.test/)
  assert.match(html, /https:\/\/demo\.onrender\.com\//)
  assert.match(html, /https:\/\/clinica\.example\.test\//)
  assert.match(html, /Av\. Meta &amp; Calle 1/)
  assert.match(html, /Data Deletion Request/)
})

test('public site host middleware serves /meta-privacy publicly on Render host', async () => {
  const previousProfile = await getAppConfig(BUSINESS_PROFILE_KEY)

  try {
    await setAppConfig(BUSINESS_PROFILE_KEY, {
      name: 'RAUL GOMEZ',
      email: 'raul.gom11@gmail.com',
      website: '',
      phone: '',
      address: '',
      terms: ''
    })

    const req = {
      path: '/meta-privacy',
      method: 'GET',
      query: {},
      protocol: 'https',
      headers: {
        host: 'raulgomez.onrender.com',
        'x-forwarded-host': 'raulgomez.onrender.com',
        'x-forwarded-proto': 'https'
      }
    }
    const res = createResponseStub()
    let nextCalled = false

    await publicSiteHostMiddleware(req, res, () => {
      nextCalled = true
    })

    assert.equal(nextCalled, false)
    assert.equal(res.state.statusCode, 200)
    assert.equal(res.state.contentType, 'html')
    assert.equal(res.state.headers['Cache-Control'], 'no-store')
    assert.match(res.state.body, /RAUL GOMEZ/)
    assert.match(res.state.body, /https:\/\/raulgomez\.onrender\.com\//)
    assert.match(res.state.body, /mailto:raul\.gom11@gmail\.com/)
  } finally {
    await setAppConfig(BUSINESS_PROFILE_KEY, previousProfile)
    await db.run('DELETE FROM app_config WHERE config_key = ? AND config_value IS NULL', [BUSINESS_PROFILE_KEY])
  }
})
