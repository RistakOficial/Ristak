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
  CHAT_FALLBACK_REFRESH_INTERVAL_MS,
  CHAT_HEALTHY_RECONCILE_INTERVAL_MS,
  CHAT_TRAILING_REFRESH_DELAY_MS,
  ChatReconnectReconciliationGate,
  ChatRefreshBurstGate,
  runChatRefreshBurst,
  runInitialConnectedRecovery,
  shouldRunChatReconciliation,
} = require('../src/chatRefreshPolicy.ts');
const { shouldDeletePreloadCandidate } = require('../src/cachePreloadPolicy.ts');

const appSource = fs.readFileSync(require.resolve('../src/App.tsx'), 'utf8');
const apiSource = fs.readFileSync(require.resolve('../src/api.ts'), 'utf8');

test('el polling solo reconcilia seguido cuando el SSE esta desconectado', () => {
  const now = 1_000_000;

  assert.equal(CHAT_FALLBACK_REFRESH_INTERVAL_MS, 30_000);
  assert.equal(CHAT_HEALTHY_RECONCILE_INTERVAL_MS, 120_000);
  assert.equal(CHAT_TRAILING_REFRESH_DELAY_MS, 500);
  assert.equal(shouldRunChatReconciliation(false, now - 1_000, now), true);
  assert.equal(shouldRunChatReconciliation(true, now - 119_999, now), false);
  assert.equal(shouldRunChatReconciliation(true, now - 120_000, now), true);
});

test('Android recibe estado del SSE y usa la misma politica en inbox e hilo', () => {
  assert.match(apiSource, /export type ChatLiveConnectionStatus = 'connecting' \| 'connected' \| 'disconnected'/);
  assert.match(apiSource, /onStatusChange\?: \(status: ChatLiveConnectionStatus\) => void/);
  assert.match(apiSource, /updateConnectionStatus\('connected'\)/);
  assert.match(appSource, /onStatusChange: \(status\) =>/);
  assert.equal((appSource.match(/shouldRunChatReconciliation\(/g) || []).length, 2);
  assert.equal((appSource.match(/CHAT_FALLBACK_REFRESH_INTERVAL_MS/g) || []).length, 3);
  assert.doesNotMatch(appSource, /CHAT_INBOX_REFRESH_INTERVAL_MS/);
  assert.doesNotMatch(appSource, /CONVERSATION_REFRESH_INTERVAL_MS/);
});

test('reconecta una sola vez tras un hueco SSE y no duplica el bootstrap inicial', () => {
  const gate = new ChatReconnectReconciliationGate();

  assert.equal(gate.observe('connecting'), false);
  assert.equal(gate.observe('connected'), false);
  assert.equal(gate.observe('connected'), false);
  assert.equal(gate.observe('disconnected'), false);
  assert.equal(gate.observe('connecting'), false);
  assert.equal(gate.observe('connected'), true);
  assert.equal(gate.observe('connected'), false);
  assert.equal(gate.observe('disconnected'), false);
  assert.equal(gate.observe('disconnected'), false);
  assert.equal(gate.observe('connected'), true);

  gate.reset();
  assert.equal(gate.observe('connected'), false);
  assert.match(appSource, /chatReconnectReconciliationGateRef\.current\.observe\(status\)/);
  assert.match(appSource, /if \(shouldReconcileGap\)[\s\S]*requestSilentInboxRefresh\(\)[\s\S]*setChatReconnectVersion/);
});

test('connected inicial no duplica GET si bootstrap termina bien', async () => {
  let releaseInitial = () => undefined;
  const initialRequest = new Promise((resolve) => {
    releaseInitial = resolve;
  });
  let reconciled = false;
  let refreshCount = 0;
  const recovery = runInitialConnectedRecovery(
    initialRequest,
    () => reconciled,
    async () => {
      refreshCount += 1;
    },
  );

  reconciled = true;
  releaseInitial();
  assert.equal(await recovery, false);
  assert.equal(refreshCount, 0);
});

test('connected inicial reintenta exactamente una vez si bootstrap falla', async () => {
  let releaseInitial = () => undefined;
  const initialRequest = new Promise((resolve) => {
    releaseInitial = resolve;
  });
  let refreshCount = 0;
  const recovery = runInitialConnectedRecovery(
    initialRequest,
    () => false,
    async () => {
      refreshCount += 1;
    },
  );

  releaseInitial();
  assert.equal(await recovery, true);
  assert.equal(refreshCount, 1);
  assert.equal((appSource.match(/runInitialConnectedRecovery\(/g) || []).length, 2);
});

test('inbox e hilo deciden su recuperacion inicial de forma independiente', async () => {
  let inboxRefreshes = 0;
  let threadRefreshes = 0;

  const [inboxRetried, threadRetried] = await Promise.all([
    runInitialConnectedRecovery(Promise.resolve(), () => true, async () => {
      inboxRefreshes += 1;
    }),
    runInitialConnectedRecovery(Promise.resolve(), () => false, async () => {
      threadRefreshes += 1;
    }),
  ]);

  assert.equal(inboxRetried, false);
  assert.equal(threadRetried, true);
  assert.equal(inboxRefreshes, 0);
  assert.equal(threadRefreshes, 1);
  assert.match(appSource, /chatLastInboxReconcileAtRef\.current > 0/);
  assert.match(appSource, /conversationLastReconcileAtRef\.current > 0/);
});

test('la limpieza diferida conserva archivos reescritos o activos despues del stat', () => {
  const captured = { size: 128, modifiedAt: 1_000 };

  assert.equal(shouldDeletePreloadCandidate(captured, captured, false), true);
  assert.equal(shouldDeletePreloadCandidate(captured, { size: 129, modifiedAt: 1_000 }, false), false);
  assert.equal(shouldDeletePreloadCandidate(captured, { size: 128, modifiedAt: 2_000 }, false), false);
  assert.equal(shouldDeletePreloadCandidate(captured, captured, true), false);
  assert.equal(shouldDeletePreloadCandidate(captured, null, false), false);
});

test('inbox e hilo usan backpressure acotado en vez de una cola recursiva', () => {
  assert.doesNotMatch(appSource, /chatRealtimeRefreshQueuedRef/);
  assert.doesNotMatch(appSource, /conversationRealtimeRefreshQueuedRef/);
  assert.match(appSource, /chatRefreshBurstGateRef = useRef\(new ChatRefreshBurstGate\(\)\)/);
  assert.match(appSource, /conversationRefreshBurstGateRef = useRef\(new ChatRefreshBurstGate\(\)\)/);
  assert.equal((appSource.match(/runChatRefreshBurst\(/g) || []).length, 2);
  assert.equal((appSource.match(/CHAT_TRAILING_REFRESH_DELAY_MS/g) || []).length, 3);
  assert.doesNotMatch(appSource, /\(\) => chatListRequestSettledRef\.current \|\| loadChats/);
  assert.doesNotMatch(appSource, /\(\) => conversationPrimaryRequestSettledRef\.current \|\| loadConversation/);
  assert.match(appSource, /gate !== chatRefreshBurstGateRef\.current/);
  assert.match(appSource, /gate !== conversationRefreshBurstGateRef\.current/);
  assert.match(appSource, /clearTimeout\(chatRealtimeRefreshTimeoutRef\.current\)[\s\S]*new ChatRefreshBurstGate\(\)[\s\S]*}, \[api\]\)/);
  assert.match(appSource, /clearTimeout\(conversationRealtimeRefreshTimeoutRef\.current\)[\s\S]*new ChatRefreshBurstGate\(\)[\s\S]*}, \[api, contact\.id\]\)/);
});

test('un evento durante una query produce un solo follow-up', async () => {
  let releaseCurrent = () => undefined;
  const currentRequest = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const gate = new ChatRefreshBurstGate();
  let refreshCount = 0;

  const burst = runChatRefreshBurst(gate, currentRequest, async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 0);

  releaseCurrent();
  assert.deepEqual(await burst, { ran: true, trailingNeeded: false });
  assert.equal(refreshCount, 1);
});

test('un evento durante el follow-up pide trailing sin crear una tercera query inmediata', async () => {
  const releases = [];
  const refresh = () => new Promise((resolve) => {
    releases.push(resolve);
  });
  const gate = new ChatRefreshBurstGate();
  let refreshCount = 0;
  const countedRefresh = async () => {
    refreshCount += 1;
    await refresh();
  };

  const burst = runChatRefreshBurst(gate, null, countedRefresh);
  await Promise.resolve();
  assert.equal(refreshCount, 1);

  assert.deepEqual(
    await runChatRefreshBurst(gate, null, countedRefresh),
    { ran: false, trailingNeeded: false },
  );
  releases[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCount, 2);

  for (let index = 0; index < 20; index += 1) {
    assert.deepEqual(
      await runChatRefreshBurst(gate, null, countedRefresh),
      { ran: false, trailingNeeded: false },
    );
  }
  releases[1]();
  assert.deepEqual(await burst, { ran: true, trailingNeeded: true });
  assert.equal(refreshCount, 2);

  const trailing = runChatRefreshBurst(gate, null, async () => {
    refreshCount += 1;
  });
  assert.deepEqual(await trailing, { ran: true, trailingNeeded: false });
  assert.equal(refreshCount, 3);
});

test('una request sustituida no se adopta como snapshot posterior al nudge', async () => {
  let releaseCaptured = () => undefined;
  const captured = new Promise((resolve) => {
    releaseCaptured = resolve;
  });
  let replacementStillPending = true;
  const replacement = new Promise(() => undefined);
  let freshSnapshots = 0;
  let currentRequest = captured;
  const gate = new ChatRefreshBurstGate();

  const burst = runChatRefreshBurst(gate, currentRequest, async () => {
    // The refresh factory must run even though another request replaced the
    // captured one and remains pending.
    assert.equal(currentRequest, replacement);
    assert.equal(replacementStillPending, true);
    freshSnapshots += 1;
  });
  currentRequest = replacement;
  releaseCaptured();

  assert.deepEqual(await burst, { ran: true, trailingNeeded: false });
  assert.equal(freshSnapshots, 1);
});

test('la ruta critica baja 50 mensajes y los marcadores usan chatActivityOnly', () => {
  assert.match(appSource, /const CHAT_CONVERSATION_MESSAGE_LIMIT = 50/);
  assert.match(appSource, /api\.getContactJourney\(contactId, supplementalAbortController\.signal, true\)/);
  assert.match(apiSource, /getContactJourney\(contactId: string, signal\?: AbortSignal, chatActivityOnly = false\)/);
  assert.match(apiSource, /chatActivityOnly: chatActivityOnly \|\| undefined/);
});

test('verify tiene timeout abortable, cancelacion central y guards de sesion', () => {
  assert.match(apiSource, /type VerifyRequestOptions = \{[\s\S]*signal\?: AbortSignal;[\s\S]*timeoutMs\?: number;/);
  assert.match(apiSource, /verify\(token: string, options: VerifyRequestOptions = \{\}\)/);
  assert.match(apiSource, /signal: options\.signal,[\s\S]*timeoutMs: options\.timeoutMs/);
  assert.match(appSource, /const sessionVerifyRequestRef = useRef/);
  assert.match(appSource, /const sessionLifecycleEpochRef = useRef\(0\)/);
  assert.match(appSource, /const cancelSessionVerification = useCallback/);
  assert.match(appSource, /current\?\.baseUrl === baseUrl && current\.token === token/);
  assert.match(appSource, /sessionVerifyRequestRef\.current\?\.controller\.abort\(\)/);
  assert.match(appSource, /sessionVerifyRequestRef\.current = null/);
  assert.match(appSource, /sessionVerifyInFlightRef\.current = null/);
  assert.match(appSource, /signal: controller\.signal/);
  assert.match(appSource, /timeoutMs: BOOTSTRAP_SESSION_VERIFY_TIMEOUT_MS/);
  assert.match(appSource, /const isCurrentSessionOperation = useCallback/);
  assert.match(appSource, /if \(!isCurrentSessionOperation\(storedBaseUrl, storedToken, operationEpoch\)\) return;[\s\S]*writeJsonValue\(VERIFIED_USER_CACHE_STORAGE_KEY/);
  for (const handlerName of ['handleLogin', 'logout', 'resetServer']) {
    const start = appSource.indexOf(`const ${handlerName} = async`);
    const end = appSource.indexOf('\n  };', start);
    const handler = appSource.slice(start, end);
    assert.ok(start >= 0);
    assert.ok(handler.indexOf('cancelSessionVerification();') >= 0);
    assert.ok(handler.indexOf('cancelSessionVerification();') < handler.indexOf('await '));
  }
  assert.doesNotMatch(appSource, /withStartupTimeout/);
});

test('los iconos de fuente se importan directo y no empacan familias que no se usan', () => {
  assert.match(appSource, /import FontAwesome6 from '@expo\/vector-icons\/FontAwesome6'/);
  assert.match(appSource, /import Ionicons from '@expo\/vector-icons\/Ionicons'/);
  assert.doesNotMatch(appSource, /import FontAwesome from/);
  assert.doesNotMatch(appSource, /import \{[^}]*FontAwesome[^}]*\} from '@expo\/vector-icons'/s);
});
