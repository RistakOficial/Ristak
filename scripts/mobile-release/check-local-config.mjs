#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const EXPECTED_TEMPLATE_KEYS = [
  'MOBILE_RELEASE_CREDENTIAL_SOURCE',
  'MOBILE_RELEASE_DEFAULT_PLATFORM',
  'MOBILE_RELEASE_SUBMIT_FOR_REVIEW',
  'MOBILE_RELEASE_GITHUB_BRANCH',
  'MOBILE_RELEASE_INSTALLER_URL',
  'MOBILE_RELEASE_IOS_VERSION',
  'IOS_APPLE_ID',
  'IOS_APPLE_TEAM_ID',
  'IOS_BUNDLE_ID',
  'IOS_APP_STORE_CONNECT_KEY_ID',
  'IOS_APP_STORE_CONNECT_ISSUER_ID',
  'IOS_APP_STORE_CONNECT_API_KEY_PATH',
  'IOS_DISTRIBUTION_CERTIFICATE_PATH',
  'IOS_DISTRIBUTION_CERTIFICATE_PASSWORD',
  'IOS_APPSTORE_PROVISIONING_PROFILE_PATH',
  'IOS_CI_KEYCHAIN_PASSWORD',
  'IOS_EXPORT_OPTIONS_PLIST',
  'MOBILE_RELEASE_ANDROID_VERSION_NAME',
  'MOBILE_RELEASE_ANDROID_TRACK',
  'ANDROID_PACKAGE_NAME',
  'ANDROID_KEYSTORE_PROPERTIES_PATH',
  'ANDROID_KEYSTORE_PATH',
  'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH'
]

const HELP = {
  MOBILE_RELEASE_INSTALLER_URL: {
    get: 'Get it from the Ristak Installer public Render/custom domain.',
    put: 'Set MOBILE_RELEASE_INSTALLER_URL in .mobile-release.local.env.'
  },
  IOS_APP_STORE_CONNECT_KEY_ID: {
    get: 'App Store Connect > Users and Access > Integrations > App Store Connect API.',
    put: 'Set IOS_APP_STORE_CONNECT_KEY_ID in .mobile-release.local.env.'
  },
  IOS_APP_STORE_CONNECT_ISSUER_ID: {
    get: 'App Store Connect > Users and Access > Integrations > App Store Connect API.',
    put: 'Set IOS_APP_STORE_CONNECT_ISSUER_ID in .mobile-release.local.env.'
  },
  IOS_APP_STORE_CONNECT_API_KEY_PATH: {
    get: 'Download the .p8 once from App Store Connect API keys.',
    put: 'Save it under .mobile-release/ios/AuthKey_<KEY_ID>.p8 and set IOS_APP_STORE_CONNECT_API_KEY_PATH.'
  },
  IOS_DISTRIBUTION_CERTIFICATE_PATH: {
    get: 'Apple Developer > Certificates, or export the Apple Distribution certificate from Keychain as .p12.',
    put: 'Save it under .mobile-release/ios/AppleDistribution.p12 and set IOS_DISTRIBUTION_CERTIFICATE_PATH.'
  },
  IOS_DISTRIBUTION_CERTIFICATE_PASSWORD: {
    get: 'Use the password created when exporting the .p12 certificate.',
    put: 'Set IOS_DISTRIBUTION_CERTIFICATE_PASSWORD in .mobile-release.local.env.'
  },
  IOS_APPSTORE_PROVISIONING_PROFILE_PATH: {
    get: 'Apple Developer > Profiles. Use an App Store profile for com.ristak.app with the same distribution certificate.',
    put: 'Save it under .mobile-release/ios/RistakAppStore.mobileprovision and set IOS_APPSTORE_PROVISIONING_PROFILE_PATH.'
  },
  IOS_EXPORT_OPTIONS_PLIST: {
    get: 'This repo already provides the App Store export plist.',
    put: 'Keep IOS_EXPORT_OPTIONS_PLIST pointing to frontend/ios/App/ExportOptions-AppStore.plist unless the repo changes.'
  },
  ANDROID_KEYSTORE_PROPERTIES_PATH: {
    get: 'Create it locally for Gradle release signing; this repo already ignores it.',
    put: 'Put it at frontend/android/app/keystore.properties with storeFile, storePassword, keyAlias and keyPassword.'
  },
  ANDROID_KEYSTORE_PATH: {
    get: 'Use the existing Play upload keystore, or create/download the upload key for this app.',
    put: 'Put it at frontend/android/app/ristak-play-upload.jks or update ANDROID_KEYSTORE_PATH.'
  },
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH: {
    get: 'Google Play Console > Setup > API access > service account with release permissions.',
    put: 'Save the JSON under .mobile-release/android/google-play-service-account.json and set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH.'
  }
}

const VALID_PLATFORMS = new Set(['ios', 'android', 'both'])
const VALID_SOURCES = new Set(['installer', 'local'])
const VALID_TRACKS = new Set(['internal', 'closed', 'production'])

function parseArgs(argv) {
  const args = {
    envFile: '.mobile-release.local.env',
    platform: null,
    source: null,
    template: false
  }

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--template') {
      args.template = true
    } else if (arg === '--env') {
      args.envFile = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--env=')) {
      args.envFile = arg.slice('--env='.length)
    } else if (arg === '--platform') {
      args.platform = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--platform=')) {
      args.platform = arg.slice('--platform='.length)
    } else if (arg === '--source') {
      args.source = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--source=')) {
      args.source = arg.slice('--source='.length)
    } else {
      console.error(`Unknown option: ${arg}`)
      process.exit(2)
    }
  }

  return args
}

function parseEnvFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  const env = {}

  raw.split(/\r?\n/).forEach((line, lineIndex) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) {
      throw new Error(`Invalid env line ${lineIndex + 1}: expected KEY=value`)
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    let value = trimmed.slice(separatorIndex + 1).trim()
    if (!/^[A-Z0-9_]+$/.test(key)) {
      throw new Error(`Invalid env key on line ${lineIndex + 1}: ${key}`)
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    env[key] = value
  })

  return env
}

function isMissingValue(value) {
  if (typeof value !== 'string') return true
  const trimmed = value.trim()
  return !trimmed || trimmed.includes('REPLACE_') || /^<.+>$/.test(trimmed)
}

function toBool(value) {
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

function resolveFromRoot(rootDir, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.join(rootDir, maybePath)
}

function relativeDisplay(rootDir, targetPath) {
  const relative = path.relative(rootDir, targetPath)
  return relative && !relative.startsWith('..') ? relative : targetPath
}

function checkPrivateMode(report, filePath, label) {
  if (process.platform === 'win32') return

  const mode = fs.statSync(filePath).mode & 0o777
  if ((mode & 0o077) !== 0) {
    report.warnings.push(`${label} is readable or writable by group/others. Run: chmod 600 ${filePath}`)
  }
}

function requireVar(report, env, name) {
  if (isMissingValue(env[name])) {
    const help = HELP[name]
    report.errors.push([
      `${name} is missing.`,
      help?.get ? `Get: ${help.get}` : null,
      help?.put ? `Put: ${help.put}` : null
    ].filter(Boolean).join(' '))
    return null
  }
  report.ok.push(`${name} is set`)
  return env[name]
}

function requireFile(report, rootDir, env, name, options = {}) {
  const value = requireVar(report, env, name)
  if (!value) return null

  const targetPath = resolveFromRoot(rootDir, value)
  if (!fs.existsSync(targetPath)) {
    const help = HELP[name]
    report.errors.push([
      `${name} points to a missing file: ${relativeDisplay(rootDir, targetPath)}.`,
      help?.get ? `Get: ${help.get}` : null,
      help?.put ? `Put: ${help.put}` : null
    ].filter(Boolean).join(' '))
    return null
  }

  if (options.extensions?.length) {
    const extension = path.extname(targetPath)
    if (!options.extensions.includes(extension)) {
      report.warnings.push(`${name} should usually end with ${options.extensions.join(' or ')}.`)
    }
  }

  const stat = fs.statSync(targetPath)
  if (!stat.isFile()) {
    report.errors.push(`${name} is not a file: ${relativeDisplay(rootDir, targetPath)}.`)
    return null
  }

  if (stat.size === 0) {
    report.errors.push(`${name} is empty: ${relativeDisplay(rootDir, targetPath)}.`)
    return null
  }

  if (options.private !== false) {
    checkPrivateMode(report, targetPath, name)
  }
  report.ok.push(`${name} file exists`)
  return targetPath
}

function parseProperties(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  const result = {}
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) return
    result[trimmed.slice(0, separatorIndex).trim()] = trimmed.slice(separatorIndex + 1).trim()
  })
  return result
}

function validateGoogleServiceAccount(report, filePath) {
  let payload
  try {
    payload = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    report.errors.push(`Google Play service account JSON is not valid JSON: ${error.message}`)
    return
  }

  for (const key of ['type', 'client_email', 'private_key']) {
    if (isMissingValue(payload[key])) {
      report.errors.push(`Google Play service account JSON is missing ${key}.`)
    }
  }

  if (payload.type && payload.type !== 'service_account') {
    report.errors.push('Google Play service account JSON must have type=service_account.')
  }
}

function validateAndroidKeystore(report, rootDir, env) {
  const keystorePathFromEnv = requireFile(report, rootDir, env, 'ANDROID_KEYSTORE_PATH', { extensions: ['.jks', '.keystore'] })
  const propertiesPath = requireFile(report, rootDir, env, 'ANDROID_KEYSTORE_PROPERTIES_PATH')
  if (!propertiesPath) return

  const properties = parseProperties(propertiesPath)
  for (const key of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword']) {
    if (isMissingValue(properties[key])) {
      report.errors.push(`ANDROID_KEYSTORE_PROPERTIES_PATH is missing ${key}.`)
    }
  }

  const keystorePathFromProperties = properties.storeFile
    ? path.resolve(path.dirname(propertiesPath), properties.storeFile)
    : null
  const keystorePath = keystorePathFromEnv || keystorePathFromProperties

  if (!keystorePath) {
    report.errors.push('Android keystore file is missing. Set ANDROID_KEYSTORE_PATH or storeFile in keystore.properties.')
    return
  }

  if (
    keystorePathFromEnv &&
    keystorePathFromProperties &&
    path.resolve(keystorePathFromEnv) !== path.resolve(keystorePathFromProperties)
  ) {
    report.warnings.push('ANDROID_KEYSTORE_PATH and storeFile in keystore.properties point to different files.')
  }

  if (!fs.existsSync(keystorePath)) {
    report.errors.push(`Android keystore file does not exist: ${relativeDisplay(rootDir, keystorePath)}.`)
    return
  }

  const stat = fs.statSync(keystorePath)
  if (!stat.isFile() || stat.size === 0) {
    report.errors.push(`Android keystore file is invalid: ${relativeDisplay(rootDir, keystorePath)}.`)
    return
  }

  checkPrivateMode(report, keystorePath, 'ANDROID_KEYSTORE_PATH')
  report.ok.push('Android keystore file exists')
}

function validateTemplate(env) {
  const missingKeys = EXPECTED_TEMPLATE_KEYS.filter((key) => !(key in env))
  if (missingKeys.length) {
    console.error('Template is missing expected keys:')
    for (const key of missingKeys) console.error(`- ${key}`)
    process.exit(1)
  }

  console.log(`Template OK. ${EXPECTED_TEMPLATE_KEYS.length} expected keys are present.`)
}

function validateConfig(rootDir, envFilePath, env, args) {
  const report = {
    ok: [],
    warnings: [],
    errors: []
  }

  checkPrivateMode(report, envFilePath, '.mobile-release.local.env')

  const platform = args.platform || env.MOBILE_RELEASE_DEFAULT_PLATFORM || 'both'
  if (!VALID_PLATFORMS.has(platform)) {
    report.errors.push(`Invalid platform "${platform}". Use ios, android, or both.`)
  }

  const source = args.source || env.MOBILE_RELEASE_CREDENTIAL_SOURCE || 'installer'
  if (!VALID_SOURCES.has(source)) {
    report.errors.push(`Invalid credential source "${source}". Use installer or local.`)
  }

  const submitForReview = toBool(env.MOBILE_RELEASE_SUBMIT_FOR_REVIEW)
  if (submitForReview === null) {
    report.errors.push('MOBILE_RELEASE_SUBMIT_FOR_REVIEW must be true or false.')
  }

  if (platform === 'ios' || platform === 'both') {
    requireVar(report, env, 'MOBILE_RELEASE_IOS_VERSION')
    requireVar(report, env, 'IOS_APPLE_TEAM_ID')
    requireVar(report, env, 'IOS_BUNDLE_ID')
  }

  if (platform === 'android' || platform === 'both') {
    requireVar(report, env, 'MOBILE_RELEASE_ANDROID_VERSION_NAME')
    requireVar(report, env, 'ANDROID_PACKAGE_NAME')

    const track = requireVar(report, env, 'MOBILE_RELEASE_ANDROID_TRACK')
    if (track && !VALID_TRACKS.has(track)) {
      report.errors.push(`MOBILE_RELEASE_ANDROID_TRACK must be one of: ${Array.from(VALID_TRACKS).join(', ')}.`)
    }
  }

  if (source === 'installer') {
    requireVar(report, env, 'MOBILE_RELEASE_INSTALLER_URL')
    report.ok.push('Store signing credentials are expected in Ristak Installer, not in this repo')
  }

  if (source === 'local') {
    if (platform === 'ios' || platform === 'both') {
      requireVar(report, env, 'IOS_APP_STORE_CONNECT_KEY_ID')
      requireVar(report, env, 'IOS_APP_STORE_CONNECT_ISSUER_ID')
      requireFile(report, rootDir, env, 'IOS_APP_STORE_CONNECT_API_KEY_PATH', { extensions: ['.p8'] })
      requireFile(report, rootDir, env, 'IOS_DISTRIBUTION_CERTIFICATE_PATH', { extensions: ['.p12'] })
      requireVar(report, env, 'IOS_DISTRIBUTION_CERTIFICATE_PASSWORD')
      requireFile(report, rootDir, env, 'IOS_APPSTORE_PROVISIONING_PROFILE_PATH', { extensions: ['.mobileprovision'] })
      requireFile(report, rootDir, env, 'IOS_EXPORT_OPTIONS_PLIST', { extensions: ['.plist'], private: false })
    }

    if (platform === 'android' || platform === 'both') {
      validateAndroidKeystore(report, rootDir, env)
      const serviceAccountPath = requireFile(report, rootDir, env, 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH', { extensions: ['.json'] })
      if (serviceAccountPath) validateGoogleServiceAccount(report, serviceAccountPath)
    }
  }

  return { platform, source, report }
}

const args = parseArgs(process.argv)
const rootDir = process.cwd()
const envFilePath = resolveFromRoot(rootDir, args.envFile)

if (!fs.existsSync(envFilePath)) {
  console.error(`Missing env file: ${relativeDisplay(rootDir, envFilePath)}`)
  console.error('Run: npm run mobile:release:init')
  process.exit(1)
}

let env
try {
  env = parseEnvFile(envFilePath)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

if (args.template) {
  validateTemplate(env)
  process.exit(0)
}

const { platform, source, report } = validateConfig(rootDir, envFilePath, env, args)

console.log('Mobile release config check')
console.log(`- env: ${relativeDisplay(rootDir, envFilePath)}`)
console.log(`- source: ${source}`)
console.log(`- platform: ${platform}`)

if (report.ok.length) {
  console.log('\nOK')
  for (const item of report.ok) console.log(`- ${item}`)
}

if (report.warnings.length) {
  console.log('\nWarnings')
  for (const item of report.warnings) console.log(`- ${item}`)
}

if (report.errors.length) {
  console.log('\nMissing or invalid')
  for (const item of report.errors) console.log(`- ${item}`)
  process.exit(1)
}

console.log('\nReady. No secret values were printed.')
