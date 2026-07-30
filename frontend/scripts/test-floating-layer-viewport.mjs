import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const readSource = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8')

const [
  dropdownSource,
  dropdownStyles,
  globalStyles,
  anchoredPortalSource,
  sitesStyles,
  viewSelectorSource,
  customSelectSource,
  tagPickerSource,
  contactSearchSource,
  globalSearchSource,
  metaParameterValueSource,
  treeFilterSource,
  appointmentModalSource,
  dateRangePickerSource,
  dateTimePickerSource,
  appointmentsSource,
  accountSettingsSource,
  conditionBuilderSource,
  customFieldsSource,
  tagsSettingsSource,
  messageTemplatesSource,
  sitesSource,
  desktopChatSource,
  desktopChatStyles,
  conversationalAgentSource,
  aiAgentStyles,
  automationComposerSource,
  drillSelectSource,
  stepPickerSource,
  messageBlocksSource
] = await Promise.all([
  readSource('../src/components/common/DropdownMenu/DropdownMenu.tsx'),
  readSource('../src/components/common/DropdownMenu/DropdownMenu.module.css'),
  readSource('../src/styles/index.css'),
  readSource('../src/hooks/useAnchoredPortal.ts'),
  readSource('../src/pages/Sites/Sites.module.css'),
  readSource('../src/components/common/ViewSelector/ViewSelector.tsx'),
  readSource('../src/components/common/CustomSelect/CustomSelect.tsx'),
  readSource('../src/components/common/TagPicker/TagPicker.tsx'),
  readSource('../src/components/common/ContactSearchInput/ContactSearchInput.tsx'),
  readSource('../src/components/common/GlobalSearch/GlobalSearch.tsx'),
  readSource('../src/components/common/MetaParameterValueInput/MetaParameterValueInput.tsx'),
  readSource('../src/components/common/TreeFilter/TreeFilter.tsx'),
  readSource('../src/components/common/AppointmentModal/AppointmentModal.tsx'),
  readSource('../src/components/common/DateRangePicker/DateRangePicker.tsx'),
  readSource('../src/components/common/DateTimePicker/DateTimePicker.tsx'),
  readSource('../src/pages/Appointments/Appointments.tsx'),
  readSource('../src/pages/Settings/AccountSettings.tsx'),
  readSource('../src/pages/Settings/ConditionBuilder.tsx'),
  readSource('../src/pages/Settings/CustomFields.tsx'),
  readSource('../src/pages/Settings/TagsSettings.tsx'),
  readSource('../src/pages/Settings/MessageTemplates.tsx'),
  readSource('../src/pages/Sites/Sites.tsx'),
  readSource('../src/pages/DesktopChat/DesktopChat.tsx'),
  readSource('../src/pages/DesktopChat/DesktopChat.module.css'),
  readSource('../src/pages/Settings/ConversationalAgentSettings.tsx'),
  readSource('../src/pages/Settings/ConversationalAgentSettings.module.css'),
  readSource('../src/pages/Automations/editor/composer/MessageComposer.tsx'),
  readSource('../src/pages/Automations/editor/config/DrillSelect.tsx'),
  readSource('../src/pages/Automations/editor/StepPickerBubble.tsx'),
  readSource('../src/pages/Automations/editor/config/MessageBlocksEditor.tsx')
])

assert.match(
  dropdownSource,
  /collisionPadding = 12[\s\S]*avoidCollisions = true[\s\S]*sticky = 'always'/,
  'DropdownMenu debe evitar colisiones con un margen visible por default'
)
assert.match(
  dropdownSource,
  /position: 'relative'[\s\S]*top: 'auto'[\s\S]*bottom: 'auto'/,
  'DropdownMenu debe neutralizar posicionamiento absoluto heredado de consumidores legacy'
)
assert.match(
  dropdownStyles,
  /max-height:\s*min\(calc\(100dvh - 24px\), var\(--radix-dropdown-menu-content-available-height\)\)/,
  'DropdownMenu debe limitar su altura al espacio que Radix calculó dentro del viewport'
)
assert.match(
  dropdownStyles,
  /overflow-y:\s*auto/,
  'las opciones deben seguir accesibles mediante scroll cuando ninguna dirección tiene altura suficiente'
)
assert.match(
  globalStyles,
  /\[data-ristak-dropdown-panel\][\s\S]*max-height:\s*min\([\s\S]*--radix-dropdown-menu-content-available-height[\s\S]*overflow-y:\s*auto/,
  'todo panel desplegable identificado por el sistema debe respetar la altura del viewport'
)

assert.match(
  anchoredPortalSource,
  /const available = openAbove \? spaceAbove : spaceBelow[\s\S]*const height = Math\.min\(maxHeight, available\)/,
  'el portal anclado debe usar el espacio real disponible, sin mínimos que lo saquen de pantalla'
)
assert.doesNotMatch(
  anchoredPortalSource,
  /Math\.max\((?:120|140|160|180|220),\s*openAbove/,
  'el portal anclado no debe imponer una altura mínima mayor que el viewport'
)
assert.match(
  anchoredPortalSource,
  /const width = Math\.min\(preferredWidth, maxWidth \|\| preferredWidth, viewportContentWidth\)/,
  'el portal anclado también debe caber horizontalmente'
)
assert.match(
  anchoredPortalSource,
  /panelRef\?\.current\?\.offsetWidth[\s\S]*align === 'end'[\s\S]*right: 'auto'[\s\S]*bottom: 'auto'/,
  'el portal anclado debe medir paneles variables, alinearlos y neutralizar coordenadas legacy'
)

const siteMenuBlocks = [...sitesStyles.matchAll(/\.pageMenu\s*\{([^}]*)\}/g)]
assert.ok(siteMenuBlocks.length > 0, 'Sitios debe conservar el estilo visual de su menú de acciones')
for (const [, block] of siteMenuBlocks) {
  assert.doesNotMatch(
    block,
    /\b(?:position|top|right|bottom|left)\s*:/,
    'Sitios no debe volver a sobreescribir la posición calculada por DropdownMenu'
  )
}

assert.match(
  viewSelectorSource,
  /<DropdownMenu[\s\S]*<DropdownMenuContent/,
  'ViewSelector debe usar el menú global con detección de colisiones'
)
for (const [name, source] of [
  ['CustomSelect', customSelectSource],
  ['TagPicker', tagPickerSource],
  ['ContactSearchInput', contactSearchSource]
]) {
  assert.match(
    source,
    /useAnchoredPortal/,
    `${name} debe compartir el posicionamiento adaptativo de portales`
  )
}
assert.match(tagPickerSource, /portal = true/, 'TagPicker debe portalar por default para evitar recortes')
assert.match(contactSearchSource, /portal = true/, 'ContactSearchInput debe portalar por default para evitar recortes')

for (const [name, source] of [
  ['GlobalSearch', globalSearchSource],
  ['MetaParameterValueInput', metaParameterValueSource],
  ['TreeFilter', treeFilterSource],
  ['AppointmentModal', appointmentModalSource],
  ['DateRangePicker', dateRangePickerSource],
  ['DateTimePicker', dateTimePickerSource],
  ['AccountSettings', accountSettingsSource],
  ['ConditionBuilder', conditionBuilderSource],
  ['MessageTemplates', messageTemplatesSource],
  ['Sites', sitesSource],
  ['Chat de escritorio', desktopChatSource],
  ['Modelos del agente conversacional', conversationalAgentSource],
  ['Automation MessageComposer', automationComposerSource],
  ['Automation DrillSelect', drillSelectSource]
]) {
  assert.match(
    source,
    /useAnchoredPortal/,
    `${name} debe usar el posicionamiento anclado común en sus paneles legacy`
  )
}

for (const [name, source, selector] of [
  ['selector de color de Sites', sitesStyles, 'colorPopover'],
  ['modelos del agente conversacional', aiAgentStyles, 'aiProviderDropdownMenu']
]) {
  const blocks = [...source.matchAll(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`, 'g'))]
  assert.ok(blocks.length > 0, `${name} debe conservar su estilo visual`)
  for (const [, block] of blocks) {
    assert.doesNotMatch(
      block,
      /\b(?:position|top|right|bottom|left)\s*:/,
      `${name} no debe fijar coordenadas que anulen el cálculo común`
    )
  }
}

for (const selector of ['composerMenu', 'templatePanel', 'agentComposerMenu']) {
  const block = desktopChatStyles.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`))?.[1] || ''
  assert.ok(block, `Chat de escritorio debe conservar el estilo de ${selector}`)
  assert.doesNotMatch(
    block,
    /\b(?:position|top|right|bottom|left)\s*:/,
    `Chat de escritorio no debe fijar la posición de ${selector} fuera del cálculo común`
  )
  assert.match(
    block,
    /overflow(?:-y)?:\s*auto/,
    `Chat de escritorio debe permitir scroll en ${selector} cuando la ventana sea pequeña`
  )
}

assert.match(
  appointmentsSource,
  /useAnchoredPortal[\s\S]*<DropdownMenu[\s\S]*<DropdownMenuContent/,
  'Citas debe usar el portal compartido en búsqueda y DropdownMenu en mes/año'
)
for (const [name, source] of [
  ['Campos personalizados', customFieldsSource],
  ['Etiquetas', tagsSettingsSource],
  ['Plantillas de mensajes', messageTemplatesSource]
]) {
  assert.match(
    source,
    /<DropdownMenu[\s\S]*<DropdownMenuContent/,
    `${name} debe usar DropdownMenu para las acciones de carpeta`
  )
}

assert.doesNotMatch(
  stepPickerSource,
  /Math\.max\((?:90|320),\s*bounds\.(?:width|height)/,
  'el selector de pasos de Automatizaciones no debe imponer mínimos mayores que sus límites'
)
assert.match(
  messageBlocksSource,
  /const maxHeight = Math\.max\(0, window\.innerHeight - 16\)[\s\S]*overflowY: 'auto'/,
  'el popover de retraso debe limitarse al alto real de la ventana'
)

console.log('Floating layer viewport contract OK')
