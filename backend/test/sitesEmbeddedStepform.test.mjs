import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import vm from 'node:vm'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import {
  createBlock,
  createPublicSiteFormProgressFromRequest,
  createSite,
  createSubmissionFromRequest,
  deleteSite,
  getSitesTrackingSummary,
  getSitePreview,
  renderPublicSiteHtml,
  updateBlock
} from '../src/services/sitesService.js'
import {
  businessTodayDateOnly,
  getAccountTimezone
} from '../src/utils/dateUtils.js'
import { parseContactCustomFields } from '../src/utils/contactCustomFields.js'

function findFormEmbedBlock(site) {
  return site.blocks.find(block => block.blockType === 'form_embed')
}

function extractMainFormFlow(html) {
  const marker = 'const MAIN_FORM_FLOW = '
  const start = html.indexOf(marker)
  assert.notEqual(start, -1, 'El HTML público debe declarar MAIN_FORM_FLOW.')
  const valueStart = start + marker.length
  const valueEnd = html.indexOf(';\n', valueStart)
  assert.notEqual(valueEnd, -1, 'MAIN_FORM_FLOW debe terminar como una asignación JSON.')
  return JSON.parse(html.slice(valueStart, valueEnd))
}

const DOMAIN_KEYS = {
  domain: 'sites_public_domain',
  verified: 'sites_public_domain_verified',
  checkedAt: 'sites_public_domain_checked_at',
  error: 'sites_public_domain_error'
}

test('linked forms keep their disqualification rules when submitted from a landing', async () => {
  const suffix = crypto.randomUUID()
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  let sourceForm
  let landing

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    sourceForm = await createSite({
      name: 'Formulario fuente con descalificacion',
      slug: `source-form-disqualify-${suffix}`,
      siteType: 'standard_form',
      status: 'published',
      blankCanvas: true
    })
    let sourceWithBlocks = await createBlock(sourceForm.id, {
      blockType: 'email',
      label: 'Correo',
      required: true,
      settings: { systemFieldKey: 'email', internalName: 'email' }
    })
    sourceWithBlocks = await createBlock(sourceForm.id, {
      blockType: 'radio',
      label: '¿Calificas?',
      required: true,
      options: [
        { id: 'yes', label: 'Sí', value: 'Sí', action: 'continue' },
        {
          id: 'no',
          label: 'No',
          value: 'No',
          action: 'disqualify_after_submit',
          message: 'No calificas para continuar.'
        }
      ]
    })

    const emailBlock = sourceWithBlocks.blocks.find(block => block.blockType === 'email')
    const qualificationBlock = sourceWithBlocks.blocks.find(block => block.blockType === 'radio')
    assert.ok(emailBlock)
    assert.ok(qualificationBlock)

    landing = await createSite({
      name: 'Landing con formulario fuente',
      slug: `landing-form-disqualify-${suffix}`,
      siteType: 'landing_page',
      status: 'published',
      blankCanvas: true,
      theme: {
        pageMode: 'funnel',
        pages: [
          { id: 'page-1', title: 'Formulario', sortOrder: 0 },
          { id: 'page-2', title: 'Siguiente paso', sortOrder: 1 }
        ]
      }
    })
    landing = await createBlock(landing.id, {
      blockType: 'form_embed',
      label: 'Formulario embebido',
      settings: {
        pageId: 'page-1'
      }
    })
    const formEmbed = findFormEmbedBlock(landing)
    assert.ok(formEmbed)
    assert.equal(formEmbed.settings.completionAction, 'next_page')
    assert.equal(formEmbed.settings.completionActionOrigin, 'auto_funnel')

    landing = await updateBlock(landing.id, formEmbed.id, {
      settings: {
        ...formEmbed.settings,
        formSiteId: sourceForm.id,
        embeddedTheme: undefined
      }
    })

    const linkedEmbed = findFormEmbedBlock(landing)
    assert.equal(linkedEmbed.settings.completionAction, 'form_default')
    assert.equal(linkedEmbed.settings.completionActionOrigin, 'form_source')

    const rendered = await renderPublicSiteHtml(landing, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })
    assert.match(rendered, /const completionAction = "next_page_if_qualified";/)
    assert.match(rendered, /const completionUsesFormRules = true;/)
    assert.match(rendered, /formFinalMarkerVersion: 2,/)
    assert.match(rendered, /formFinalSubmit: Boolean\(finalSubmit\),/)
    assert.match(rendered, /const finalSubmit = !ruleSubmit && !pendingRuntimeStep && !isStandardFormIntermediatePage/)
    assert.match(rendered, /finalSubmit,\s*flowContext: submissionFlow/)
    assert.doesNotMatch(rendered, /formFinalSubmit: isStandardForm &&/)

    // Compatibilidad: los embeds viejos no registraban si next_page era el
    // default automático. Si el fuente sí descalifica, se reparan al hidratar.
    landing = await updateBlock(landing.id, linkedEmbed.id, {
      settings: {
        ...linkedEmbed.settings,
        completionAction: 'next_page',
        completionActionOrigin: undefined
      }
    })
    assert.equal(findFormEmbedBlock(landing).settings.completionAction, 'next_page')
    const repairedLegacyEmbed = findFormEmbedBlock(await getSitePreview(landing.id))
    assert.equal(
      repairedLegacyEmbed.settings.completionAction,
      'form_default',
      JSON.stringify({
        origin: repairedLegacyEmbed.settings.completionActionOrigin,
        optionActions: repairedLegacyEmbed.settings.embeddedBlocks
          ?.flatMap(block => block.options || [])
          .map(option => option.action)
      })
    )
    const repairedLegacyRender = await renderPublicSiteHtml(await getSitePreview(landing.id), {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })
    assert.match(repairedLegacyRender, /const completionAction = "next_page_if_qualified";/)
    assert.match(repairedLegacyRender, /const completionUsesFormRules = true;/)

    // Una acción re-elegida explícitamente por el usuario sí conserva el
    // override del sitio, incluso si el formulario fuente tiene reglas.
    landing = await updateBlock(landing.id, linkedEmbed.id, {
      settings: {
        ...findFormEmbedBlock(landing).settings,
        completionAction: 'next_page',
        completionActionOrigin: 'user'
      }
    })
    assert.equal(findFormEmbedBlock(landing).settings.completionAction, 'next_page')

    landing = await updateBlock(landing.id, linkedEmbed.id, {
      settings: {
        ...findFormEmbedBlock(landing).settings,
        completionAction: 'form_default',
        completionActionOrigin: 'form_source'
      }
    })

    const result = await createSubmissionFromRequest({
      headers: { host: 'example.test', 'user-agent': 'node-test' },
      hostname: 'example.test',
      path: `/${landing.slug}`,
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }
    }, {
      siteId: landing.id,
      pageId: 'page-1',
      finalSubmit: true,
      responses: {
        [emailBlock.id]: `embedded-disqualified-${suffix}@example.test`,
        [qualificationBlock.id]: 'No'
      }
    })

    assert.equal(result.status, 'disqualified')
    assert.equal(result.message, 'No calificas para continuar.')
    assert.equal(result.rules.actions[0]?.action, 'disqualify_after_submit')

    const checkpoint = await createSubmissionFromRequest({
      headers: { host: 'example.test', 'user-agent': 'node-test' },
      hostname: 'example.test',
      path: `/${landing.slug}`,
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }
    }, {
      siteId: landing.id,
      pageId: 'page-1',
      responses: {
        [emailBlock.id]: `embedded-checkpoint-${suffix}@example.test`,
        [qualificationBlock.id]: 'Sí'
      },
      meta: {
        formFinalMarkerVersion: 2,
        formFinalSubmit: false,
        visitorId: `embedded-checkpoint-visitor-${suffix}`,
        sessionId: `embedded-checkpoint-session-${suffix}`
      }
    })
    const conversionRow = await db.get(
      "SELECT id FROM sessions WHERE submission_id = ? AND event_name = 'native_site_conversion' LIMIT 1",
      [checkpoint.submissionId]
    )
    assert.equal(conversionRow, null)
    assert.equal(checkpoint.mappedFields.custom.calificas, 'Sí')
    const checkpointContact = await db.get(
      'SELECT custom_fields FROM contacts WHERE id = ?',
      [checkpoint.contactId]
    )
    const qualificationField = parseContactCustomFields(checkpointContact.custom_fields)
      .find(field => field.fieldKey === 'calificas')
    assert.equal(qualificationField?.dataType, 'radio')
    assert.equal(qualificationField?.value, 'Sí')
  } finally {
    if (landing?.id) await deleteSite(landing.id).catch(() => undefined)
    if (sourceForm?.id) await deleteSite(sourceForm.id).catch(() => undefined)
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain)
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified)
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt)
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error)
  }
})

test('terminal form rules do not count as completed journeys while a real final submit does', async () => {
  const suffix = crypto.randomUUID()
  const previousConfig = {
    domain: await getAppConfig(DOMAIN_KEYS.domain),
    verified: await getAppConfig(DOMAIN_KEYS.verified),
    checkedAt: await getAppConfig(DOMAIN_KEYS.checkedAt),
    error: await getAppConfig(DOMAIN_KEYS.error)
  }
  const contactIds = []
  const submissionIdsByCase = new Map()
  let site

  try {
    await setAppConfig(DOMAIN_KEYS.domain, 'example.test')
    await setAppConfig(DOMAIN_KEYS.verified, '1')
    await setAppConfig(DOMAIN_KEYS.checkedAt, new Date().toISOString())
    await setAppConfig(DOMAIN_KEYS.error, '')

    site = await createSite({
      name: 'Formulario con cierres terminales',
      slug: `form-terminal-journeys-${suffix}`,
      siteType: 'interactive_form',
      status: 'published',
      blankCanvas: true,
      theme: {
        pages: [{ id: `question-${suffix}`, title: 'Correo', sortOrder: 0 }]
      }
    })
    site = await createBlock(site.id, {
      blockType: 'email',
      label: 'Correo',
      required: true,
      settings: {
        pageId: `question-${suffix}`,
        systemFieldKey: 'email',
        internalName: 'email',
        validation: 'email'
      }
    })

    const emailBlock = site.blocks.find(block => block.blockType === 'email')
    assert.ok(emailBlock)
    const html = await renderPublicSiteHtml({ ...site, domain: 'example.test' }, {
      pageId: `question-${suffix}`,
      trackingEnabled: true,
      preview: false
    })
    const flow = extractMainFormFlow(html)
    assert.match(flow.formContextToken, /^pct1\./)
    const stage = flow.stages[0]
    assert.ok(stage)

    const request = {
      headers: { host: 'example.test', 'user-agent': 'node-test' },
      hostname: 'example.test',
      path: `/${site.slug}`,
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }
    }
    const unresolvedHostRequest = {
      ...request,
      headers: { ...request.headers, host: 'unconfigured.invalid' },
      hostname: 'unconfigured.invalid'
    }
    await assert.rejects(
      createPublicSiteFormProgressFromRequest(unresolvedHostRequest, {
        attemptId: `attempt-oversized-batch-${suffix}`,
        formContextToken: flow.formContextToken,
        events: Array.from({ length: 51 }, (_, index) => ({
          eventId: `event-oversized-${suffix}-${index}`,
          eventSequence: index + 1,
          eventName: index === 0 ? 'attempt_start' : 'step_view'
        }))
      }),
      error => (
        error?.status === 400 &&
        error?.code === 'site_flow_envelope_invalid' &&
        error?.message.includes('entre 1 y 50')
      )
    )
    await assert.rejects(
      createPublicSiteFormProgressFromRequest(unresolvedHostRequest, {
        attemptId: `attempt-long-token-${suffix}`,
        formContextToken: 'x'.repeat(4097),
        events: [{
          eventId: `event-long-token-${suffix}`,
          eventSequence: 1,
          eventName: 'attempt_start'
        }]
      }),
      error => (
        error?.status === 400 &&
        error?.code === 'site_flow_envelope_invalid' &&
        error?.message.includes('4096')
      )
    )
    const unsigned = await createPublicSiteFormProgressFromRequest(request, {
      siteId: site.id,
      formSiteId: site.id,
      publicPageId: stage.stageId,
      flowRevision: flow.flowRevision,
      attemptId: `attempt-unsigned-${suffix}`,
      visitorId: `visitor-unsigned-${suffix}`,
      sessionId: `session-unsigned-${suffix}`,
      events: [{
        eventId: `event-unsigned-${suffix}`,
        eventSequence: 1,
        eventName: 'attempt_start',
        clientEventAt: new Date().toISOString()
      }]
    })
    assert.deepEqual(unsigned, {
      accepted: false,
      skipped: true,
      reason: 'unsigned_form_context'
    })

    await assert.rejects(
      createPublicSiteFormProgressFromRequest(request, {
        siteId: `other-site-${suffix}`,
        formSiteId: site.id,
        publicPageId: stage.stageId,
        flowRevision: flow.flowRevision,
        formContextToken: flow.formContextToken,
        attemptId: `attempt-context-mismatch-${suffix}`,
        visitorId: `visitor-context-mismatch-${suffix}`,
        sessionId: `session-context-mismatch-${suffix}`,
        events: [{
          eventId: `event-context-mismatch-${suffix}`,
          eventSequence: 1,
          eventName: 'attempt_start',
          clientEventAt: new Date().toISOString()
        }]
      }),
      error => error?.status === 409 && error?.code === 'site_flow_context_mismatch'
    )
    await assert.rejects(
      createPublicSiteFormProgressFromRequest(request, {
        siteId: site.id,
        formSiteId: site.id,
        publicPageId: stage.stageId,
        flowRevision: flow.flowRevision,
        formContextToken: `${flow.formContextToken.slice(0, -1)}x`,
        attemptId: `attempt-tampered-${suffix}`,
        visitorId: `visitor-tampered-${suffix}`,
        sessionId: `session-tampered-${suffix}`,
        events: [{
          eventId: `event-tampered-${suffix}`,
          eventSequence: 1,
          eventName: 'attempt_start',
          clientEventAt: new Date().toISOString()
        }]
      }),
      error => error?.status === 400 && error?.code === 'invalid_public_context_token'
    )

    const cases = [
      { key: 'end-form', ruleAction: 'end_form', finalSubmit: false, trackProgress: true },
      { key: 'show-message', ruleAction: 'show_message', finalSubmit: false, trackProgress: true },
      { key: 'final', ruleAction: '', finalSubmit: true, trackProgress: true },
      { key: 'final-without-start', ruleAction: '', finalSubmit: true, trackProgress: false }
    ]

    for (const item of cases) {
      const attemptId = `attempt-${item.key}-${suffix}`
      const visitorId = `visitor-${item.key}-${suffix}`
      const sessionId = `session-${item.key}-${suffix}`
      if (item.trackProgress) {
        await createPublicSiteFormProgressFromRequest(request, {
          siteId: site.id,
          formSiteId: site.id,
          publicPageId: stage.stageId,
          flowRevision: flow.flowRevision,
          formContextToken: flow.formContextToken,
          attemptId,
          visitorId,
          sessionId,
          contactId: `spoofed-public-contact-${suffix}`,
          events: [
            {
              eventId: `event-${item.key}-start-${suffix}`,
              eventSequence: 1,
              eventName: 'attempt_start',
              stepId: stage.stageId,
              stepIndex: 1,
              stepTotal: 1,
              stepKind: stage.kind,
              clientEventAt: new Date().toISOString()
            },
            {
              eventId: `event-${item.key}-view-${suffix}`,
              eventSequence: 2,
              eventName: 'step_view',
              stepId: stage.stageId,
              stepIndex: 1,
              stepTotal: 1,
              stepKind: stage.kind,
              clientEventAt: new Date().toISOString()
            }
          ]
        })
        const publicProgressRows = await db.all(`
          SELECT contact_id
          FROM site_flow_events
          WHERE attempt_id = ?
        `, [attemptId])
        assert.ok(publicProgressRows.length > 0)
        assert.ok(publicProgressRows.every(row => row.contact_id === null))
      }

      const submission = await createSubmissionFromRequest(request, {
        siteId: site.id,
        pageId: stage.stageId,
        responses: {
          [emailBlock.id]: `${item.key}-${suffix}@example.test`
        },
        meta: {
          formFinalMarkerVersion: 2,
          formFinalSubmit: item.finalSubmit,
          ruleSubmit: !item.finalSubmit,
          ruleAction: item.ruleAction,
          flowAttemptId: attemptId,
          flowRevision: flow.flowRevision,
          flowEventSequence: 2,
          flowFormSiteId: site.id,
          flowStepId: stage.stageId,
          visitorId,
          sessionId
        }
      })
      submissionIdsByCase.set(item.key, submission.submissionId)
      if (submission.contactId) contactIds.push(submission.contactId)
    }

    const terminalRows = await db.all(`
      SELECT attempt_id, event_name, outcome
      FROM site_flow_events
      WHERE attempt_id IN (?, ?, ?, ?)
        AND event_name IN ('attempt_completed', 'attempt_terminal')
      ORDER BY attempt_id ASC
    `, cases.map(item => `attempt-${item.key}-${suffix}`))
    assert.deepEqual(
      terminalRows.map(row => ({
        attemptId: row.attempt_id,
        eventName: row.event_name,
        outcome: row.outcome
      })),
      [
        {
          attemptId: `attempt-end-form-${suffix}`,
          eventName: 'attempt_terminal',
          outcome: 'terminal_exit'
        },
        {
          attemptId: `attempt-final-${suffix}`,
          eventName: 'attempt_completed',
          outcome: 'completed'
        },
        {
          attemptId: `attempt-final-without-start-${suffix}`,
          eventName: 'attempt_completed',
          outcome: 'completed'
        },
        {
          attemptId: `attempt-show-message-${suffix}`,
          eventName: 'attempt_terminal',
          outcome: 'terminal_exit'
        }
      ]
    )
    const savedSubmissionRow = await db.get(`
      SELECT COUNT(*) AS total
      FROM public_site_submissions
      WHERE site_id = ?
    `, [site.id])
    assert.equal(Number(savedSubmissionRow?.total || 0), 4)

    const interruptedSubmissionId = submissionIdsByCase.get('final')
    assert.ok(interruptedSubmissionId)
    await db.run(`
      DELETE FROM site_flow_events
      WHERE submission_id = ?
        AND event_name = 'attempt_completed'
    `, [interruptedSubmissionId])
    const interruptedTerminal = await db.get(`
      SELECT id
      FROM site_flow_events
      WHERE submission_id = ?
        AND event_name IN ('attempt_completed', 'attempt_terminal')
      LIMIT 1
    `, [interruptedSubmissionId])
    assert.equal(interruptedTerminal, null)

    const timezone = await getAccountTimezone({ forceRefresh: true })
    const businessDate = businessTodayDateOnly(timezone)
    const summary = await getSitesTrackingSummary({
      siteIds: [site.id],
      formJourneySiteId: site.id,
      dateFrom: businessDate,
      dateTo: businessDate
    })
    const journey = summary.formJourneys[site.id]
    assert.equal(journey.entrants, 3)
    assert.equal(journey.completedAttempts, 1)
    assert.equal(journey.completedVisitors, 1)
    assert.equal(journey.conversionRate, 33.3)
    assert.equal(journey.stages[0].terminalAttempts, 3)
    assert.equal(journey.coverage.status, 'partial')
    assert.equal(journey.coverage.terminalAttemptsWithoutStart, 1)
    assert.equal(journey.coverage.reconciledFinalSubmissions, 1)
    assert.equal(journey.coverage.finalSubmissionsWithoutTerminal, 0)
    assert.equal(journey.coverage.terminalReconciliationUnavailable, false)
    const repairedTerminal = await db.get(`
      SELECT attempt_id, event_name, outcome
      FROM site_flow_events
      WHERE submission_id = ?
      LIMIT 1
    `, [interruptedSubmissionId])
    assert.deepEqual(
      {
        attemptId: repairedTerminal?.attempt_id,
        eventName: repairedTerminal?.event_name,
        outcome: repairedTerminal?.outcome
      },
      {
        attemptId: `attempt-final-${suffix}`,
        eventName: 'attempt_completed',
        outcome: 'completed'
      }
    )
    assert.ok(
      journey.coverage.warnings.some(warning => (
        warning.includes('sin inicio') &&
        warning.includes('no se incluyeron')
      ))
    )

    const irreconcilableSubmissionId = `submission-irreconcilable-${suffix}`
    await db.run(`
      INSERT INTO public_site_submissions (
        id,
        site_id,
        form_site_id,
        contact_id,
        domain,
        response_json,
        meta_json,
        status,
        created_at
      ) VALUES (?, ?, ?, NULL, ?, '{}', ?, 'received', CURRENT_TIMESTAMP)
    `, [
      irreconcilableSubmissionId,
      site.id,
      site.id,
      'example.test',
      JSON.stringify({
        formFinalMarkerVersion: 2,
        formFinalSubmit: true,
        flowAttemptId: `attempt-irreconcilable-${suffix}`,
        flowRevision: flow.flowRevision,
        flowFormSiteId: site.id,
        flowStepId: `missing-step-${suffix}`,
        visitorId: `visitor-irreconcilable-${suffix}`,
        sessionId: `session-irreconcilable-${suffix}`
      })
    ])
    const summaryWithBrokenEvidence = await getSitesTrackingSummary({
      siteIds: [site.id],
      formJourneySiteId: site.id,
      dateFrom: businessDate,
      dateTo: businessDate
    })
    const journeyWithBrokenEvidence = summaryWithBrokenEvidence.formJourneys[site.id]
    assert.equal(journeyWithBrokenEvidence.coverage.status, 'partial')
    assert.equal(journeyWithBrokenEvidence.coverage.finalSubmissionsWithoutTerminal, 1)
    assert.ok(
      journeyWithBrokenEvidence.coverage.warnings.some(warning => (
        warning.includes('1 envío(s) final(es)') &&
        warning.includes('no pudieron reconciliarse')
      ))
    )
  } finally {
    if (site?.id) await deleteSite(site.id).catch(() => undefined)
    for (const contactId of contactIds) {
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    }
    await setAppConfig(DOMAIN_KEYS.domain, previousConfig.domain)
    await setAppConfig(DOMAIN_KEYS.verified, previousConfig.verified)
    await setAppConfig(DOMAIN_KEYS.checkedAt, previousConfig.checkedAt)
    await setAppConfig(DOMAIN_KEYS.error, previousConfig.error)
  }
})

test('landing form embeds render multiple form pages as an inline stepform', async () => {
  const site = {
    id: 'site_embedded_stepform',
    name: 'Landing con formulario',
    title: 'Landing con formulario',
    description: '',
    slug: 'landing-formulario',
    siteType: 'landing_page',
    status: 'published',
    theme: {
      template: 'ristak',
      pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
    },
    blocks: [
      {
        id: 'embed-form',
        siteId: 'site_embedded_stepform',
        blockType: 'form_embed',
        label: 'Formulario',
        content: 'Formulario',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 0,
        settings: {
          pageId: 'page-1',
          embeddedPages: [
            { id: 'step-1', title: 'Paso 1', sortOrder: 0, buttonText: 'Siguiente pregunta' },
            { id: 'step-2', title: 'Paso 2', sortOrder: 1, buttonText: 'Enviar solicitud', buttonSubtitle: 'Finalizar' }
          ],
          embeddedTheme: {
            pagePadding: 64,
            pageMaxWidth: 720,
            formContentAlign: 'right',
            brandName: 'adryckk',
            brandSubtitle: 'Productor musical',
            followers: '46,3 mil'
          },
          embeddedBlocks: [
            {
              id: 'social-profile',
              siteId: 'site_embedded_stepform',
              blockType: 'social_profile',
              label: 'Perfil de red social',
              content: '',
              placeholder: '',
              required: false,
              options: [],
              sortOrder: 0,
              settings: { pageId: 'step-1', platform: 'instagram' }
            },
            {
              id: 'content-title',
              siteId: 'site_embedded_stepform',
              blockType: 'title',
              label: 'Título',
              content: 'Título interno del formulario',
              placeholder: '',
              required: false,
              options: [],
              sortOrder: 1,
              settings: { pageId: 'step-1' }
            },
            {
              id: 'field-name',
              siteId: 'site_embedded_stepform',
              blockType: 'short_text',
              label: 'Nombre',
              content: '',
              placeholder: 'Tu nombre',
              required: true,
              options: [],
              sortOrder: 2,
              settings: { pageId: 'step-1' }
            },
            {
              id: 'full-width-copy',
              siteId: 'site_embedded_stepform',
              blockType: 'text',
              label: 'Texto amplio',
              content: 'Bloque amplio dentro del formulario',
              placeholder: '',
              required: false,
              options: [],
              sortOrder: 3,
              settings: { pageId: 'step-1', blockFullWidth: true }
            },
            {
              id: 'field-email',
              siteId: 'site_embedded_stepform',
              blockType: 'email',
              label: 'Correo',
              content: '',
              placeholder: 'tu@email.com',
              required: true,
              options: [],
              sortOrder: 4,
              settings: { pageId: 'step-2' }
            },
            {
              id: 'final-page-copy',
              siteId: 'site_embedded_stepform',
              blockType: 'text',
              label: 'Texto',
              content: 'Texto de página final que no debe aparecer',
              placeholder: '',
              required: false,
              options: [],
              sortOrder: 5,
              settings: { pageId: 'page-2' }
            }
          ]
        },
        createdAt: '',
        updatedAt: ''
      }
    ]
  }

  const html = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /data-embedded-form-pages/)
  assert.match(html, /--rstk-frame-pad:64px/)
  assert.match(html, /--rstk-max:720px/)
  assert.match(html, /--rstk-page-border-width:0px/)
  assert.match(html, /--rstk-form-page-margin-left:auto/)
  assert.match(html, /--rstk-form-page-margin-right:0/)
  assert.match(html, /\.rstk-embedded-form-source-frame\{[^}]*margin:0;padding:0/)
  assert.match(html, /\.rstk-embedded-form-source-frame\{[^}]*width:100%;max-width:100%;min-width:0/)
  assert.match(html, /\.rstk-embedded-form-source-frame>.rstk-page\{[^}]*max-width:min\(100%,var\(--rstk-max\)\);min-width:0;[^}]*margin-left:var\(--rstk-form-page-margin-left,auto\);margin-right:var\(--rstk-form-page-margin-right,auto\)/)
  assert.match(html, /\.rstkSocialProfileBlock\.rstk-block-style\{width:fit-content;min-width:0;max-width:100%\}/)
  // El bloque de red social comparte el carril de los campos y respeta la
  // alineación configurada del formulario; el frame embebido elimina el nudge.
  assert.match(html, /\.rstk-kind-form \.rstk-field,[^{}]+\.rstk-kind-form \.rstkSocialProfileBlock\.rstk-block-style,[^{}]+\.rstk-embedded-form \.rstkSocialProfileBlock\.rstk-block-style\{[^}]*width:min\(100%,var\(--rstk-form-field-width,560px\)\);justify-self:var\(--rstk-form-field-justify,center\)/)
  assert.match(html, /\.rstk-social-profile-block\{width:fit-content;min-width:0;max-width:100%;/)
  assert.match(html, /\.rstk-social-profile-block \.rstk-social-details\{flex:1 1 auto;min-width:0;max-width:100%\}/)
  assert.match(html, /\.rstk-social-profile-block \.rstk-social-name,\.rstk-social-profile-block \.rstk-social-followers\{overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/)
  assert.match(html, /\.rstk-embedded-form-source-frame \.rstk-block-style\.rstkBlockFullWidth\{width:100%;max-width:100%;margin-left:0;margin-right:0/)
  assert.match(html, /\.rstk-embedded-form-source-frame \.rstk-shell\{display:grid;grid-template-columns:minmax\(0,1fr\);width:100%;max-width:100%;min-width:0;[^}]*border-radius:var\(--rstk-page-radius,var\(--rstk-radius-lg\)\);[^}]*padding:0;[^}]*overflow:hidden/)
  assert.match(html, /\.rstk-embedded-form-source-frame \.rstk-shell:has\(\.rstkBlockFullWidth\)\{overflow:visible\}/)
  assert.match(html, /\.rstk-kind-landing \.rstk-embedded-form-source-frame \.rstk-embedded-form,\.rstk-embedded-form-source-frame \.rstk-embedded-form\{width:100%;max-width:100%;min-width:0;justify-self:stretch/)
  assert.match(html, /\.rstk-embedded-form-source-frame \.rstk-embedded-pages,\.rstk-embedded-form-source-frame \.rstk-embedded-pages \[data-embedded-page-content\]\{width:100%;max-width:100%;min-width:0;justify-self:stretch\}/)
  assert.match(html, /\.rstk-embedded-form-source-frame \.rstk-block-style\{max-width:100%;min-width:0\}/)
  assert.match(html, /\.rstk-embedded-form-source-frame \.rstkSocialProfileBlock\.rstk-block-style\{width:min\(100%,var\(--rstk-form-field-width,560px\)\);justify-self:var\(--rstk-form-field-justify,center\);transform:none\}/)
  assert.match(html, /\.rstk-embedded-form-source-frame \.rstk-social-profile-block\{padding:0\}/)
  assert.match(html, /\.rstk-embedded-form-source-frame \.rstk-headline\{[^}]*max-width:100%;min-width:0;overflow-wrap:break-word/)
  assert.match(html, /\.rstk-embedded-form-source-frame \.rstk-subheading\{[^}]*max-width:min\(100%,var\(--rstk-content-max,60ch\)\);min-width:0;[^}]*overflow-wrap:break-word/)
  assert.match(html, /\.rstk-embedded-form-source-frame \.rstk-media,\.rstk-embedded-form-source-frame \.rstk-video\{max-width:100%;min-width:0\}/)
  assert.match(html, /data-embedded-page-content="step-1"/)
  assert.match(html, /data-embedded-page-content="step-2" hidden/)
  assert.match(html, /data-embedded-next/)
  assert.match(html, /<button type="button" data-embedded-next>Siguiente pregunta<\/button>/)
  assert.match(html, /data-embedded-page-content="step-2" hidden data-next-label="Enviar solicitud" data-submit-label="Enviar solicitud" data-submit-subtitle="Finalizar"/)
  assert.match(html, /<button type="submit" data-submit hidden><span class="rstk-button-label">Enviar solicitud<\/span><span class="rstk-button-subtitle">Finalizar<\/span><\/button>/)
  assert.match(html, /data-embedded-back hidden/)
  assert.match(html, /data-submit hidden/)
  assert.match(html, /rstk-social-profile-instagram/)
  assert.match(html, /adryckk/)
  assert.match(html, /46,3 mil seguidores/)
  assert.match(html, /Título interno del formulario/)
  assert.match(html, /Bloque amplio dentro del formulario/)
  assert.match(html, /rstkBlockFullWidth/)
  assert.match(html, /data-block-id="field-name" data-page-id="step-1"/)
  assert.match(html, /data-block-id="field-email" data-page-id="step-2"/)
  assert.match(html, /class="rstk-block-style rstkBlockFullWidth" data-rstk-block-id="full-width-copy"/)
  assert.match(html, /data-embedded-form-result="qualified" hidden>[\s\S]*Texto de página final que no debe aparecer/)
  assert.doesNotMatch(html, /<h2>Formulario<\/h2>/)
  assert.match(html, /getEmbeddedPageFields/)
  assert.match(html, /embeddedForms\.forEach\(state => renderEmbeddedForm\(state\)\)/)
  assert.match(html, /state\.index = 0;/)
  assert.ok(html.includes("setHiddenAndSyncMedia(content, (content.getAttribute('data-embedded-page-content') || '') !== currentPageId);"))

  const resolverMatch = html.match(
    /const resolvePendingFormStep = ([\s\S]*?);\n\n      const getPendingRuntimeStep/
  )
  assert.ok(resolverMatch, 'el runtime debe exponer un resolver puro para impedir envíos antes del último paso')
  const resolvePendingFormStep = vm.runInNewContext(`(${resolverMatch[1]})`)
  const activeElement = {}
  const embeddedNextButton = { hidden: false, disabled: false }
  const embeddedState = {
    pageIds: ['step-1', 'step-2'],
    index: 0,
    formHost: { contains: candidate => candidate === activeElement },
    nextButton: embeddedNextButton
  }

  const pendingInteractive = resolvePendingFormStep({
    interactive: true,
    interactiveIndex: 0,
    interactivePageCount: 2,
    interactiveNextButton: { hidden: false },
    embeddedStates: []
  })
  assert.equal(pendingInteractive.kind, 'interactive')

  const standardNextButton = { hidden: false, disabled: false }
  const pendingStandard = resolvePendingFormStep({
    standardFormIntermediate: true,
    standardFormNextButton: standardNextButton,
    interactive: false,
    embeddedStates: []
  })
  assert.equal(pendingStandard.kind, 'standard')
  assert.equal(pendingStandard.nextButton, standardNextButton)

  const pendingEmbedded = resolvePendingFormStep({
    interactive: false,
    interactiveIndex: 0,
    interactivePageCount: 0,
    embeddedStates: [embeddedState],
    activeElement
  })
  assert.equal(pendingEmbedded.kind, 'embedded')
  assert.equal(pendingEmbedded.nextButton, embeddedNextButton)

  embeddedState.index = 1
  assert.equal(resolvePendingFormStep({
    interactive: false,
    interactiveIndex: 0,
    interactivePageCount: 0,
    embeddedStates: [embeddedState],
    activeElement
  }), null)

  const pendingActiveElement = {}
  const finalSubmitter = {}
  const pendingOtherState = {
    pageIds: ['other-1', 'other-2'],
    index: 0,
    formHost: { contains: candidate => candidate === pendingActiveElement },
    nextButton: { hidden: false, disabled: false }
  }
  const finalSubmitterState = {
    pageIds: ['final-1', 'final-2'],
    index: 1,
    formHost: { contains: candidate => candidate === finalSubmitter },
    nextButton: { hidden: true, disabled: false }
  }
  assert.equal(resolvePendingFormStep({
    interactive: false,
    interactiveIndex: 0,
    interactivePageCount: 0,
    embeddedStates: [pendingOtherState, finalSubmitterState],
    activeElement: pendingActiveElement,
    submitter: finalSubmitter
  }), null, 'el submitter de un embed final manda sobre el foco stale de otro embed')

  assert.match(html, /const pendingRuntimeStep = ruleSubmit \? null : getPendingRuntimeStep\(event\.submitter\);/)
  assert.match(html, /if \(pendingRuntimeStep && !allowPendingStepSubmit\)/)
  assert.match(html, /if \(forwardButton && !forwardButton\.hidden && !forwardButton\.disabled\) forwardButton\.click\(\);/)
})

test('multistep form runtime pauses media when switching questions', async () => {
  const site = {
    id: 'site_interactive_video_steps',
    name: 'Formulario con video por paso',
    title: 'Formulario con video por paso',
    description: '',
    slug: 'formulario-video-pasos',
    siteType: 'interactive_form',
    status: 'published',
    theme: {
      template: 'interactive',
      pages: [
        { id: 'step-video-1', title: 'Video 1', sortOrder: 0 },
        { id: 'step-video-2', title: 'Video 2', sortOrder: 1 }
      ]
    },
    blocks: [
      {
        id: 'video-step-1',
        siteId: 'site_interactive_video_steps',
        blockType: 'video',
        label: 'Video inicial',
        content: '',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 0,
        settings: { pageId: 'step-video-1', mediaUrl: 'https://cdn.example.com/video-1.mp4' }
      },
      {
        id: 'question-step-1',
        siteId: 'site_interactive_video_steps',
        blockType: 'short_text',
        label: 'Pregunta 1',
        content: '',
        placeholder: 'Respuesta',
        required: true,
        options: [],
        sortOrder: 1,
        settings: { pageId: 'step-video-1' }
      },
      {
        id: 'video-step-2',
        siteId: 'site_interactive_video_steps',
        blockType: 'video',
        label: 'Video siguiente',
        content: '',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 2,
        settings: { pageId: 'step-video-2', mediaUrl: 'https://iframe.mediadelivery.net/embed/library/video-id' }
      },
      {
        id: 'email-step-2',
        siteId: 'site_interactive_video_steps',
        blockType: 'email',
        label: 'Correo',
        content: '',
        placeholder: 'correo@example.test',
        required: true,
        options: [],
        sortOrder: 3,
        settings: { pageId: 'step-video-2' }
      }
    ]
  }

  const html = await renderPublicSiteHtml(site, {
    pageId: 'step-video-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /const pauseMediaIn = \(root\) =>/)
  assert.match(html, /media\.pause\(\)/)
  assert.match(html, /frame\.removeAttribute\('src'\)/)
  assert.match(html, /restorePausedMediaIn/)
  assert.ok(html.includes('setHiddenAndSyncMedia(content, contentPageId !== currentPageId);'))
  assert.match(html, /data-interactive-page-content="step-video-1"/)
  assert.match(html, /data-interactive-page-content="step-video-2"/)
})

test('standard form content-only pages still render navigation actions', async () => {
  const site = {
    id: 'site_standard_content_steps',
    name: 'Formulario con paginas de contenido',
    title: 'Formulario con paginas de contenido',
    description: '',
    slug: 'formulario-contenido',
    siteType: 'standard_form',
    status: 'published',
    theme: {
      template: 'compact',
      pages: [
        { id: 'page-1', title: 'Intro', sortOrder: 0, buttonText: 'Ver siguiente parte' },
        { id: 'page-content', title: 'Video', sortOrder: 1, buttonText: 'Enviar mi solicitud' }
      ]
    },
    blocks: [
      {
        id: 'intro-title',
        siteId: 'site_standard_content_steps',
        blockType: 'title',
        label: 'Titulo',
        content: 'Antes de empezar',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 0,
        settings: { pageId: 'page-1' }
      },
      {
        id: 'intro-copy',
        siteId: 'site_standard_content_steps',
        blockType: 'text',
        label: 'Texto',
        content: 'Esta pagina no tiene campos.',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 1,
        settings: { pageId: 'page-1' }
      },
      {
        id: 'content-video',
        siteId: 'site_standard_content_steps',
        blockType: 'video',
        label: 'Video',
        content: '',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 2,
        settings: { pageId: 'page-content', mediaUrl: 'https://example.test/video.mp4' }
      },
      {
        id: 'content-copy',
        siteId: 'site_standard_content_steps',
        blockType: 'text',
        label: 'Texto',
        content: 'Ultima pagina antes de enviar.',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 3,
        settings: { pageId: 'page-content' }
      }
    ]
  }

  const firstPageHtml = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(firstPageHtml, /Antes de empezar/)
  assert.match(firstPageHtml, /<button type="button" data-form-next>Ver siguiente parte<\/button>/)
  assert.match(firstPageHtml, /<button type="submit" hidden data-submit>/)

  const lastContentPageHtml = await renderPublicSiteHtml(site, {
    pageId: 'page-content',
    trackingEnabled: false,
    preview: true
  })

  assert.match(lastContentPageHtml, /Ultima pagina antes de enviar/)
  assert.doesNotMatch(lastContentPageHtml, /<button type="button" data-form-next>/)
  assert.doesNotMatch(lastContentPageHtml, /<button type="submit" hidden data-submit>/)
  assert.match(lastContentPageHtml, /<button type="submit"\s+data-submit><span class="rstk-button-label">Enviar mi solicitud<\/span><\/button>/)
})

test('landing form embeds proxy linked form source instead of stale embedded copies', async () => {
  let formSite

  try {
    formSite = await createSite({
      name: 'Formulario fuente proxy',
      slug: `form-source-proxy-${Date.now()}`,
      siteType: 'standard_form',
      status: 'published',
      blankCanvas: true,
      theme: {
        template: 'facebook',
        brandName: 'Formulario 01',
        brandSubtitle: 'Patrocinado',
        backgroundColor: '#112233',
        pages: [
          { id: 'source-step-1', title: 'Fuente 1', sortOrder: 0, buttonText: 'Siguiente desde fuente' },
          { id: 'source-step-2', title: 'Fuente 2', sortOrder: 1, buttonText: 'Enviar fuente' }
        ]
      }
    })

    await createBlock(formSite.id, {
      blockType: 'title',
      label: 'Título',
      content: 'Deja tus datos y seguimos por mensaje',
      required: false,
      settings: { pageId: 'source-step-1' }
    })
    await createBlock(formSite.id, {
      blockType: 'text',
      label: 'Texto',
      content: 'Completa este formulario corto y te contactamos con el siguiente paso.',
      required: false,
      settings: { pageId: 'source-step-1' }
    })
    await createBlock(formSite.id, {
      blockType: 'short_text',
      label: 'Campo real fuente',
      placeholder: 'Respuesta real',
      required: true,
      settings: { pageId: 'source-step-1' }
    })
    formSite = await createBlock(formSite.id, {
      blockType: 'email',
      label: 'Correo fuente',
      placeholder: 'real@example.test',
      required: true,
      settings: { pageId: 'source-step-2' }
    })

    const landing = {
      id: 'landing_proxy_embed',
      name: 'Landing proxy',
      title: 'Landing proxy',
      description: '',
      slug: 'landing-proxy',
      siteType: 'landing_page',
      status: 'published',
      theme: {
        template: 'ristak',
        pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
      },
      blocks: [
        {
          id: 'embed-form-proxy',
          siteId: 'landing_proxy_embed',
          blockType: 'form_embed',
          label: 'Formulario',
          content: '',
          placeholder: '',
          required: false,
          options: [],
          sortOrder: 0,
          settings: {
            pageId: 'page-1',
            formSiteId: formSite.id,
            embeddedPages: [{ id: 'stale-step', title: 'Viejo', sortOrder: 0, buttonText: 'Boton viejo' }],
            embeddedBlocks: [
              {
                id: 'stale-field',
                siteId: 'landing_proxy_embed',
                blockType: 'short_text',
                label: 'Campo viejo',
                content: '',
                placeholder: 'Viejo',
                required: false,
                options: [],
                sortOrder: 0,
                settings: { pageId: 'stale-step' }
              }
            ]
          },
          createdAt: '',
          updatedAt: ''
        }
      ]
    }

    const html = await renderPublicSiteHtml(landing, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(html, /Campo real fuente/)
    assert.match(html, /Correo fuente/)
    assert.match(html, /<button type="button" data-embedded-next>Siguiente desde fuente<\/button>/)
    assert.match(html, /data-submit-label="Enviar fuente"/)
    assert.match(html, /rstk-embedded-form-source-frame/)
    assert.match(html, /rstk-embedded-form-source-chrome/)
    assert.match(html, /rstk-social-platform-facebook/)
    assert.match(html, /Formulario 01/)
    assert.match(html, /Patrocinado/)
    assert.match(html, /Deja tus datos y seguimos por mensaje/)
    assert.match(html, /Completa este formulario corto/)
    assert.match(html, /rstk-kind-form/)
    assert.match(html, /--rstk-page-bg:#112233;/)
    assert.match(html, /--rstk-block-bg:#112233;/)
    assert.doesNotMatch(html, /Campo viejo/)
    assert.doesNotMatch(html, /Boton viejo/)
    assert.doesNotMatch(html, /data-embedded-page-content="stale-step"/)
  } finally {
    if (formSite?.id) await deleteSite(formSite.id).catch(() => undefined)
  }
})

test('landing form embeds preserve explicit white source backgrounds', async () => {
  let formSite
  try {
    formSite = await createSite({
      name: 'Formulario blanco',
      siteType: 'standard_form',
      theme: {
        template: 'facebook_lead',
        backgroundColor: '#ffffff',
        pageRadius: 24,
        pageMaxWidth: 520,
        pagePadding: 22
      },
      status: 'draft'
    })
    await createBlock(formSite.id, {
      blockType: 'title',
      label: 'Titulo',
      content: 'Formulario blanco',
      settings: { pageId: 'page-1' },
      sortOrder: 0
    })
    await createBlock(formSite.id, {
      blockType: 'email',
      label: 'Correo',
      content: '',
      placeholder: 'correo@example.test',
      required: true,
      settings: { pageId: 'page-1' },
      sortOrder: 1
    })

    const landing = {
      id: 'landing_white_embed',
      name: 'Landing blanco',
      siteType: 'landing_page',
      status: 'draft',
      theme: {
        template: 'ristak'
      },
      blocks: [
      {
        id: 'landing_white_embed_block',
        siteId: 'landing_white_embed',
        blockType: 'form_embed',
        label: 'Formulario blanco',
        content: '',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 0,
        settings: {
          pageId: 'page-1',
          formSiteId: formSite.id
        },
        createdAt: '',
        updatedAt: ''
      }
      ]
    }

    const html = await renderPublicSiteHtml(landing, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(html, /rstk-embedded-form-source-frame/)
    assert.match(html, /--rstk-page-bg:#ffffff;/)
    assert.match(html, /--rstk-block-bg:#ffffff;/)
  } finally {
    if (formSite?.id) await deleteSite(formSite.id).catch(() => undefined)
  }
})

test('landing form embeds inherit source completion rules or target a specific page', async () => {
  const embeddedBlocks = [
    {
      id: 'completion-email',
      siteId: 'landing_completion_embed',
      blockType: 'email',
      label: 'Correo',
      content: '',
      placeholder: 'correo@example.test',
      required: true,
      options: [],
      sortOrder: 0,
      settings: { pageId: 'form-step' }
    }
  ]
  const baseLanding = {
    id: 'landing_completion_embed',
    name: 'Landing completion',
    title: 'Landing completion',
    description: '',
    slug: 'landing-completion',
    siteType: 'landing_page',
    status: 'published',
    theme: {
      template: 'ristak',
      pages: [
        { id: 'page-1', title: 'Pagina 1', sortOrder: 0 },
        { id: 'page-2', title: 'Pagina 2', sortOrder: 1 }
      ]
    },
    blocks: [
      {
        id: 'embed-form-completion',
        siteId: 'landing_completion_embed',
        blockType: 'form_embed',
        label: 'Formulario',
        content: '',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 0,
        settings: {
          pageId: 'page-1',
          completionAction: 'form_default',
          embeddedTheme: {
            template: 'ristak',
            formCompletionAction: 'redirect_qualified',
            formQualifiedRedirectUrl: 'https://example.test/califica',
            formDisqualifiedCompletionAction: 'redirect_url',
            formDisqualifiedRedirectUrl: 'https://example.test/no-califica'
          },
          embeddedPages: [{ id: 'form-step', title: 'Formulario', sortOrder: 0, buttonText: 'Enviar' }],
          embeddedBlocks
        },
        createdAt: '',
        updatedAt: ''
      }
    ]
  }

  const inheritedHtml = await renderPublicSiteHtml(baseLanding, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(inheritedHtml, /const completionAction = "redirect_qualified";/)
  assert.match(inheritedHtml, /const qualifiedRedirectUrl = "https:\/\/example\.test\/califica";/)
  assert.match(inheritedHtml, /const disqualifiedCompletionAction = "redirect_url";/)
  assert.match(inheritedHtml, /const disqualifiedRedirectUrl = "https:\/\/example\.test\/no-califica";/)
  // "Usar reglas del formulario" (form_default): el redirect propio del formulario manda.
  assert.match(inheritedHtml, /const completionUsesFormRules = true;/)
  // El corto-circuito del redirect del formulario queda condicionado a esa bandera.
  assert.match(inheritedHtml, /if \(submission\.redirectUrl && completionUsesFormRules\)/)

  const specificPageHtml = await renderPublicSiteHtml({
    ...baseLanding,
    blocks: baseLanding.blocks.map(block => ({
      ...block,
      settings: {
        ...block.settings,
        completionAction: 'specific_page',
        completionPageId: 'page-2'
      }
    }))
  }, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(specificPageHtml, /const completionAction = "specific_page";/)
  assert.match(specificPageHtml, /const completionTargetPageUrl = "\?page=page-2";/)
  // Acción del editor de sitios (no form_default): el redirect del formulario NO debe mandar.
  assert.match(specificPageHtml, /const completionUsesFormRules = false;/)

  const unconditionalRedirectHtml = await renderPublicSiteHtml({
    ...baseLanding,
    blocks: baseLanding.blocks.map(block => ({
      ...block,
      settings: {
        ...block.settings,
        completionAction: 'redirect',
        completionRedirectUrl: 'https://example.test/siempre'
      }
    }))
  }, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(unconditionalRedirectHtml, /const completionAction = "redirect";/)
  assert.match(unconditionalRedirectHtml, /const qualifiedRedirectUrl = "https:\/\/example\.test\/siempre";/)
  // Unconditional redirect branch is present in the decision script.
  assert.match(unconditionalRedirectHtml, /completionAction === 'redirect' && qualifiedRedirectUrl/)
  // Redirigir a URL (no form_default): el redirect del formulario NO debe mandar.
  assert.match(unconditionalRedirectHtml, /const completionUsesFormRules = false;/)

  const specificPageIfQualifiedHtml = await renderPublicSiteHtml({
    ...baseLanding,
    blocks: baseLanding.blocks.map(block => ({
      ...block,
      settings: {
        ...block.settings,
        completionAction: 'specific_page_if_qualified',
        completionPageId: 'page-2'
      }
    }))
  }, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(specificPageIfQualifiedHtml, /const completionAction = "specific_page_if_qualified";/)
  assert.match(specificPageIfQualifiedHtml, /const completionTargetPageUrl = "\?page=page-2";/)
  // Conditional specific-page branch is present in the decision script.
  assert.match(specificPageIfQualifiedHtml, /completionAction === 'specific_page_if_qualified'/)
  // Variante "si no descalifica" (no form_default): el redirect del formulario NO debe mandar.
  assert.match(specificPageIfQualifiedHtml, /const completionUsesFormRules = false;/)
})

test('form embeds created on funnel landings default to next page on submit', async () => {
  const site = await createSite({
    siteType: 'landing_page',
    name: 'Formulario funnel default',
    slug: 'formulario-funnel-default',
    blankCanvas: true,
    theme: {
      pageMode: 'funnel',
      pages: [
        { id: 'page-1', title: 'Pagina 1', sortOrder: 0 },
        { id: 'page-2', title: 'Pagina 2', sortOrder: 1 }
      ]
    }
  })

  try {
    const updated = await createBlock(site.id, {
      blockType: 'form_embed',
      label: 'Formulario',
      settings: {
        pageId: 'page-1',
        embeddedTheme: {
          template: 'ristak',
          formCompletionAction: 'redirect_qualified',
          formQualifiedRedirectUrl: 'https://example.test/califica'
        },
        embeddedPages: [{ id: 'form-step', title: 'Formulario', sortOrder: 0, buttonText: 'Enviar' }],
        embeddedBlocks: [
          {
            id: 'funnel-default-email',
            siteId: site.id,
            blockType: 'email',
            label: 'Correo',
            content: '',
            placeholder: 'correo@example.test',
            required: true,
            options: [],
            sortOrder: 0,
            settings: { pageId: 'form-step' }
          }
        ]
      }
    })

    const block = findFormEmbedBlock(updated)
    assert.equal(block?.settings?.completionAction, 'next_page')

    const html = await renderPublicSiteHtml(updated, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(html, /const completionAction = "next_page";/)
    assert.match(html, /const nextPageUrl = "\?page=page-2";/)
    assert.match(html, /const completionUsesFormRules = false;/)
  } finally {
    await deleteSite(site.id).catch(() => undefined)
  }
})

test('form embeds created on the final funnel page keep form rules by default', async () => {
  const site = await createSite({
    siteType: 'landing_page',
    name: 'Formulario final default',
    slug: 'formulario-final-default',
    blankCanvas: true,
    theme: {
      pageMode: 'funnel',
      pages: [
        { id: 'page-1', title: 'Pagina 1', sortOrder: 0 },
        { id: 'page-2', title: 'Pagina final', sortOrder: 1 }
      ]
    }
  })

  try {
    const updated = await createBlock(site.id, {
      blockType: 'form_embed',
      label: 'Formulario',
      settings: {
        pageId: 'page-2',
        embeddedTheme: {
          template: 'ristak',
          formCompletionAction: 'redirect_qualified',
          formQualifiedRedirectUrl: 'https://example.test/califica'
        },
        embeddedPages: [{ id: 'form-step', title: 'Formulario', sortOrder: 0, buttonText: 'Enviar' }],
        embeddedBlocks: [
          {
            id: 'final-default-email',
            siteId: site.id,
            blockType: 'email',
            label: 'Correo',
            content: '',
            placeholder: 'correo@example.test',
            required: true,
            options: [],
            sortOrder: 0,
            settings: { pageId: 'form-step' }
          }
        ]
      }
    })

    const block = findFormEmbedBlock(updated)
    assert.equal(block?.settings?.completionAction, undefined)

    const html = await renderPublicSiteHtml(updated, {
      pageId: 'page-2',
      trackingEnabled: false,
      preview: true
    })

    assert.match(html, /const completionAction = "redirect_qualified";/)
    assert.match(html, /const completionUsesFormRules = true;/)
  } finally {
    await deleteSite(site.id).catch(() => undefined)
  }
})

test('form embed creation preserves explicit completion rules', async () => {
  const site = await createSite({
    siteType: 'landing_page',
    name: 'Formulario explicit default',
    slug: 'formulario-explicit-default',
    blankCanvas: true,
    theme: {
      pageMode: 'funnel',
      pages: [
        { id: 'page-1', title: 'Pagina 1', sortOrder: 0 },
        { id: 'page-2', title: 'Pagina 2', sortOrder: 1 }
      ]
    }
  })

  try {
    const updated = await createBlock(site.id, {
      blockType: 'form_embed',
      label: 'Formulario',
      settings: {
        pageId: 'page-1',
        completionAction: 'form_default',
        embeddedTheme: {
          template: 'ristak',
          formCompletionAction: 'redirect_qualified',
          formQualifiedRedirectUrl: 'https://example.test/califica'
        },
        embeddedPages: [{ id: 'form-step', title: 'Formulario', sortOrder: 0, buttonText: 'Enviar' }],
        embeddedBlocks: [
          {
            id: 'explicit-default-email',
            siteId: site.id,
            blockType: 'email',
            label: 'Correo',
            content: '',
            placeholder: 'correo@example.test',
            required: true,
            options: [],
            sortOrder: 0,
            settings: { pageId: 'form-step' }
          }
        ]
      }
    })

    const block = findFormEmbedBlock(updated)
    assert.equal(block?.settings?.completionAction, 'form_default')

    const html = await renderPublicSiteHtml(updated, {
      pageId: 'page-1',
      trackingEnabled: false,
      preview: true
    })

    assert.match(html, /const completionAction = "redirect_qualified";/)
    assert.match(html, /const completionUsesFormRules = true;/)
  } finally {
    await deleteSite(site.id).catch(() => undefined)
  }
})

test('form embeds created on website landings keep form rules by default', async () => {
  const site = await createSite({
    siteType: 'landing_page',
    name: 'Formulario website default',
    slug: 'formulario-website-default',
    blankCanvas: true,
    theme: {
      pageMode: 'website',
      pages: [
        { id: 'page-1', title: 'Inicio', slug: 'inicio', sortOrder: 0 },
        { id: 'page-2', title: 'Gracias', slug: 'gracias', sortOrder: 1 }
      ]
    }
  })

  try {
    const updated = await createBlock(site.id, {
      blockType: 'form_embed',
      label: 'Formulario',
      settings: {
        pageId: 'page-1',
        embeddedTheme: { template: 'ristak' }
      }
    })

    const block = findFormEmbedBlock(updated)
    assert.equal(block?.settings?.completionAction, undefined)
  } finally {
    await deleteSite(site.id).catch(() => undefined)
  }
})

test('standalone standard form keeps honoring its own result redirect', async () => {
  // Fuera de un embed de sitio (formulario/embudo standalone) el redirect propio
  // del formulario (página de calificación/descalificación) siempre debe mandar.
  const site = {
    id: 'site_standalone_result_redirect',
    name: 'Formulario standalone',
    title: 'Formulario standalone',
    description: '',
    slug: 'formulario-standalone',
    siteType: 'standard_form',
    status: 'published',
    theme: {
      template: 'compact',
      pages: [{ id: 'page-1', title: 'Formulario', sortOrder: 0 }]
    },
    blocks: [
      {
        id: 'standalone-email',
        siteId: 'site_standalone_result_redirect',
        blockType: 'email',
        label: 'Correo',
        content: '',
        placeholder: 'correo@example.test',
        required: true,
        options: [],
        sortOrder: 0,
        settings: { pageId: 'page-1' }
      }
    ]
  }

  const html = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.match(html, /const completionUsesFormRules = true;/)
  assert.match(html, /if \(submission\.redirectUrl && completionUsesFormRules\)/)
  assert.match(html, /const navigateAway = \(targetUrl\) =>/)
  assert.match(html, /pauseMediaIn\(document\)/)
  const redirectBeforeResetIndex = html.indexOf('if (navigateAway(getSubmissionCompletionUrl())) return;')
  const resetIndex = html.indexOf('form.reset();')
  assert.ok(redirectBeforeResetIndex >= 0, 'expected completion navigation before form reset')
  assert.ok(resetIndex > redirectBeforeResetIndex, 'form reset must not run before redirect decisions')
})

test('immediate disqualify choices run when advancing, not when selecting', async () => {
  const site = {
    id: 'site_immediate_disqualify_choice',
    name: 'Formulario descalificacion inmediata',
    title: 'Formulario descalificacion inmediata',
    description: '',
    slug: 'formulario-descalificacion-inmediata',
    siteType: 'standard_form',
    status: 'published',
    theme: {
      template: 'compact',
      pages: [
        { id: 'page-1', title: 'Formulario', sortOrder: 0 },
        { id: 'page-3', title: 'No califica', sortOrder: 1 }
      ]
    },
    blocks: [
      {
        id: 'field-route',
        siteId: 'site_immediate_disqualify_choice',
        blockType: 'radio',
        label: 'Ruta',
        content: '',
        placeholder: '',
        required: true,
        options: [
          { id: 'yes', label: 'Si califica', value: 'Si califica', action: 'continue' },
          { id: 'no', label: 'No califica', value: 'No califica', action: 'disqualify', message: 'No califica por ahora.' }
        ],
        sortOrder: 0,
        settings: { pageId: 'page-1' }
      }
    ]
  }

  const html = await renderPublicSiteHtml(site, {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })

  assert.doesNotMatch(html, /Redirigiendo\.\.\./)
  assert.match(html, /const getImmediateDisqualifyUrl = \(rule\) =>/)
  assert.match(html, /const submitSubmissionInBackground = \(payload\) =>/)
  assert.doesNotMatch(html, /const immediateRule = readSelectedRules\(field\)/)
  assert.doesNotMatch(html, /handleBlockingRule\(immediateRule/)
  assert.ok(html.includes("const immediateSubmitRule = !ruleSubmit ? submitRules.find(item => item.action === 'disqualify') || null : null;"))
  assert.ok(html.includes("handleBlockingRule(immediateSubmitRule, rulePageId, message, { immediate: true, fieldId: immediateSubmitRule.fieldId || ruleFieldId })"))
  assert.ok(html.includes("handleBlockingRule(blockingRule, getCurrentPageId(), message, blockingRule.action === 'disqualify' ? { immediate: true, fieldId: blockingRule.fieldId || '' } : {})"))
})

// Contrato de paridad (Paquete D / riesgo B-a): la clase rstkPageTextGradient
// del theme embebido vive EN el frame (.rstk-embedded-form-source-frame), que
// es el elemento donde la guarda de gradiente de la hoja compartida evalúa su
// :not(.rstkPageTextGradient). El editor pone la clase en el mismo elemento.
test('embedded form frame carries its own rstkPageTextGradient class on the frame element', async () => {
  const gradient = 'linear-gradient(90deg, #ff0055, #5500ff)'
  const buildSite = (embeddedTheme) => ({
    id: 'site_embedded_gradient',
    name: 'Landing gradiente',
    title: 'Landing gradiente',
    description: '',
    slug: 'landing-gradiente',
    siteType: 'landing_page',
    status: 'published',
    theme: {
      template: 'ristak',
      // Anfitrión con gradiente de texto propio (caso del corner B-a).
      textColor: gradient,
      textColorCustom: true,
      pages: [{ id: 'page-1', title: 'Pagina 1', sortOrder: 0 }]
    },
    blocks: [
      {
        id: 'embed-form',
        siteId: 'site_embedded_gradient',
        blockType: 'form_embed',
        label: 'Formulario',
        content: 'Formulario',
        placeholder: '',
        required: false,
        options: [],
        sortOrder: 0,
        settings: {
          pageId: 'page-1',
          embeddedPages: [{ id: 'step-1', title: 'Paso 1', sortOrder: 0 }],
          embeddedTheme,
          embeddedBlocks: [
            {
              id: 'field-name',
              siteId: 'site_embedded_gradient',
              blockType: 'short_text',
              label: 'Nombre',
              content: '',
              placeholder: '',
              required: true,
              options: [],
              sortOrder: 0,
              settings: { pageId: 'step-1' }
            }
          ]
        }
      }
    ]
  })

  const frameClass = (html) => {
    const match = html.match(/class="([^"]*rstk-embedded-form-source-frame[^"]*)"/)
    assert.ok(match, 'embedded frame element not found')
    return match[1]
  }

  // Embed con gradiente propio: la clase va EN el frame (el :not de la guarda
  // no aplica y el gradiente del embed sobrevive, igual que en el canvas).
  const withGradient = await renderPublicSiteHtml(buildSite({ textColor: gradient, textColorCustom: true }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })
  assert.match(frameClass(withGradient), /\brstkPageTextGradient\b/)

  // Embed con texto sólido propio: el frame NO lleva la clase aunque el
  // anfitrión tenga gradiente (la guarda apaga el gradiente heredado dentro).
  const withSolid = await renderPublicSiteHtml(buildSite({ textColor: '#111111', textColorCustom: true }), {
    pageId: 'page-1',
    trackingEnabled: false,
    preview: true
  })
  assert.doesNotMatch(frameClass(withSolid), /\brstkPageTextGradient\b/)
})

test('form flow revision follows topology and ignores copy-only edits', async () => {
  const buildForm = ({
    pageTitle = 'Primera pregunta',
    fieldLabel = 'Tu nombre',
    fieldId = 'field-copy-stable'
  } = {}) => ({
    id: 'site_form_revision_copy',
    name: 'Formulario',
    title: 'Formulario',
    description: '',
    slug: 'formulario-revision-copy',
    siteType: 'standard_form',
    status: 'published',
    theme: {
      pages: [
        { id: 'page-copy-stable', title: pageTitle, sortOrder: 0 }
      ]
    },
    blocks: [{
      id: fieldId,
      siteId: 'site_form_revision_copy',
      blockType: 'short_text',
      label: fieldLabel,
      content: '',
      placeholder: '',
      required: true,
      options: [],
      sortOrder: 0,
      settings: { pageId: 'page-copy-stable' }
    }]
  })
  const renderFlow = async form => extractMainFormFlow(await renderPublicSiteHtml(form, {
    pageId: 'page-copy-stable',
    trackingEnabled: false,
    preview: true
  }))

  const original = await renderFlow(buildForm())
  const renamed = await renderFlow(buildForm({
    pageTitle: 'Cuéntanos quién eres',
    fieldLabel: 'Nombre completo'
  }))
  const changedTopology = await renderFlow(buildForm({
    fieldId: 'field-copy-replaced'
  }))

  assert.equal(renamed.flowRevision, original.flowRevision)
  assert.notEqual(changedTopology.flowRevision, original.flowRevision)
  assert.equal(renamed.stages[0].label, 'Nombre completo')
})
