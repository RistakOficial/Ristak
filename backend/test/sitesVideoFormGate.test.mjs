import test from 'node:test'
import assert from 'node:assert/strict'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { createBlock, createSite, createSubmissionFromRequest, deleteSite, renderPublicSiteHtml } from '../src/services/sitesService.js'

const DOMAIN_KEYS = {
  domain: 'sites_public_domain',
  verified: 'sites_public_domain_verified',
  checkedAt: 'sites_public_domain_checked_at',
  error: 'sites_public_domain_error'
}

test('video form gate renders inside the video player and posts as the source form', async () => {
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  const suffix = Date.now()
  const email = `video-gate-${suffix}@example.test`
  let formSite
  let landingSite

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    formSite = await createSite({
      name: 'Formulario fuente video',
      slug: `video-source-form-${suffix}`,
      siteType: 'standard_form',
      status: 'published',
      blankCanvas: true,
      theme: {
        template: 'ristak',
        submitText: 'Enviar video',
        nextText: 'Siguiente video',
        finalMessages: {
          disqualified: 'No calificas para este video.'
        }
      }
    })

    await createBlock(formSite.id, {
      blockType: 'email',
      label: 'Correo',
      placeholder: 'correo@example.test',
      required: true,
      settings: { systemFieldKey: 'email', internalName: 'email', validation: 'email' }
    })
    await createBlock(formSite.id, {
      blockType: 'short_text',
      label: 'Empresa',
      placeholder: 'Tu empresa',
      required: false,
      settings: {
        internalName: 'empresa_video',
        customFieldKey: 'empresa_video',
        customFieldLabel: 'Empresa video',
        customFieldDataType: 'text'
      }
    })
    formSite = await createBlock(formSite.id, {
      blockType: 'radio',
      label: 'Calificación',
      required: true,
      settings: { internalName: 'calificacion_video' },
      options: [
        { label: 'Califica', value: 'Califica', action: 'continue' },
        { label: 'No califica', value: 'No califica', action: 'disqualify', message: 'No calificas para este video.' }
      ]
    })

    const sourceBlocks = formSite.blocks || []
    const emailBlock = sourceBlocks.find(block => block.blockType === 'email')
    const companyBlock = sourceBlocks.find(block => block.label === 'Empresa')
    const qualificationBlock = sourceBlocks.find(block => block.blockType === 'radio')
    assert.ok(emailBlock)
    assert.ok(companyBlock)
    assert.ok(qualificationBlock)

    landingSite = await createSite({
      name: 'Landing video gate',
      slug: `landing-video-gate-${suffix}`,
      siteType: 'landing_page',
      status: 'published',
      blankCanvas: true,
      theme: {
        template: 'ristak',
        pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
      }
    })

    landingSite = await createBlock(landingSite.id, {
      blockType: 'video',
      label: 'Video con formulario',
      sortOrder: 0,
      settings: {
        pageId: 'page-1',
        mediaUrl: 'https://cdn.example.com/video-form-gate.mp4',
        videoFormGateEnabled: true,
        videoFormGateFormSiteId: formSite.id,
        videoFormGateTitle: 'Formulario de video',
        videoFormGateTriggerSeconds: 3
      }
    })

    const videoBlock = (landingSite.blocks || []).find(block => block.blockType === 'video')
    assert.ok(videoBlock)

    const html = await renderPublicSiteHtml(landingSite, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(html, /data-rstk-video-form-gate/)
    assert.match(html, new RegExp(`data-video-block-id="${videoBlock.id}"`))
    assert.match(html, new RegExp(`data-form-site-id="${formSite.id}"`))
    assert.match(html, /Formulario de video/)
    assert.match(html, /Correo/)
    assert.match(html, /Empresa/)
    assert.match(html, /Calificaci/)
    assert.match(html, /rstk-video-form-field/)
    assert.match(html, /ristakVideoFormGateRuntimeLoaded/)
    assert.match(html, /data-trigger-seconds="3"/)

    const result = await createSubmissionFromRequest(
      {
        headers: { host: 'example.test', 'user-agent': 'node-test' },
        hostname: 'example.test',
        path: `/${landingSite.slug}`,
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' }
      },
      {
        siteId: landingSite.id,
        pageId: 'page-1',
        videoFormGateBlockId: videoBlock.id,
        responses: {
          [emailBlock.id]: email,
          [companyBlock.id]: 'Ristak Labs',
          [qualificationBlock.id]: 'No califica'
        },
        meta: {
          videoFormGate: true,
          videoFormGateBlockId: videoBlock.id
        }
      }
    )

    assert.equal(result.status, 'disqualified')
    assert.equal(result.message, 'No calificas para este video.')
    assert.equal(result.mappedFields.standard.email, email)
    assert.equal(result.mappedFields.custom.empresa_video, 'Ristak Labs')

    const submission = await db.get('SELECT site_id, form_site_id, meta_json FROM public_site_submissions WHERE id = ?', [result.submissionId])
    assert.equal(submission.site_id, landingSite.id)
    assert.equal(submission.form_site_id, formSite.id)
    const meta = JSON.parse(submission.meta_json)
    assert.equal(meta.videoFormGate, true)
    assert.equal(meta.videoFormGateBlockId, videoBlock.id)
    assert.equal(meta.formSiteId, formSite.id)
  } finally {
    await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
    if (landingSite?.id) await deleteSite(landingSite.id).catch(() => undefined)
    if (formSite?.id) await deleteSite(formSite.id).catch(() => undefined)
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain)
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified)
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt)
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error)
  }
})
