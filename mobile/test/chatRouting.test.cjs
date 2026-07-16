const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

const {
  buildNativeWhatsAppSenderRoute,
  getNativeApiReplyWindowOpen,
  getLastHighLevelWhatsAppBusinessPhone,
  getOutboundMessageChannelFamily,
  getOutboundProviderMessageId,
  getPreferredWhatsAppPhoneId,
  getOutboundSendResultState,
  isHighLevelWhatsAppTransport,
  keepLastKnownCatalogValue,
  normalizeNativeWhatsAppSenderRoute,
  readLocalCatalogWithRetry,
} = require('../src/chatRouting.ts');
const { resolveChatMessageChannel } = require('../src/chatMessageChannel.ts');

test('los globos distinguen WhatsApp API de QR y dejan correo/SMS neutrales', () => {
  assert.equal(resolveChatMessageChannel({ eventType: 'whatsapp_message', transport: 'api' }), 'whatsapp_api');
  assert.equal(resolveChatMessageChannel({ eventType: 'whatsapp_message', transport: 'qr' }), 'whatsapp_qr');
  assert.equal(resolveChatMessageChannel({ channel: 'whatsapp', transport: 'baileys' }), 'whatsapp_qr');
  assert.equal(resolveChatMessageChannel({ channel: 'whatsapp_qr' }), 'whatsapp_qr');
  assert.equal(resolveChatMessageChannel({ channel: 'whatsapp', provider: 'qr' }), 'whatsapp_qr');
  assert.equal(resolveChatMessageChannel({ eventType: 'email_message', transport: 'smtp' }), 'email');
  assert.equal(resolveChatMessageChannel({ channel: 'sms_qr', transport: 'qr' }), 'sms');
  assert.equal(resolveChatMessageChannel({ eventType: 'sms_message' }), 'sms');
});

test('Instagram y Facebook/Messenger ganan sobre un transporte API generico', () => {
  assert.equal(resolveChatMessageChannel({ eventType: 'meta_message', transport: 'api', platform: 'instagram' }), 'instagram');
  assert.equal(resolveChatMessageChannel({ channel: 'facebook_comment', transport: 'meta' }), 'messenger');
});

const contact = {
  id: 'contact-1',
  phone: '+526561111111',
  lastInboundBusinessPhone: '+52 656 700 0001',
  lastInboundBusinessPhoneNumberId: 'meta-direct-1',
  firstInboundBusinessPhone: '+52 656 700 0000',
  firstInboundBusinessPhoneNumberId: 'meta-direct-old',
  lastBusinessPhone: '+52 656 799 9999',
  lastBusinessPhoneNumberId: 'ycloud-old',
};

test('el remitente default prioriza el ultimo numero que recibio al contacto', () => {
  assert.equal(getPreferredWhatsAppPhoneId(contact), 'meta-direct-1');
  assert.deepEqual(normalizeNativeWhatsAppSenderRoute(contact), {
    phoneNumberId: 'meta-direct-1',
    fromPhone: '+52 656 700 0001',
    transport: undefined,
  });

  assert.equal(getPreferredWhatsAppPhoneId({
    ...contact,
    preferredWhatsAppPhoneNumberId: 'manual-number',
  }), 'manual-number');
});

test('el numero elegido viaja como una sola identidad en id, from y transporte', () => {
  const route = buildNativeWhatsAppSenderRoute(contact, {
    id: 'meta-direct-2',
    provider: 'meta_direct',
    phone_number: '+52 656 700 0002',
  }, 'api');

  assert.deepEqual(route, {
    phoneNumberId: 'meta-direct-2',
    fromPhone: '+52 656 700 0002',
    transport: 'api',
  });

  assert.deepEqual(normalizeNativeWhatsAppSenderRoute(contact, {
    phoneNumberId: 'meta-direct-1',
    transport: 'api',
  }), {
    phoneNumberId: 'meta-direct-1',
    fromPhone: '+52 656 700 0001',
    transport: 'api',
  });

  assert.deepEqual(normalizeNativeWhatsAppSenderRoute(contact, {
    phoneNumberId: 'new-number-without-visible-phone',
    transport: 'api',
  }), {
    phoneNumberId: 'new-number-without-visible-phone',
    fromPhone: undefined,
    transport: 'api',
  });
});

test('la ventana de 24 horas pertenece al numero seleccionado, no a otro WhatsApp', () => {
  const now = Date.parse('2026-07-15T18:00:00.000Z');
  const messages = [
    {
      id: 'recent-for-a',
      contactId: contact.id,
      date: '2026-07-15T17:55:00.000Z',
      direction: 'inbound',
      text: 'Hola A',
      channel: 'whatsapp_api',
      businessPhone: '+52 656 700 0001',
      businessPhoneNumberId: 'meta-direct-1',
    },
    {
      id: 'old-for-b',
      contactId: contact.id,
      date: '2026-07-13T17:55:00.000Z',
      direction: 'inbound',
      text: 'Hola B',
      channel: 'whatsapp_api',
      businessPhone: '+52 656 700 0002',
      businessPhoneNumberId: 'meta-direct-2',
    },
  ];

  assert.equal(getNativeApiReplyWindowOpen(messages, {
    phoneNumberId: 'meta-direct-1',
    fromPhone: '+526567000001',
  }, now), true);
  assert.equal(getNativeApiReplyWindowOpen(messages, {
    phoneNumberId: 'meta-direct-2',
    fromPhone: '+526567000002',
  }, now), false);
  assert.equal(getNativeApiReplyWindowOpen([{
    ...messages[0],
    businessPhone: undefined,
    businessPhoneNumberId: undefined,
  }], {
    phoneNumberId: 'meta-direct-1',
    fromPhone: '+526567000001',
  }, now), false);
  assert.equal(getNativeApiReplyWindowOpen([{
    ...messages[0],
    transport: 'ghl_whatsapp_api',
  }], {
    phoneNumberId: 'meta-direct-1',
    fromPhone: '+526567000001',
  }, now), false);
});

test('WhatsApp HighLevel se liga al ultimo business phone inbound verificado', () => {
  assert.equal(getLastHighLevelWhatsAppBusinessPhone([
    {
      id: 'native', contactId: contact.id, date: '2026-07-15T18:00:00.000Z',
      direction: 'inbound', text: 'Meta', channel: 'whatsapp_api', transport: 'api',
      businessPhone: '+526567000001',
    },
    {
      id: 'ghl-old', contactId: contact.id, date: '2026-07-15T17:00:00.000Z',
      direction: 'inbound', text: 'GHL viejo', channel: 'whatsapp_api', transport: 'ghl_whatsapp',
      businessPhone: '+528123802400',
    },
    {
      id: 'ghl-new', contactId: contact.id, date: '2026-07-15T17:30:00.000Z',
      direction: 'inbound', text: 'GHL nuevo', channel: 'whatsapp_api', transport: 'ghl_whatsapp',
      businessPhone: '+528123802444',
    },
    {
      id: 'native-newer', contactId: contact.id, date: '2026-07-15T17:50:00.000Z',
      direction: 'inbound', text: 'Meta más nuevo', channel: 'whatsapp_api', transport: 'meta_direct',
      businessPhone: '+526567000099',
    },
    {
      id: 'ghl-alias', contactId: contact.id, date: '2026-07-15T17:40:00.000Z',
      direction: 'inbound', text: 'Alias canónico', channel: 'whatsapp_api', transport: 'ghl_whatsapp_api',
      businessPhone: '+528123802455',
    },
  ]), '+528123802455');
  assert.equal(isHighLevelWhatsAppTransport('HighLevel-WhatsApp-API'), true);
  assert.equal(isHighLevelWhatsAppTransport('meta_direct'), false);
});

test('el catalogo local reintenta una vez y conserva el ultimo estado si vuelve a fallar', async () => {
  let attempts = 0;
  const recovered = await readLocalCatalogWithRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('timeout local');
    return { connected: true, phoneNumbers: [{ id: 'meta-direct-1' }] };
  }, 1, 0);

  assert.equal(attempts, 2);
  assert.equal(recovered.ok, true);
  assert.equal(keepLastKnownCatalogValue(recovered, null).connected, true);

  const known = { connected: true, phoneNumbers: [{ id: 'known-good' }] };
  const failed = await readLocalCatalogWithRetry(async () => {
    throw new Error('backend no disponible');
  }, 1, 0);
  assert.equal(failed.ok, false);
  assert.equal(keepLastKnownCatalogValue(failed, known), known);

  let notFoundAttempts = 0;
  const notFound = await readLocalCatalogWithRetry(async () => {
    notFoundAttempts += 1;
    throw Object.assign(new Error('no encontrado'), { status: 404 });
  }, 1, 0);
  assert.equal(notFound.ok, false);
  assert.equal(notFoundAttempts, 1);
});

test('un HTTP aceptado conserva pending y un status failed nunca pinta falso exito', () => {
  assert.deepEqual(getOutboundSendResultState({ status: 'pending' }), {
    status: 'pending',
    pending: true,
    failed: false,
    errorReason: '',
  });
  assert.deepEqual(getOutboundSendResultState({
    status: 'failed',
    errorMessage: 'Pasaron más de 24 horas.',
  }), {
    status: 'failed',
    pending: false,
    failed: true,
    errorReason: 'Pasaron más de 24 horas.',
  });
  assert.deepEqual(getOutboundSendResultState({
    status: 'sent',
    transport: 'ghl_whatsapp',
    messageId: 'ghl-accepted',
  }), {
    status: 'pending',
    pending: true,
    failed: false,
    errorReason: '',
  });
  assert.deepEqual(getOutboundSendResultState({
    transport: 'ghl_whatsapp',
    messageId: 'ghl-without-receipt',
  }), {
    status: 'pending',
    pending: true,
    failed: false,
    errorReason: '',
  });
  assert.deepEqual(getOutboundSendResultState({
    success: false,
    error: 'HighLevel rechazó el mensaje.',
  }), {
    status: 'failed',
    pending: false,
    failed: true,
    errorReason: 'HighLevel rechazó el mensaje.',
  });
});

test('la identidad y familia del proveedor impiden cruzar HighLevel con Meta o YCloud', () => {
  assert.equal(getOutboundProviderMessageId({ messageId: 'ghl-message-1', id: 'legacy-id' }), 'ghl-message-1');
  assert.equal(getOutboundProviderMessageId({ data: { message: { messageId: 'nested-message-2' } } }), 'nested-message-2');
  assert.equal(getOutboundProviderMessageId({ messageIds: ['message-array-3'] }), 'message-array-3');

  assert.equal(getOutboundMessageChannelFamily({ channel: 'whatsapp_api', transport: 'ghl_whatsapp' }), 'highlevel_whatsapp');
  assert.equal(getOutboundMessageChannelFamily({ channel: 'whatsapp_api', transport: 'meta_direct' }), 'whatsapp');
  assert.equal(getOutboundMessageChannelFamily({ channel: 'whatsapp_api', transport: 'ycloud' }), 'whatsapp');
  assert.equal(getOutboundMessageChannelFamily({ channel: 'meta_message', transport: 'messenger' }), 'meta_social');
  assert.notEqual(
    getOutboundMessageChannelFamily({ channel: 'whatsapp_api', transport: 'ghl_whatsapp' }),
    getOutboundMessageChannelFamily({ channel: 'whatsapp_api', transport: 'native' }),
  );
});

test('todos los envios nativos consumen la ruta normalizada y no el sender viejo del contacto', () => {
  const source = fs.readFileSync(require.resolve('../src/api.ts'), 'utf8');
  const normalizations = source.match(/normalizeNativeWhatsAppSenderRoute\(contact, whatsAppSender\)/g) || [];

  assert.ok(normalizations.length >= 8);
  assert.doesNotMatch(source, /from:\s*contact\.lastBusinessPhone/);
  assert.doesNotMatch(source, /fromPhone:[\s\S]{0,120}contact\.lastBusinessPhone/);
  assert.match(source, /sendWhatsAppTemplate\([\s\S]*?from: sender\.fromPhone[\s\S]*?phoneNumberId: sender\.phoneNumberId/);
  assert.match(source, /scheduleText\([\s\S]*?fromPhone:[\s\S]*?sender\.fromPhone[\s\S]*?businessPhoneNumberId:[\s\S]*?sender\.phoneNumberId/);
});

test('ubicacion, auxiliares y programados conservan proveedor, ventana y estado semantico', () => {
  const source = fs.readFileSync(require.resolve('../src/App.tsx'), 'utf8');

  assert.match(source, /const highLevelScheduleChannel = isHighLevelConnected\(integrationsStatus\)[\s\S]*isHighLevelWhatsAppTransport\(lastTransport\)/);
  assert.match(source, /highLevelChannel: highLevelScheduleChannel/);
  assert.match(source, /const whatsAppSend = selectedHighLevelChannel \? null : resolveWhatsAppSendTransport\(\);[\s\S]*Ventana de WhatsApp cerrada[\s\S]*api\.sendLocation/);
  assert.match(source, /const clabeWhatsAppSend =[\s\S]*replyWindowOpen[\s\S]*const response = selectedHighLevelChannel[\s\S]*getOutboundSendResultState\(response\)/);
  assert.match(source, /const optimisticTransport = selectedHighLevelChannel === 'whatsapp_api'[\s\S]*'ghl_whatsapp'[\s\S]*'ghl_sms'/);
  assert.match(source, /function getSendResponseProviderMessageId[\s\S]*getOutboundProviderMessageId\(response\)/);
});

test('fallar al persistir la preferencia no revierte el canal usable del composer', () => {
  const source = fs.readFileSync(require.resolve('../src/App.tsx'), 'utf8');
  const selector = source.slice(
    source.indexOf('const selectComposerChannel = useCallback(async'),
    source.indexOf('if (contactInfoOpen)', source.indexOf('const selectComposerChannel = useCallback(async')),
  );

  assert.match(selector, /setSelectedSendChannel\(channel\)/);
  assert.match(selector, /catch \(err\)[\s\S]*Puedes seguir enviando con este número/);
  assert.doesNotMatch(selector, /catch \(err\)[\s\S]*setSelectedSendChannel/);
  assert.doesNotMatch(selector, /catch \(err\)[\s\S]*rollbackPatch/);
});
