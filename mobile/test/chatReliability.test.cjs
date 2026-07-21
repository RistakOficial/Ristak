const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');

// Execute the production TypeScript modules without adding a test-only runtime
// dependency. TypeScript is already part of the mobile development toolchain.
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
  applyChatLiveEvent,
  mergeChatContactPages,
  mergeFreshChatPage,
  sortChatContactsByRecency,
} = require('../src/chatListState.ts');
const { parseSortableDateValue, resolveChatMessageReactions } = require('../src/format.ts');
const { buildUserCustomFieldRows } = require('../src/contactCustomFields.ts');
const {
  normalizeChatSelectionIds,
  toggleVisibleChatSelectionIds,
} = require('../src/chatSelectionState.ts');
const {
  NATIVE_LOCAL_OUTBOX_RETENTION_MS,
  getOldestConversationHistoryCursor,
  hasNewRenderableConversationHistoryMessage,
  isConversationHistoryCursorOlder,
  makeUnreconciledNativePendingMessagesRetryable,
  retainNativeLocalOutboxMessages,
} = require('../src/conversationReliability.ts');
const { PHONE_SECTION_MODULE, hasPaymentGatewaysAccess, hasPaymentLinksAccess, hasPhoneSectionAccess, hasWebAnalyticsAccess } = require('../src/access.ts');
const {
  createVerifiedUserCacheRecord,
  getCachedVerifiedUser,
  getSessionCacheNamespace,
  getSessionVerifyRejection,
  getVerifiedUserCacheNamespace,
  isCurrentSessionCacheNamespace,
} = require('../src/sessionAccess.ts');

function contact(id, lastMessageDate, overrides = {}) {
  return {
    id,
    name: `Contacto ${id}`,
    lastMessageDate,
    messageCount: 1,
    unreadCount: 0,
    ...overrides,
  };
}

test('seleccionar todos conserva ids que no estan en la pagina visible', () => {
  const allIds = normalizeChatSelectionIds([
    { id: 'visible-1' },
    { id: 'offscreen-1' },
    'offscreen-2',
    { id: 'offscreen-1' },
    { id: '  ' },
  ]);

  assert.deepEqual(allIds, ['visible-1', 'offscreen-1', 'offscreen-2']);
  assert.deepEqual(
    toggleVisibleChatSelectionIds(allIds, ['visible-1']),
    ['offscreen-1', 'offscreen-2'],
  );
  assert.deepEqual(
    toggleVisibleChatSelectionIds(['offscreen-1'], ['visible-1', 'visible-2']),
    ['offscreen-1', 'visible-1', 'visible-2'],
  );
});

test('info de contacto solo muestra campos definidos por el usuario', () => {
  const rows = buildUserCustomFieldRows([
    { definitionId: 'history', key: 'clinical_history', label: 'Historia clínica', sourceType: 'manual' },
    { definitionId: 'meta', key: 'meta_social_sender_id', label: 'Meta Social Sender ID', sourceType: 'system', system: true },
    { definitionId: 'business', key: 'business_name', label: 'Nombre del negocio', sourceType: 'manual' },
    { definitionId: 'business-dot', fieldKey: 'business.name', label: 'Empresa', sourceType: 'manual' },
  ], [
    { definitionId: 'history', key: 'clinical_history', value: 'Alergia a penicilina' },
    { definitionId: 'meta', key: 'meta_social_sender_id', value: '178900000' },
    { key: 'database_internal_id', label: 'Database Internal ID', value: 'abc' },
    { definitionId: 'business', key: 'business_name', value: 'Clínica Demo' },
  ]);

  assert.deepEqual(rows.map((row) => row.label), ['Historia clínica']);
  assert.equal(rows[0].value, 'Alergia a penicilina');
});

test('Analiticas movil usa el mismo permiso Dashboard que sus endpoints', () => {
  const dashboardOnlyUser = {
    role: 'employee',
    licenseEnforced: false,
    accessConfig: { dashboard: 'read', analytics: 'none' },
  };
  const webAnalyticsOnlyUser = {
    role: 'employee',
    licenseEnforced: false,
    accessConfig: { dashboard: 'none', analytics: 'read' },
  };
  const dashboardOutsidePlanUser = {
    role: 'employee',
    licenseEnforced: true,
    licenseFeatures: { dashboard: false, analytics: true },
    accessConfig: { dashboard: 'read', analytics: 'read' },
  };
  const dashboardInPlanUser = {
    ...dashboardOutsidePlanUser,
    licenseFeatures: { dashboard: true, analytics: false },
  };
  const dashboardMissingFromPlanUser = {
    ...dashboardOutsidePlanUser,
    licenseFeatures: { analytics: true },
  };
  const dashboardWithInvalidFeatureSourceUser = {
    ...dashboardInPlanUser,
    licenseFeaturesSourceValid: false,
  };

  assert.equal(PHONE_SECTION_MODULE.analytics, 'dashboard');
  assert.equal(hasPhoneSectionAccess(dashboardOnlyUser, 'analytics'), true);
  assert.equal(hasPhoneSectionAccess(webAnalyticsOnlyUser, 'analytics'), false);
  assert.equal(hasPhoneSectionAccess(dashboardOutsidePlanUser, 'analytics'), false);
  assert.equal(hasPhoneSectionAccess(dashboardInPlanUser, 'analytics'), true);
  assert.equal(hasPhoneSectionAccess(dashboardMissingFromPlanUser, 'analytics'), false);
  assert.equal(hasPhoneSectionAccess(dashboardWithInvalidFeatureSourceUser, 'analytics'), false);
});

test('Analiticas movil solo muestra metricas web en Profesional', () => {
  const licensedUser = (licensePlan, webAnalytics = true) => ({
    role: 'admin',
    licenseEnforced: true,
    licensePlan,
    licenseFeatures: { web_analytics: webAnalytics },
  });

  assert.equal(hasWebAnalyticsAccess(licensedUser('basic')), false);
  assert.equal(hasWebAnalyticsAccess(licensedUser('medium')), false);
  assert.equal(hasWebAnalyticsAccess(licensedUser('professional')), true);
  assert.equal(hasWebAnalyticsAccess(licensedUser('premium')), true);
  assert.equal(hasWebAnalyticsAccess(licensedUser('professional', false)), false);
  assert.equal(hasWebAnalyticsAccess({ licenseEnforced: false }), true);
});

test('Pagos movil reserva pasarelas y links para Profesional', () => {
  const licensedUser = (licensePlan, enabled = true) => ({
    role: 'admin',
    licenseEnforced: true,
    licensePlan,
    licenseFeatures: { payment_gateways: enabled, payment_links: enabled },
  });

  for (const accessCheck of [hasPaymentGatewaysAccess, hasPaymentLinksAccess]) {
    assert.equal(accessCheck(licensedUser('basic')), false);
    assert.equal(accessCheck(licensedUser('medium')), false);
    assert.equal(accessCheck(licensedUser('professional')), true);
    assert.equal(accessCheck(licensedUser('premium')), true);
    assert.equal(accessCheck(licensedUser('professional', false)), false);
    assert.equal(accessCheck({ licenseEnforced: false }), true);
  }

  const appSource = fs.readFileSync(require.resolve('../src/App.tsx'), 'utf8');
  assert.match(appSource, /hasProfessionalMobilePlan\(plan\)/);
  assert.match(appSource, /isLicenseFeatureEnabled\(license\?\.features, 'payment_links'\)/);
  assert.match(appSource, /const offlineOnly = !canUsePaymentLinks \|\| !hasConnectedGateway/);
});

test('un usuario sin verificar nunca abre secciones por default', () => {
  assert.equal(hasPhoneSectionAccess(null, 'chat'), false);
  assert.equal(hasPhoneSectionAccess(undefined, 'analytics'), false);
});

test('la ACL offline solo hidrata para el mismo servidor y token', () => {
  const user = {
    id: 'operator-1',
    role: 'employee',
    accessConfig: { chat: 'read', payments: 'none' },
  };
  const record = createVerifiedUserCacheRecord('https://tenant.example.com/', 'token-a', user, 123);

  assert.ok(record);
  assert.equal(getCachedVerifiedUser(record, 'https://tenant.example.com', 'token-a'), user);
  assert.equal(getCachedVerifiedUser(record, 'https://other.example.com', 'token-a'), null);
  assert.equal(getCachedVerifiedUser(record, 'https://tenant.example.com', 'token-b'), null);
  assert.equal(record.namespace.includes('token-a'), false);
  assert.notEqual(
    getVerifiedUserCacheNamespace('https://tenant.example.com', 'token-a'),
    getVerifiedUserCacheNamespace('https://tenant.example.com', 'token-b'),
  );
});

test('la cache de datos usa el mismo limite de sesion y rechaza resultados background viejos', () => {
  const namespace = getSessionCacheNamespace('https://tenant.example.com/', 'token-a');

  assert.equal(namespace, getVerifiedUserCacheNamespace('https://tenant.example.com', 'token-a'));
  assert.equal(namespace.includes('token-a'), false);
  assert.equal(isCurrentSessionCacheNamespace(namespace, 'https://tenant.example.com', 'token-a'), true);
  assert.equal(isCurrentSessionCacheNamespace(namespace, 'https://tenant.example.com', 'token-b'), false);
  assert.equal(isCurrentSessionCacheNamespace(namespace, 'https://other.example.com', 'token-a'), false);
  assert.notEqual(namespace, getSessionCacheNamespace('https://tenant.example.com', 'token-b'));
});

test('el refresh background revalida la sesion y fija el namespace al escribir incluso vacio', () => {
  const source = fs.readFileSync(require.resolve('../src/background.ts'), 'utf8');

  assert.match(source, /isCurrentSessionCacheNamespace\(session\.namespace, currentBaseUrl, currentToken\)/);
  assert.match(source, /writeCacheNow\([\s\S]*NATIVE_INBOX_CACHE_KEY,[\s\S]*chats\.slice\(0, NATIVE_INBOX_CACHE_LIMIT\),[\s\S]*session\.namespace/);
  assert.doesNotMatch(source, /if \(chats\.length\)/);
  assert.doesNotMatch(source, /setCacheNamespace/);
});

test('los envios secundarios conservan identidad estable y Analiticas no disfraza errores como ceros', () => {
  const apiSource = fs.readFileSync(require.resolve('../src/api.ts'), 'utf8');
  const appSource = fs.readFileSync(require.resolve('../src/App.tsx'), 'utf8');

  assert.match(apiSource, /sendLocation\([^)]*externalId\?: string\)/s);
  assert.match(apiSource, /sendWhatsAppTemplate\([^)]*externalId\?: string\)/s);
  assert.match(apiSource, /externalId: externalId \|\| createNativeExternalId\('native-location'\)/);
  assert.match(apiSource, /externalId: externalId \|\| createNativeExternalId\('native-template'\)/);
  assert.match(appSource, /quickPaymentIntentRef[\s\S]*id: intent\.transactionId/);
  assert.match(appSource, /scheduleSendIntentRef[\s\S]*api\.scheduleText\([\s\S]*scheduledId/);
  assert.match(appSource, /setChartError\(/);
  assert.match(appSource, /setFunnelError\(/);
  assert.match(appSource, /setOriginError\(/);
  assert.doesNotMatch(appSource, /getOriginDistribution\([^\n]+\)\.catch\(\(\) => EMPTY_ORIGIN_DATA\)/);
});

test('los cambios realtime de mensajes programados fuerzan reconciliacion inmediata', () => {
  const apiSource = fs.readFileSync(require.resolve('../src/api.ts'), 'utf8');
  const appSource = fs.readFileSync(require.resolve('../src/App.tsx'), 'utf8');

  assert.match(apiSource, /parsed\.event === 'chat_data_changed'/);
  assert.match(apiSource, /options\.onDataChanged\?\.\(payload as ChatLiveDataChangedEvent\)/);
  assert.match(appSource, /onDataChanged: \(event\) => \{\s+DeviceEventEmitter\.emit\(CHAT_REFRESH_EVENT, event\)/);
  assert.match(appSource, /event\.domains\.includes\('scheduled_messages'\)[\s\S]{0,500}scheduledMessagesLastLoadedAtRef\.current = 0/);
});

test('solo un rechazo definitivo invalida la sesion durante revalidacion', () => {
  assert.equal(getSessionVerifyRejection({ status: 401 }), 'unauthorized');
  assert.equal(getSessionVerifyRejection({ status: 403, code: 'license_blocked' }), 'license_blocked');
  assert.equal(getSessionVerifyRejection({ status: 403, code: 'feature_not_available' }), null);
  assert.equal(getSessionVerifyRejection({ status: 500 }), null);
  assert.equal(getSessionVerifyRejection(new Error('network request failed')), null);
});

test('una reaccion de pagina reciente se adjunta cuando llega su mensaje historico', () => {
  const pendingReaction = {
    id: 'reaction-1',
    contactId: 'contact-1',
    date: '2026-07-10T18:31:00.000Z',
    direction: 'outbound',
    text: '',
    messageType: 'reaction',
    reactionEmoji: '🔥',
    reactionTargetProviderMessageId: 'provider-message-1',
  };
  const target = {
    id: 'message-1',
    providerMessageId: 'provider-message-1',
    contactId: 'contact-1',
    date: '2026-07-10T18:00:00.000Z',
    direction: 'inbound',
    text: 'Mensaje histórico',
  };

  const recentPage = resolveChatMessageReactions([pendingReaction]);
  assert.equal(recentPage.length, 1);
  const mergedPages = resolveChatMessageReactions([...recentPage, target]);
  assert.equal(mergedPages.length, 1);
  assert.equal(mergedPages[0].id, target.id);
  assert.deepEqual(mergedPages[0].reactions, [{ id: 'reaction-1', emoji: '🔥', direction: 'outbound' }]);
});

test('el historial conserva fecha e identidad para paginar empates sin saltos', () => {
  const tiedDate = '2026-07-10T18:30:00.000Z';
  const cursor = getOldestConversationHistoryCursor([
    { type: 'whatsapp_message', date: tiedDate, cursorKey: 'whatsapp_api:z-message' },
    { type: 'meta_message', date: tiedDate, cursorKey: 'meta_social:a-message' },
    // Una reaccion no pinta globo propio, pero sí puede ser el limite real de la pagina.
    { type: 'meta_message', date: tiedDate, cursorKey: 'meta_social:0-reaction' },
    { type: 'whatsapp_message', date: '2026-07-10T18:31:00.000Z', cursorKey: 'whatsapp_api:newer' },
  ]);

  assert.deepEqual(cursor, {
    beforeMessageDate: tiedDate,
    beforeMessageCursor: 'meta_social:0-reaction',
  });

  assert.equal(isConversationHistoryCursorOlder(cursor, {
    beforeMessageDate: tiedDate,
    beforeMessageCursor: 'meta_social:_later',
  }), true);
  assert.equal(isConversationHistoryCursorOlder(cursor, cursor), false);
});

test('una pagina historica de puras reacciones no bloquea el prefetch de burbujas', () => {
  const current = [{
    id: 'message-current',
    contactId: 'contact-1',
    date: '2026-07-10T18:30:00.000Z',
    direction: 'inbound',
    text: 'Mensaje actual',
  }];
  const reactionOnlyPage = [{
    id: 'reaction-old',
    contactId: 'contact-1',
    date: '2026-07-10T18:00:00.000Z',
    direction: 'outbound',
    text: '',
    reactionEmoji: '👍',
    reactionTargetProviderMessageId: 'provider-current',
  }];
  const pageWithBubble = [...reactionOnlyPage, {
    id: 'message-old',
    contactId: 'contact-1',
    date: '2026-07-10T17:59:00.000Z',
    direction: 'inbound',
    text: 'Mensaje anterior',
  }];

  assert.equal(hasNewRenderableConversationHistoryMessage(current, reactionOnlyPage), false);
  assert.equal(hasNewRenderableConversationHistoryMessage(current, pageWithBubble), true);

  const appSource = fs.readFileSync(require.resolve('../src/App.tsx'), 'utf8');
  assert.match(appSource, /CHAT_CONVERSATION_EMPTY_HISTORY_PREFETCH_LIMIT = 5/);
  assert.match(appSource, /hasNewRenderableConversationHistoryMessage\(messagesRef\.current, collectedOlderMessages\)/);
});

test('el outbox conserva solo locales pendientes o fallidos dentro de su TTL', () => {
  const now = Date.parse('2026-07-10T18:30:00.000Z');
  const base = {
    contactId: 'contact-1',
    direction: 'outbound',
    text: 'Hola',
    channel: 'whatsapp',
  };
  const freshFailed = { ...base, id: 'local-failed', date: new Date(now - 60_000).toISOString(), failed: true, status: 'error' };
  const freshPending = { ...base, id: 'local-pending', date: new Date(now - 30_000).toISOString(), pending: true, status: 'enviando' };
  const expiredFailed = { ...base, id: 'local-expired', date: new Date(now - NATIVE_LOCAL_OUTBOX_RETENTION_MS - 1).toISOString(), failed: true };
  const alreadySent = { ...base, id: 'local-sent', date: new Date(now - 30_000).toISOString(), status: 'sent' };
  const scheduled = { ...base, id: 'scheduled-1', date: new Date(now - 30_000).toISOString(), pending: true, status: 'scheduled', scheduledAt: new Date(now + 60_000).toISOString() };
  const inbound = { ...base, id: 'local-inbound', date: new Date(now - 30_000).toISOString(), direction: 'inbound', failed: true };

  const retained = retainNativeLocalOutboxMessages([
    freshFailed,
    freshPending,
    expiredFailed,
    alreadySent,
    scheduled,
    inbound,
  ], now);

  assert.deepEqual(retained.map(({ id }) => id), ['local-failed', 'local-pending']);
});

test('un pending rehidratado queda fallido y reintentable si el servidor no lo reconcilio', () => {
  const pending = {
    id: 'local-native-send-contact-1-123',
    contactId: 'contact-1',
    date: '2026-07-10T18:29:00.000Z',
    direction: 'outbound',
    text: 'Mensaje pendiente',
    channel: 'whatsapp',
    pending: true,
    status: 'enviando',
  };
  const failed = {
    ...pending,
    id: 'local-native-send-contact-1-456',
    pending: false,
    failed: true,
    status: 'error',
  };
  const reconciled = {
    ...pending,
    id: 'local-native-send-contact-1-789',
    pending: false,
    failed: false,
    status: 'sent',
  };
  const acknowledgedPending = {
    ...pending,
    id: 'local-native-send-contact-1-ack',
    serverMessageId: 'server-row-1',
  };

  const activeSendResult = makeUnreconciledNativePendingMessagesRetryable([pending], false);
  const result = makeUnreconciledNativePendingMessagesRetryable([pending, failed, reconciled, acknowledgedPending]);

  assert.equal(activeSendResult[0], pending);
  assert.equal(result[0].pending, false);
  assert.equal(result[0].failed, true);
  assert.equal(result[0].status, 'error');
  assert.match(result[0].errorReason, /reintentar/i);
  assert.equal(result[1], failed);
  assert.equal(result[2], reconciled);
  assert.equal(result[3], acknowledgedPending);
});

test('la carga canonica conserva el outbox y la cache escribe vacio solo despues de hidratar', () => {
  const source = fs.readFileSync(require.resolve('../src/App.tsx'), 'utf8');
  const mergeSource = fs.readFileSync(require.resolve('../src/chatMessageMerge.ts'), 'utf8');

  assert.match(source, /if \(!conversationCacheHydrated\) return;/);
  assert.match(source, /writeCache\(conversationCacheKey\(contact\.id\), latestMessages\)/);
  assert.match(source, /retainNativeLocalOutboxMessages\(current\)/);
  assert.match(source, /mergeNativeChatMessagesAuthoritatively\([\s\S]*!sendLockedRef\.current,[\s\S]*retainedOutboxMessages/);
  assert.match(mergeSource, /reconcileNativeOptimisticMessages\(byId, includeUnsettledLocal\)/);
  assert.match(mergeSource, /const serverState = getOutboundSendResultState\(serverRow\)/);
  assert.match(mergeSource, /pending: serverRow\.pending \?\? serverState\.pending,[\s\S]{0,120}failed: serverRow\.failed \?\? serverState\.failed/);
  assert.doesNotMatch(source, /if \(messages\.length\) \{[\s\S]{0,300}conversationCacheKey\(contact\.id\)/);
});

test('normaliza timestamps ISO y SQLite UTC al mismo instante', () => {
  const iso = '2026-07-10T18:30:45.000Z';
  const sqlite = '2026-07-10 18:30:45';

  assert.equal(parseSortableDateValue(sqlite), parseSortableDateValue(iso));
  assert.equal(
    parseSortableDateValue('2026-07-10 13:30:45-0500'),
    parseSortableDateValue(iso),
  );
});

test('ordena por instante y conserva un orden estable para timestamps equivalentes', () => {
  const sameFirst = contact('same-first', '2026-07-10 18:30:45');
  const oldest = contact('oldest', '2026-07-10T18:29:00.000Z');
  const sameSecond = contact('same-second', '2026-07-10T18:30:45.000Z');
  const newest = contact('newest', '2026-07-10T18:31:00.000Z');

  const result = sortChatContactsByRecency([sameFirst, oldest, sameSecond, newest]);

  assert.deepEqual(result.map(({ id }) => id), [
    'newest',
    'same-first',
    'same-second',
    'oldest',
  ]);
});

test('un evento SSE entrante promueve la fila e incrementa el no leido', () => {
  const openChat = contact('open', '2026-07-10T18:30:00.000Z');
  const updatedChat = contact('updated', '2026-07-10 18:20:00', {
    messageCount: 4,
    unreadCount: 2,
  });

  const result = applyChatLiveEvent([openChat, updatedChat], {
    type: 'chat_message',
    contactId: 'updated',
    direction: 'inbound',
    channel: 'whatsapp',
    transport: 'ycloud',
    messageType: 'text',
    messageTimestamp: '2026-07-10T18:31:00.000Z',
    isNew: true,
  }, 'open');

  assert.equal(result[0].id, 'updated');
  assert.equal(result[0].messageCount, 5);
  assert.equal(result[0].unreadCount, 3);
  assert.equal(result[0].lastMessageDirection, 'inbound');
  assert.equal(result[0].lastMessageChannel, 'whatsapp');
  assert.equal(result[0].lastMessageTransport, 'ycloud');
  assert.equal(result[0].lastMessageType, 'text');
});

test('ignora un evento mas viejo sin crear otro arreglo', () => {
  const current = [
    contact('first', '2026-07-10T18:30:00.000Z'),
    contact('second', '2026-07-10 18:25:00'),
  ];

  const result = applyChatLiveEvent(current, {
    type: 'chat_message',
    contactId: 'second',
    direction: 'inbound',
    messageTimestamp: '2026-07-10T18:24:59.000Z',
    isNew: true,
  });

  assert.equal(result, current);
});

test('una pagina inicial corta elimina filas fantasma', () => {
  const retained = contact('retained', '2026-07-10T18:30:00.000Z');
  const ghost = contact('ghost', '2026-07-10T18:20:00.000Z');

  const result = mergeFreshChatPage([{ ...retained }], [retained, ghost], 2);

  assert.deepEqual(result.map(({ id }) => id), ['retained']);
  assert.equal(result[0], retained);
});

test('una pagina inicial llena conserva solamente el tail realmente mas viejo', () => {
  const previous = [
    contact('first', '2026-07-10T18:20:00.000Z'),
    contact('stale-recent', '2026-07-10T18:15:00.000Z'),
    contact('second', '2026-07-10T18:10:00.000Z'),
    contact('older-tail', '2026-07-10T18:00:00.000Z'),
  ];
  const fresh = [
    contact('first', '2026-07-10T18:30:00.000Z'),
    contact('second', '2026-07-10 18:10:00'),
  ];

  const result = mergeFreshChatPage(fresh, previous, 2);

  assert.deepEqual(result.map(({ id }) => id), ['first', 'second', 'older-tail']);
});

test('conserva el tail empatado usando el mismo desempate descendente por id del backend', () => {
  const tiedAtBoundary = '2026-07-10T18:10:00.000Z';
  const previous = [
    contact('z-contact', '2026-07-10T18:30:00.000Z'),
    contact('m-contact', tiedAtBoundary),
    contact('a-contact', tiedAtBoundary),
  ];
  const fresh = [
    contact('z-contact', '2026-07-10T18:30:00.000Z'),
    contact('m-contact', tiedAtBoundary),
  ];

  const result = mergeFreshChatPage(fresh, previous, 2);

  assert.deepEqual(result.map(({ id }) => id), ['z-contact', 'm-contact', 'a-contact']);
});

test('los merges sin cambios preservan la identidad del arreglo y sus filas', () => {
  const current = [
    contact('first', '2026-07-10T18:30:00.000Z'),
    contact('second', '2026-07-10 18:20:00'),
  ];
  const incoming = current.map((item) => ({ ...item }));

  const paginatedResult = mergeChatContactPages(current, incoming);
  const freshResult = mergeFreshChatPage(incoming, current, 3);

  assert.equal(paginatedResult, current);
  assert.equal(freshResult, current);
  assert.equal(paginatedResult[0], current[0]);
  assert.equal(freshResult[1], current[1]);
});
