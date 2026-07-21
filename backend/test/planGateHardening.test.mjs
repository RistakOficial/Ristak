import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const backendRoot = join(repoRoot, 'backend')
const frontendRoot = join(repoRoot, 'frontend')

const backendFile = (path) => readFile(join(backendRoot, path), 'utf8')
const frontendFile = (path) => readFile(join(frontendRoot, path), 'utf8')
const repoFile = (path) => readFile(join(repoRoot, path), 'utf8')

test('module access checks the commercial plan before exposing a module', async () => {
  const licenseService = await backendFile('src/services/licenseService.js')
  const userAccessMiddleware = await backendFile('src/middleware/userAccessMiddleware.js')

  assert.match(licenseService, /const LICENSE_FEATURES_BY_MODULE = \{/)
  assert.match(licenseService, /settings_api_access: \{ primary: 'developers'/)
  assert.match(licenseService, /export async function hasModuleFeature\(moduleKey\)/)
  assert.match(licenseService, /'payments', 'reports', 'campaigns', 'sites', 'forms'/)

  assert.match(userAccessMiddleware, /hasModuleFeature\(moduleKey\)/)
  assert.match(userAccessMiddleware, /code: 'feature_not_available'/)
  assert.match(userAccessMiddleware, /module: moduleKey/)
})

test('developer surfaces are gated by Developers and by resource features', async () => {
  const authRoutes = await backendFile('src/routes/auth.routes.js')
  const externalRoutes = await backendFile('src/routes/external.routes.js')
  const mcpRoutes = await backendFile('src/routes/mcp.routes.js')
  const goalLedgerMigration = await repoFile('backend/migrations/versioned/019_conversational_goal_effects_ledger.sql')

  assert.match(authRoutes, /router\.get\('\/api-token', requireAuth, requireModuleAccess\('settings_api_access'\), getApiToken\)/)
  assert.match(authRoutes, /router\.post\('\/api-token\/rotate', requireAuth, requireModuleAccess\('settings_api_access'\), rotateApiToken\)/)
  assert.match(authRoutes, /router\.delete\('\/api-token', requireAuth, requireModuleAccess\('settings_api_access'\), revokeApiToken\)/)

  assert.match(externalRoutes, /router\.use\(requireFeature\('developers'\)\)/)
  assert.match(externalRoutes, /function getExternalTableFeatureKeys\(table\)/)
  assert.match(externalRoutes, /router\.get\('\/data\/:table', requireExternalTableFeature, queryDataTable\)/)
  assert.match(externalRoutes, /router\.post\('\/highlevel\/request', requireExternalFeatures\('integrations'\), proxyHighLevelRequest\)/)
  assert.match(externalRoutes, /router\.get\('\/transactions', requireExternalFeatures\('payments'\), getTransactions\)/)
  assert.match(externalRoutes, /SENSITIVE_TABLE_PATTERN[^\n]*conversational_agent_goal_links/)
  assert.match(externalRoutes, /SENSITIVE_TABLE_PATTERN[^\n]*meta_oauth_integrations[^\n]*meta_oauth_integration_sessions/)
  assert.match(externalRoutes, /SENSITIVE_TABLE_PATTERN[^\n]*meta_oauth_pending_sessions[^\n]*meta_oauth_connection_backups[^\n]*meta_oauth_authorized_assets/)
  assert.match(externalRoutes, /WRITE_BLOCKED_TABLE_PATTERN[^\n]*conversational_agents[^\n]*conversational_agent_\.\*/)
  assert.match(externalRoutes, /name === 'conversational_agents' \|\| \/\^conversational_agent_\/\.test\(name\)/)

  assert.match(mcpRoutes, /hasFeature\('developers'\)/)
  assert.match(mcpRoutes, /ghl_create_payment_link: \['integrations', 'payments', 'payment_links'\]/)
  assert.match(mcpRoutes, /ghl_create_installment_plan: \['integrations', 'payments', 'payment_plans'\]/)
  assert.match(mcpRoutes, /await assertMcpFeatures\(getMcpToolFeatureKeys\(name, args\)\)/)
  assert.match(mcpRoutes, /getMcpTableFeatureKeys\(args\?\.table\)/)
  assert.match(mcpRoutes, /SENSITIVE_TABLE_PATTERN[^\n]*conversational_agent_goal_links/)
  assert.match(mcpRoutes, /SENSITIVE_TABLE_PATTERN[^\n]*meta_oauth_integrations[^\n]*meta_oauth_integration_sessions/)
  assert.match(mcpRoutes, /SENSITIVE_TABLE_PATTERN[^\n]*meta_oauth_pending_sessions[^\n]*meta_oauth_connection_backups[^\n]*meta_oauth_authorized_assets/)
  assert.match(mcpRoutes, /blockedTables:[^\n]*conversational_agent_goal_links/)
  assert.match(mcpRoutes, /blockedTables:[^\n]*meta_oauth_integrations[^\n]*meta_oauth_integration_sessions/)
  assert.match(mcpRoutes, /blockedTables:[^\n]*meta_oauth_pending_sessions[^\n]*meta_oauth_connection_backups[^\n]*meta_oauth_authorized_assets/)
  assert.match(mcpRoutes, /const selectedColumns = config\.exposedColumns/)
  assert.match(mcpRoutes, /name === 'conversational_agents' \|\| \/\^conversational_agent_\/\.test\(name\)/)
  assert.match(goalLedgerMigration, /WHERE status = 'completed'/)
  assert.match(goalLedgerMigration, /completion_effects_status IS NULL/)
})

test('Sites and HighLevel cannot bypass payments, plans, or integrations', async () => {
  const sitesRoutes = await backendFile('src/routes/sites.routes.js')
  const highlevelRoutes = await backendFile('src/routes/highlevel.routes.js')

  assert.match(sitesRoutes, /function requirePaymentsForSitePaymentFeature\(req, res, next\)/)
  assert.match(sitesRoutes, /router\.post\('\/public\/checkout\/init', requireFeature\('payment_checkout'\), sitePaymentCheckoutInitHandler\)/)
  assert.match(sitesRoutes, /router\.post\('\/public\/checkout\/prepare-installments', requireFeature\('payment_checkout'\), requireFeature\('payment_plans'\), sitePaymentCheckoutPrepareHandler\)/)
  assert.match(sitesRoutes, /router\.post\('\/:siteId\/blocks', requirePaymentsForSitePaymentFeature, createBlockHandler\)/)

  assert.match(highlevelRoutes, /router\.use\(requireFeature\('highlevel_integration'\)\)/)
  assert.match(highlevelRoutes, /router\.post\('\/contacts\/search', requireModuleAccess\('contacts'\), searchContacts\)/)
  assert.match(highlevelRoutes, /router\.post\('\/conversations\/messages', requireModuleAccess\('chat'\), sendConversationMessage\)/)
  assert.match(highlevelRoutes, /router\.post\('\/payment-flows\/installments', requireModuleAccess\('payments'\), requireFeature\('payment_plans'\), createInstallmentFlow\)/)
})

test('calendar custom forms require the Forms/Sites plan features', async () => {
  const calendarsController = await backendFile('src/controllers/calendarsController.js')
  const localCalendarService = await backendFile('src/services/localCalendarService.js')
  const calendarsConfiguration = await frontendFile('src/pages/Settings/CalendarsConfiguration.tsx')

  assert.match(calendarsController, /async function canUseCalendarCustomForms\(\)/)
  assert.match(calendarsController, /hasFeature\('forms'\)[\s\S]*hasFeature\('sites'\)/)
  assert.match(calendarsController, /async function enforceCalendarCustomFormAccess\(existingCalendar = \{\}, updateData = \{\}\)/)
  assert.match(calendarsController, /Los formularios personalizados de calendario no están incluidos en tu plan actual/)
  assert.match(
    calendarsController,
    /const formSafeCalendarData = await enforceCalendarCustomFormAccess\(\s*\{\},\s*normalizeCalendarAvailabilityWrite\(withoutGoogleCalendarLinkMutation\(calendarData\)\)\s*\)/
  )
  assert.match(
    calendarsController,
    /const formSafeUpdateData = await enforceCalendarCustomFormAccess\(\s*existing,\s*normalizeCalendarAvailabilityWrite\(withoutGoogleCalendarLinkMutation\(updateData\)\)\s*\)/
  )

  assert.match(localCalendarService, /export function normalizeCalendarBookingFormConfig\(value = \{\}\)/)
  assert.match(localCalendarService, /async function canUseCalendarCustomForms\(\)/)
  assert.match(localCalendarService, /config\.useCustomForm && config\.customFormId && await canUseCalendarCustomForms\(\)/)

  assert.match(calendarsConfiguration, /const hasCalendarCustomFormsAccess = hasLicenseFeature\(user, \['forms'\]\) && hasLicenseFeature\(user, \['sites'\]\)/)
  assert.match(calendarsConfiguration, /label: 'URL y Datos', description: 'Enlace, preguntas y cierre\.'/)
  assert.match(calendarsConfiguration, /if \(!hasCalendarCustomFormsAccess\) \{[\s\S]*setFormSites\(\[\]\)/)
  assert.match(calendarsConfiguration, /hasCalendarCustomFormsAccess && bookingFormConfig\.useCustomForm/)
})

test('automation builder and runtime reject premium nodes outside the plan', async () => {
  const flowValidation = await backendFile('src/services/automationFlowValidation.js')
  const automationsService = await backendFile('src/services/automationsService.js')
  const automationEngine = await backendFile('src/services/automationEngine.js')
  const nodeRegistry = await frontendFile('src/pages/Automations/editor/nodeRegistry.tsx')
  const automationsHome = await frontendFile('src/pages/Automations/AutomationsHome.tsx')

  assert.match(flowValidation, /'channel-whatsapp': \['whatsapp'\]/)
  assert.match(flowValidation, /'trigger-payment-received': \['payments'\]/)
  assert.match(flowValidation, /'trigger-incoming-webhook': \['developers'\]/)
  assert.match(flowValidation, /export function collectAutomationFlowRequiredFeatures\(flow = \{\}\)/)

  assert.match(automationsService, /await assertAutomationFlowFeatureAccess\(flow\)/)
  assert.match(automationEngine, /async function canRunAutomationFlow\(flow = \{\}\)/)
  assert.match(automationEngine, /await assertAutomationNodeFeatureAccess\(node\)/)
  assert.match(automationEngine, /if \(!\(await canRunBackgroundJob\('automations'\)\)\) return/)

  assert.match(nodeRegistry, /type: 'trigger-whatsapp-message'[\s\S]*requiredFeature: 'whatsapp'/)
  assert.match(nodeRegistry, /type: 'channel-whatsapp'[\s\S]*requiredFeature: 'whatsapp'/)
  assert.match(nodeRegistry, /type: 'trigger-payment-received'[\s\S]*requiredFeature: 'payments'/)
  assert.match(nodeRegistry, /type: 'action-webhook'[\s\S]*requiredFeature: 'developers'/)
  assert.match(automationsHome, /const canUseWhatsApp = hasLicenseFeature\(user, \['whatsapp'\]\)/)
})

test('mobile phone view and background jobs respect plan features', async () => {
  const phoneApp = await frontendFile('src/pages/PhoneApp/PhoneApp.tsx')

  assert.match(phoneApp, /featureKeys\?: readonly string\[\]/)
  assert.match(phoneApp, /id: 'transactions', label: 'Pagos'[\s\S]*featureKeys: \['payments'\]/)
  assert.match(phoneApp, /const visibleSections = useMemo/)
  assert.match(phoneApp, /featureAccessKey/)
  assert.match(
    phoneApp,
    /loadTransactions && canUsePayments\s*\?\s*safe\(\s*transactionsService\.getTransactionsPage\(\{[\s\S]*?limit:\s*5,[\s\S]*?\}\)\.then\(result => result\.transactions\)/
  )
  assert.doesNotMatch(phoneApp, /transactionsService\.getTransactions\(/)

  for (const cronPath of [
    'src/jobs/scheduledChatMessages.cron.js',
    'src/jobs/appointmentReminders.cron.js',
    'src/jobs/paymentAutomations.cron.js',
    'src/jobs/contactBulkActions.cron.js',
    'src/jobs/stripePaymentPlans.cron.js',
    'src/jobs/conektaPaymentPlans.cron.js',
    'src/jobs/mercadoPagoPaymentPlans.cron.js',
    'src/jobs/rebillPaymentPlans.cron.js',
    'src/jobs/googleCalendarSync.cron.js',
    'src/jobs/metaSync.cron.js',
    'src/jobs/emailInboundSync.cron.js',
    'src/jobs/whatsappQrWatchdog.cron.js',
    'src/jobs/highlevelSync.cron.js'
  ]) {
    const source = await backendFile(cronPath)
    assert.match(source, /canRunBackgroundJob\(/, `${cronPath} must validate license before background work`)
  }
})

test('embedded plan features cannot leak through contacts, chat, notifications, or iPhone', async () => {
  const contactsRoutes = await backendFile('src/routes/contacts.routes.js')
  const settingsRoutes = await backendFile('src/routes/settings.routes.js')
  const licenseService = await backendFile('src/services/licenseService.js')
  const contactsController = await backendFile('src/controllers/contactsController.js')
  const notificationsService = await backendFile('src/services/notificationsService.js')
  const paymentAutomationsService = await backendFile('src/services/paymentAutomationsService.js')
  const paymentAutomationsCron = await backendFile('src/jobs/paymentAutomations.cron.js')
  const whatsappApiRoutes = await backendFile('src/routes/whatsappApi.routes.js')
  const contactDetailsModal = await frontendFile('src/components/common/ContactDetailsModal/ContactDetailsModal.tsx')
  const desktopChat = await frontendFile('src/pages/DesktopChat/DesktopChat.tsx')
  const contactsPage = await frontendFile('src/pages/Contacts/Contacts.tsx')
  const bulkActionModals = await frontendFile('src/pages/Contacts/ContactBulkActionModals.tsx')
  const advancedFiltersModal = await frontendFile('src/pages/Contacts/ContactAdvancedFiltersModal.tsx')
  const paymentsConfiguration = await frontendFile('src/pages/Settings/PaymentsConfiguration.tsx')
  const whatsappSettings = await frontendFile('src/pages/Settings/WhatsAppSettings.tsx')
  const settingsNav = await frontendFile('src/pages/Settings/settingsNav.ts')
  const accessStore = await repoFile('ios/app/Ristak/Core/Auth/AccessStore.swift')
  const contactInfoScreen = await repoFile('ios/app/Ristak/Features/Chats/ContactInfo/ContactInfoScreen.swift')

  assert.match(contactDetailsModal, /const hasAutomationsAccess = hasLicenseFeature\(user, \['automations'\]\)/)
  assert.match(contactDetailsModal, /if \(!contactId \|\| !hasAutomationsAccess\) return/)
  assert.match(contactDetailsModal, /\{hasAutomationsAccess && \(/)
  assert.match(desktopChat, /const hasAutomationsAccess = hasLicenseFeature\(user, \['automations'\]\)/)
  assert.match(desktopChat, /\{hasAutomationsAccess && \(/)
  assert.match(bulkActionModals, /const hasAutomationsAccess = hasLicenseFeature\(user, \['automations'\]\)/)
  assert.match(bulkActionModals, /isOpen=\{hasAutomationsAccess && automationOpen\}/)
  assert.match(contactsPage, /const hasAutomationsAccess = hasLicenseFeature\(user, \['automations'\]\)/)
  assert.match(contactsPage, /automationOpen=\{hasAutomationsAccess && showBulkAutomationModal\}/)

  assert.match(contactsRoutes, /router\.post\('\/bulk-actions\/automation', requireFeature\('automations'\), createBulkAutomationAction\)/)
  assert.match(contactsRoutes, /router\.post\('\/bulk-actions\/whatsapp-template', requireFeature\('whatsapp_templates'\), createBulkWhatsAppTemplateAction\)/)
  assert.match(contactsController, /const CONTACT_ADVANCED_FILTER_FEATURES = \[/)
  assert.match(contactsController, /feature: 'automations'/)
  assert.match(contactsController, /assertContactAdvancedFilterFeatureAccess\(res, advancedFilterConfig\)/)
  assert.match(advancedFiltersModal, /const hasAutomationsAccess = hasLicenseFeature\(user, \['automations'\]\)/)
  assert.doesNotMatch(advancedFiltersModal, /hasTagsAccess|hasCustomFieldsAccess/)
  assert.doesNotMatch(licenseService, /settings_custom_fields:\s*\{\s*primary:\s*'forms'/)
  assert.match(settingsRoutes, /router\.get\('\/custom-fields', requireCustomFieldsAccess, listCustomFields\)/)
  assert.match(settingsRoutes, /router\.get\('\/variable-fields', requireCustomFieldsAccess, listVariableFieldsHandler\)/)
  assert.match(settingsRoutes, /router\.get\('\/trigger-links', requireCustomFieldsAccess, requireFeature\('trigger_links'\), listTriggerLinksHandler\)/)

  assert.match(notificationsService, /canRunBackgroundJob\('automations'\)/)
  assert.match(paymentAutomationsService, /canRunBackgroundJob\('payment_automations'\)/)
  assert.match(paymentAutomationsCron, /canRunBackgroundJob\('payment_automations'\)/)
  assert.match(paymentsConfiguration, /const hasPaymentAutomationsAccess = canAccessPaymentAutomations\(user\)/)
  assert.match(paymentsConfiguration, /const hasPaymentCheckoutAccess = canAccessPaymentCheckout\(user\)/)
  assert.match(paymentsConfiguration, /const hasPaymentGatewaysAccess = canAccessPaymentGateways\(user\)/)
  assert.match(whatsappSettings, /const hasWhatsAppApiAccess = hasLicenseFeature\(user, \['whatsapp_api'\]\)/)
  assert.match(whatsappSettings, /const hasWhatsAppTemplatesAccess = hasLicenseFeature\(user, \['whatsapp_templates'\]\)/)
  assert.match(whatsappApiRoutes, /router\.post\('\/connect', requireWhatsAppApiAccess, connectWhatsAppApiView\)/)
  assert.match(whatsappApiRoutes, /router\.get\('\/templates', requireFeature\('whatsapp_templates'\), getWhatsAppApiTemplatesView\)/)
  assert.match(whatsappApiRoutes, /router\.post\('\/templates\/send', requireWhatsAppTemplatesChatAccess, sendWhatsAppApiTemplateMessageView\)/)
  assert.match(settingsNav, /featureKeys: \['highlevel_integration'\]/)

  assert.match(accessStore, /case automations/)
  assert.match(accessStore, /\.automations: LicenseFeatureRule\(primary: "automations", legacy: \[\]\)/)
  assert.match(accessStore, /return false/)
  assert.match(contactInfoScreen, /canEditContact && access\.canWrite\(module: \.automations\)/)
})
