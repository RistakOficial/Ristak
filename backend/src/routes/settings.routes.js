import express from 'express';
import {
  archiveCustomFieldFolder,
  createCustomField,
  createCustomFieldFolder,
  deleteCustomField,
  getTimezone,
  listCustomFields,
  setTimezone,
  updateCustomField,
  updateCustomFieldFolder
} from '../controllers/settingsController.js';
import { getNotificationsView } from '../controllers/notificationsController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
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
  sendMessageTemplateTestView,
  submitMessageTemplateToYCloudView,
  syncAllMessageTemplatesWithYCloudView,
  syncMessageTemplateStatusView,
  updateMessageTemplateView,
  updateTemplateFolderView
} from '../controllers/messageTemplatesController.js';
import {
  createPaymentReceiptPreviewSessionView,
  getPaymentSettingsView,
  previewPaymentReceiptSessionView,
  savePaymentSettingsView
} from '../controllers/paymentSettingsController.js';

const router = express.Router();
const requireAccountAccess = requireModuleAccess('settings_account');
const requireCustomFieldsAccess = requireModuleAccess('settings_custom_fields');
const requireWhatsAppAccess = requireModuleAccess('settings_whatsapp');
const requirePaymentsAccess = requireModuleAccess('settings_payments');

router.get('/payments/receipt-preview-session/:token', previewPaymentReceiptSessionView);

router.use(requireAuth);

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
router.get('/trigger-links', requireCustomFieldsAccess, listTriggerLinksHandler);
router.post('/trigger-links', requireCustomFieldsAccess, createTriggerLinkHandler);
router.put('/trigger-links/:triggerLinkId', requireCustomFieldsAccess, updateTriggerLinkHandler);
router.delete('/trigger-links/:triggerLinkId', requireCustomFieldsAccess, deleteTriggerLinkHandler);
router.get('/trigger-links/:triggerLinkId/events', requireCustomFieldsAccess, listTriggerLinkEventsHandler);

// GET /api/settings/notifications
router.get('/notifications', requireAccountAccess, getNotificationsView);

// Payment settings
router.get('/payments', requirePaymentsAccess, getPaymentSettingsView);
router.post('/payments', requirePaymentsAccess, savePaymentSettingsView);
router.post('/payments/receipt-preview-session', requirePaymentsAccess, createPaymentReceiptPreviewSessionView);

// WhatsApp message templates
router.get('/message-templates', requireWhatsAppAccess, getMessageTemplatesView);
router.get('/message-templates/variables', requireWhatsAppAccess, getMessageTemplateVariablesView);
router.post('/message-templates/preview', requireWhatsAppAccess, previewMessageTemplateView);
router.post('/message-templates/sync', requireWhatsAppAccess, syncAllMessageTemplatesWithYCloudView);

router.post('/message-templates/folders', requireWhatsAppAccess, createTemplateFolderView);
router.put('/message-templates/folders/:id', requireWhatsAppAccess, updateTemplateFolderView);
router.delete('/message-templates/folders/:id', requireWhatsAppAccess, deleteTemplateFolderView);

router.post('/message-templates/custom-fields', requireWhatsAppAccess, createTemplateCustomFieldView);
router.delete('/message-templates/custom-fields/:id', requireWhatsAppAccess, deleteTemplateCustomFieldView);

router.post('/message-templates', requireWhatsAppAccess, createMessageTemplateView);
router.post('/message-templates/:id/submit', requireWhatsAppAccess, submitMessageTemplateToYCloudView);
router.post('/message-templates/:id/sync', requireWhatsAppAccess, syncMessageTemplateStatusView);
router.post('/message-templates/:id/send-test', requireWhatsAppAccess, sendMessageTemplateTestView);
router.put('/message-templates/:id', requireWhatsAppAccess, updateMessageTemplateView);
router.delete('/message-templates/:id', requireWhatsAppAccess, deleteMessageTemplateView);

export default router;
