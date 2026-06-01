#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])
const DEFAULT_SOURCE_DIR = path.resolve(process.cwd(), 'tmp/highlevel-api-docs')
const DEFAULT_OUTPUT_FILE = path.resolve(process.cwd(), 'backend/src/data/highlevelEndpointCatalog.js')
const sourceDir = path.resolve(process.argv[2] || DEFAULT_SOURCE_DIR)
const appsDir = path.join(sourceDir, 'apps')
const outputFile = path.resolve(process.argv[3] || DEFAULT_OUTPUT_FILE)

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function cleanText(value, limit = 600) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function getGitCommit(repoPath) {
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function getSecuritySchemes(operation = {}, apiDoc = {}) {
  const security = Array.isArray(operation.security)
    ? operation.security
    : Array.isArray(apiDoc.security)
      ? apiDoc.security
      : []

  return security
    .flatMap((entry) => Object.keys(entry || {}))
    .filter(Boolean)
}

function getAccess(operation = {}, apiDoc = {}) {
  const schemes = getSecuritySchemes(operation, apiDoc)
  if (!schemes.length) return 'unspecified'

  const hasSubAccount = schemes.some((scheme) => /^(bearer|Location-Access|Location-Access-Only)$/i.test(scheme))
  const hasAgency = schemes.some((scheme) => /^Agency-Access(?:-Only)?$/i.test(scheme))

  if (hasSubAccount && hasAgency) return 'subaccount_or_agency'
  if (hasSubAccount) return 'subaccount'
  if (hasAgency) return 'agency'

  return 'unknown'
}

function getScopes(operation = {}) {
  if (!Array.isArray(operation.security)) return []

  const scopes = operation.security.flatMap((entry) => Object.values(entry || {}).flat())
  return Array.from(new Set(scopes.filter(Boolean))).sort()
}

function getVersion(operation = {}, pathItem = {}) {
  const params = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : [])
  ]
  const header = params.find((param) => String(param?.name || '').toLowerCase() === 'version')
  const enumValues = header?.schema?.enum

  if (Array.isArray(enumValues) && enumValues.length) return String(enumValues[0])
  if (header?.schema?.default) return String(header.schema.default)

  return null
}

function simplifyParameter(param = {}) {
  return {
    name: cleanText(param.name, 160),
    in: cleanText(param.in, 40),
    required: Boolean(param.required),
    type: cleanText(param.schema?.type || param.schema?.format || '', 80) || null,
    enum: Array.isArray(param.schema?.enum) ? param.schema.enum.map(String) : undefined,
    description: cleanText(param.description, 240) || undefined
  }
}

function getParameters(operation = {}, pathItem = {}) {
  const params = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : [])
  ]

  return params
    .filter((param) => param?.name && param?.in && String(param.name).toLowerCase() !== 'version')
    .map(simplifyParameter)
}

function getRequestBody(operation = {}) {
  const content = operation.requestBody?.content || {}
  const jsonSchema = content['application/json']?.schema
  const formSchema = content['application/x-www-form-urlencoded']?.schema
  const multipartSchema = content['multipart/form-data']?.schema
  const schema = jsonSchema || formSchema || multipartSchema
  const contentTypes = Object.keys(content)

  if (!schema && !contentTypes.length) return null

  return {
    required: Boolean(operation.requestBody?.required),
    contentTypes,
    schemaRef: schema?.$ref || undefined,
    schemaType: schema?.type || undefined
  }
}

function shouldIncludeSubAccountEndpoint(endpoint) {
  if (endpoint.access === 'subaccount' || endpoint.access === 'subaccount_or_agency') return true

  // Some official OpenAPI operations are missing the security stanza but are still
  // location-scoped paths. Keep them in the sub-account catalog, except OAuth token
  // exchange because the agent already receives a stored token and cannot call that
  // form-encoded flow through the generic Bearer REST tool.
  return endpoint.access === 'unspecified' && endpoint.app !== 'oauth'
}

if (!fs.existsSync(appsDir)) {
  throw new Error(`No encontre apps/ en ${sourceDir}. Clona https://github.com/GoHighLevel/highlevel-api-docs primero.`)
}

const appFiles = fs.readdirSync(appsDir)
  .filter((file) => file.endsWith('.json'))
  .sort()

const allEndpoints = []

for (const file of appFiles) {
  const apiDoc = readJson(path.join(appsDir, file))
  const app = file.replace(/\.json$/i, '')
  const appTitle = cleanText(apiDoc.info?.title || app, 180)

  for (const [endpointPath, pathItem] of Object.entries(apiDoc.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!HTTP_METHODS.has(method)) continue

      const parameters = getParameters(operation, pathItem)
      const pathParams = parameters.filter((param) => param.in === 'path')
      const queryParams = parameters.filter((param) => param.in === 'query')

      allEndpoints.push({
        method: method.toUpperCase(),
        path: endpointPath,
        operationId: cleanText(operation.operationId, 180) || null,
        summary: cleanText(operation.summary, 240) || null,
        description: cleanText(operation.description, 360) || null,
        app,
        appTitle,
        tags: Array.isArray(operation.tags) ? operation.tags.map((tag) => cleanText(tag, 120)).filter(Boolean) : [],
        scopes: getScopes(operation),
        security: getSecuritySchemes(operation, apiDoc),
        access: getAccess(operation, apiDoc),
        version: getVersion(operation, pathItem),
        pathParams,
        queryParams,
        requestBody: getRequestBody(operation)
      })
    }
  }
}

const subAccountEndpoints = allEndpoints
  .filter(shouldIncludeSubAccountEndpoint)
  .sort((a, b) => `${a.app}:${a.path}:${a.method}`.localeCompare(`${b.app}:${b.path}:${b.method}`))

const methodCounts = subAccountEndpoints.reduce((acc, endpoint) => {
  acc[endpoint.method] = (acc[endpoint.method] || 0) + 1
  return acc
}, {})

const appCounts = subAccountEndpoints.reduce((acc, endpoint) => {
  acc[endpoint.appTitle] = (acc[endpoint.appTitle] || 0) + 1
  return acc
}, {})

const source = {
  generatedAt: new Date().toISOString(),
  repository: 'https://github.com/GoHighLevel/highlevel-api-docs',
  docsUrl: 'https://marketplace.gohighlevel.com/docs/',
  commit: getGitCommit(sourceDir),
  totalDocumentedEndpoints: allEndpoints.length,
  subAccountEndpointCount: subAccountEndpoints.length,
  excludedAgencyEndpointCount: allEndpoints.filter((endpoint) => endpoint.access === 'agency').length,
  includedUnspecifiedEndpointCount: subAccountEndpoints.filter((endpoint) => endpoint.access === 'unspecified').length,
  methodCounts,
  appCounts
}

const fileBody = `// Generated by backend/scripts/sync-highlevel-endpoint-catalog.mjs.
// Source: ${source.repository}${source.commit ? ` @ ${source.commit}` : ''}

export const HIGHLEVEL_ENDPOINT_SOURCE = ${JSON.stringify(source, null, 2)}

export const HIGHLEVEL_SUBACCOUNT_ENDPOINTS = ${JSON.stringify(subAccountEndpoints, null, 2)}
`

fs.mkdirSync(path.dirname(outputFile), { recursive: true })
fs.writeFileSync(outputFile, `${fileBody}\n`, 'utf8')

console.log(`Generated ${subAccountEndpoints.length} HighLevel sub-account endpoints at ${outputFile}`)
