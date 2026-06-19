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
  'src/components/ai/AIAgentPanel/AIAgentPanel.module.css',
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

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name)
    if (excludedPathParts.some((part) => absolutePath.includes(part))) continue

    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolutePath))
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
