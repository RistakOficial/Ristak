import express from 'express';
import {
  archiveCustomFieldFolder,
  createCustomField,
  createCustomFieldFolder,
  deleteCustomField,
  getContactLabels,
  getTimezone,
  listCustomFields,
  setTimezone,
  setContactLabels,
  updateCustomField,
  updateCustomFieldFolder
} from '../controllers/settingsController.js';
import { getNotificationsView } from '../controllers/notificationsController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { requireFeature } from '../middleware/licenseMiddleware.js';
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js';
import {
  createTriggerLinkHandler,
  deleteTriggerLinkHandler,
  listTriggerLinkEventsHandler,
  listTriggerLinksHandler,
  updateTriggerLinkHandler
} from '../controllers/triggerLinksController.js';
import {
  createVariableFieldHandler,
  deleteVariableFieldHandler,
  listVariableFieldsHandler,
  updateVariableFieldHandler
} from '../controllers/variableFieldsController.js';
import {
  createMessageTemplateView,
  createTemplateCustomFieldView,
  createTemplateFolderView,
  deleteMessageTemplateView,
  deleteTemplateCustomFieldView,
  deleteTemplateFolderView,
  getMessageTemplatesView,
  getMessageTemplateVariablesView,
  previewMessageTemplateView,
  repairDefaultMessageTemplatesView,
  sendMessageTemplateTestView,
  submitMessageTemplateToActiveProviderView,
  syncAllMessageTemplatesWithActiveProviderView,
  syncMessageTemplateStatusView,
  updateMessageTemplateView,
  updateTemplateFolderView
} from '../controllers/messageTemplatesController.js';
import {
  createPaymentReceiptPreviewSessionView,
  getPaymentSettingsView,
  previewPaymentReceiptSessionView,
  savePaymentSettingsView,
  syncGigstackFiscalProfileView,
  testGigstackConnectionView
} from '../controllers/paymentSettingsController.js';

const router = express.Router();
const requireAccountAccess = requireModuleAccess('settings_account');
const requireCustomFieldsAccess = requireModuleAccess('settings_custom_fields');
const requireWhatsAppAccess = requireModuleAccess('settings_whatsapp');
const requirePaymentsAccess = requireModuleAccess('settings_payments');

router.get('/payments/receipt-preview-session/:token', previewPaymentReceiptSessionView);

router.use(requireAuth);

// Nombres de CRM: cualquier usuario autenticado puede leerlos porque se usan
// en toda la app; sólo quien administra la cuenta puede cambiarlos.
router.get('/contact-labels', getContactLabels);
router.post('/contact-labels', requireAccountAccess, setContactLabels);

// GET /api/settings/timezone
router.get('/timezone', requireAccountAccess, getTimezone);

// POST /api/settings/timezone
router.post('/timezone', requireAccountAccess, setTimezone);

// Custom fields
router.get('/custom-fields', requireCustomFieldsAccess, listCustomFields);
router.post('/custom-fields', requireCustomFieldsAccess, createCustomField);
router.put('/custom-fields/:definitionId', requireCustomFieldsAccess, updateCustomField);
router.delete('/custom-fields/:definitionId', requireCustomFieldsAccess, deleteCustomField);

router.post('/custom-field-folders', requireCustomFieldsAccess, createCustomFieldFolder);
router.put('/custom-field-folders/:folderId', requireCustomFieldsAccess, updateCustomFieldFolder);
router.delete('/custom-field-folders/:folderId', requireCustomFieldsAccess, archiveCustomFieldFolder);

// Variable fields / campos variables
router.get('/variable-fields', requireCustomFieldsAccess, listVariableFieldsHandler);
router.post('/variable-fields', requireCustomFieldsAccess, createVariableFieldHandler);
router.put('/variable-fields/:variableFieldId', requireCustomFieldsAccess, updateVariableFieldHandler);
router.delete('/variable-fields/:variableFieldId', requireCustomFieldsAccess, deleteVariableFieldHandler);

// Trigger links / enlaces de disparo
router.get('/trigger-links', requireCustomFieldsAccess, requireFeature('trigger_links'), listTriggerLinksHandler);
router.post('/trigger-links', requireCustomFieldsAccess, requireFeature('trigger_links'), createTriggerLinkHandler);
router.put('/trigger-links/:triggerLinkId', requireCustomFieldsAccess, requireFeature('trigger_links'), updateTriggerLinkHandler);
router.delete('/trigger-links/:triggerLinkId', requireCustomFieldsAccess, requireFeature('trigger_links'), deleteTriggerLinkHandler);
router.get('/trigger-links/:triggerLinkId/events', requireCustomFieldsAccess, requireFeature('trigger_links'), listTriggerLinkEventsHandler);

// GET /api/settings/notifications
router.get('/notifications', requireAccountAccess, getNotificationsView);

// Payment settings
router.get('/payments', requirePaymentsAccess, getPaymentSettingsView);
router.post('/payments', requirePaymentsAccess, savePaymentSettingsView);
router.post('/payments/gigstack/test-connection', requirePaymentsAccess, testGigstackConnectionView);
router.post('/payments/gigstack/sync-fiscal-profile', requirePaymentsAccess, syncGigstackFiscalProfileView);
router.post('/payments/receipt-preview-session', requirePaymentsAccess, createPaymentReceiptPreviewSessionView);

// WhatsApp message templates
router.get('/message-templates', requireWhatsAppAccess, requireFeature('whatsapp_templates'), getMessageTemplatesView);
router.get('/message-templates/variables', requireWhatsAppAccess, requireFeature('whatsapp_templates'), getMessageTemplateVariablesView);
router.post('/message-templates/preview', requireWhatsAppAccess, requireFeature('whatsapp_templates'), previewMessageTemplateView);
router.post('/message-templates/sync', requireWhatsAppAccess, requireFeature('whatsapp_templates'), syncAllMessageTemplatesWithActiveProviderView);
router.post('/message-templates/repair-defaults', requireWhatsAppAccess, requireFeature('whatsapp_templates'), repairDefaultMessageTemplatesView);

router.post('/message-templates/folders', requireWhatsAppAccess, requireFeature('whatsapp_templates'), createTemplateFolderView);
router.put('/message-templates/folders/:id', requireWhatsAppAccess, requireFeature('whatsapp_templates'), updateTemplateFolderView);
router.delete('/message-templates/folders/:id', requireWhatsAppAccess, requireFeature('whatsapp_templates'), deleteTemplateFolderView);

router.post('/message-templates/custom-fields', requireWhatsAppAccess, requireFeature('whatsapp_templates'), createTemplateCustomFieldView);
router.delete('/message-templates/custom-fields/:id', requireWhatsAppAccess, requireFeature('whatsapp_templates'), deleteTemplateCustomFieldView);

router.post('/message-templates', requireWhatsAppAccess, requireFeature('whatsapp_templates'), createMessageTemplateView);
router.post('/message-templates/:id/submit', requireWhatsAppAccess, requireFeature('whatsapp_templates'), submitMessageTemplateToActiveProviderView);
router.post('/message-templates/:id/sync', requireWhatsAppAccess, requireFeature('whatsapp_templates'), syncMessageTemplateStatusView);
router.post('/message-templates/:id/send-test', requireWhatsAppAccess, requireFeature('whatsapp_templates'), sendMessageTemplateTestView);
router.put('/message-templates/:id', requireWhatsAppAccess, requireFeature('whatsapp_templates'), updateMessageTemplateView);
router.delete('/message-templates/:id', requireWhatsAppAccess, requireFeature('whatsapp_templates'), deleteMessageTemplateView);

export default router;
