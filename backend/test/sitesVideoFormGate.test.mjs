import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
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
  const forcedEmail = `video-gate-forced-${suffix}@example.test`
  const previousMetaEnv = {
    pixelId: process.env.META_PIXEL_ID,
    datasetId: process.env.META_DATASET_ID,
    accessToken: process.env.META_ACCESS_TOKEN
  }
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const metaCalls = []
  let metaServer
  let formSite
  let landingSite

  try {
    process.env.META_PIXEL_ID = 'pixel-video-gate-test'
    process.env.META_DATASET_ID = ''
    process.env.META_ACCESS_TOKEN = 'token-video-gate-test'
    metaServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        metaCalls.push({ url: req.url, body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ events_received: 1 }))
      })
    })
    await new Promise(resolve => metaServer.listen(0, '127.0.0.1', resolve))
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

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
        backgroundColor: '#fee2e2',
        textColor: '#7f1d1d',
        textColorCustom: true,
        formFieldBg: '#fff1f2',
        formFieldText: '#7f1d1d',
        formFieldBorder: '#fecdd3',
        submitBg: '#ef4444',
        submitTextColor: '#ffffff',
        submitBorderColor: '#ef4444',
        submitRadius: 30,
        submitText: 'Enviar video',
        nextText: 'Siguiente video',
        submitAlign: 'left',
        formContentAlign: 'center',
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
      metaCapiEnabled: true,
      theme: {
        template: 'ristak',
        pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
      }
    })

    landingSite = await createBlock(landingSite.id, {
      blockType: 'title',
      label: 'Oferta oculta',
      content: 'Oferta desbloqueada',
      sortOrder: 1,
      settings: {
        pageId: 'page-1'
      }
    })

    const targetBlock = (landingSite.blocks || []).find(block => block.label === 'Oferta oculta')
    assert.ok(targetBlock)

    landingSite = await createBlock(landingSite.id, {
      blockType: 'video',
      label: 'Video con formulario',
      sortOrder: 0,
      settings: {
        pageId: 'page-1',
        mediaUrl: 'https://cdn.example.com/video-form-gate.mp4',
        videoFormGateEnabled: true,
        videoFormGateFormSiteId: formSite.id,
        videoFormGateEmbeddedTheme: {
          template: 'ristak',
          backgroundColor: '#ffffff',
          textColor: '#111827',
          textColorCustom: true,
          formFieldBg: '#ffffff',
          formFieldText: '#111827',
          formFieldBorder: '#d1d5db',
          formPlaceholderColor: '#6b7280',
          formFieldRadius: 14,
          submitBg: '#111827',
          submitTextColor: '#ffffff',
          submitBorderColor: '#111827',
          submitRadius: 12,
          submitHeight: 52,
          submitPaddingX: 28,
          submitPaddingY: 10,
          submitFontSize: 16
        },
        videoFormGateTitle: 'Formulario de video',
        videoFormGateTriggerSeconds: 3,
        videoFormGateVideoBackground: 'rgba(255, 255, 255, 0.2)',
        videoFormGateCompletionAction: 'show_targets',
        videoFormGateCompletionTargetId: targetBlock.id,
        videoFormGateCompletionTargetIds: [targetBlock.id],
        videoFormGateRepeatMode: 'remember_visitor',
        videoFormGateStorageValue: 45,
        videoFormGateStorageUnit: 'days',
        videoFormGateMetaEnabled: true,
        videoFormGateMetaEventName: 'CompleteRegistration',
        videoFormGateMetaEventParameters: {
          value: '25',
          predictedLtv: '1500',
          currency: 'MXN',
          status: 'qualified',
          custom: [{ key: 'video_gate', value: 'completed' }]
        }
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
    assert.match(html, /--rstk-video-form-gate-video-bg:rgba\(255, 255, 255, 0\.2\)/)
    assert.match(html, /--rstk-form-content-align:center/)
    assert.match(html, /--rstk-submit-justify:start/)
    assert.match(html, /rstk-video-gate-active\{aspect-ratio:auto;min-height:/)
    assert.match(html, /--rstk-video-form-panel-bg:#ffffff/)
    assert.match(html, /--rstk-form-field-bg:#ffffff/)
    assert.match(html, /--rstk-form-field-text:#111827/)
    assert.match(html, /--rstk-form-field-border:#d1d5db/)
    assert.match(html, /--rstk-form-placeholder:#6b7280/)
    assert.match(html, /--rstk-form-field-radius:14px/)
    assert.match(html, /--rstk-submit-bg:#111827/)
    assert.match(html, /--rstk-submit-text:#ffffff/)
    assert.match(html, /--rstk-submit-border:#111827/)
    assert.match(html, /--rstk-submit-radius:12px/)
    assert.match(html, /--rstk-submit-height:52px/)
    assert.match(html, /--rstk-submit-pad-x:28px/)
    assert.match(html, /--rstk-submit-pad-y:10px/)
    assert.match(html, /--rstk-submit-size:16px/)
    assert.doesNotMatch(html, /--rstk-submit-bg:#ef4444/)
    assert.match(html, /\.rstk-video-form-actions button\{[^}]*background:var\(--rstk-submit-bg,var\(--rstk-accent\)\)/)
    assert.match(html, /data-completion-action="show_targets"/)
    assert.match(html, /data-repeat-mode="remember_visitor"/)
    assert.match(html, /data-storage-ttl-seconds="3888000"/)
    assert.match(html, /data-meta-event-name="CompleteRegistration"/)
    assert.match(html, /&quot;predicted_ltv&quot;:1500/)
    assert.match(html, /&quot;video_gate&quot;:&quot;completed&quot;/)
    assert.match(html, new RegExp(`data-rstk-video-action-target="${targetBlock.id}"`))
    assert.match(html, /data-rstk-video-action-hidden="true"/)

    const legacyHtml = await renderPublicSiteHtml({
      ...landingSite,
      blocks: (landingSite.blocks || []).map(block => block.id === videoBlock.id
        ? {
            ...block,
            settings: {
              ...block.settings,
              videoFormGateCompletionAction: 'disqualify_message'
            }
          }
        : block)
    }, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })
    assert.match(legacyHtml, /data-completion-action="continue_video"/)
    assert.doesNotMatch(legacyHtml, /data-completion-action="disqualify_message"/)

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
    assert.equal(result.capi.sent, false)
    assert.equal(result.capi.reason, 'video_form_disqualified')
    assert.equal(result.capi.eventName, 'CompleteRegistration')
    assert.equal(metaCalls.length, 0)

    const submission = await db.get('SELECT site_id, form_site_id, meta_json FROM public_site_submissions WHERE id = ?', [result.submissionId])
    assert.equal(submission.site_id, landingSite.id)
    assert.equal(submission.form_site_id, formSite.id)
    const meta = JSON.parse(submission.meta_json)
    assert.equal(meta.videoFormGate, true)
    assert.equal(meta.videoFormGateBlockId, videoBlock.id)
    assert.equal(meta.formSiteId, formSite.id)

    const qualifiedResult = await createSubmissionFromRequest(
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
          [emailBlock.id]: forcedEmail,
          [companyBlock.id]: 'Ristak Labs',
          [qualificationBlock.id]: 'Califica'
        },
        meta: {
          videoFormGate: true,
          videoFormGateBlockId: videoBlock.id,
          videoFormGateCompletionAction: 'disqualify_message',
          videoFormGateForceDisqualified: true
        }
      }
    )

    assert.equal(qualifiedResult.status, 'received')
    assert.notEqual(qualifiedResult.message, 'No calificas para este video.')
    assert.equal(qualifiedResult.capi.sent, true)
    assert.equal(qualifiedResult.capi.eventName, 'CompleteRegistration')
    assert.equal(metaCalls.length, 1)
    const metaPayload = JSON.parse(metaCalls[0].body)
    assert.equal(metaPayload.data[0].event_name, 'CompleteRegistration')
    assert.equal(metaPayload.data[0].custom_data.conversion_type, 'video_form_gate_submit')
    assert.equal(metaPayload.data[0].custom_data.video_block_id, videoBlock.id)
    assert.equal(metaPayload.data[0].custom_data.predicted_ltv, 1500)
    assert.equal(metaPayload.data[0].custom_data.video_gate, 'completed')
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    if (previousMetaEnv.pixelId === undefined) delete process.env.META_PIXEL_ID
    else process.env.META_PIXEL_ID = previousMetaEnv.pixelId
    if (previousMetaEnv.datasetId === undefined) delete process.env.META_DATASET_ID
    else process.env.META_DATASET_ID = previousMetaEnv.datasetId
    if (previousMetaEnv.accessToken === undefined) delete process.env.META_ACCESS_TOKEN
    else process.env.META_ACCESS_TOKEN = previousMetaEnv.accessToken
    await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE email = ?', [forcedEmail]).catch(() => undefined)
    if (landingSite?.id) await deleteSite(landingSite.id).catch(() => undefined)
    if (formSite?.id) await deleteSite(formSite.id).catch(() => undefined)
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain)
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified)
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt)
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error)
  }
})
