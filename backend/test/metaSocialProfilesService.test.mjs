import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db, getAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { getSocialProfiles, refreshSocialProfiles } from '../src/controllers/metaController.js'
import { saveMetaAssetSnapshot, clearMetaAssetSnapshot } from '../src/services/metaAssetSnapshotService.js'
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

async function snapshotOAuthAssetState(callback) {
  const previousAuthorized = await db.all('SELECT * FROM meta_oauth_authorized_assets')
  const previousSnapshot = await db.get(
    'SELECT * FROM app_config WHERE config_key = ?',
    ['meta_asset_snapshot_v1']
  )
  try {
    await db.run('DELETE FROM meta_oauth_authorized_assets')
    await db.run('DELETE FROM app_config WHERE config_key = ?', ['meta_asset_snapshot_v1'])
    return await callback()
  } finally {
    await db.run('DELETE FROM meta_oauth_authorized_assets')
    for (const row of previousAuthorized) {
      const columns = Object.keys(row)
      await db.run(
        `INSERT INTO meta_oauth_authorized_assets (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map(column => row[column])
      )
    }
    await db.run('DELETE FROM app_config WHERE config_key = ?', ['meta_asset_snapshot_v1'])
    if (previousSnapshot) {
      const columns = Object.keys(previousSnapshot)
      await db.run(
        `INSERT INTO app_config (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map(column => previousSnapshot[column])
      )
    }
  }
}

async function insertMetaConfig({
  token = 'meta-token-db',
  pageId = 'page_1',
  instagramAccountId = 'ig_1',
  connectionMode = 'manual_system_user',
  oauthConnectionId = '',
  pageToken = '',
  pageProof = ''
} = {}) {
  await db.run(`
    INSERT INTO meta_config (
      ad_account_id,
      access_token,
      connection_mode,
      oauth_connection_id,
      page_id,
      instagram_account_id,
      oauth_page_access_token,
      oauth_page_appsecret_proof,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    'act_meta_social_profiles',
    encrypt(token),
    connectionMode,
    oauthConnectionId || null,
    pageId,
    instagramAccountId,
    pageToken ? encrypt(pageToken) : null,
    pageProof ? encrypt(pageProof) : null
  ])
}

async function seedMetaAssetSnapshot() {
  await saveMetaAssetSnapshot({
    updatedAt: '2026-07-14T00:00:00.000Z',
    pages: [{
      id: 'page_1',
      name: 'Raul Gomez',
      category: 'Marketing',
      pictureUrl: 'https://example.test/page.webp',
      followers: 1532,
      instagramAccounts: [{
        id: 'ig_1',
        username: 'raulgomezjj',
        name: 'Raul Gomez IG',
        avatarUrl: 'https://example.test/instagram.webp',
        followers: 24000
      }]
    }],
    profiles: [{
      id: 'facebook:page_1',
      platform: 'facebook',
      sourceId: 'page_1',
      pageId: 'page_1',
      pageName: 'Raul Gomez',
      name: 'Raul Gomez',
      category: 'Marketing',
      avatarUrl: 'https://example.test/page.webp',
      followers: 1532,
      followersLabel: '1,5 mil'
    }, {
      id: 'instagram:ig_1',
      platform: 'instagram',
      sourceId: 'ig_1',
      pageId: 'page_1',
      pageName: 'Raul Gomez',
      name: 'raulgomezjj',
      username: 'raulgomezjj',
      category: 'Instagram',
      avatarUrl: 'https://example.test/instagram.webp',
      followers: 24000,
      followersLabel: '24 mil'
    }]
  })
}

async function withFakeMetaGraph(callback, { rejectCombinedProfileFields = false } = {}) {
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

      if (url.pathname === '/me/accounts' || url.pathname === '/page_1' || url.pathname === '/ig_1') {
        const oauthPageRequest = url.pathname === '/page_1' || url.pathname === '/ig_1'
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

        const fields = url.searchParams.get('fields') || ''
        if (
          rejectCombinedProfileFields &&
          url.pathname === '/page_1' &&
          fields.includes('connected_instagram_account') &&
          fields.includes('followers_count')
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'unsupported combined fields' } }))
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (url.pathname === '/ig_1') {
          res.end(JSON.stringify({
            id: 'ig_1',
            username: 'raulgomezjj',
            name: 'Raul Gomez IG',
            profile_picture_url: 'https://example.test/instagram.webp',
            followers_count: 24000
          }))
          return
        }
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
        if (rejectCombinedProfileFields && oauthPageRequest) {
          if (fields === 'id,name,category,picture{url}') {
            res.end(JSON.stringify({
              id: page.id,
              name: page.name,
              category: page.category,
              picture: page.picture
            }))
            return
          }
          if (fields === 'id,followers_count') {
            res.end(JSON.stringify({ id: page.id, followers_count: page.followers_count }))
            return
          }
          if (fields === 'id,fan_count') {
            res.end(JSON.stringify({ id: page.id, fan_count: 1500 }))
            return
          }
          if (fields.includes('instagram_business_account')) {
            res.end(JSON.stringify({
              id: page.id,
              instagram_business_account: {
                id: 'ig_1',
                username: 'raulgomezjj',
                name: 'Raul Gomez IG'
              }
            }))
            return
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
    await seedMetaAssetSnapshot()

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
      assert.equal(calls.length, 0)
      assert.equal(res.body.data.profiles.some(profile => profile.id === 'facebook:page_1'), true)
      assert.equal(res.body.data.profiles.some(profile => profile.id === 'instagram:ig_1'), true)
    })

    await clearMetaAssetSnapshot()
  })
})

test('Meta asset snapshot keeps an unknown follower count as null instead of inventing zero', async () => {
  await initializeMasterKey()

  await snapshotMetaConfig(async () => {
    await insertMetaConfig()
    await saveMetaAssetSnapshot({
      updatedAt: '2026-07-14T00:00:00.000Z',
      profiles: [{
        id: 'facebook:page_1',
        platform: 'facebook',
        sourceId: 'page_1',
        pageId: 'page_1',
        name: 'Raul Gomez',
        followers: null,
        followersLabel: ''
      }]
    })

    try {
      const res = createJsonResponse()
      await getSocialProfiles({ headers: {}, query: {} }, res)
      assert.equal(res.statusCode, 200)
      assert.equal(res.body.data.profiles[0].followers, null)
      assert.equal(res.body.data.profiles[0].followersLabel, '')
    } finally {
      await clearMetaAssetSnapshot()
    }
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
    await seedMetaAssetSnapshot()

    await withFakeMetaGraph(async (calls) => {
      const res = createJsonResponse()
      await getSocialProfiles({ headers: {}, query: {} }, res)

      assert.equal(res.statusCode, 200)
      assert.equal(res.body.success, true)
      assert.equal(calls.length, 0)
      assert.equal(res.body.data.profiles.some(profile => profile.id === 'instagram:ig_1'), true)
    })

    await clearMetaAssetSnapshot()
  })
})

test('OAuth social profile refresh recovers avatars and followers with each saved Page credential', async () => {
  await initializeMasterKey()

  await snapshotMetaConfig(async () => {
    await snapshotOAuthAssetState(async () => {
      await insertMetaConfig({
        connectionMode: 'oauth_user',
        oauthConnectionId: 'oauth-social-rich-profile',
        pageToken: 'oauth-page-token',
        pageProof: 'oauth-page-proof'
      })
      await db.run(
        `INSERT INTO meta_oauth_authorized_assets (id, connection_id, payload_encrypted)
         VALUES (?, ?, ?)`,
        [
          'unified',
          'oauth-social-rich-profile',
          encrypt(JSON.stringify({
            connectionId: 'oauth-social-rich-profile',
            connectionMode: 'oauth_user',
            pages: [{
              id: 'page_1',
              name: 'Raul Gomez',
              category: 'Marketing',
              pictureUrl: '',
              followers: null,
              instagramAccounts: [{
                id: 'ig_1',
                username: 'raulgomezjj',
                name: 'Raul Gomez IG',
                avatarUrl: '',
                followers: null
              }]
            }],
            pageSecrets: {
              page_1: {
                pageAccessToken: 'oauth-page-token',
                pageAppSecretProof: 'oauth-page-proof'
              }
            }
          }))
        ]
      )

      await withFakeMetaGraph(async calls => {
        const res = createJsonResponse()
        await refreshSocialProfiles({ headers: {}, query: {} }, res)

        assert.equal(res.statusCode, 200)
        assert.equal(res.body.success, true)
        assert.equal(calls.length, 1)
        assert.deepEqual(calls[0], {
          pathname: '/page_1',
          accessToken: 'oauth-page-token',
          appSecretProof: 'oauth-page-proof'
        })

        const facebook = res.body.data.profiles.find(profile => profile.id === 'facebook:page_1')
        const instagram = res.body.data.profiles.find(profile => profile.id === 'instagram:ig_1')
        assert.equal(facebook.avatarUrl, 'https://example.test/page.webp')
        assert.equal(facebook.followers, 1532)
        assert.equal(facebook.followersLabel, '1,5 mil')
        assert.equal(instagram.avatarUrl, 'https://example.test/instagram.webp')
        assert.equal(instagram.followers, 24000)
        assert.equal(instagram.followersLabel, '24 mil')

        const storedSnapshot = JSON.parse(await getAppConfig('meta_asset_snapshot_v1'))
        assert.equal(storedSnapshot.profiles.some(profile => profile.followers === 24000), true)
      })
    })
  })
})

test('OAuth social profile refresh isolates fields when Meta rejects the combined Page query', async () => {
  await initializeMasterKey()

  await snapshotMetaConfig(async () => {
    await snapshotOAuthAssetState(async () => {
      await insertMetaConfig({
        connectionMode: 'oauth_user',
        oauthConnectionId: 'oauth-social-partial-fields',
        pageToken: 'oauth-page-token',
        pageProof: 'oauth-page-proof'
      })

      await withFakeMetaGraph(async calls => {
        const res = createJsonResponse()
        await refreshSocialProfiles({ headers: {}, query: {} }, res)

        assert.equal(res.statusCode, 200)
        assert.equal(calls.some(call => call.pathname === '/ig_1'), true)
        const facebook = res.body.data.profiles.find(profile => profile.id === 'facebook:page_1')
        const instagram = res.body.data.profiles.find(profile => profile.id === 'instagram:ig_1')
        assert.equal(facebook.avatarUrl, 'https://example.test/page.webp')
        assert.equal(facebook.followers, 1532)
        assert.equal(instagram.avatarUrl, 'https://example.test/instagram.webp')
        assert.equal(instagram.followers, 24000)
      }, { rejectCombinedProfileFields: true })
    })
  })
})
