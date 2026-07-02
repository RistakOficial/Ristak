#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const rootDir = process.cwd()
const envPath = path.join(rootDir, '.mobile-release.local.env')
const examplePath = path.join(rootDir, '.mobile-release.local.env.example')
const force = process.argv.includes('--force')

const privateDirs = [
  path.join(rootDir, '.mobile-release'),
  path.join(rootDir, '.mobile-release', 'ios'),
  path.join(rootDir, '.mobile-release', 'android')
]

function chmodSafe(targetPath, mode) {
  try {
    fs.chmodSync(targetPath, mode)
  } catch (error) {
    if (process.platform !== 'win32') {
      throw error
    }
  }
}

if (!fs.existsSync(examplePath)) {
  console.error('Missing .mobile-release.local.env.example. Run this command from the repo root.')
  process.exit(1)
}

for (const dir of privateDirs) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSafe(dir, 0o700)
}

if (fs.existsSync(envPath) && !force) {
  chmodSafe(envPath, 0o600)
  console.log('Local mobile release env already exists. It was not overwritten.')
  console.log('Path: .mobile-release.local.env')
  console.log('Private vault: .mobile-release/')
  process.exit(0)
}

fs.copyFileSync(examplePath, envPath)
chmodSafe(envPath, 0o600)

console.log('Created local mobile release configuration.')
console.log('Path: .mobile-release.local.env')
console.log('Private vault: .mobile-release/')
console.log('Next: fill the missing values, add private files, then run npm run mobile:release:check -- --platform both')
