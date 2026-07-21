import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SITE_TEMPLATES,
  DEFAULT_THEME,
  EMBEDDED_FORM_DEFAULT_THEME,
  computeSitePageRenderState,
  buildFormThemeStyleVars,
  buildStyleSheet,
  buildEmbeddedFormTheme,
  popupSurfaceDefaults,
  buildPopupSurfaceVars,
  appendCalendarEmbedParams,
  buildFormStyleContext,
  buildEmbeddedFormProxyVars,
  serializeCssVars,
  rescopeSiteCssForCanvas,
  RSTK_BASE_CSS,
  RSTK_TEMPLATE_EXTRAS,
  RSTK_POPUP_CSS,
  AUTO_DARK_TEXT,
  buildBlockStyleVars,
  buildBlockStyleClassName,
  blockHasStyleWrapper,
  blockTextContrastBackground,
  buildVideoFrameStyleVars,
  parseCountdownTargetDate,
  countdownShowLabelsValue,
  extractWistiaMediaId,
  wistiaEmbedIframeUrl,
  normalizeSocialPlatform
} from '../../shared/sites/renderContract.js'

// ---------------------------------------------------------------------------
// Contrato de explicitud raw-vs-merged (theme-vars #1)
// ---------------------------------------------------------------------------

test('un backgroundColor NO definido conserva la paleta del template (form y landing)', () => {
  const formState = computeSitePageRenderState({ siteType: 'standard_form', theme: { template: 'ristak' } })
  const tpl = SITE_TEMPLATES.ristak.vars
  assert.equal(formState.hasExplicitBackgroundColor, false)
  assert.equal(formState.vars['--rstk-page-bg'], tpl.pageBg)
  assert.equal(formState.vars['--rstk-border'], tpl.border)
  assert.equal(formState.vars['--rstk-surface'], tpl.surface)
  assert.equal(formState.vars['--rstk-accent'], tpl.accent)

  const landingState = computeSitePageRenderState({ siteType: 'landing_page', theme: { template: 'ristak' } })
  // En landing sí se derivan neutrales, pero sobre el pageBg DEL TEMPLATE (no blanco).
  assert.equal(landingState.vars['--rstk-page-bg'], tpl.pageBg)
})

test("un '#ffffff' EXPLÍCITO sí deriva la paleta neutral (guard vivo)", () => {
  const state = computeSitePageRenderState({
    siteType: 'standard_form',
    theme: { template: 'ristak', backgroundColor: '#ffffff' }
  })
  assert.equal(state.hasExplicitBackgroundColor, true)
  assert.equal(state.vars['--rstk-page-bg'], '#ffffff')
  // Paleta neutral clara de deriveNeutralVars, no la del template.
  assert.equal(state.vars['--rstk-border'], 'rgba(15,23,42,0.1)')
  assert.equal(state.vars['--rstk-surface'], 'rgba(15,23,42,0.022)')
  assert.equal(state.vars['--rstk-input-border'], '#dfe3e8')
})

// ---------------------------------------------------------------------------
// Geometría de página
// ---------------------------------------------------------------------------

test('remap 1160 -> 1440 del ancho histórico de landings', () => {
  const remapped = computeSitePageRenderState({ siteType: 'landing_page', theme: { pageMaxWidth: 1160 } })
  assert.equal(remapped.pageMaxWidth, 1440)
  assert.equal(remapped.vars['--rstk-max'], '1440px')
  // Solo aplica al valor exacto 1160 en landings.
  const untouched = computeSitePageRenderState({ siteType: 'landing_page', theme: { pageMaxWidth: 1200 } })
  assert.equal(untouched.pageMaxWidth, 1200)
  const formSite = computeSitePageRenderState({ siteType: 'standard_form', theme: { pageMaxWidth: 1160 } })
  assert.equal(formSite.pageMaxWidth, 1160)
})

test('clamps de geometría: pageMaxWidth 240-3000, pagePadding 0-600, pageBorderWidth 0-80', () => {
  const state = computeSitePageRenderState({
    siteType: 'standard_form',
    theme: { pageMaxWidth: 99999, pagePadding: 9999, pageRadius: 9999, pageBorderWidth: 500 }
  })
  assert.equal(state.pageMaxWidth, 3000)
  assert.equal(state.pagePadding, 600)
  assert.equal(state.pageRadius, 400)
  assert.equal(state.pageBorderWidth, 80)
})

// ---------------------------------------------------------------------------
// Variables de formulario: defaults y clamps
// ---------------------------------------------------------------------------

test('buildFormThemeStyleVars: defaults con el contexto del template', () => {
  const v = SITE_TEMPLATES.ristak.vars
  const vars = buildFormThemeStyleVars({}, { baseFont: SITE_TEMPLATES.ristak.font, v, accent: v.accent, ink: v.ink, muted: v.muted })
  assert.equal(vars['--rstk-form-label-size'], '15px')
  assert.equal(vars['--rstk-form-input-size'], '16px')
  assert.equal(vars['--rstk-form-help-size'], '14px')
  assert.equal(vars['--rstk-form-weight'], '500')
  assert.equal(vars['--rstk-form-field-bg'], 'transparent')
  assert.equal(vars['--rstk-form-field-radius'], '14px') // parseInt(radius '14px')
  assert.equal(vars['--rstk-form-field-height'], '50px')
  assert.equal(vars['--rstk-form-field-width'], '560px')
  assert.equal(vars['--rstk-form-content-align'], 'left')
  assert.equal(vars['--rstk-form-field-justify'], 'center')
  assert.equal(vars['--rstk-form-page-margin-left'], 'auto')
  assert.equal(vars['--rstk-form-page-margin-right'], 'auto')
  assert.equal(vars['--rstk-submit-bg'], v.accent)
  assert.equal(vars['--rstk-submit-text'], v.onAccent)
  assert.equal(vars['--rstk-submit-radius'], '14px') // parseInt(btnRadius '14px')
  assert.equal(vars['--rstk-submit-justify'], 'center')
  assert.equal(vars['--rstk-submit-width'], 'fit-content')
  // Fix deliberado (form-fields #2): rojo de error definido en el contrato.
  assert.equal(vars['--rstk-form-error'], '#dc2626')
  // Sin formSurfaceColor no se emite la variable.
  assert.equal('--rstk-form-surface' in vars, false)
})

test('buildFormThemeStyleVars: clamps y alineaciones explícitas', () => {
  const v = SITE_TEMPLATES.ristak.vars
  const vars = buildFormThemeStyleVars({
    formLabelSize: 100,
    formFieldHeight: 5,
    formFieldWidth: 99999,
    formContentAlign: 'right',
    submitAlign: 'left',
    submitWidth: 50,
    formSurfaceColor: '#112233'
  }, { baseFont: SITE_TEMPLATES.ristak.font, v, accent: v.accent, ink: v.ink, muted: v.muted })
  assert.equal(vars['--rstk-form-label-size'], '28px') // clamp 11-28
  assert.equal(vars['--rstk-form-field-height'], '34px') // clamp 34-96
  assert.equal(vars['--rstk-form-field-width'], '2000px') // clamp 120-2000
  assert.equal(vars['--rstk-form-content-align'], 'right')
  assert.equal(vars['--rstk-form-field-justify'], 'end')
  assert.equal(vars['--rstk-form-page-margin-left'], 'auto')
  assert.equal(vars['--rstk-form-page-margin-right'], '0')
  assert.equal(vars['--rstk-submit-justify'], 'start')
  assert.equal(vars['--rstk-submit-width'], '50%')
  assert.equal(vars['--rstk-form-surface'], '#112233')
})

test('serializeCssVars produce declaraciones name:value unidas por el separador', () => {
  assert.equal(serializeCssVars({ '--a': '1px', '--b': 'red' }), '--a:1px;--b:red')
  assert.equal(serializeCssVars({}), '')
})

// ---------------------------------------------------------------------------
// Cadena de theme del formulario embebido (embeds #2 / #4)
// ---------------------------------------------------------------------------

test('buildEmbeddedFormTheme: el theme del host se filtra al frame', () => {
  const { theme, sourceTheme } = buildEmbeddedFormTheme({
    hostTheme: { formChoiceStyle: 'pills', backgroundColor: '#123456' },
    sourceFormTheme: {},
    isImportedForm: false
  })
  assert.equal(sourceTheme.formChoiceStyle, 'pills')
  assert.equal(sourceTheme.backgroundColor, '#123456')
  // Defaults de embed aplican en lienzos no importados y dejan el inspector y el
  // render público con el mismo preset desde el primer paint.
  assert.equal(sourceTheme.pageMaxWidth, EMBEDDED_FORM_DEFAULT_THEME.pageMaxWidth)
  assert.equal(sourceTheme.pagePadding, EMBEDDED_FORM_DEFAULT_THEME.pagePadding)
  assert.equal(sourceTheme.pageRadius, EMBEDDED_FORM_DEFAULT_THEME.pageRadius)
  assert.equal(sourceTheme.pageBorderWidth, EMBEDDED_FORM_DEFAULT_THEME.pageBorderWidth)
  assert.equal(sourceTheme.pageBorderColor, EMBEDDED_FORM_DEFAULT_THEME.pageBorderColor)
  assert.equal(sourceTheme.formContentAlign, EMBEDDED_FORM_DEFAULT_THEME.formContentAlign)
  assert.equal(sourceTheme.formFieldWidth, EMBEDDED_FORM_DEFAULT_THEME.formFieldWidth)
  // theme = DEFAULT_THEME + cadena cruda.
  assert.equal(theme.accentColor, DEFAULT_THEME.accentColor)
  assert.equal(theme.backgroundColor, '#123456')
})

test('buildEmbeddedFormTheme: importado NO recibe EMBEDDED_FORM_DEFAULT_THEME', () => {
  const { sourceTheme } = buildEmbeddedFormTheme({
    hostTheme: {},
    sourceFormTheme: { template: 'imported_html' },
    isImportedForm: true
  })
  assert.equal('pageBorderWidth' in sourceTheme, false)
  assert.equal('pageBorderColor' in sourceTheme, false)
  assert.equal(sourceTheme.template, 'imported_html')
})

test('buildEmbeddedFormTheme: el override local gana sobre el theme del formulario', () => {
  const { sourceTheme } = buildEmbeddedFormTheme({
    hostTheme: { backgroundColor: '#111111' },
    sourceFormTheme: { backgroundColor: '#222222', formFieldHeight: 60 },
    embeddedThemeOverride: { backgroundColor: '#333333' },
    isImportedForm: false
  })
  assert.equal(sourceTheme.backgroundColor, '#333333')
  assert.equal(sourceTheme.formFieldHeight, 60)
  // La cadena cruda no incluye DEFAULT_THEME: la explicitud sale de aquí.
  assert.equal('accentColor' in sourceTheme, false)
})

test('explicitud del frame embebido: host sin backgroundColor conserva paleta del template', () => {
  const { sourceTheme } = buildEmbeddedFormTheme({
    hostTheme: { template: 'premium' },
    sourceFormTheme: {},
    isImportedForm: false
  })
  const state = computeSitePageRenderState({ siteType: 'standard_form', theme: sourceTheme })
  assert.equal(state.hasExplicitBackgroundColor, false)
  assert.equal(state.vars['--rstk-page-bg'], SITE_TEMPLATES.premium.vars.pageBg)
})

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

test('popupSurfaceDefaults responde al modo del sitio', () => {
  assert.deepEqual(popupSurfaceDefaults(true), { background: '#0f172a', color: '#f8fafc' })
  assert.deepEqual(popupSurfaceDefaults(false), { background: '#ffffff', color: '#111827' })
})

test('RSTK_POPUP_CSS es estática y usa variables --rstk-popup-*', () => {
  assert.match(RSTK_POPUP_CSS, /var\(--rstk-popup-bg,#ffffff\)/)
  assert.match(RSTK_POPUP_CSS, /var\(--rstk-popup-backdrop,rgba\(2, 6, 23, 0\.62\)\)/)
  assert.doesNotMatch(RSTK_POPUP_CSS, /\$\{/)
})

// ---------------------------------------------------------------------------
// rescopeSiteCssForCanvas
// ---------------------------------------------------------------------------

test('rescope: clases de body se pegan al scope', () => {
  assert.equal(
    rescopeSiteCssForCanvas('body.rstk-dark .rstk-shell{color:#fff}'),
    '.rstkCanvas.rstk-dark .rstk-shell{color:#fff}'
  )
  assert.equal(
    rescopeSiteCssForCanvas('body:has(.rstkBlockFullWidth){overflow-x:hidden}'),
    '.rstkCanvas:has(.rstkBlockFullWidth){overflow-x:hidden}'
  )
  assert.equal(rescopeSiteCssForCanvas(':root{--x:1}'), '.rstkCanvas{--x:1}')
  assert.equal(rescopeSiteCssForCanvas('body{margin:0}'), '.rstkCanvas{margin:0}')
  assert.equal(rescopeSiteCssForCanvas('html{-webkit-text-size-adjust:100%}'), '.rstkCanvas{-webkit-text-size-adjust:100%}')
})

test('rescope: selector encabezado por clase emite DOBLE rama (compound en el scope + descendiente)', () => {
  // Las clases de body viven EN el scope (.rstkCanvas.rstk-kind-form) pero también
  // aparecen dentro del contenido (overrides por-campo): ambas ramas, +0,1,0 uniforme.
  assert.equal(
    rescopeSiteCssForCanvas('.rstk-frame{padding:10px}'),
    '.rstkCanvas.rstk-frame,.rstkCanvas .rstk-frame{padding:10px}'
  )
  assert.equal(
    rescopeSiteCssForCanvas('.rstk-kind-form .rstk-field > select{color:red}'),
    '.rstkCanvas.rstk-kind-form .rstk-field > select,.rstkCanvas .rstk-kind-form .rstk-field > select{color:red}'
  )
  assert.equal(
    rescopeSiteCssForCanvas('.rstk-choice-cards .rstk-option{gap:0}'),
    '.rstkCanvas.rstk-choice-cards .rstk-option,.rstkCanvas .rstk-choice-cards .rstk-option{gap:0}'
  )
  assert.equal(
    rescopeSiteCssForCanvas('.rstk-interactive label{font-weight:800}'),
    '.rstkCanvas.rstk-interactive label,.rstkCanvas .rstk-interactive label{font-weight:800}'
  )
  assert.equal(
    rescopeSiteCssForCanvas('.rstk-centered .rstk-shell{text-align:center}'),
    '.rstkCanvas.rstk-centered .rstk-shell,.rstkCanvas .rstk-centered .rstk-shell{text-align:center}'
  )
})

test('rescope: selectores encabezados por elemento/atributo quedan solo descendientes', () => {
  assert.equal(
    rescopeSiteCssForCanvas('select{appearance:none}', { scope: '.otroScope' }),
    '.otroScope select{appearance:none}'
  )
  assert.equal(
    rescopeSiteCssForCanvas('[data-rstk-user-hidden="true"]{display:none}'),
    '.rstkCanvas [data-rstk-user-hidden="true"]{display:none}'
  )
})

test('rescope: listas con comas mezclan ramas y respetan comas internas de :has()/:is()', () => {
  assert.equal(
    rescopeSiteCssForCanvas('h1,.rstk-a:is(.b,.c),body{margin:0}'),
    '.rstkCanvas h1,.rstkCanvas.rstk-a:is(.b,.c),.rstkCanvas .rstk-a:is(.b,.c),.rstkCanvas{margin:0}'
  )
})

test('rescope: @media de ancho se vuelve @container rstk-canvas y se rescopea por dentro (doble rama)', () => {
  assert.equal(
    rescopeSiteCssForCanvas('@media (max-width:640px){.rstk-x{padding:4vw}}'),
    '@container rstk-canvas (max-width:640px){.rstkCanvas.rstk-x,.rstkCanvas .rstk-x{padding:4cqw}}'
  )
  assert.equal(
    rescopeSiteCssForCanvas('@media (min-width:760px){body{gap:8px}}'),
    '@container rstk-canvas (min-width:760px){.rstkCanvas{gap:8px}}'
  )
})

test('rescope: @container existente pasa intacto por fuera y rescopeado por dentro', () => {
  assert.equal(
    rescopeSiteCssForCanvas('@container (max-width:460px){.rstk-video-form-gate{padding:8px}}'),
    '@container (max-width:460px){.rstkCanvas.rstk-video-form-gate,.rstkCanvas .rstk-video-form-gate{padding:8px}}'
  )
})

test('rescope: vw -> cqw y vh -> --rstk-vh100 dentro de valores (sin tocar strings)', () => {
  assert.equal(
    rescopeSiteCssForCanvas('.rstk-h{font-size:clamp(1.7rem,4.6vw,3rem)}'),
    '.rstkCanvas.rstk-h,.rstkCanvas .rstk-h{font-size:clamp(1.7rem,4.6cqw,3rem)}'
  )
  assert.equal(
    rescopeSiteCssForCanvas('.rstk-shell{min-height:min(72vh,560px)}'),
    '.rstkCanvas.rstk-shell,.rstkCanvas .rstk-shell{min-height:min(calc(var(--rstk-vh100,100vh) * 72 / 100),560px)}'
  )
  assert.equal(
    rescopeSiteCssForCanvas('body{min-height:100vh}'),
    '.rstkCanvas{min-height:var(--rstk-vh100,100vh)}'
  )
  assert.equal(
    rescopeSiteCssForCanvas(".x{content:'100vh usa 50vw'}"),
    ".rstkCanvas.x,.rstkCanvas .x{content:'100vh usa 50vw'}"
  )
})

test('rescope: @supports pasa intacto por fuera y rescopeado por dentro; @keyframes intacto', () => {
  assert.equal(
    rescopeSiteCssForCanvas('@supports (width:1cqw){.rstk-video-shell{width:50vw}}'),
    '@supports (width:1cqw){.rstkCanvas.rstk-video-shell,.rstkCanvas .rstk-video-shell{width:50cqw}}'
  )
  const keyframes = '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}'
  assert.equal(rescopeSiteCssForCanvas(keyframes), keyframes)
})

test('rescope: procesa RSTK_BASE_CSS + extras + popup sin explotar y sin @media de ancho residuales', () => {
  const full = rescopeSiteCssForCanvas(`${RSTK_BASE_CSS}\n${RSTK_TEMPLATE_EXTRAS.interactive}\n${RSTK_POPUP_CSS}`)
  assert.match(full, /@container rstk-canvas \(max-width:640px\)/)
  assert.doesNotMatch(full, /@media \(max-width:/)
  // El body de la hoja pública quedó mapeado al scope.
  assert.match(full, /\.rstkCanvas\{\s*margin:0;min-height:var\(--rstk-vh100,100vh\)/)
  // Los vw internos ya no dependen de la ventana.
  assert.doesNotMatch(full, /[\d.]vw[,)\s;}]/)
})

// ---------------------------------------------------------------------------
// buildStyleSheet (hoja pública)
// ---------------------------------------------------------------------------

test('buildStyleSheet: color-scheme + extras del template + fixes deliberados', () => {
  const state = computeSitePageRenderState({ siteType: 'interactive_form', theme: {} })
  const sheet = buildStyleSheet(state)
  // color-scheme en ambas formas (variable + declaración).
  assert.match(sheet, /--rstk-color-scheme:dark/)
  assert.match(sheet, /color-scheme:dark;/)
  // Extras del template interactivo incluidos.
  assert.ok(sheet.includes('.rstk-interactive .rstk-shell{min-height:min(72vh,560px)'))
  // Fix caret + fondos gradiente (form-fields #1): --rstk-form-field-bg es un
  // PAINT (puede ser gradiente); background-color:<gradiente> es inválido y se
  // descartaba. Inputs/textareas usan shorthand background: (acepta ambos) y el
  // select del campo lleva las capas de caret encima del paint del usuario.
  assert.ok(sheet.includes('.rstk-kind-form .rstk-field > input,.rstk-kind-form .rstk-field > textarea,.rstk-embedded-form .rstk-field > input,.rstk-embedded-form .rstk-field > textarea{background:var(--rstk-form-field-bg,var(--rstk-input-bg))}'))
  const fieldSelectRule = sheet.match(/\.rstk-kind-form \.rstk-field > select,\.rstk-embedded-form \.rstk-field > select\{[^}]+\}/)?.[0] || ''
  assert.match(fieldSelectRule, /linear-gradient\(45deg,transparent 50%,var\(--rstk-muted\) 50%\)/)
  assert.match(fieldSelectRule, /linear-gradient\(135deg,var\(--rstk-muted\) 50%,transparent 50%\)/)
  assert.ok(fieldSelectRule.includes('var(--rstk-form-field-bg,var(--rstk-input-bg))'))
  // La regla combinada del campo ya no pisa el fondo con un longhand inválido.
  assert.doesNotMatch(sheet, /background-color:var\(--rstk-form-field-bg,var\(--rstk-input-bg\)\);color:var\(--rstk-form-field-text/)
  // La regla base del select con flechas sigue viva.
  assert.ok(sheet.includes('select{appearance:none;-webkit-appearance:none;background-image:linear-gradient'))
  // Fix botones de avance (form-fields #3): heredan el diseño del submit.
  assert.ok(sheet.includes('.rstk-kind-form .rstk-actions [data-form-next]'))
  assert.ok(sheet.includes('.rstk-kind-form .rstk-actions [data-next]'))
  assert.ok(sheet.includes('.rstk-embedded-form .rstk-actions [data-embedded-next]'))
  // Fix rojo de error (form-fields #2).
  assert.match(sheet, /--rstk-form-error:#dc2626/)
})

test('buildStyleSheet: landing usa extras del template correspondiente', () => {
  const state = computeSitePageRenderState({ siteType: 'standard_form', theme: { template: 'vsl' } })
  const sheet = buildStyleSheet(state)
  assert.ok(sheet.includes('.rstk-tpl-vsl .rstk-shell'))
  assert.match(sheet, /color-scheme:dark;/)
})

// ---------------------------------------------------------------------------
// Golden parity: computeSitePageRenderState contra valores calculados a mano
// ---------------------------------------------------------------------------

test('golden: formulario ristak default', () => {
  const state = computeSitePageRenderState({ siteType: 'standard_form', theme: { template: 'ristak' } })
  const expected = {
    '--rstk-color-scheme': 'light',
    '--rstk-font': "'Inter', Arial, sans-serif",
    '--rstk-display': "'Inter Tight', 'Inter', Arial, sans-serif",
    '--rstk-page-bg': '#eef2f7',
    '--rstk-page-image': 'none',
    '--rstk-page-overlay': 'none',
    '--rstk-page-video': '',
    '--rstk-page-image-size': 'auto',
    '--rstk-page-image-position': 'center center',
    '--rstk-page-image-repeat': 'no-repeat',
    '--rstk-page-image-attachment': 'scroll',
    '--rstk-page-video-fit': 'cover',
    '--rstk-ink': '#0f172a',
    '--rstk-muted': '#64748b',
    '--rstk-surface': '#ffffff',
    '--rstk-surface2': '#f8fafc',
    '--rstk-border': '#d7dee8',
    '--rstk-accent': '#0f172a',
    '--rstk-accent-strong': '#020617',
    '--rstk-on-accent': '#ffffff',
    '--rstk-ring': 'rgba(15,23,42,.16)',
    '--rstk-input-bg': '#ffffff',
    '--rstk-input-ink': '#0f172a',
    '--rstk-input-border': '#d7dee8',
    '--rstk-radius': '14px',
    '--rstk-radius-lg': '24px',
    '--rstk-max': '520px',
    '--rstk-frame-pad': '22px',
    '--rstk-page-border': 'transparent',
    '--rstk-page-border-width': '0px',
    '--rstk-page-radius': '24px',
    '--rstk-submit-bg': '#0f172a',
    '--rstk-submit-text': '#ffffff',
    '--rstk-form-error': '#dc2626',
    '--rstk-form-choice-selected-bg': 'color-mix(in srgb, #0f172a 10%, transparent)'
  }
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(state.vars[name], value, `${name} debería ser ${value}`)
  }
  assert.deepEqual(state.bodyClassList, [
    'rstk-tpl-ristak',
    'rstk-light',
    'rstk-kind-form',
    'rstk-choice-native',
    'rstk-select-classic',
    'rstk-input-box'
  ])
  assert.equal(state.siteIsDark, false)
})

test('golden: landing con fondo y acento personalizados (neutrales derivados)', () => {
  const state = computeSitePageRenderState({
    siteType: 'landing_page',
    theme: { template: 'ristak', backgroundColor: '#101418', accentColor: '#ff5500' }
  })
  const expected = {
    '--rstk-page-bg': '#101418',
    '--rstk-page-overlay': 'linear-gradient(#101418, #101418)',
    '--rstk-ink': '#f4f4f6',
    '--rstk-muted': 'color-mix(in srgb, #f4f4f6 60%, #101418)',
    '--rstk-surface': 'rgba(255,255,255,0.04)',
    '--rstk-surface2': 'rgba(255,255,255,0.06)',
    '--rstk-border': 'rgba(255,255,255,0.1)',
    '--rstk-accent': '#ff5500',
    '--rstk-accent-strong': '#ff5500',
    '--rstk-on-accent': '#ffffff',
    '--rstk-ring': 'color-mix(in srgb, #ff5500 26%, transparent)',
    '--rstk-input-bg': 'rgba(255,255,255,0.04)',
    '--rstk-input-ink': '#f4f4f6',
    '--rstk-input-border': 'rgba(255,255,255,0.14)',
    '--rstk-max': '1440px',
    '--rstk-frame-pad': '36px',
    '--rstk-page-radius': '0px'
  }
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(state.vars[name], value, `${name} debería ser ${value}`)
  }
  assert.ok(state.bodyClassList.includes('rstk-kind-landing'))
  assert.equal(state.siteIsDark, true)
})

test('golden: template oscuro (premium) sin colores custom conserva su paleta', () => {
  const state = computeSitePageRenderState({ siteType: 'standard_form', theme: { template: 'premium' } })
  const tpl = SITE_TEMPLATES.premium.vars
  const expected = {
    '--rstk-color-scheme': 'dark',
    '--rstk-page-bg': tpl.pageBg,
    '--rstk-ink': tpl.ink,
    '--rstk-muted': tpl.muted,
    '--rstk-surface': tpl.surface,
    '--rstk-border': tpl.border,
    '--rstk-accent': tpl.accent,
    '--rstk-accent-strong': tpl.accentStrong,
    '--rstk-on-accent': tpl.onAccent,
    '--rstk-input-bg': tpl.inputBg,
    '--rstk-max': '520px'
  }
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(state.vars[name], value, `${name} debería ser ${value}`)
  }
  assert.ok(state.bodyClassList.includes('rstk-dark'))
  assert.equal(state.siteIsDark, true)
})

test('golden: formulario interactivo (template implícito, centrado, 600px)', () => {
  const state = computeSitePageRenderState({ siteType: 'interactive_form', theme: {} })
  const tpl = SITE_TEMPLATES.interactive.vars
  const expected = {
    '--rstk-color-scheme': 'dark',
    '--rstk-page-bg': tpl.pageBg,
    '--rstk-accent': tpl.accent,
    '--rstk-radius': tpl.radius,
    '--rstk-max': '600px',
    '--rstk-frame-pad': '22px',
    '--rstk-page-radius': '24px'
  }
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(state.vars[name], value, `${name} debería ser ${value}`)
  }
  assert.deepEqual(state.bodyClassList, [
    'rstk-tpl-interactive',
    'rstk-dark',
    'rstk-kind-form',
    'rstk-centered',
    'rstk-interactive',
    'rstk-choice-native',
    'rstk-select-classic',
    'rstk-input-box'
  ])
  assert.equal(state.template.id, 'interactive')
  assert.equal(state.siteIsDark, true)
})

test('el template imported_html existe en el contrato compartido (theme-vars #2)', () => {
  const tpl = SITE_TEMPLATES.imported_html
  assert.ok(tpl)
  assert.equal(tpl.mode, 'light')
  assert.equal(tpl.vars.pageBg, '#ffffff')
  assert.equal(tpl.vars.border, '#e6e8ec')
  const state = computeSitePageRenderState({ siteType: 'standard_form', theme: { template: 'imported_html' } })
  assert.equal(state.template.id, 'imported_html')
  assert.ok(state.bodyClassList.includes('rstk-tpl-imported_html'))
})

// ---------------------------------------------------------------------------
// Contrato de bloques (Paquete C)
// ---------------------------------------------------------------------------

test('buildBlockStyleVars: fondo con gradiente emite layer + color transparente', () => {
  const gradient = 'linear-gradient(90deg, #111111, #222222)'
  const vars = buildBlockStyleVars({ blockType: 'title', settings: { blockBg: gradient } })
  assert.equal(vars['--rstk-block-bg'], gradient)
  assert.equal(vars['--rstk-block-bg-layer'], gradient)
  assert.equal(vars['--rstk-block-bg-color'], 'transparent')
})

test('buildBlockStyleVars: números no finitos se OMITEN (semántica del publicado, content #11)', () => {
  const vars = buildBlockStyleVars({
    blockType: 'title',
    settings: { fontSize: 'garbage', blockRadius: 'x', mediaWidth: 'nope', buttonRadius: '12px extra' }
  })
  assert.equal(vars['--rstk-block-size'], undefined)
  assert.equal(vars['--rstk-block-radius'], undefined)
  assert.equal(vars['--rstk-media-width'], undefined)
  assert.equal(vars['--rstk-block-button-radius'], undefined)
  assert.deepEqual(Object.keys(vars), [])
  // Ojo: '' y null coercionan a 0 (Number('') === 0) y SÍ se emiten clampados,
  // igual que el emisor histórico del publicado.
  const zeroish = buildBlockStyleVars({ blockType: 'title', settings: { blockRadius: '' } })
  assert.equal(zeroish['--rstk-block-radius'], '0px')
})

test('buildBlockStyleVars: blockBg inválido no emite nada (fallback \'\' del publicado, content #11)', () => {
  const vars = buildBlockStyleVars({ blockType: 'title', settings: { blockBg: 'no-es-un-color' } })
  assert.equal(vars['--rstk-block-bg'], undefined)
})

test('buildBlockStyleVars: blockBackgroundPosition se sanitiza y el fit legacy cae a cover (content #10)', () => {
  const vars = buildBlockStyleVars({
    blockType: 'hero',
    settings: {
      blockBackgroundImage: 'https://cdn.example.com/bg.jpg',
      blockBackgroundFit: 'no-repeat',
      blockBackgroundPosition: 'top; } body { color: red'
    }
  })
  assert.equal(vars['--rstk-block-bg-size'], 'cover')
  assert.equal(vars['--rstk-block-bg-position'], 'center center')
})

test('buildBlockStyleVars: contraste de blockText usa el pageBg del estado (content #8)', () => {
  const state = computeSitePageRenderState({ siteType: 'standard_form', theme: { template: 'ristak', backgroundColor: '#ffffff' } })
  const pageBg = blockTextContrastBackground(state)
  assert.equal(pageBg, '#ffffff')
  // Texto blanco sobre página blanca -> el publicado lo voltea al oscuro automático.
  const vars = buildBlockStyleVars({ blockType: 'title', settings: { blockText: '#ffffff' } }, { pageBg })
  assert.equal(vars['--rstk-block-text'], AUTO_DARK_TEXT)
  // Con fondo propio del bloque, el contraste se evalúa contra el bloque, no la página.
  const varsOwnBg = buildBlockStyleVars({ blockType: 'title', settings: { blockText: '#ffffff', blockBg: '#0f172a' } }, { pageBg })
  assert.equal(varsOwnBg['--rstk-block-text'], '#ffffff')
})

test('buildBlockStyleVars: blockText con gradiente publica paint + color legible', () => {
  const gradient = 'linear-gradient(90deg, #ffffff, #eeeeee)'
  const vars = buildBlockStyleVars({ blockType: 'title', settings: { blockText: gradient } }, { pageBg: '#ffffff' })
  assert.equal(vars['--rstk-block-text-paint'], gradient)
  assert.equal(vars['--rstk-block-text'], AUTO_DARK_TEXT)
})

test('rstk-field-width-set: solo con fieldWidth VÁLIDO (form-fields #5)', () => {
  const withWidth = buildBlockStyleClassName({ blockType: 'short_text', settings: { fieldWidth: 60 } })
  assert.ok(withWidth.includes('rstk-field-width-set'))
  const invalidWidth = buildBlockStyleClassName({ blockType: 'short_text', settings: { fieldWidth: 'abc' } })
  assert.ok(!invalidWidth.includes('rstk-field-width-set'))
  const noWidth = buildBlockStyleClassName({ blockType: 'short_text', settings: { blockText: '#111111' } })
  assert.ok(!noWidth.includes('rstk-field-width-set'))
  // La variable acompaña a la clase (misma condición).
  assert.equal(buildBlockStyleVars({ blockType: 'short_text', settings: { fieldWidth: 60 } })['--rstk-field-width'], '60%')
})

test('RSTK_BASE_CSS: el override de ancho por campo cuelga de .rstk-field-width-set', () => {
  assert.ok(RSTK_BASE_CSS.includes('.rstk-field-width-set.rstk-field,.rstk-field-width-set > .rstk-field{width:min(100%,var(--rstk-field-width,100%));justify-self:center}'))
  assert.ok(!/\.rstk-block-style\s*>\s*\.rstk-field\{width/.test(RSTK_BASE_CSS))
})

test('RSTK_BASE_CSS: el perfil social en formularios comparte carril con los campos', () => {
  const formLaneRule = RSTK_BASE_CSS.match(/\.rstk-kind-form \.rstk-field,[^{}]+\.rstk-embedded-form \.rstkSocialProfileBlock\.rstk-block-style\{[^}]+\}/)?.[0] || ''

  assert.match(formLaneRule, /\.rstk-kind-form \.rstkSocialProfileBlock\.rstk-block-style/)
  assert.match(formLaneRule, /\.rstk-embedded-form \.rstkSocialProfileBlock\.rstk-block-style/)
  assert.match(formLaneRule, /width:min\(100%,var\(--rstk-form-field-width,560px\)\)/)
  assert.match(formLaneRule, /justify-self:var\(--rstk-form-field-justify,center\)/)

  assert.ok(RSTK_BASE_CSS.includes('.rstk-embedded-form-source-frame .rstkSocialProfileBlock.rstk-block-style{width:min(100%,var(--rstk-form-field-width,560px));justify-self:var(--rstk-form-field-justify,center);transform:none}'))
  assert.ok(!RSTK_BASE_CSS.includes('.rstk-kind-form:not(.rstk-embedded-form-source-frame) .rstkSocialProfileBlock.rstk-block-style{justify-self:start}'))
  assert.ok(!RSTK_BASE_CSS.includes('.rstk-embedded-form-source-frame .rstkSocialProfileBlock.rstk-block-style{justify-self:start'))
})

test('blockHasStyleWrapper espeja las condiciones del wrapper publicado (content #3)', () => {
  assert.equal(blockHasStyleWrapper({ blockType: 'title', settings: {} }), false)
  assert.equal(blockHasStyleWrapper({ blockType: 'title', settings: { blockText: '#111111' } }), true)
  assert.equal(blockHasStyleWrapper({ blockType: 'title', settings: { blockFullWidth: true } }), true)
  assert.equal(blockHasStyleWrapper({ blockType: 'title', settings: { hidden: true } }), true)
  assert.equal(blockHasStyleWrapper({ blockType: 'title', settings: { hidden: 'true' } }), true)
  assert.equal(blockHasStyleWrapper({
    blockType: 'title',
    settings: { blockBackgroundMediaType: 'video', blockBackgroundImage: '/media/assets/abc/file' }
  }), true)
  // Los blancos de acciones (video/contador) también se envuelven en el publicado.
  assert.equal(blockHasStyleWrapper({ blockType: 'title', settings: {} }, { hasActionTarget: true }), true)
  // Un fieldWidth válido implica variable -> wrapper.
  assert.equal(blockHasStyleWrapper({ blockType: 'short_text', settings: { fieldWidth: 40 } }), true)
})

test('buildVideoFrameStyleVars: defaults y modo retrato (content #1)', () => {
  const vars = buildVideoFrameStyleVars({}, '')
  assert.equal(vars['--rstk-video-bg'], '#000000')
  assert.equal(vars['--rstk-video-radius'], '18px')
  assert.equal(vars['--rstk-video-border-color'], 'var(--rstk-border)')
  assert.equal(vars['--rstk-video-border-width'], '0px')
  assert.equal(vars['--rstk-video-aspect-ratio'], '16 / 9')
  assert.equal(vars['--rstk-media-width'], undefined)

  const portrait = buildVideoFrameStyleVars({ videoOrientation: 'portrait' }, '')
  assert.equal(portrait['--rstk-video-aspect-ratio'], '9 / 16')
  assert.equal(portrait['--rstk-media-width'], undefined)

  const styled = buildVideoFrameStyleVars({ videoPlayerBackground: '#112233', videoPlayerRadius: 200, videoPlayerBorderColor: '#38bdf8', videoPlayerBorderWidth: 30 })
  assert.equal(styled['--rstk-video-bg'], '#112233')
  assert.equal(styled['--rstk-video-radius'], '80px')
  assert.equal(styled['--rstk-video-border-color'], '#38bdf8')
  assert.equal(styled['--rstk-video-border-width'], '12px')
})

test('parseCountdownTargetDate: normalización UTC determinista (content #12)', () => {
  assert.equal(parseCountdownTargetDate('2030-05-01'), Date.UTC(2030, 4, 1))
  assert.equal(parseCountdownTargetDate('2030-05-01 10:30'), Date.UTC(2030, 4, 1, 10, 30))
  assert.equal(parseCountdownTargetDate('2030-05-01 10:30+0200'), Date.UTC(2030, 4, 1, 8, 30))
  assert.equal(parseCountdownTargetDate('2030-05-01T10:30:00Z'), Date.UTC(2030, 4, 1, 10, 30))
  assert.equal(parseCountdownTargetDate(''), null)
  assert.equal(parseCountdownTargetDate('no-es-fecha'), null)
})

test('countdownShowLabelsValue: coerción del editor (content #12)', () => {
  assert.equal(countdownShowLabelsValue(undefined), true)
  assert.equal(countdownShowLabelsValue(true), true)
  assert.equal(countdownShowLabelsValue('true'), true)
  assert.equal(countdownShowLabelsValue(1), true)
  assert.equal(countdownShowLabelsValue(false), false)
  assert.equal(countdownShowLabelsValue('false'), false)
  assert.equal(countdownShowLabelsValue('0'), false)
})

test('extractWistiaMediaId cubre URLs y snippets (content #9)', () => {
  assert.equal(extractWistiaMediaId('https://fast.wistia.net/embed/iframe/abc123'), 'abc123')
  assert.equal(extractWistiaMediaId('https://miempresa.wistia.com/medias/xyz789'), 'xyz789')
  assert.equal(extractWistiaMediaId('<script src="https://fast.wistia.com/embed/def456.js" async></script>'), 'def456')
  assert.equal(extractWistiaMediaId('<div class="wistia_async_ghi012"></div>'), 'ghi012')
  assert.equal(extractWistiaMediaId('https://www.youtube.com/watch?v=abc'), '')
  assert.equal(wistiaEmbedIframeUrl('abc123'), 'https://fast.wistia.net/embed/iframe/abc123')
})

test('normalizeSocialPlatform respeta fallback y plataformas soportadas (content #7)', () => {
  assert.equal(normalizeSocialPlatform('instagram'), 'instagram')
  assert.equal(normalizeSocialPlatform('threads'), 'threads')
  assert.equal(normalizeSocialPlatform('', 'tiktok'), 'tiktok')
  assert.equal(normalizeSocialPlatform('otra-cosa'), 'facebook')
})

// ---------------------------------------------------------------------------
// Superficies embebidas (Paquete D)
// ---------------------------------------------------------------------------

test('buildPopupSurfaceVars: defaults conscientes del modo + clamps del shell (embeds #11/#12)', () => {
  const dark = buildPopupSurfaceVars({}, true)
  assert.equal(dark['--rstk-popup-bg'], '#0f172a')
  assert.equal(dark['--rstk-popup-text'], '#f8fafc')
  assert.equal(dark['--rstk-popup-backdrop'], 'rgba(2, 6, 23, 0.62)')
  assert.equal(dark['--rstk-popup-max-width'], '560px')
  assert.equal(dark['--rstk-popup-border-width'], '1px')
  assert.equal(dark['--rstk-popup-radius'], '18px')
  assert.equal(dark['--rstk-popup-padding'], '24px')

  const light = buildPopupSurfaceVars({}, false)
  assert.equal(light['--rstk-popup-bg'], '#ffffff')
  assert.equal(light['--rstk-popup-text'], '#111827')

  const custom = buildPopupSurfaceVars({
    popupBackgroundColor: '#123456',
    popupTextColor: '#fefefe',
    popupMaxWidth: 2000,
    popupBorderWidth: 40,
    popupRadius: -5,
    popupPadding: 500
  }, false)
  assert.equal(custom['--rstk-popup-bg'], '#123456')
  assert.equal(custom['--rstk-popup-text'], '#fefefe')
  assert.equal(custom['--rstk-popup-max-width'], '960px')
  assert.equal(custom['--rstk-popup-border-width'], '12px')
  assert.equal(custom['--rstk-popup-radius'], '0px')
  assert.equal(custom['--rstk-popup-padding'], '96px')
})

test('appendCalendarEmbedParams custom: solo colores DEFINIDOS, toggles siempre, layout clásico (embeds #9)', () => {
  const src = appendCalendarEmbedParams('/calendar/mi-cal?test=1', {
    calendarDesignMode: 'custom',
    calendarLayout: 'compact',
    calendarWidgetTheme: 'agenda',
    calendarFontFamily: 'serif',
    calendarAccentColor: '#ff0055',
    calendarSlotRadius: 40,
    calendarShowSidebar: false,
    calendarCoverImage: 'https://cdn.example.com/cover.png'
  }, { preview: true })
  assert.ok(src.startsWith('/calendar/mi-cal?'))
  const url = new URL(src, 'https://rstk.local')
  assert.equal(url.searchParams.get('test'), '1')
  assert.equal(url.searchParams.get('embed'), '1')
  assert.equal(url.searchParams.get('designMode'), 'custom')
  assert.equal(url.searchParams.get('editor_preview'), '1')
  // Layout siempre clásico aunque el bloque guarde otro valor legacy.
  assert.equal(url.searchParams.get('layout'), 'classic')
  assert.equal(url.searchParams.get('widgetTheme'), 'agenda')
  assert.equal(url.searchParams.get('fontFamily'), 'serif')
  assert.equal(url.searchParams.get('coverImage'), 'https://cdn.example.com/cover.png')
  // Color definido viaja; los NO definidos se resuelven dentro del widget.
  assert.equal(url.searchParams.get('accent'), '#ff0055')
  assert.equal(url.searchParams.get('text'), null)
  // Números con clamp del contrato (0-32).
  assert.equal(url.searchParams.get('slotRadius'), '32')
  assert.equal(url.searchParams.get('fieldRadius'), null)
  // Toggles SIEMPRE (ON por defecto, OFF explícito).
  assert.equal(url.searchParams.get('showSidebar'), '0')
  assert.equal(url.searchParams.get('showIcon'), '1')
  assert.equal(url.searchParams.get('allowTimezoneSelection'), '1')
})

test('appendCalendarEmbedParams original: no fuerza estilo ni toggles', () => {
  const src = appendCalendarEmbedParams('/calendar/mi-cal?test=1', {
    calendarDesignMode: 'original',
    calendarAccentColor: '#ff0055',
    calendarWidgetTheme: 'agenda',
    calendarShowSidebar: false
  }, {})
  const url = new URL(src, 'https://rstk.local')
  assert.equal(url.searchParams.get('designMode'), 'original')
  assert.equal(url.searchParams.get('accent'), null)
  assert.equal(url.searchParams.get('widgetTheme'), null)
  assert.equal(url.searchParams.get('showSidebar'), null)
  assert.equal(url.searchParams.get('editor_preview'), null)
})

test('appendCalendarEmbedParams: override Meta ya resuelto y URLs absolutas/vacías', () => {
  const withMeta = new URL(appendCalendarEmbedParams('/calendar/x', {}, {
    bookingBridge: true,
    metaCalEvent: 'Lead',
    metaCalData: '{"value":10}'
  }), 'https://rstk.local')
  assert.equal(withMeta.searchParams.get('bookingBridge'), '1')
  assert.equal(withMeta.searchParams.get('metaCalEvent'), 'Lead')
  assert.equal(withMeta.searchParams.get('metaCalData'), '{"value":10}')

  const noMeta = new URL(appendCalendarEmbedParams('/calendar/x', {}, { metaCalEvent: '', metaCalData: '' }), 'https://rstk.local')
  assert.equal(noMeta.searchParams.get('metaCalEvent'), null)
  assert.equal(noMeta.searchParams.get('metaCalData'), null)

  const absolute = appendCalendarEmbedParams('https://cal.example.com/calendar/x?y=1', {}, {})
  assert.ok(absolute.startsWith('https://cal.example.com/calendar/x?'))
  assert.equal(new URL(absolute).searchParams.get('y'), '1')

  assert.equal(appendCalendarEmbedParams('', {}, {}), '')
})

test('buildFormStyleContext expone el subconjunto del estado que consumen los proxies', () => {
  const state = computeSitePageRenderState({ siteType: 'landing_page', theme: { template: 'premium' } })
  const ctx = buildFormStyleContext(state)
  assert.equal(ctx.baseFont, state.baseFont)
  assert.equal(ctx.v, state.renderVars)
  assert.equal(ctx.accent, state.accent)
  assert.equal(ctx.ink, state.ink)
  assert.equal(ctx.muted, state.muted)
  assert.equal(ctx.pageBg, blockTextContrastBackground(state))
})

test('buildEmbeddedFormProxyVars: hereda ink/muted del anfitrión; blanco default NO es fondo explícito (embeds #14)', () => {
  const state = computeSitePageRenderState({ siteType: 'landing_page', theme: { template: 'premium' } })
  const ctx = buildFormStyleContext(state)

  assert.deepEqual(buildEmbeddedFormProxyVars({ ...DEFAULT_THEME }, null), {})

  const inherited = buildEmbeddedFormProxyVars({ ...DEFAULT_THEME }, ctx)
  assert.equal(inherited['--rstk-ink'], ctx.ink)
  assert.equal(inherited['--rstk-muted'], ctx.muted)
  assert.equal(inherited['--rstk-block-bg'], undefined)

  const explicitBg = buildEmbeddedFormProxyVars({ ...DEFAULT_THEME, backgroundColor: '#111827' }, ctx)
  assert.equal(explicitBg['--rstk-block-bg'], '#111827')

  const gradientBg = buildEmbeddedFormProxyVars({
    ...DEFAULT_THEME,
    backgroundColor: 'linear-gradient(145deg, rgba(15, 23, 42, 0.96), rgba(12, 10, 10, 0.96))'
  }, ctx)
  assert.equal(gradientBg['--rstk-block-bg'], 'linear-gradient(145deg, rgba(15, 23, 42, 0.96), rgba(12, 10, 10, 0.96))')
})

test('buildEmbeddedFormProxyVars: textColor propio recalcula ink legible y muted mezclado', () => {
  const state = computeSitePageRenderState({ siteType: 'landing_page', theme: { template: 'ristak' } })
  const ctx = buildFormStyleContext(state)
  const vars = buildEmbeddedFormProxyVars({
    ...DEFAULT_THEME,
    textColor: '#123456',
    textColorCustom: true,
    submitBg: '#0f2348'
  }, ctx)
  const proxyBg = ctx.pageBg || ctx.v.pageBg
  assert.notEqual(vars['--rstk-ink'], undefined)
  assert.equal(vars['--rstk-muted'], `color-mix(in srgb, ${vars['--rstk-ink']} 60%, ${proxyBg})`)
  // Incluye las variables de formulario/submit del contrato (mismo emisor que el gate en vivo).
  assert.equal(vars['--rstk-submit-bg'], '#0f2348')
})

test('cadena de theme del embed DRAFT: hereda template del ANFITRIÓN con explicitud cruda (embeds #3)', () => {
  // Sin fuente (draft): el frame vive con el template/vars del landing anfitrión.
  const { sourceTheme } = buildEmbeddedFormTheme({
    hostTheme: { template: 'premium' },
    sourceFormTheme: {},
    embeddedThemeOverride: { pageBorderWidth: 0, pageBorderColor: 'transparent' },
    isImportedForm: false
  })
  assert.equal(sourceTheme.template, 'premium')
  const state = computeSitePageRenderState({ siteType: 'standard_form', theme: sourceTheme })
  assert.equal(state.template.id, 'premium')
  // La cadena cruda no trae backgroundColor => conserva la paleta del template.
  assert.equal(state.hasExplicitBackgroundColor, false)
  assert.equal(state.vars['--rstk-page-bg'], SITE_TEMPLATES.premium.vars.pageBg)

  // Con fondo elegido en el anfitrión, el frame SÍ lo hereda como explícito.
  const { sourceTheme: withBg } = buildEmbeddedFormTheme({
    hostTheme: { template: 'premium', backgroundColor: '#0b1220' },
    sourceFormTheme: {},
    isImportedForm: false
  })
  const stateWithBg = computeSitePageRenderState({ siteType: 'standard_form', theme: withBg })
  assert.equal(stateWithBg.hasExplicitBackgroundColor, true)
  assert.equal(stateWithBg.vars['--rstk-page-bg'], '#0b1220')
})
