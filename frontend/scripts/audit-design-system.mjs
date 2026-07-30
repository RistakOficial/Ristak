import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname)
const srcRoot = path.join(repoRoot, 'src')

const excludedPathParts = [
  `${path.sep}components${path.sep}common${path.sep}`,
  `${path.sep}components${path.sep}phone${path.sep}`,
  `${path.sep}pages${path.sep}Automations${path.sep}`,
  `${path.sep}pages${path.sep}Login${path.sep}`,
  `${path.sep}pages${path.sep}Phone`,
  `${path.sep}pages${path.sep}PublicPayment${path.sep}`,
  `${path.sep}pages${path.sep}Sites${path.sep}`,
]

const legacyReusablePatternFiles = new Set([
  'src/pages/Campaigns/Campaigns.module.css',
  'src/pages/Contacts/Contacts.module.css',
  'src/pages/Contacts/Contacts.tsx',
  'src/pages/Settings/Costs.module.css',
  'src/pages/Settings/Costs.tsx',
  'src/pages/Settings/CustomFields.module.css',
  'src/pages/Settings/CustomFields.tsx',
  'src/pages/Settings/HighLevelIntegration.module.css',
  'src/pages/Settings/HighLevelIntegration.tsx',
  'src/pages/Settings/Settings.module.css',
  'src/pages/Settings/TagsSettings.tsx',
  'src/pages/Settings/TriggerLinks.tsx',
  'src/pages/Settings/VariableFields.tsx',
  'src/pages/Settings/WhatsAppSettings.module.css',
  'src/pages/Settings/WhatsAppSettings.tsx',
  'src/pages/Transactions/Transactions.module.css',
  'src/pages/Transactions/Transactions.tsx',
])

const legacySemanticColorFiles = new Set([
  'src/components/layout/Header/Header.tsx',
  'src/pages/Analytics/Analytics.tsx',
  'src/pages/Appointments/Appointments.module.css',
  'src/pages/Campaigns/Campaigns.tsx',
  'src/pages/Dashboard/Dashboard.tsx',
  'src/pages/DesktopChat/DesktopChat.module.css',
  'src/pages/Reports/Reports.tsx',
  'src/pages/Settings/CalendarsConfiguration.tsx',
  'src/pages/Settings/Costs.tsx',
  'src/styles/index.css',
  'src/theme/tokens.ts',
])

const checks = [
  {
    id: 'reusable-css',
    label: 'CSS local de patrones reutilizables',
    extensions: new Set(['.css']),
    pattern: /\.(searchBox|searchInput|inputWithIcon|tabs|tabList|badge|pill|modal|overlay|table)\b/g,
    hint: 'Usa o extiende common/: SearchField, Button, TabList/SegmentTabs, Badge, Modal, Table, DropdownMenu.',
  },
  {
    id: 'reusable-jsx',
    label: 'JSX atado a clases locales de patrones reutilizables',
    extensions: new Set(['.tsx', '.ts']),
    pattern: /styles\.(searchBox|searchInput|inputWithIcon|tabs|tabList|badge|pill|modal|overlay|table)\b/g,
    hint: 'Mueve el patron a un componente global o usa el componente global existente.',
  },
  {
    id: 'semantic-color',
    label: 'Colores semanticos hardcodeados',
    extensions: new Set(['.css', '.tsx', '.ts']),
    pattern: /#(?:10b981|22c55e|16a34a|dc2626|ef4444)\b|text-(?:green|red)-/gi,
    hint: 'Usa var(--pos), var(--neg), var(--warn), var(--info) o Badge/statusBadges.',
  },
]

async function collectFiles(dir, { includeExcluded = false } = {}) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name)
    if (!includeExcluded && excludedPathParts.some((part) => absolutePath.includes(part))) continue

    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolutePath, { includeExcluded }))
      continue
    }

    if (entry.isFile() && ['.css', '.tsx', '.ts'].includes(path.extname(entry.name))) {
      files.push(absolutePath)
    }
  }

  return files
}

function toRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/')
}

function lineNumberForIndex(source, index) {
  return source.slice(0, index).split('\n').length
}

const files = await collectFiles(srcRoot)
const violations = []

for (const file of files) {
  const relativePath = toRelative(file)
  const extension = path.extname(file)
  const source = await readFile(file, 'utf8')

  for (const check of checks) {
    if (!check.extensions.has(extension)) continue

    check.pattern.lastIndex = 0
    let match
    while ((match = check.pattern.exec(source)) !== null) {
      if ((check.id === 'reusable-css' || check.id === 'reusable-jsx') && legacyReusablePatternFiles.has(relativePath)) continue
      if (check.id === 'semantic-color' && legacySemanticColorFiles.has(relativePath)) continue

      violations.push({
        file: relativePath,
        line: lineNumberForIndex(source, match.index),
        check: check.label,
        value: match[0],
        hint: check.hint,
      })
    }
  }
}

const allFiles = await collectFiles(srcRoot, { includeExcluded: true })
const nativeNumberInputPattern = /<input\b[^>]*\btype\s*=\s*(?:"number"|'number'|\{\s*["']number["']\s*\})[^>]*>/gis

for (const file of allFiles) {
  const relativePath = toRelative(file)
  const extension = path.extname(file)
  if (!['.tsx', '.ts'].includes(extension)) continue

  const source = await readFile(file, 'utf8')
  nativeNumberInputPattern.lastIndex = 0

  let match
  while ((match = nativeNumberInputPattern.exec(source)) !== null) {
    violations.push({
      file: relativePath,
      line: lineNumberForIndex(source, match.index),
      check: 'Input numerico nativo prohibido',
      value: '<input type="number">',
      hint: 'Usa NumberInput en escritorio o un input type="text" con inputMode numerico en primitivas moviles. Los steppers nativos estan prohibidos.',
    })
  }
}

const sitesSource = await readFile(path.join(srcRoot, 'pages/Sites/Sites.tsx'), 'utf8')
const sitesStyles = await readFile(path.join(srcRoot, 'pages/Sites/Sites.module.css'), 'utf8')
const flatContractStart = '/* INSPECTOR FLAT-CONTENT CONTRACT — START'
const flatContractEnd = '/* INSPECTOR FLAT-CONTENT CONTRACT — END */'
const flatContractStartIndex = sitesStyles.indexOf(flatContractStart)
const flatContractEndIndex = sitesStyles.indexOf(flatContractEnd)

if (!sitesSource.includes('data-inspector-section-content')) {
  violations.push({
    file: 'src/pages/Sites/Sites.tsx',
    line: 1,
    check: 'Jerarquia plana del inspector de Sites',
    value: 'AccordionSection sin marcador de contenido',
    hint: 'Conserva data-inspector-section-content en el cuerpo expandido del acordeon.',
  })
}

if (flatContractStartIndex === -1 || flatContractEndIndex === -1) {
  violations.push({
    file: 'src/pages/Sites/Sites.module.css',
    line: 1,
    check: 'Jerarquia plana del inspector de Sites',
    value: 'Contrato visual ausente',
    hint: 'Restaura el contrato que deja una sola superficie por categoria expandida.',
  })
} else {
  const flatContract = sitesStyles.slice(flatContractStartIndex, flatContractEndIndex)
  const requiredFlatSelectors = [
    '.propertiesBody :is(',
    '.settingsGroup,',
    '.blockStyleControls,',
    '.formGlobalControls,',
    '.textFormatPanel,',
    '.typographyInspector,',
    '.customFieldBinding,',
    '.optionRules',
    '.accordionBody .accordionSection',
    '.propertiesBody .videoSettingsSection',
    '.propertiesBody .advancedBody',
    '.propertiesBody .optionRuleCard',
  ]

  for (const selector of requiredFlatSelectors) {
    if (flatContract.includes(selector)) continue

    violations.push({
      file: 'src/pages/Sites/Sites.module.css',
      line: lineNumberForIndex(sitesStyles, flatContractStartIndex),
      check: 'Jerarquia plana del inspector de Sites',
      value: `Falta ${selector}`,
      hint: 'Todos los wrappers de agrupacion deben seguir planos dentro de la categoria expandida.',
    })
  }
}

const directVideoNesting = '.accordionBody > .videoSettingsBox > .videoSettingsSection'
if (sitesStyles.includes(directVideoNesting)) {
  violations.push({
    file: 'src/pages/Sites/Sites.module.css',
    line: lineNumberForIndex(sitesStyles, sitesStyles.indexOf(directVideoNesting)),
    check: 'Jerarquia plana del inspector de Sites',
    value: directVideoNesting,
    hint: 'No dependas de hijos directos: Video puede vivir dentro de settingsGroup u otros wrappers compartidos.',
  })
}

const htmlPaneContractStart = '/* HTML EDITOR FLAT-PANE CONTRACT — START'
const htmlPaneContractEnd = '/* HTML EDITOR FLAT-PANE CONTRACT — END */'
const htmlPaneContractStartIndex = sitesStyles.indexOf(htmlPaneContractStart)
const htmlPaneContractEndIndex = sitesStyles.indexOf(htmlPaneContractEnd)

if (htmlPaneContractStartIndex === -1 || htmlPaneContractEndIndex === -1) {
  violations.push({
    file: 'src/pages/Sites/Sites.module.css',
    line: 1,
    check: 'Jerarquia plana del editor HTML de Sites',
    value: 'Contrato visual ausente',
    hint: 'Restaura la superficie unica de Codigo, vista previa e inspector.',
  })
} else {
  const htmlPaneContract = sitesStyles.slice(htmlPaneContractStartIndex, htmlPaneContractEndIndex)
  const requiredHtmlPaneSelectors = [
    '.importedCodeEditorPanel.importedCodeEditorPanelWithInspector',
    '.importedCodeEditorPanel > :is(.importedCodeSourcePane, .importedCodePreviewPane)',
    '.importedCodeEditorPanel > .importedCodeResizeHandle::before',
    '.propertiesPanel.importedCodeNativeInspectorPane',
    'border-left: 1px solid var(--border) !important',
    'border-radius: 0 !important',
    'column-gap: 0',
    'grid-column: auto !important',
  ]

  for (const selector of requiredHtmlPaneSelectors) {
    if (htmlPaneContract.includes(selector)) continue

    violations.push({
      file: 'src/pages/Sites/Sites.module.css',
      line: lineNumberForIndex(sitesStyles, htmlPaneContractStartIndex),
      check: 'Jerarquia plana del editor HTML de Sites',
      value: `Falta ${selector}`,
      hint: 'Codigo, vista previa e inspector deben compartir superficie y separarse solo con divisores.',
    })
  }
}

const compactHtmlPaneStart = sitesStyles.indexOf('@media (max-width: 1680px), (max-height: 900px)')
const compactHtmlPaneEnd = sitesStyles.indexOf('@media (max-width: 1540px), (max-height: 820px)', compactHtmlPaneStart)
const compactHtmlPaneRules = compactHtmlPaneStart === -1 || compactHtmlPaneEnd === -1
  ? ''
  : sitesStyles.slice(compactHtmlPaneStart, compactHtmlPaneEnd)

if (!compactHtmlPaneRules.includes('.importedCodeEditorPanelWithInspector')) {
  violations.push({
    file: 'src/pages/Sites/Sites.module.css',
    line: lineNumberForIndex(sitesStyles, Math.max(compactHtmlPaneStart, 0)),
    check: 'Columnas del editor HTML en escritorio compacto',
    value: 'Falta la cuadricula con inspector',
    hint: 'Conserva Codigo, vista previa e inspector en una misma fila hasta el breakpoint apilado.',
  })
}

if (violations.length > 0) {
  console.error('Design system audit failed. Reusable UI patterns must live in frontend/src/components/common or global recipes.\n')

  for (const violation of violations.slice(0, 80)) {
    console.error(`${violation.file}:${violation.line} ${violation.check}: ${violation.value}`)
    console.error(`  ${violation.hint}`)
  }

  if (violations.length > 80) {
    console.error(`\n...and ${violations.length - 80} more violations.`)
  }

  process.exit(1)
}

console.log('Design system audit passed. No new local reusable UI patterns found.')
