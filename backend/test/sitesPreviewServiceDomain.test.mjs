import test from 'node:test'
import assert from 'node:assert/strict'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { createBlock, createMetaPageEventFromRequest, createSite, createSubmissionFromRequest, deleteSite } from '../src/services/sitesService.js'

const DOMAIN_KEYS = {
  domain: 'sites_public_domain',
  verified: 'sites_public_domain_verified',
  checkedAt: 'sites_public_domain_checked_at',
  error: 'sites_public_domain_error'
}

async function snapshotPublicDomainConfig() {
  return {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
}

async function restorePublicDomainConfig(config) {
  await Promise.all([
    setAppConfig(DOMAIN_KEYS.domain, config.domain),
    setAppConfig(DOMAIN_KEYS.verified, config.verified),
    setAppConfig(DOMAIN_KEYS.checkedAt, config.checkedAt),
    setAppConfig(DOMAIN_KEYS.error, config.error)
  ])
}

test('draft preview actions work on the service domain without a public domain', async () => {
  const previousConfig = await snapshotPublicDomainConfig()
  const slug = `preview-service-${Date.now()}`
  const email = `preview-service-${Date.now()}@example.test`
  let site

  try {
    await setAppConfig(DOMAIN_KEYS.domain, '')
    await setAppConfig(DOMAIN_KEYS.verified, '0')
    await setAppConfig(DOMAIN_KEYS.checkedAt, '')
    await setAppConfig(DOMAIN_KEYS.error, '')

    site = await createSite({
      name: 'Preview sin dominio publico',
      slug,
      siteType: 'standard_form',
      status: 'draft',
      blankCanvas: true
    })

    const siteWithField = await createBlock(site.id, {
      blockType: 'email',
      label: 'Correo',
      placeholder: 'tu@email.com',
      required: true,
      settings: { systemFieldKey: 'email', internalName: 'email', validation: 'email' }
    })
    const emailBlock = siteWithField.blocks.find(block => block.blockType === 'email')
    assert.ok(emailBlock)

    const req = {
      headers: { host: 'ristak-preview.onrender.com', 'user-agent': 'node-test' },
      hostname: 'ristak-preview.onrender.com',
      path: `/${slug}`,
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }
    }

    await assert.rejects(
      () => createSubmissionFromRequest(req, {
        siteId: site.id,
        finalSubmit: true,
        responses: { [emailBlock.id]: email }
      }),
      /Dominio no configurado/
    )

    const result = await createSubmissionFromRequest(
      req,
      {
        siteId: site.id,
        finalSubmit: true,
        responses: { [emailBlock.id]: email }
      },
      {
        previewContext: {
          siteId: site.id,
          pageId: 'preview-page',
          token: 'preview-test',
          host: 'ristak-preview.onrender.com'
        }
      }
    )

    assert.equal(result.status, 'received')
    assert.equal(result.siteId, site.id)
    assert.equal(result.contactEmail, email)

    const submission = await db.get(
      'SELECT domain, meta_json FROM public_site_submissions WHERE id = ?',
      [result.submissionId]
    )
    assert.equal(submission.domain, 'ristak-preview.onrender.com')
    const meta = JSON.parse(submission.meta_json)
    assert.equal(meta.previewSession, true)
    assert.equal(meta.previewPageId, 'preview-page')

    const metaEvent = await createMetaPageEventFromRequest(
      req,
      {
        siteId: site.id,
        pageId: 'page-1'
      },
      {
        previewContext: {
          siteId: site.id,
          pageId: 'preview-page',
          token: 'preview-test',
          host: 'ristak-preview.onrender.com'
        }
      }
    )
    assert.deepEqual(metaEvent, { sent: false, reason: 'site_disabled' })
  } finally {
    if (site?.id) await deleteSite(site.id).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
    await restorePublicDomainConfig(previousConfig)
  }
})
