import express from 'express';
import { getTimezone, setTimezone } from '../controllers/settingsController.js';
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

// GET /api/settings/timezone
router.get('/timezone', getTimezone);

// POST /api/settings/timezone
router.post('/timezone', setTimezone);

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
