import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { getSocialProfiles } from '../src/controllers/metaController.js'
import { refreshConnectedSocialProfileBlocks } from '../src/services/metaSocialProfilesService.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'

async function snapshotMetaConfig(callback) {
  const previousRows = await db.all('SELECT * FROM meta_config')

  try {
    await db.run('DELETE FROM meta_config')
    return await callback()
  } finally {
    await db.run('DELETE FROM meta_config')
    for (const row of previousRows) {
      const columns = Object.keys(row)
      const placeholders = columns.map(() => '?').join(', ')
      await db.run(
        `INSERT INTO meta_config (${columns.join(', ')}) VALUES (${placeholders})`,
        columns.map(column => row[column])
      )
    }
  }
}

async function insertMetaConfig({
  token = 'meta-token-db',
  pageId = 'page_1',
  instagramAccountId = 'ig_1',
  connectionMode = 'manual_system_user',
  pageToken = '',
  pageProof = ''
} = {}) {
  await db.run(`
    INSERT INTO meta_config (
      ad_account_id,
      access_token,
      connection_mode,
      page_id,
      instagram_account_id,
      oauth_page_access_token,
      oauth_page_appsecret_proof,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    'act_meta_social_profiles',
    encrypt(token),
    connectionMode,
    pageId,
    instagramAccountId,
    pageToken ? encrypt(pageToken) : null,
    pageProof ? encrypt(pageProof) : null
  ])
}

async function withFakeMetaGraph(callback) {
  const calls = []
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  let server

  try {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      calls.push({
        pathname: url.pathname,
        accessToken: url.searchParams.get('access_token'),
        appSecretProof: url.searchParams.get('appsecret_proof')
      })

      if (url.pathname === '/me/accounts' || url.pathname === '/page_1') {
        const oauthPageRequest = url.pathname === '/page_1'
        const expectedToken = oauthPageRequest ? 'oauth-page-token' : 'meta-token-db'
        const expectedProof = oauthPageRequest ? 'oauth-page-proof' : null
        if (
          url.searchParams.get('access_token') !== expectedToken ||
          (oauthPageRequest && url.searchParams.get('appsecret_proof') !== expectedProof)
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'invalid meta token' } }))
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        const page = {
              id: 'page_1',
              name: 'Raul Gomez',
              category: 'Marketing',
              followers_count: 1532,
              picture: { data: { url: 'https://example.test/page.webp' } },
              instagram_business_account: {
                id: 'ig_1',
                username: 'raulgomezjj',
                name: 'Raul Gomez IG',
                profile_picture_url: 'https://example.test/instagram.webp',
                followers_count: 24000
              }
            }
        res.end(JSON.stringify(oauthPageRequest ? page : { data: [page] }))
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `unexpected ${url.pathname}` } }))
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${server.address().port}`,
      configurable: true
    })

    return await callback(calls)
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
  }
}

function createJsonResponse() {
  const state = {
    statusCode: 200,
    body: null
  }

  return {
    status(code) {
      state.statusCode = code
      return this
    },
    json(payload) {
      state.body = payload
      return this
    },
    get statusCode() {
      return state.statusCode
    },
    get body() {
      return state.body
    }
  }
}

async function cleanupSite(siteId) {
  await db.run('DELETE FROM public_site_blocks WHERE site_id = ?', [siteId]).catch(() => undefined)
  await db.run('DELETE FROM public_sites WHERE id = ?', [siteId]).catch(() => undefined)
}

test('Meta social profiles endpoint uses saved Meta config instead of the Ristak auth token', async () => {
  await initializeMasterKey()

  await snapshotMetaConfig(async () => {
    await insertMetaConfig()

    await withFakeMetaGraph(async (calls) => {
      const res = createJsonResponse()

      await getSocialProfiles(
        {
          headers: { authorization: 'Bearer ristak-session-token' },
          query: {}
        },
        res
      )

      assert.equal(res.statusCode, 200)
      assert.equal(res.body.success, true)
      assert.equal(res.body.data.connected, true)
      assert.equal(calls[0]?.accessToken, 'meta-token-db')
      assert.equal(res.body.data.profiles.some(profile => profile.id === 'facebook:page_1'), true)
      assert.equal(res.body.data.profiles.some(profile => profile.id === 'instagram:ig_1'), true)
    })
  })
})

test('published social profile refresh adopts configured Meta profile when legacy block has no source id', async () => {
  await initializeMasterKey()

  const siteId = `site_meta_social_${Date.now()}`
  const blockId = `block_meta_social_${Date.now()}`

  await cleanupSite(siteId)

  await snapshotMetaConfig(async () => {
    await insertMetaConfig({ instagramAccountId: '' })

    await db.run(`
      INSERT INTO public_sites (id, name, slug, site_type, status, theme_json)
      VALUES (?, ?, ?, 'landing_page', 'published', ?)
    `, [
      siteId,
      'Landing social',
      `landing-social-${Date.now()}`,
      JSON.stringify({ template: 'facebook' })
    ])

    await db.run(`
      INSERT INTO public_site_blocks (
        id,
        site_id,
        block_type,
        label,
        content,
        options_json,
        settings_json,
        sort_order
      ) VALUES (?, ?, 'social_profile', 'Perfil de red social', 'Perfil de red social', '[]', ?, 0)
    `, [
      blockId,
      siteId,
      JSON.stringify({
        platform: 'facebook',
        brandName: 'Formulario 01',
        brandSubtitle: 'Patrocinado',
        followers: '',
        socialAutoSync: true
      })
    ])

    try {
      await withFakeMetaGraph(async () => {
        const result = await refreshConnectedSocialProfileBlocks()
        assert.equal(result.success, true)
        assert.equal(result.updated, 1)

        const row = await db.get('SELECT settings_json FROM public_site_blocks WHERE id = ?', [blockId])
        const settings = JSON.parse(row.settings_json)
        assert.equal(settings.brandName, 'Raul Gomez')
        assert.equal(settings.brandSubtitle, 'P\u00e1gina de Facebook conectada')
        assert.equal(settings.followers, '1,5 mil')
        assert.equal(settings.socialSourceProfileId, 'facebook:page_1')
        assert.equal(settings.socialSourceId, 'page_1')
      })
    } finally {
      await cleanupSite(siteId)
    }
  })
})

test('OAuth social profiles uses the stored Page token and matching Page proof', async () => {
  await initializeMasterKey()

  await snapshotMetaConfig(async () => {
    await insertMetaConfig({
      connectionMode: 'oauth_bisu',
      pageToken: 'oauth-page-token',
      pageProof: 'oauth-page-proof'
    })

    await withFakeMetaGraph(async (calls) => {
      const res = createJsonResponse()
      await getSocialProfiles({ headers: {}, query: {} }, res)

      assert.equal(res.statusCode, 200)
      assert.equal(res.body.success, true)
      assert.equal(calls[0]?.pathname, '/page_1')
      assert.equal(calls[0]?.accessToken, 'oauth-page-token')
      assert.equal(calls[0]?.appSecretProof, 'oauth-page-proof')
      assert.equal(res.body.data.profiles.some(profile => profile.id === 'instagram:ig_1'), true)
    })
  })
})
