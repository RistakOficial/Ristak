import { createProgramPaymentAssociationService } from '../services/programPaymentAssociationService.js'
import { createMagnetismoPaymentVerificationClient } from '../services/magnetismoPaymentVerificationClient.js'
import { hasFeature, isLicenseEnforced } from '../services/licenseService.js'

const ID = { type: 'string', minLength: 1, maxLength: 300 }
const source = { sourceType: { type: 'string', enum: ['payment', 'plan'] }, sourceId: ID }
const decision = {
  type: 'object', additionalProperties: false,
  description: 'Sólo cuando el usuario haya decidido expresamente el producto de esta fuente exacta. Nunca inferir confirmed del recibo ni del nombre del alumno.',
  properties: { confirmed: { type: 'boolean', enum: [true] }, productId: ID, reason: { type: 'string', minLength: 8, maxLength: 500 } },
  required: ['confirmed', 'productId', 'reason']
}
const linkProperties = { ...source, enrollmentId: ID, decision }
const pagination = { afterId: { type: 'string', maxLength: 300 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

async function service() {
  const { db, databaseDialect } = await import('../config/database.js')
  // Resolve configuration only when a remote read is necessary. Local review is
  // useful before an existing MCP key has been configured by its owner.
  let client
  const getClient = () => client ||= createMagnetismoPaymentVerificationClient()
  const target = {
    get targetKey() {
      return getClient().targetKey
    },
    getProgram: (...args) => getClient().getProgram(...args),
    getStudent: (...args) => getClient().getStudent(...args),
    getProgress: (...args) => getClient().getProgress(...args)
  }
  return createProgramPaymentAssociationService({ db, dialect: databaseDialect, target })
}

function tool(name, description, inputSchema, run, write = false) {
  return Object.freeze({
    name, description, inputSchema: write ? {
      ...inputSchema, properties: { ...inputSchema.properties,
        idempotencyKey: { type: 'string', minLength: 8, maxLength: 180, pattern: '^[A-Za-z0-9._:-]+$' } },
      required: [...inputSchema.required, 'idempotencyKey']
    } : inputSchema,
    module: 'payments', access: write ? 'write' : 'read', scope: write ? 'ristak.write' : 'ristak.read',
    adminOnly: true, risk: write ? 'medium' : 'low', openWorld: true,
    featureKeys: [], additionalModules: [], connectionPrerequisites: [], confirmRequired: false,
    idempotencyRequired: write,
    async execute(context, args) {
      if (args.sourceType === 'plan' && isLicenseEnforced() && !(await hasFeature('payment_plans', {
        state: context.license || null, email: context.user?.email || context.user?.username || null
      }))) {
        throw Object.assign(new Error('Los planes de pago no están incluidos en el plan actual.'), { code: 'feature_not_available', status: 403 })
      }
      return run(await service(), context, args)
    }
  })
}

export const programPaymentToolSpecs = Object.freeze([
  tool('payments_program_mappings_list', 'Lista relaciones explícitas producto Ristak → programa Magnetismo por ID; no equipara productos de nombres similares.',
    schema(pagination), (s, _c, args) => s.list({ ...args, kind: 'mappings' })),
  tool('payments_program_mapping_create', 'Prepara o guarda una relación de un producto local activo con un programa remoto verificado. dryRun=true por defecto. No crea alumnos ni accesos ni cambia webhooks.',
    schema({ productId: ID, programId: ID, reason: { type: 'string', minLength: 8, maxLength: 500 }, dryRun: { type: 'boolean' } }, ['productId', 'programId', 'reason']),
    (s, c, args) => s.createMapping(c, args), true),
  tool('payments_program_review', 'Revisión local paginada para polling diario o recuperación de eventos: identifica fuentes relevantes y casos que necesitan decisión. Recorrer nextAfterId hasta hasMore=false. No consulta alumnos ni cambia accesos. Los eventos de pago son avisos: releer siempre la fuente.',
    schema({ sourceType: source.sourceType, ...pagination }, ['sourceType']), (s, _c, args) => s.review(args)),
  tool('payments_program_link_preview', 'Verifica el producto explícito, correo exacto y una inscripción existente por MCP de Magnetismo; devuelve fingerprint para asociar. Consulta individual o descripción ambigua exige decisión explícita del usuario. Nunca crea ni modifica acceso.',
    schema(linkProperties, ['sourceType', 'sourceId']), (s, _c, args) => s.preview(args)),
  tool('payments_program_link', 'Guarda sólo el vínculo informativo de una fuente con inscripción existente. dryRun=true por defecto. Para aplicar usa dryRun=false y expectedFingerprint de una vista previa reciente; conserva la misma decision/enrollmentId. Nunca cobra, envía mensajes, da acceso ni suspende.',
    schema({ ...linkProperties, dryRun: { type: 'boolean' }, expectedFingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['sourceType', 'sourceId']),
    (s, c, args) => s.link(c, args), true),
  tool('payments_program_links_list', 'Lista los vínculos informativos guardados con paginación estable por ID.',
    schema(pagination), (s, _c, args) => s.list({ ...args, kind: 'links' })),
  tool('payments_program_link_context', 'Relee la fuente, cuotas y fechas canónicas y verifica la inscripción asociada. includeProgress añade avance observado; no equivale a completar trabajos. No infiere deuda de intentos fallidos ni iguala vencimiento financiero con fin de acceso. Nunca cambia acceso.',
    schema({ ...source, includeProgress: { type: 'boolean' } }, ['sourceType', 'sourceId']), (s, _c, args) => s.context(args))
])
