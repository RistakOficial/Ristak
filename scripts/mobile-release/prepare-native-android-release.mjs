#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const rootDir = path.resolve(new URL('../..', import.meta.url).pathname)
const buildGradlePath = path.join(rootDir, 'mobile', 'android', 'app', 'build.gradle')

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!fs.existsSync(buildGradlePath)) {
  fail('Missing mobile/android/app/build.gradle. Run Expo prebuild for Android before preparing release signing.')
}

let buildGradle = fs.readFileSync(buildGradlePath, 'utf8')

if (!buildGradle.includes('applicationId \'com.ristak.android\'') && !buildGradle.includes('applicationId "com.ristak.android"')) {
  fail('Android native project is not configured for com.ristak.android. Refusing to prepare a Play release for the wrong package.')
}

if (!buildGradle.includes('keystorePropertiesFile')) {
  buildGradle = buildGradle.replace(
    'android {',
    `def keystorePropertiesFile = rootProject.file("app/keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

android {`
  )
}

if (!buildGradle.includes('ciVersionCode')) {
  buildGradle = buildGradle.replace(
    /versionCode\s+\d+/,
    'versionCode Integer.parseInt((project.findProperty("ciVersionCode") ?: "1").toString())'
  )
  buildGradle = buildGradle.replace(
    /versionName\s+["'][^"']+["']/,
    'versionName (project.findProperty("ciVersionName") ?: "1.0.0").toString()'
  )
}

if (!buildGradle.includes('storeFile file(keystoreProperties')) {
  const signingConfigsPattern = /signingConfigs\s*\{\s*\n\s*debug\s*\{[\s\S]*?\n\s*\}\s*\n\s*\}/
  const releaseSigningBlock = `signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            if (!keystorePropertiesFile.exists()) {
                throw new GradleException("Missing Android release signing file: app/keystore.properties")
            }
            storeFile file(keystoreProperties['storeFile'])
            storePassword keystoreProperties['storePassword']
            keyAlias keystoreProperties['keyAlias']
            keyPassword keystoreProperties['keyPassword']
        }
    }`

  if (!signingConfigsPattern.test(buildGradle)) {
    fail('Could not find the generated Android signingConfigs block to patch release signing.')
  }

  buildGradle = buildGradle.replace(signingConfigsPattern, releaseSigningBlock)
}

buildGradle = buildGradle.replace(
  /(buildTypes\s*\{\s*debug\s*\{[\s\S]*?)signingConfig signingConfigs\.(?:debug|release)([\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.(?:debug|release)/,
  '$1signingConfig signingConfigs.debug$2signingConfig signingConfigs.release'
)

if (!buildGradle.includes('signingConfig signingConfigs.release')) {
  fail('Could not switch Android release buildType to signingConfigs.release.')
}

fs.writeFileSync(buildGradlePath, buildGradle)
console.log('Prepared native Android release signing for com.ristak.android.')
