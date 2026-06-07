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

const router = express.Router();

router.use(requireAuth);

// GET /api/settings/timezone
router.get('/timezone', getTimezone);

// POST /api/settings/timezone
router.post('/timezone', setTimezone);

// Custom fields
router.get('/custom-fields', listCustomFields);
router.post('/custom-fields', createCustomField);
router.put('/custom-fields/:definitionId', updateCustomField);
router.delete('/custom-fields/:definitionId', deleteCustomField);

router.post('/custom-field-folders', createCustomFieldFolder);
router.put('/custom-field-folders/:folderId', updateCustomFieldFolder);
router.delete('/custom-field-folders/:folderId', archiveCustomFieldFolder);

// GET /api/settings/notifications
router.get('/notifications', getNotificationsView);

// WhatsApp message templates
router.get('/message-templates', getMessageTemplatesView);
router.get('/message-templates/variables', getMessageTemplateVariablesView);
router.post('/message-templates/preview', previewMessageTemplateView);
router.post('/message-templates/sync', syncAllMessageTemplatesWithYCloudView);

router.post('/message-templates/folders', createTemplateFolderView);
router.put('/message-templates/folders/:id', updateTemplateFolderView);
router.delete('/message-templates/folders/:id', deleteTemplateFolderView);

router.post('/message-templates/custom-fields', createTemplateCustomFieldView);
router.delete('/message-templates/custom-fields/:id', deleteTemplateCustomFieldView);

router.post('/message-templates', createMessageTemplateView);
router.post('/message-templates/:id/submit', submitMessageTemplateToYCloudView);
router.post('/message-templates/:id/sync', syncMessageTemplateStatusView);
router.post('/message-templates/:id/send-test', sendMessageTemplateTestView);
router.put('/message-templates/:id', updateMessageTemplateView);
router.delete('/message-templates/:id', deleteMessageTemplateView);

export default router;
