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
  appendBackgroundNotificationReceipt,
  BACKGROUND_NOTIFICATION_RECEIPT_LIMIT,
  BACKGROUND_PUSH_CONVERSATION_TARGET_LIMIT,
  BACKGROUND_PUSH_TARGET_BUDGET_MS,
  flattenBackgroundNotificationData,
  getBackgroundNotificationContactId,
  getBackgroundNotificationReceiptKey,
  getBackgroundNotificationRelayContent,
  isChatBackgroundNotification,
  mapWithConcurrency,
  mergeBackgroundConversationSnapshot,
  runBoundedPushChatWork,
  selectRecentConversationContactIds,
  shouldRefreshConversationSnapshot,
  shouldSuppressHeadlessRemoteNotification,
} = require('../src/backgroundChatPolicy.ts');
const {
  contactSummaryExpectsMessages,
  ConversationLatestAnchorGate,
  loadConversationWithSuccessfulEmptyRecovery,
  shouldPreserveConversationSnapshot,
  shouldRecoverEmptyConversation,
} = require('../src/conversationOpeningPolicy.ts');
const { mergeNativeChatMessagesAuthoritatively } = require('../src/chatMessageMerge.ts');
const { resolveNotificationChatContact } = require('../src/notificationChatRouting.ts');

const appSource = fs.readFileSync(require.resolve('../src/App.tsx'), 'utf8');
const backgroundSource = fs.readFileSync(require.resolve('../src/background.ts'), 'utf8');
const notificationSource = fs.readFileSync(require.resolve('../src/notifications.ts'), 'utf8');
const indexSource = fs.readFileSync(require.resolve('../index.ts'), 'utf8');

test('prioriza el hilo del push y luego las conversaciones realmente recientes', () => {
  const chats = [
    { id: 'old', lastMessageDate: '2026-07-10T10:00:00.000Z' },
    { id: 'new', lastMessageDate: '2026-07-16T10:00:00.000Z' },
    { id: 'middle', lastMessageDate: '2026-07-14T10:00:00.000Z' },
  ];
  assert.deepEqual(
    selectRecentConversationContactIds(chats, ['target', 'new'], 4),
    ['target', 'new', 'middle', 'old'],
  );
  assert.deepEqual(
    selectRecentConversationContactIds(chats, ['new'], 4, ['new']),
    ['middle', 'old'],
  );
});

test('solo vuelve a bajar un snapshot ausente, preferido o atrasado respecto al inbox', () => {
  const cached = [{ id: 'm1', date: '2026-07-16T09:00:00.000Z' }];
  assert.equal(shouldRefreshConversationSnapshot({ id: 'c1', lastMessageDate: '2026-07-16T09:00:00.000Z' }, cached), false);
  assert.equal(shouldRefreshConversationSnapshot({ id: 'c1', lastMessageDate: '2026-07-16T10:00:00.000Z' }, cached), true);
  assert.equal(shouldRefreshConversationSnapshot({ id: 'c1' }, [], false), true);
  assert.equal(shouldRefreshConversationSnapshot({ id: 'c1' }, cached, true), true);
});

test('el worker nunca borra historial por un vacio transitorio y lo fusiona por id', () => {
  const cached = [
    { id: 'old', date: '2026-07-15T10:00:00.000Z', text: 'viejo' },
    { id: 'same', date: '2026-07-16T09:00:00.000Z', status: 'sent' },
  ];
  assert.deepEqual(mergeBackgroundConversationSnapshot(cached, [], 10), cached);
  const merged = mergeBackgroundConversationSnapshot(cached, [
    { id: 'same', date: '2026-07-16T09:00:00.000Z', status: 'read' },
    { id: 'new', date: '2026-07-16T10:00:00.000Z' },
  ], 10);
  assert.deepEqual(merged.map((item) => item.id), ['old', 'same', 'new']);
  assert.equal(merged[1].status, 'read');
});

test('el worker reconcilia la burbuja optimista con su fila canonica sin duplicarla', () => {
  const optimistic = {
    id: 'local-send-1',
    optimisticId: 'local-send-1',
    serverMessageId: 'db-77',
    providerMessageId: 'wamid-77',
    contactId: 'c1',
    date: '2026-07-16T10:00:00.000Z',
    direction: 'outbound',
    text: 'Mensaje único',
    channel: 'whatsapp_api',
    pending: true,
  };
  const canonical = {
    id: 'db-77',
    providerMessageId: 'wamid-77',
    contactId: 'c1',
    date: '2026-07-16T10:00:03.000Z',
    direction: 'outbound',
    text: 'Mensaje único',
    channel: 'whatsapp_api',
    status: 'delivered',
  };
  const merged = mergeBackgroundConversationSnapshot([optimistic], [canonical], 50);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'local-send-1');
  assert.equal(merged[0].serverMessageId, 'db-77');
  assert.equal(merged[0].providerMessageId, 'wamid-77');
  assert.equal(merged[0].status, 'delivered');
});

test('la reconciliacion compartida usa texto y ventana temporal como ultimo recurso', () => {
  const local = {
    id: 'local-send-2',
    optimisticId: 'local-send-2',
    contactId: 'c1',
    date: '2026-07-16T10:00:00.000Z',
    direction: 'outbound',
    text: 'Sin ids todavía',
    channel: 'whatsapp_api',
    pending: true,
  };
  const canonical = {
    id: 'server-2',
    contactId: 'c1',
    date: '2026-07-16T10:00:20.000Z',
    direction: 'outbound',
    text: 'Sin ids todavía',
    channel: 'whatsapp_api',
    status: 'sent',
  };
  const merged = mergeNativeChatMessagesAuthoritatively(false, [local], [canonical]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'local-send-2');
  assert.equal(merged[0].serverMessageId, 'server-2');
});

test('extrae el payload FCM headless privado y reconoce el relay local para no ciclar', () => {
  const flattened = flattenBackgroundNotificationData({
    data: {
      dataString: JSON.stringify({
        category: 'chat',
        contactId: 'contact-1',
        messageId: 'message-1',
        ristakRelayTitle: 'Mensaje nuevo',
        ristakRelayBody: 'Hola',
        androidChannelId: 'ristak_alerts',
        ristakBackgroundRelay: '1',
      }),
    },
    notification: null,
  });
  assert.equal(getBackgroundNotificationContactId(flattened), 'contact-1');
  assert.equal(getBackgroundNotificationReceiptKey(flattened), 'message:message-1');
  assert.deepEqual(getBackgroundNotificationRelayContent(flattened), {
    title: 'Mensaje nuevo',
    body: 'Hola',
  });
  assert.equal(isChatBackgroundNotification(flattened), true);
  assert.equal(flattened.ristakBackgroundRelay, '1');
});

test('ignora claves reservadas de Expo y nunca procesa citas o pagos como chat headless', () => {
  const legacyReserved = flattenBackgroundNotificationData({
    data: {
      category: 'appointment',
      title: 'Expo podría mostrar esto',
      body: 'No debe existir un segundo relay local',
      message: 'Tampoco esta clave reservada',
      contactId: 'contact-2',
    },
  });
  assert.deepEqual(getBackgroundNotificationRelayContent(legacyReserved), { title: '', body: '' });
  assert.equal(Object.hasOwn(legacyReserved, 'title'), false);
  assert.equal(Object.hasOwn(legacyReserved, 'body'), false);
  assert.equal(Object.hasOwn(legacyReserved, 'message'), false);
  assert.equal(isChatBackgroundNotification(legacyReserved), false);
});

test('suprime solo el FCM headless remoto y deja visible su relay local marcado', () => {
  const remoteHeadless = {
    category: 'chat',
    ristakRelayTitle: 'Nuevo mensaje',
    ristakRelayBody: 'Hola',
  };
  assert.equal(shouldSuppressHeadlessRemoteNotification(remoteHeadless), true);
  assert.equal(shouldSuppressHeadlessRemoteNotification({
    ...remoteHeadless,
    ristakBackgroundRelay: '1',
  }), false);
  assert.equal(shouldSuppressHeadlessRemoteNotification({
    ...remoteHeadless,
    category: 'appointment',
  }), false);
});

test('los recibos locales se deduplican y mantienen un limite durable', () => {
  let receipts = [];
  for (let index = 0; index < BACKGROUND_NOTIFICATION_RECEIPT_LIMIT + 10; index += 1) {
    receipts = appendBackgroundNotificationReceipt(receipts, `m-${index}`);
  }
  assert.equal(receipts.length, BACKGROUND_NOTIFICATION_RECEIPT_LIMIT);
  receipts = appendBackgroundNotificationReceipt(receipts, receipts[0]);
  assert.equal(receipts.length, BACKGROUND_NOTIFICATION_RECEIPT_LIMIT);
  assert.equal(receipts.at(-1), 'm-10');
});

test('la descarga reciente respeta la concurrencia acotada', async () => {
  let active = 0;
  let peak = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 4));
    active -= 1;
  });
  assert.equal(peak, 2);
});

test('el push persiste un solo objetivo antes del relay y no hace fan-out reciente', async () => {
  const events = [];
  let persistedTargets = 0;
  const result = await runBoundedPushChatWork({
    contactId: 'target-1',
    persistTarget: async (contactId, signal) => {
      assert.equal(signal.aborted, false);
      persistedTargets += 1;
      events.push(`target:${contactId}`);
      return true;
    },
    relayNotification: async () => {
      events.push('relay');
      return true;
    },
    refreshInbox: async () => {
      events.push('inbox');
      return true;
    },
  });
  assert.equal(BACKGROUND_PUSH_CONVERSATION_TARGET_LIMIT, 1);
  assert.equal(BACKGROUND_PUSH_TARGET_BUDGET_MS, 1_800);
  assert.equal(persistedTargets, 1);
  assert.deepEqual(events, ['target:target-1', 'relay', 'inbox']);
  assert.deepEqual(result, {
    targetPersisted: true,
    targetTimedOut: false,
    relayed: true,
    inboxRefreshed: true,
  });
});

test('el deadline aborta la precarga exclusiva antes del commit y publica de inmediato', async () => {
  const events = [];
  let lateWrites = 0;
  const startedAt = Date.now();
  const result = await runBoundedPushChatWork({
    contactId: 'slow-target',
    targetBudgetMs: 15,
    persistTarget: async (_contactId, signal) => {
      events.push('target:start');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          lateWrites += 1;
          resolve();
        }, 120);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          events.push('target:aborted');
          resolve();
        }, { once: true });
      });
      if (signal.aborted) return false;
      lateWrites += 1;
      return true;
    },
    relayNotification: async () => {
      events.push('relay');
      return true;
    },
    refreshInbox: async () => {
      events.push('inbox');
      return true;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(result.targetTimedOut, true);
  assert.equal(result.targetPersisted, false);
  assert.equal(lateWrites, 0);
  assert.deepEqual(events, ['target:start', 'target:aborted', 'relay', 'inbox']);
  assert.ok(Date.now() - startedAt < 500);
});

test('el deadline no espera ni invalida un commit compartido seguro ya iniciado', async () => {
  const events = [];
  let capturedNamespaceCommits = 0;
  const result = await runBoundedPushChatWork({
    contactId: 'shared-target',
    targetBudgetMs: 10,
    // Simula un warmup preexistente: no pertenece al lease del push y por eso
    // puede terminar, pero su escritura queda en el namespace que capturó.
    persistTarget: async () => {
      events.push('shared:start');
      await new Promise((resolve) => setTimeout(resolve, 35));
      capturedNamespaceCommits += 1;
      events.push('shared:committed');
      return true;
    },
    relayNotification: async () => {
      events.push('relay');
      return true;
    },
    refreshInbox: async () => {
      events.push('inbox');
      return true;
    },
  });
  assert.equal(result.targetTimedOut, true);
  assert.deepEqual(events.slice(0, 3), ['shared:start', 'relay', 'inbox']);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(capturedNamespaceCommits, 1);
  assert.equal(events.at(-1), 'shared:committed');
});

test('un rechazo o timeout de conversation nunca dispara journey ni retries ocultos', async () => {
  for (const error of [
    Object.assign(new Error('Unauthorized'), { status: 401 }),
    Object.assign(new Error('Forbidden'), { status: 403 }),
    Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }),
  ]) {
    let primaryCalls = 0;
    let recoveryCalls = 0;
    await assert.rejects(
      loadConversationWithSuccessfulEmptyRecovery(
        async () => {
          primaryCalls += 1;
          throw error;
        },
        () => true,
        async () => {
          recoveryCalls += 1;
          return [];
        },
      ),
      error,
    );
    assert.equal(primaryCalls, 1);
    assert.equal(recoveryCalls, 0);
  }
});

test('solo un 200 vacio contradictorio usa journey exactamente una vez', async () => {
  let primaryCalls = 0;
  let recoveryCalls = 0;
  const result = await loadConversationWithSuccessfulEmptyRecovery(
    async () => {
      primaryCalls += 1;
      return [];
    },
    (items) => items.length === 0,
    async () => {
      recoveryCalls += 1;
      return [{ type: 'whatsapp_message' }];
    },
  );
  assert.equal(primaryCalls, 1);
  assert.equal(recoveryCalls, 1);
  assert.equal(result.usedRecovery, true);
  assert.equal(result.items.length, 1);
});

test('un vacio contradictorio se recupera y nunca reemplaza mensajes visibles', () => {
  const contact = { lastMessageDate: '2026-07-16T10:00:00.000Z', messageCount: 3 };
  const cached = [{ id: 'm1', date: '2026-07-16T09:00:00.000Z' }];
  assert.equal(contactSummaryExpectsMessages(contact), true);
  assert.equal(shouldRecoverEmptyConversation(contact, [], []), true);
  assert.equal(shouldRecoverEmptyConversation(contact, cached, []), true);
  assert.equal(shouldPreserveConversationSnapshot(contact, cached, []), true);
  assert.equal(shouldPreserveConversationSnapshot({}, cached, []), true);
});

test('una notificacion resuelve y abre un contacto nuevo sin depender del inbox actual', async () => {
  let requested = '';
  const fetched = await resolveNotificationChatContact('new-contact', [{ id: 'old-contact' }], async (id) => {
    requested = id;
    return { id, name: 'Nuevo' };
  });
  assert.equal(requested, 'new-contact');
  assert.equal(fetched.id, 'new-contact');

  let fetchCalls = 0;
  const cached = await resolveNotificationChatContact('old-contact', [{ id: 'old-contact' }], async () => {
    fetchCalls += 1;
    return { id: 'old-contact' };
  });
  assert.equal(cached.id, 'old-contact');
  assert.equal(fetchCalls, 0);
});

test('el ancla al ultimo mensaje se consume una sola vez cuando ya existen filas', () => {
  const gate = new ConversationLatestAnchorGate();
  assert.equal(gate.consume(0), false);
  assert.equal(gate.consume(10), true);
  assert.equal(gate.consume(11), false);
});

test('App fija offset cero, conserva indice cero y precarga el hilo antes de montarlo', () => {
  assert.match(appSource, /preloadCacheKeys\(\[cacheKey\]\)\.finally\(mountConversation\)/);
  assert.match(appSource, /conversationLatestAnchorGateRef\.current\.consume\(conversationRenderItems\.length\)/);
  assert.match(appSource, /scrollConversationToLatest\(false\)/);
  assert.match(appSource, /maintainVisibleContentPosition=\{\{ minIndexForVisible: 0, autoscrollToTopThreshold: 24 \}\}/);
  assert.match(appSource, /style=\{styles\.conversationMessageScroller\}/);
  assert.match(appSource, /alwaysBounceVertical=\{false\}/);
  assert.match(appSource, /shouldPreserveConversationSnapshot\(contactSummary, current, journeyMessages\)/);
  assert.match(appSource, /api\.getContactJourney\(contactId, primaryAbortController\.signal, false\)/);
  assert.match(appSource, /loadConversationWithSuccessfulEmptyRecovery\(/);
  assert.doesNotMatch(appSource, /conversationInitialRetryTimerRef/);
});

test('el binario declara la capacidad headless y actualiza inbox mas hilos recientes', () => {
  assert.match(notificationSource, /ANDROID_EXPO_BACKGROUND_CLIENT_TYPE = 'expo_background_v1'/);
  assert.match(notificationSource, /const backgroundTaskReady = await chatNotificationBackgroundTaskReady/);
  assert.match(notificationSource, /clientType: backgroundTaskReady[\s\S]*ANDROID_EXPO_BACKGROUND_CLIENT_TYPE[\s\S]*ANDROID_EXPO_LEGACY_CLIENT_TYPE/);
  assert.match(backgroundSource, /TaskManager\.defineTask\(CHAT_NOTIFICATION_BACKGROUND_TASK/);
  assert.match(backgroundSource, /Notifications\s*\.registerTaskAsync\(CHAT_NOTIFICATION_BACKGROUND_TASK\)/);
  assert.match(backgroundSource, /export const chatNotificationBackgroundTaskReady: Promise<boolean>/);
  assert.match(backgroundSource, /notificationRelayInFlight\.has\(receiptKey\)/);
  assert.match(backgroundSource, /notificationRelayInFlight\.add\(receiptKey\)/);
  assert.match(backgroundSource, /getBackgroundNotificationRelayContent\(data\)/);
  assert.match(backgroundSource, /runBoundedPushChatWork\(/);
  assert.doesNotMatch(backgroundSource, /syncBackgroundChats\(contactId/);
  assert.doesNotMatch(backgroundSource, /session\.api\.getContactJourney/);
  assert.match(backgroundSource, /if \(signal\?\.aborted\) return false;/);
  assert.match(backgroundSource, /const sharedWarmup = !signal/);
  assert.match(backgroundSource, /if \(sharedWarmup\) conversationWarmups\.set\(warmupKey, warmup\)/);
  assert.match(backgroundSource, /return backgroundSessionIsCurrent\(session\)/);
  const categoryGateIndex = backgroundSource.indexOf('if (!isChatBackgroundNotification(notificationData))');
  const notificationSessionReadIndex = backgroundSource.indexOf(
    'const session = await readBackgroundSession();',
    backgroundSource.indexOf('TaskManager.defineTask(CHAT_NOTIFICATION_BACKGROUND_TASK'),
  );
  assert.ok(categoryGateIndex > 0 && categoryGateIndex < notificationSessionReadIndex);
  const channelCreationIndex = backgroundSource.indexOf('await createAndroidNotificationChannels();');
  const finalSessionCheckIndex = backgroundSource.indexOf(
    'if (!await backgroundSessionIsCurrent(session)) return false;',
    channelCreationIndex,
  );
  const scheduleIndex = backgroundSource.indexOf('await Notifications.scheduleNotificationAsync({');
  assert.ok(channelCreationIndex > 0 && finalSessionCheckIndex > channelCreationIndex);
  assert.ok(scheduleIndex > finalSessionCheckIndex);
  assert.match(notificationSource, /getNativeNotificationPresentationBehavior/);
  assert.match(notificationSource, /handleNotification: async \(notification\)/);
  assert.match(appSource, /eventContactId && eventContactId !== openContactId/);
  assert.match(appSource, /prefetchRecentConversationCaches\([\s\S]*openContactId \? \[openContactId\] : \[\]/);
  assert.match(backgroundSource, /Notifications\.scheduleNotificationAsync/);
  assert.match(backgroundSource, /writeCacheNow\(\s*NATIVE_INBOX_CACHE_KEY/);
  assert.match(backgroundSource, /conversationCacheKey\(contactId\)/);
  assert.match(backgroundSource, /prefetchRecentConversationCaches/);
  assert.match(backgroundSource, /minimumInterval: 15/);
  assert.ok(indexSource.indexOf("import './src/background'") < indexSource.indexOf("import App from './App'"));
  assert.doesNotMatch(appSource, /onNotificationHandled\?\.\(\);\s+\n\s+const openNotificationContact/);
  assert.match(appSource, /resolveNotificationChatContact\(\s*contactId,\s*chatsRef\.current/);
});
