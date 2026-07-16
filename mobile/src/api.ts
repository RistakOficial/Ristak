import type {
  BankClabeAccount,
  CalendarEventItem,
  CalendarFreeSlot,
  CalendarItem,
  CalendarUser,
  ChatContact,
  ChatMessage,
  ConfigValue,
  ContactTag,
  ContactAutomationsOverview,
  ContactCustomFieldDefinition,
  CustomLabels,
  AIAgentTranscriptionResult,
  AIAgentBusinessContextAnswerResult,
  AIAgentChatResult,
  AIAgentConfigStatus,
  AIAgentMessage,
  AIAgentViewContext,
  ConversationAgentState,
  ConversationalAgentDefinition,
  ConversationHistoryCursor,
  CreateTransactionInput,
  DashboardFinancialPoint,
  DashboardFunnelRow,
  DashboardFunnelScope,
  DashboardMetrics,
  DashboardSeriesPoint,
  HighLevelInvoiceResponse,
  HighLevelPhoneNumberCatalog,
  HighLevelRecordPaymentPayload,
  HighLevelSendInvoiceResponse,
  IntegrationsStatus,
  OriginDistributionData,
  JourneyEvent,
  LicenseStatusResponse,
  LoginResponse,
  MessageTemplateBundle,
  NativeMessageChannel,
  PaymentGatewayProvider,
  PaymentLinkDeliveryOptions,
  PaymentLinkPayload,
  PaymentLinkResponse,
  PaymentPlanPayload,
  PaymentSubscription,
  ProductItem,
  RistakUser,
  RuntimeTenant,
  SaveMobilePushDevicePayload,
  PaymentSettingsResponse,
  SavedCardPaymentPayload,
  SavedCardPaymentResponse,
  SavedPaymentMethodItem,
  ScheduledChatMessage,
  SendTextResponse,
  TransactionItem,
  VerifyResponse,
  WebPushPublicConfig,
  WhatsAppTemplate,
  WhatsAppApiTemplatesResponse,
  WhatsAppApiStatus,
} from './types';
import * as FileSystem from 'expo-file-system/legacy';
import { cleanBaseUrl } from './format';
import { normalizeChatSelectionIds } from './chatSelectionState';
import {
  normalizeNativeWhatsAppSenderRoute,
  type NativeWhatsAppSenderRoute,
} from './chatRouting';

declare const process: { env?: Record<string, string | undefined> } | undefined;

const DEFAULT_INSTALLER_API_BASE_URL = 'https://www.ristak.com';
const PAYMENT_BANK_CLABES_CONFIG_KEY = 'payment_bank_clabes';
const CHAT_STREAM_ENDPOINT = '/chat-events/stream';
const CHAT_STREAM_INITIAL_RECONNECT_MS = 1000;
const CHAT_STREAM_MAX_RECONNECT_MS = 15000;
const CHAT_STREAM_HEARTBEAT_TIMEOUT_MS = 45_000;
const CHAT_STREAM_MAX_RESPONSE_CHARS = 256_000;
const XHR_HEADERS_RECEIVED = 2;
const XHR_LOADING = 3;
const XHR_DONE = 4;
const DEFAULT_API_GET_TIMEOUT_MS = 20_000;
const DEFAULT_API_MUTATION_TIMEOUT_MS = 75_000;
let nativeExternalIdSequence = 0;

function createNativeExternalId(prefix: string) {
  nativeExternalIdSequence = (nativeExternalIdSequence + 1) % 1_000_000;
  return `${prefix}-${Date.now()}-${nativeExternalIdSequence.toString(36)}`;
}

type RequestOptions = RequestInit & {
  params?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
};

type ChatListQueryOptions = {
  businessPhoneNumberId?: string;
  businessPhone?: string;
  warmProfilePictures?: boolean;
  signal?: AbortSignal;
  beforeMessageDate?: string;
  beforeContactId?: string;
};

type ConversationQueryOptions = Partial<ConversationHistoryCursor> & {
  signal?: AbortSignal;
};

export type ChatLiveMessageEvent = {
  type: 'chat_message';
  contactId: string;
  messageId?: string;
  channel?: string;
  provider?: string;
  transport?: string;
  direction?: string;
  messageType?: string;
  messageTimestamp?: string;
  isNew?: boolean;
  receivedAt?: string;
};

export type ChatLiveConnectionStatus = 'connecting' | 'connected' | 'disconnected';

type ChatLiveSubscribeOptions = {
  onMessage: (event: ChatLiveMessageEvent) => void;
  onError?: (error: unknown) => void;
  onStatusChange?: (status: ChatLiveConnectionStatus) => void;
};

type VerifyRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

type SseFrame = {
  event: string;
  data: string;
};

type MessageReplyPayload = {
  replyToMessageId?: string;
  replyToProviderMessageId?: string;
};

type NativeScheduleRoute =
  | { provider: 'whatsapp_api'; transport: 'api' }
  | { provider: 'highlevel'; channel: 'whatsapp_api' | 'sms_qr' };

type TransactionQuery = {
  limit?: number;
  page?: number;
  startDate?: string;
  endDate?: string;
  q?: string;
  sync?: boolean;
};

type ProductPayload = {
  name: string;
  description?: string;
  currency: string;
  prices: Array<{
    id?: string;
    localId?: string;
    name: string;
    amount: number;
    currency: string;
    type?: string;
  }>;
};

type TransactionPayload = {
  id?: string;
  amount: number;
  currency: string;
  method?: string;
  paymentMethod?: string;
  status?: string;
  reference?: string;
  title?: string;
  description?: string;
  date?: string;
  contactId?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  paymentMode?: string;
  metadata?: Record<string, unknown>;
};

type InstallmentFlowPayload = {
  contact: {
    id: string;
    name?: string;
    email?: string;
    phone?: string;
  };
  totalAmount: number;
  currency: string;
  concept: string;
  description?: string;
  title?: string;
  invoicePayload?: Record<string, unknown>;
  firstPayment?: Record<string, unknown>;
  remainingAutomatic?: boolean;
  remainingFrequency?: string;
  remainingPayments?: Array<Record<string, unknown>>;
  source?: string;
};

type SubscriptionPayload = {
  id?: string;
  contactId?: string | null;
  contactName?: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  name: string;
  description?: string;
  status?: string;
  amount: number;
  currency: string;
  applyTax?: boolean;
  taxCalculationMode?: string;
  intervalType: string;
  intervalCount: number;
  startDate: string;
  nextRunAt?: string | null;
  paymentMethod?: string;
  paymentProvider?: string;
  paymentMode?: string;
  paymentMethodId?: string;
  paymentSourceId?: string;
  rebillCardId?: string;
  source?: string;
  lineItems?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  clientRequestId?: string;
};

type ApiError = Error & {
  status?: number;
  body?: unknown;
  code?: string;
};

type InstallerTenantResponse = {
  success?: boolean;
  tenant?: {
    client_id?: string;
    installation_id?: string;
    name?: string;
    email?: string;
    app_url?: string;
  };
  message?: string;
};

function getErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object') return fallback;
  const object = payload as { error?: unknown; message?: unknown };
  return String(object.error || object.message || fallback);
}

function withApiPrefix(path: string) {
  if (path.startsWith('/api')) return path;
  return `/api${path.startsWith('/') ? '' : '/'}${path}`;
}

function getInstallerApiBaseUrl() {
  const installerApiUrl = typeof process === 'undefined'
    ? ''
    : process.env?.EXPO_PUBLIC_INSTALLER_API_URL;
  return cleanBaseUrl(installerApiUrl || DEFAULT_INSTALLER_API_BASE_URL);
}

function buildInstallerUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getInstallerApiBaseUrl()}${normalizedPath}`;
}

function parseSseFrame(frame: string): SseFrame | null {
  const lines = frame.split(/\r?\n/);
  let event = 'message';
  const data: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const separatorIndex = line.indexOf(':');
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const rawValue = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : '';
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    if (field === 'event') event = value || 'message';
    if (field === 'data') data.push(value);
  }

  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

function dispatchChatSseFrame(frame: string, options: ChatLiveSubscribeOptions) {
  const parsed = parseSseFrame(frame);
  if (!parsed || parsed.event !== 'chat_message') return;

  try {
    const payload = JSON.parse(parsed.data) as Partial<ChatLiveMessageEvent>;
    if (payload?.type === 'chat_message' && typeof payload.contactId === 'string' && payload.contactId.trim()) {
      options.onMessage(payload as ChatLiveMessageEvent);
    }
  } catch (error) {
    options.onError?.(error);
  }
}

function getNativeContactChannel(contact: ChatContact): NativeMessageChannel {
  const probe = [
    contact.lastMessageChannel,
    contact.lastMessageTransport,
    contact.source,
    contact.whatsappAttributionPlatform,
  ].filter(Boolean).join(' ').toLowerCase();

  if (probe.includes('instagram')) return 'instagram';
  if (probe.includes('messenger')) return 'messenger';
  if (probe.includes('email') || probe.includes('mail')) return 'email';
  if (probe.includes('sms')) return 'sms';
  return 'whatsapp';
}

function getNativeScheduleRoute(contact: ChatContact, channel?: NativeMessageChannel): NativeScheduleRoute {
  const resolvedChannel = channel || getNativeContactChannel(contact);

  if (resolvedChannel === 'sms') {
    return { provider: 'highlevel', channel: 'sms_qr' };
  }

  if (resolvedChannel === 'whatsapp') {
    return { provider: 'whatsapp_api', transport: 'api' };
  }

  if (resolvedChannel === 'messenger' || resolvedChannel === 'instagram') {
    throw new Error('La programación para Messenger e Instagram todavía no está disponible. Puedes enviarlo al momento desde Ristak.');
  }

  throw new Error('La programación por correo todavía no está disponible desde la app móvil.');
}

export type ApiClientHandlers = {
  onUnauthorized?: (requestToken: string) => void;
  onLicenseBlocked?: (requestToken: string) => void;
  onFeatureBlocked?: (message: string, feature?: unknown) => void;
};

export class RistakApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token = '',
    private readonly handlers: ApiClientHandlers = {},
  ) {}

  private buildUrl(path: string, params?: RequestOptions['params']) {
    const url = new URL(`${this.baseUrl}${withApiPrefix(path)}`);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value).trim()) {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const {
      params,
      timeoutMs,
      signal: callerSignal,
      ...fetchOptions
    } = options;
    const headers = new Headers(options.headers);
    const hasBody = options.body !== undefined && options.body !== null;
    if (hasBody && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }

    const method = String(options.method || 'GET').toUpperCase();
    const resolvedTimeoutMs = timeoutMs ?? (method === 'GET' ? DEFAULT_API_GET_TIMEOUT_MS : DEFAULT_API_MUTATION_TIMEOUT_MS);
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = resolvedTimeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, resolvedTimeoutMs)
      : null;

    let response: Response;
    try {
      response = await fetch(this.buildUrl(path, params), {
        ...fetchOptions,
        headers,
        signal: controller.signal,
      });

      if (response.status === 204) {
        return {} as T;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch (error) {
        // Abort during body streaming must not be mistaken for a successful
        // empty JSON response. The outer catch converts timeout aborts to the
        // friendly API error and preserves caller-driven cancellation.
        if (timedOut || callerSignal?.aborted) throw error;
        payload = null;
      }

      if (!response.ok) {
        const message = getErrorMessage(payload, response.statusText);
        const error = new Error(message || `HTTP ${response.status}`) as ApiError;
        error.status = response.status;
        error.body = payload;
        let code = '';
        if (payload && typeof payload === 'object') {
          code = String((payload as { code?: unknown }).code || '');
          error.code = code;
        }
        // Cross-cutting handling mirroring the web authFetch/apiClient interceptors.
        if (response.status === 401) {
          this.handlers.onUnauthorized?.(this.token);
        } else if (response.status === 403 && code === 'license_blocked') {
          this.handlers.onLicenseBlocked?.(this.token);
        } else if (response.status === 403 && code === 'feature_not_available') {
          const method = String(options.method || 'GET').toUpperCase();
          // The web only surfaces the plan-gate message on user actions, not on
          // background screen-load GETs, to avoid nagging on read requests.
          if (method !== 'GET') {
            const feature = typeof payload === 'object' && payload
              ? (payload as { feature?: unknown }).feature
              : undefined;
            this.handlers.onFeatureBlocked?.(error.message, feature);
          }
        }
        throw error;
      }

      if (
        payload && typeof payload === 'object'
        && 'success' in payload && 'data' in payload
        && (payload as { data?: unknown }).data !== undefined
      ) {
        return (payload as { data: T }).data;
      }

      return (payload ?? {}) as T;
    } catch (error) {
      if (timedOut) {
        const timeoutError = new Error('El servidor tardó demasiado en responder. Intenta de nuevo.') as ApiError;
        timeoutError.code = 'request_timeout';
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  }

  login(email: string, password: string) {
    return this.request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  verify(token: string, options: VerifyRequestOptions = {}) {
    return new RistakApiClient(this.baseUrl).request<VerifyResponse>('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }

  getChats(query = '', offset = 0, limit = 50, options: ChatListQueryOptions = {}) {
    return this.request<ChatContact[]>('/contacts/chats', {
      signal: options.signal,
      params: {
        q: query.trim() || undefined,
        limit,
        offset: offset > 0 ? offset : undefined,
        businessPhoneNumberId: options.businessPhoneNumberId?.trim() || undefined,
        businessPhone: options.businessPhone?.trim() || undefined,
        warmProfilePictures: options.warmProfilePictures || undefined,
        beforeMessageDate: options.beforeMessageDate?.trim() || undefined,
        beforeContactId: options.beforeContactId?.trim() || undefined,
      },
    });
  }

  async getAllChatIds() {
    const pageSize = 100;
    const response = await this.request<Array<string | ChatContact>>('/contacts/chats', {
      timeoutMs: DEFAULT_API_MUTATION_TIMEOUT_MS,
      params: {
        idsOnly: true,
        limit: pageSize,
        warmProfilePictures: false,
      },
    });

    // Backend actual: arreglo ligero de ids sin limite. Compatibilidad con
    // instalaciones anteriores: si ignoraron idsOnly, recibimos la primera
    // pagina de ChatContact y completamos el universo por paginacion.
    if (response.every((item) => typeof item === 'string')) {
      return normalizeChatSelectionIds(response);
    }

    let page = response.filter((item): item is ChatContact => typeof item !== 'string');
    let offset = page.length;
    const ids = normalizeChatSelectionIds(page);
    const seen = new Set(ids);

    while (page.length >= pageSize) {
      page = await this.getChats('', offset, pageSize, { warmProfilePictures: false });
      const pageIds = normalizeChatSelectionIds(page);
      const previousCount = seen.size;
      pageIds.forEach((id) => {
        if (seen.has(id)) return;
        seen.add(id);
        ids.push(id);
      });
      offset += page.length;

      // Un backend legacy que ignore offset no debe crear un loop eterno.
      if (page.length >= pageSize && seen.size === previousCount) break;
    }

    return ids;
  }

  subscribeToChatLiveEvents(options: ChatLiveSubscribeOptions) {
    if (typeof XMLHttpRequest === 'undefined') return () => undefined;

    let stopped = false;
    let connectionStatus: ChatLiveConnectionStatus = 'disconnected';
    let reconnectMs = CHAT_STREAM_INITIAL_RECONNECT_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let activeRequest: XMLHttpRequest | null = null;

    const clearReconnectTimer = () => {
      if (!reconnectTimer) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const updateConnectionStatus = (status: ChatLiveConnectionStatus) => {
      if (connectionStatus === status) return;
      connectionStatus = status;
      options.onStatusChange?.(status);
    };

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer) return;
      updateConnectionStatus('disconnected');
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectMs);
      reconnectMs = Math.min(reconnectMs * 2, CHAT_STREAM_MAX_RECONNECT_MS);
    };

    const connect = () => {
      if (stopped) return;
      updateConnectionStatus('connecting');

      let responseOffset = 0;
      let frameBuffer = '';
      let finished = false;
      let lastActivityAt = Date.now();
      const request = new XMLHttpRequest();
      activeRequest = request;
      const watchdog = setInterval(() => {
        if (Date.now() - lastActivityAt <= CHAT_STREAM_HEARTBEAT_TIMEOUT_MS) return;
        options.onError?.(new Error('Chat live stream heartbeat timeout'));
        finish(true);
        request.abort();
      }, 10_000);

      const finish = (shouldReconnect = true) => {
        if (finished) return;
        finished = true;
        clearInterval(watchdog);
        if (activeRequest === request) activeRequest = null;
        updateConnectionStatus('disconnected');
        if (shouldReconnect) scheduleReconnect();
      };

      const consumeResponse = () => {
        const responseText = request.responseText || '';
        if (responseText.length <= responseOffset) return;

        frameBuffer += responseText.slice(responseOffset);
        responseOffset = responseText.length;
        lastActivityAt = Date.now();

        const frames = frameBuffer.split(/\r?\n\r?\n/);
        frameBuffer = frames.pop() || '';
        frames.forEach((frame) => dispatchChatSseFrame(frame, options));
        if (responseOffset >= CHAT_STREAM_MAX_RESPONSE_CHARS) {
          finish(true);
          request.abort();
        }
      };

      request.onreadystatechange = () => {
        if (request.readyState >= XHR_HEADERS_RECEIVED && (request.status === 401 || request.status === 403)) {
          if (request.status === 401) this.handlers.onUnauthorized?.(this.token);
          stopped = true;
          finish(false);
          request.abort();
          return;
        }

        if (request.readyState === XHR_HEADERS_RECEIVED && request.status === 200) {
          reconnectMs = CHAT_STREAM_INITIAL_RECONNECT_MS;
          updateConnectionStatus('connected');
        }

        if (request.readyState === XHR_LOADING || request.readyState === XHR_DONE) {
          consumeResponse();
        }

        if (request.readyState === XHR_DONE) {
          if (request.status && request.status !== 200) {
            options.onError?.(new Error(`Chat live stream unavailable: ${request.status}`));
          }
          finish(!stopped);
        }
      };

      request.onprogress = () => {
        consumeResponse();
      };

      request.onerror = () => {
        options.onError?.(new Error('Chat live stream network error'));
        finish(!stopped);
      };

      request.ontimeout = () => {
        options.onError?.(new Error('Chat live stream timeout'));
        finish(!stopped);
      };

      try {
        request.open('GET', this.buildUrl(CHAT_STREAM_ENDPOINT), true);
        request.setRequestHeader('Accept', 'text/event-stream');
        if (this.token) request.setRequestHeader('Authorization', `Bearer ${this.token}`);
        request.send();
      } catch (error) {
        options.onError?.(error);
        finish(!stopped);
      }
    };

    connect();

    return () => {
      stopped = true;
      clearReconnectTimer();
      activeRequest?.abort();
      activeRequest = null;
      updateConnectionStatus('disconnected');
    };
  }

  searchContacts(query: string) {
    return this.request<ChatContact[]>('/contacts/search', {
      params: {
        q: query.trim(),
      },
    });
  }

  getPickerContacts(limit = 100) {
    return this.request<ChatContact[]>('/contacts/search', {
      params: {
        picker: true,
        limit,
      },
    });
  }

  createContact(payload: {
    name?: string;
    full_name?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    source?: string;
  }) {
    return this.request<ChatContact>('/contacts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  getContact(contactId: string) {
    return this.request<ChatContact>(`/contacts/${encodeURIComponent(contactId)}`);
  }

  updateContact(contactId: string, patch: Partial<ChatContact>) {
    const payload: Record<string, unknown> = { ...patch };
    if (typeof patch.name === 'string' && typeof payload.full_name !== 'string') {
      payload.full_name = patch.name;
    }
    return this.request<ChatContact>(`/contacts/${encodeURIComponent(contactId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  getConversation(
    contactId: string,
    limit = 50,
    options: ConversationQueryOptions | string = {},
    legacySignal?: AbortSignal,
  ) {
    const normalizedOptions: ConversationQueryOptions = typeof options === 'string'
      ? { beforeMessageDate: options }
      : (options || {});
    return this.request<JourneyEvent[]>(`/contacts/${encodeURIComponent(contactId)}/conversation`, {
      timeoutMs: 10_000,
      signal: normalizedOptions.signal || legacySignal,
      params: {
        refreshExternalStatuses: false,
        messageLimit: limit,
        beforeMessageDate: normalizedOptions.beforeMessageDate?.trim() || undefined,
        beforeMessageCursor: normalizedOptions.beforeMessageCursor?.trim() || undefined,
      },
    });
  }

  getContactJourney(contactId: string, signal?: AbortSignal, chatActivityOnly = false) {
    return this.request<JourneyEvent[]>(`/contacts/${encodeURIComponent(contactId)}/journey`, {
      timeoutMs: 15_000,
      signal,
      params: {
        refreshExternalStatuses: false,
        chatActivityOnly: chatActivityOnly || undefined,
      },
    });
  }

  markChatRead(contactId: string) {
    return this.request(`/contacts/chats/${encodeURIComponent(contactId)}/read`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  markChatsRead(contactIds: string[]) {
    return this.request('/contacts/chats/read', {
      method: 'POST',
      body: JSON.stringify({ contactIds }),
    });
  }

  getContactTags() {
    return this.request<ContactTag[]>('/contact-tags');
  }

  createContactTag(name: string) {
    return this.request<ContactTag>('/contact-tags', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  deleteContactTag(tagId: string) {
    return this.request(`/contact-tags/${tagId}`, { method: 'DELETE' });
  }

  addContactTag(contactId: string, tagId: string) {
    return this.request<{ updated?: number; total?: number }>('/contacts/bulk/tags', {
      method: 'POST',
      body: JSON.stringify({
        contactIds: [contactId],
        addTagIds: [tagId],
        removeTagIds: [],
      }),
    });
  }

  getAgentStates(contactId: string) {
    return this.request<ConversationAgentState[]>(`/conversational-agent/states/${encodeURIComponent(contactId)}`, {
      params: {
        includeAll: 1,
      },
    });
  }

  getConversationalAgents() {
    return this.request<ConversationalAgentDefinition[]>('/conversational-agent/agents');
  }

  updateConversationalAgent(agentId: string, patch: Partial<ConversationalAgentDefinition>) {
    return this.request<ConversationalAgentDefinition>(`/conversational-agent/agents/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  }

  resetConversationalAgentSkippedContacts(agentId: string) {
    return this.request(`/conversational-agent/agents/${encodeURIComponent(agentId)}/reset-skipped`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  updateAgentState(
    contactId: string,
    action: 'activate' | 'resume' | 'pause' | 'take_over' | 'skip' | 'clear_signal',
    options: { agentId?: string } = {},
  ) {
    return this.request<ConversationAgentState>(`/conversational-agent/states/${encodeURIComponent(contactId)}`, {
      method: 'POST',
      body: JSON.stringify({
        action,
        ...(options.agentId ? { agentId: options.agentId } : {}),
      }),
    });
  }

  sendMetaSocialCommentReply(payload: {
    contactId: string;
    platform: 'messenger' | 'instagram';
    message: string;
    replyType: 'public' | 'private';
    commentId?: string;
    postId?: string;
    externalId?: string;
  }) {
    return this.request<SendTextResponse>('/whatsapp-api/meta/social/comments/reply', {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        externalId: payload.externalId || createNativeExternalId(`native-comment-${payload.replyType}`),
      }),
    });
  }

  sendText(
    contact: ChatContact,
    text: string,
    channel: NativeMessageChannel = 'whatsapp',
    reply?: MessageReplyPayload,
    whatsAppSender?: NativeWhatsAppSenderRoute,
    externalId?: string,
  ) {
    if (channel === 'email') {
      throw new Error('El correo todavía se envía desde la vista completa de chats.');
    }

    if (channel === 'messenger' || channel === 'instagram') {
      return this.request<SendTextResponse>('/whatsapp-api/meta/social/messages/text', {
        method: 'POST',
        body: JSON.stringify({
          contactId: contact.id,
          platform: channel,
          message: text,
          externalId: externalId || createNativeExternalId(`native-${channel}`),
          replyToMessageId: reply?.replyToMessageId || undefined,
          replyToProviderMessageId: reply?.replyToProviderMessageId || undefined,
        }),
      });
    }

    if (channel === 'sms') {
      return this.request<SendTextResponse>('/highlevel/conversations/messages', {
        method: 'POST',
        body: JSON.stringify({
          contactId: contact.id,
          channel: 'sms_qr',
          message: text,
          toNumber: contact.phone || undefined,
          externalId: externalId || createNativeExternalId('native-sms'),
        }),
      });
    }

    const sender = normalizeNativeWhatsAppSenderRoute(contact, whatsAppSender);
    return this.request<SendTextResponse>('/whatsapp-api/messages/text', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: sender.fromPhone,
        contactId: contact.id,
        text,
        externalId: externalId || createNativeExternalId('native'),
        phoneNumberId: sender.phoneNumberId,
        messageOrigin: 'manual_chat',
        transport: sender.transport,
        replyToMessageId: reply?.replyToMessageId || undefined,
        replyToProviderMessageId: reply?.replyToProviderMessageId || undefined,
      }),
    });
  }

  sendHighLevelMessage(
    contact: ChatContact,
    payload: {
      channel: 'whatsapp_api' | 'sms_qr';
      message?: string;
      fromNumber?: string;
      attachmentDataUrls?: Array<{
        dataUrl: string;
        filename?: string;
        mimeType?: string;
        kind?: 'image' | 'video' | 'audio' | 'document';
      }>;
      externalId?: string;
    },
  ) {
    return this.request<SendTextResponse>('/highlevel/conversations/messages', {
      method: 'POST',
      body: JSON.stringify({
        contactId: contact.id,
        channel: payload.channel,
        message: payload.message || undefined,
        fromNumber: payload.fromNumber || undefined,
        toNumber: contact.phone || undefined,
        attachmentDataUrls: payload.attachmentDataUrls?.length ? payload.attachmentDataUrls : undefined,
        externalId: payload.externalId || createNativeExternalId(`native-highlevel-${payload.channel}`),
      }),
    });
  }

  getPaymentLinkDeliveryOptions(contactId: string) {
    return this.request<PaymentLinkDeliveryOptions>(`/contacts/${encodeURIComponent(contactId)}/payment-link-delivery-options`);
  }

  sendImage(contact: ChatContact, imageDataUrl: string, caption = '', whatsAppSender?: NativeWhatsAppSenderRoute, externalId?: string) {
    const sender = normalizeNativeWhatsAppSenderRoute(contact, whatsAppSender);
    return this.request<SendTextResponse>('/whatsapp-api/messages/image', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: sender.fromPhone,
        contactId: contact.id,
        imageDataUrl,
        caption,
        externalId: externalId || createNativeExternalId('native-image'),
        phoneNumberId: sender.phoneNumberId,
        messageOrigin: 'manual_chat',
        transport: sender.transport,
      }),
    });
  }

  sendDocument(contact: ChatContact, documentDataUrl: string, filename: string, mimeType = '', caption = '', whatsAppSender?: NativeWhatsAppSenderRoute, externalId?: string) {
    const sender = normalizeNativeWhatsAppSenderRoute(contact, whatsAppSender);
    return this.request<SendTextResponse>('/whatsapp-api/messages/document', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: sender.fromPhone,
        contactId: contact.id,
        documentDataUrl,
        filename,
        mimeType: mimeType || undefined,
        caption,
        externalId: externalId || createNativeExternalId('native-document'),
        phoneNumberId: sender.phoneNumberId,
        messageOrigin: 'manual_chat',
        transport: sender.transport,
      }),
    });
  }

  sendVideo(contact: ChatContact, videoDataUrl: string, caption = '', whatsAppSender?: NativeWhatsAppSenderRoute, externalId?: string) {
    const sender = normalizeNativeWhatsAppSenderRoute(contact, whatsAppSender);
    return this.request<SendTextResponse>('/whatsapp-api/messages/video', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: sender.fromPhone,
        contactId: contact.id,
        videoDataUrl,
        caption,
        externalId: externalId || createNativeExternalId('native-video'),
        phoneNumberId: sender.phoneNumberId,
        messageOrigin: 'manual_chat',
        transport: sender.transport,
      }),
    });
  }

  sendAudio(contact: ChatContact, audioDataUrl: string, durationMs?: number, whatsAppSender?: NativeWhatsAppSenderRoute, externalId?: string) {
    const sender = normalizeNativeWhatsAppSenderRoute(contact, whatsAppSender);
    return this.request<SendTextResponse>('/whatsapp-api/messages/audio', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: sender.fromPhone,
        contactId: contact.id,
        audioDataUrl,
        durationMs,
        voice: true,
        externalId: externalId || createNativeExternalId('native-audio'),
        phoneNumberId: sender.phoneNumberId,
        messageOrigin: 'manual_chat',
        transport: sender.transport,
      }),
    });
  }

  sendMetaSocialAudio(contact: ChatContact, platform: 'messenger' | 'instagram', audioDataUrl: string, durationMs?: number, reply?: MessageReplyPayload, externalId?: string) {
    return this.request<SendTextResponse>('/whatsapp-api/meta/social/messages/audio', {
      method: 'POST',
      body: JSON.stringify({
        contactId: contact.id,
        platform,
        audioDataUrl,
        durationMs,
        externalId: externalId || createNativeExternalId(`native-${platform}-audio`),
        replyToMessageId: reply?.replyToMessageId || undefined,
        replyToProviderMessageId: reply?.replyToProviderMessageId || undefined,
      }),
    });
  }

  sendLocation(contact: ChatContact, latitude: number, longitude: number, name = 'Ubicación', address = '', whatsAppSender?: NativeWhatsAppSenderRoute, externalId?: string) {
    const sender = normalizeNativeWhatsAppSenderRoute(contact, whatsAppSender);
    return this.request<SendTextResponse>('/whatsapp-api/messages/location', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: sender.fromPhone,
        contactId: contact.id,
        latitude,
        longitude,
        name,
        address,
        externalId: externalId || createNativeExternalId('native-location'),
        phoneNumberId: sender.phoneNumberId,
        messageOrigin: 'manual_chat',
        transport: sender.transport,
      }),
    });
  }

  sendReaction(contact: ChatContact, message: ChatMessage, emoji: string, externalId = createNativeExternalId('native-reaction')) {
    const probe = `${message.transport || ''} ${message.channel || ''}`.toLowerCase();
    const metaPlatform = probe.includes('instagram')
      ? 'instagram'
      : probe.includes('messenger') || probe.includes('facebook')
        ? 'messenger'
        : '';
    const messageTransport = String(message.transport || '').toLowerCase();

    if (metaPlatform) {
      return this.request<SendTextResponse>('/whatsapp-api/meta/social/messages/reaction', {
        method: 'POST',
        body: JSON.stringify({
          contactId: contact.id,
          platform: metaPlatform,
          emoji,
          targetMessageId: message.id,
          targetProviderMessageId: message.providerMessageId || undefined,
          externalId,
        }),
      });
    }

    return this.request<SendTextResponse>('/whatsapp-api/messages/reaction', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: message.businessPhone || contact.lastBusinessPhone || undefined,
        contactId: contact.id,
        targetMessageId: message.id,
        targetProviderMessageId: message.providerMessageId || undefined,
        emoji,
        externalId,
        transport: messageTransport.includes('qr') || messageTransport.includes('baileys') || messageTransport.includes('web') ? 'qr' : 'api',
        phoneNumberId: message.businessPhoneNumberId || contact.lastBusinessPhoneNumberId || undefined,
        messageOrigin: 'manual_chat',
      }),
    });
  }

  scheduleText(
    contact: ChatContact,
    text: string,
    scheduledAt: string,
    channel?: NativeMessageChannel,
    scheduledId?: string,
    whatsAppSender?: NativeWhatsAppSenderRoute,
    options: {
      template?: WhatsAppTemplate;
      highLevelChannel?: 'whatsapp_api' | 'sms_qr';
      fromNumber?: string;
    } = {},
  ) {
    const externalId = scheduledId || createNativeExternalId('native-scheduled');
    const route: NativeScheduleRoute = options.highLevelChannel
      ? { provider: 'highlevel', channel: options.highLevelChannel }
      : getNativeScheduleRoute(contact, channel);
    const sender = normalizeNativeWhatsAppSenderRoute(contact, whatsAppSender);
    // Prefer the caller-computed transport (qr/api resolved from the selected
    // phone + reply window) over the route default, matching /movil scheduling.
    const transport = route.provider === 'whatsapp_api'
      ? (sender.transport || route.transport)
      : undefined;
    const template = options.template;
    return this.request<SendTextResponse & { data?: ScheduledChatMessage }>('/whatsapp-api/messages/scheduled', {
      method: 'POST',
      body: JSON.stringify({
        id: scheduledId || undefined,
        contactId: contact.id,
        provider: route.provider,
        channel: route.provider === 'highlevel' ? route.channel : undefined,
        transport,
        messageType: template ? 'template' : 'text',
        text,
        templateId: template?.id || undefined,
        templateName: template?.name || undefined,
        templateLanguage: template?.language || undefined,
        toPhone: contact.phone || undefined,
        fromPhone: route.provider === 'highlevel'
          ? options.fromNumber || undefined
          : sender.fromPhone,
        businessPhoneNumberId: route.provider === 'whatsapp_api'
          ? sender.phoneNumberId
          : undefined,
        scheduledAt,
        externalId,
      }),
    });
  }

  getScheduledMessages(contactId: string, signal?: AbortSignal) {
    return this.request<ScheduledChatMessage[]>('/whatsapp-api/messages/scheduled', {
      timeoutMs: 8_000,
      signal,
      params: { contactId },
    });
  }

  cancelScheduledMessage(messageId: string, contactId: string) {
    return this.request<ScheduledChatMessage>(`/whatsapp-api/messages/scheduled/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ contactId }),
    });
  }

  getMessageTemplateBundle() {
    return this.request<MessageTemplateBundle>('/settings/message-templates');
  }

  sendWhatsAppTemplate(contact: ChatContact, template: WhatsAppTemplate, whatsAppSender?: NativeWhatsAppSenderRoute, externalId?: string) {
    const sender = normalizeNativeWhatsAppSenderRoute(contact, whatsAppSender);
    return this.request<SendTextResponse>('/whatsapp-api/templates/send', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: sender.fromPhone,
        contactId: contact.id,
        templateId: template.id || undefined,
        templateName: template.name || undefined,
        language: template.language || 'es_MX',
        externalId: externalId || createNativeExternalId('native-template'),
        phoneNumberId: sender.phoneNumberId,
      }),
    });
  }

  async getBankClabes() {
    const response = await this.getConfig([PAYMENT_BANK_CLABES_CONFIG_KEY]);
    const config = 'config' in response && response.config ? response.config : response;
    const value = (config as Record<string, unknown>)[PAYMENT_BANK_CLABES_CONFIG_KEY];
    return Array.isArray(value) ? value as BankClabeAccount[] : [];
  }

  saveBankClabes(accounts: BankClabeAccount[]) {
    return this.request('/config', {
      method: 'POST',
      body: JSON.stringify({
        config: {
          [PAYMENT_BANK_CLABES_CONFIG_KEY]: accounts,
        },
      }),
    });
  }

  getProducts(limit = 100) {
    return this.request<{ products?: ProductItem[]; total?: number }>('/products', {
      params: {
        limit,
        includePrices: true,
      },
    });
  }

  createProduct(payload: ProductPayload) {
    return this.request<ProductItem>('/products', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  updateProduct(productId: string, payload: ProductPayload) {
    return this.request<ProductItem>(`/products/${encodeURIComponent(productId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  deleteProduct(productId: string) {
    return this.request(`/products/${encodeURIComponent(productId)}`, {
      method: 'DELETE',
    });
  }

  getTransactions(query: number | TransactionQuery = 20) {
    const params = typeof query === 'number'
      ? { limit: query, page: 1 }
      : {
          ...query,
          page: query.page ?? 1,
        };
    return this.request<TransactionItem[] | { transactions?: TransactionItem[] }>('/transactions', {
      params,
    });
  }

  createTransaction(payload: TransactionPayload | CreateTransactionInput) {
    return this.request<TransactionItem>('/transactions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  getPaymentSettings() {
    return this.request<PaymentSettingsResponse>('/settings/payments');
  }

  createInstallmentFlow(payload: InstallmentFlowPayload) {
    return this.request('/transactions/payment-flows/installments', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  getStripeSavedPaymentMethods(contactId: string) {
    return this.request<SavedPaymentMethodItem[]>(`/stripe/contacts/${encodeURIComponent(contactId)}/payment-methods`);
  }

  getConektaSavedPaymentSources(contactId: string) {
    return this.request<SavedPaymentMethodItem[]>(`/conekta/contacts/${encodeURIComponent(contactId)}/payment-sources`);
  }

  getRebillSavedPaymentSources(contactId: string) {
    return this.request<SavedPaymentMethodItem[]>(`/rebill/contacts/${encodeURIComponent(contactId)}/payment-sources`);
  }

  createSubscription(payload: SubscriptionPayload, idempotencyKey = '') {
    return this.request<PaymentSubscription>('/subscriptions', {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      body: JSON.stringify(payload),
    });
  }

  createHighLevelInvoice(payload: Record<string, unknown>) {
    return this.request<HighLevelInvoiceResponse>('/highlevel/invoices', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  sendHighLevelInvoice(invoiceId: string, sendMethod: 'email' | 'sms' | 'both') {
    return this.request<HighLevelSendInvoiceResponse>(`/highlevel/invoices/${encodeURIComponent(invoiceId)}/send`, {
      method: 'POST',
      body: JSON.stringify({ sendMethod }),
    });
  }

  recordHighLevelInvoicePayment(invoiceId: string, payload: HighLevelRecordPaymentPayload) {
    return this.request(`/highlevel/invoices/${encodeURIComponent(invoiceId)}/record-payment`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  syncHighLevelInvoice(invoiceId: string) {
    return this.request(`/highlevel/invoices/${encodeURIComponent(invoiceId)}/sync`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  createPaymentLink(provider: PaymentGatewayProvider, payload: PaymentLinkPayload) {
    const providerPath: Record<PaymentGatewayProvider, string> = {
      stripe: '/stripe/payment-links',
      conekta: '/conekta/payment-links',
      mercadopago: '/mercadopago/payment-links',
      clip: '/clip/payment-links',
      rebill: '/rebill/payment-links',
    };
    return this.request<PaymentLinkResponse>(providerPath[provider], {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  chargeSavedCard(
    provider: 'stripe' | 'conekta' | 'rebill',
    payload: SavedCardPaymentPayload,
    idempotencyKey = '',
  ) {
    const providerPath: Record<'stripe' | 'conekta' | 'rebill', string> = {
      stripe: '/stripe/saved-card-payments',
      conekta: '/conekta/saved-card-payments',
      rebill: '/rebill/saved-card-payments',
    };
    return this.request<SavedCardPaymentResponse>(providerPath[provider], {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      body: JSON.stringify(payload),
    });
  }

  createPaymentPlan(provider: PaymentGatewayProvider | 'highlevel', payload: PaymentPlanPayload) {
    const providerPath: Record<PaymentGatewayProvider | 'highlevel', string> = {
      highlevel: '/transactions/payment-flows/installments',
      stripe: '/stripe/payment-plans',
      conekta: '/conekta/payment-plans',
      mercadopago: '/mercadopago/payment-plans',
      clip: '/clip/payment-links',
      rebill: '/rebill/payment-plans',
    };
    return this.request<PaymentLinkResponse>(providerPath[provider], {
      method: 'POST',
      headers: payload.idempotencyKey ? { 'Idempotency-Key': payload.idempotencyKey } : undefined,
      body: JSON.stringify(payload),
    });
  }

  getIntegrationsStatus() {
    return this.request<IntegrationsStatus>('/integrations/status');
  }

  getHighLevelPhoneNumbers() {
    return this.request<HighLevelPhoneNumberCatalog>('/highlevel/phone-numbers');
  }

  getLicenseStatus() {
    return this.request<LicenseStatusResponse>('/license/status');
  }

  getDashboardMetrics(startDate: string, endDate: string) {
    return this.request<DashboardMetrics>('/dashboard/metrics', {
      params: {
        startDate,
        endDate,
      },
    });
  }

  getFinancialOverview(startDate: string, endDate: string, scope: DashboardFunnelScope = 'all') {
    return this.request<DashboardFinancialPoint[]>('/dashboard/financial-overview', {
      params: {
        startDate,
        endDate,
        scope,
      },
    });
  }

  getDashboardSeries(
    kind: 'visitors' | 'leads' | 'appointments' | 'attendances' | 'sales',
    startDate: string,
    endDate: string,
    groupBy: 'day' | 'month' = 'day',
  ) {
    return this.request<DashboardSeriesPoint[]>(`/dashboard/${kind}`, {
      params: {
        startDate,
        endDate,
        groupBy,
      },
    });
  }

  getFunnelData(
    startDate: string,
    endDate: string,
    scope: DashboardFunnelScope = 'all',
    includeWeb = true,
  ) {
    return this.request<DashboardFunnelRow[]>('/dashboard/funnel', {
      params: {
        startDate,
        endDate,
        scope,
        includeWeb: includeWeb ? '1' : '0',
      },
    });
  }

  getOriginDistribution(startDate: string, endDate: string, includeWeb = true) {
    return this.request<OriginDistributionData>('/dashboard/origin-distribution', {
      params: {
        startDate,
        endDate,
        includeWeb: includeWeb ? '1' : '0',
        dimension: 'sources',
        includePhoneBreakdown: '0',
      },
    });
  }

  getOriginPhoneBreakdown(startDate: string, endDate: string, signal?: AbortSignal) {
    return this.request<OriginDistributionData>('/dashboard/origin-distribution', {
      signal,
      params: {
        startDate,
        endDate,
        includeWeb: '0',
        includeWhatsapp: '0',
        dimension: 'sources',
        includeBreakdowns: '0',
        includePhoneBreakdown: '1',
      },
    });
  }

  getWhatsAppApiStatus() {
    return this.request<WhatsAppApiStatus>('/whatsapp-api/status');
  }

  getCustomLabels() {
    return this.request<CustomLabels>('/highlevel/custom-labels');
  }

  getCalendars() {
    return this.request<CalendarItem[] | { calendars?: CalendarItem[] }>('/calendars');
  }

  getCalendarEvents(
    startTime: number,
    endTime: number,
    calendarId?: string,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<CalendarEventItem[] | { events?: CalendarEventItem[] }>('/calendars/events', {
      signal: options.signal,
      timeoutMs: 8000,
      params: {
        startTime,
        endTime,
        calendarId,
      },
    });
  }

  getAppointment(eventId: string) {
    return this.request<CalendarEventItem>(`/calendars/events/${encodeURIComponent(eventId)}`);
  }

  getBlockedSlots(calendarId: string, startTime: number, endTime: number) {
    // Blocked slots come from the dedicated /blocked-slots endpoint (ISO
    // startTime/endTime/reason). It previously (incorrectly) hit /free-slots,
    // which returned a different shape, so the conflict check never fired.
    return this.request<CalendarFreeSlot[]>(`/calendars/${encodeURIComponent(calendarId)}/blocked-slots`, {
      params: {
        startTime,
        endTime,
      },
    });
  }

  getFreeSlots(
    calendarId: string,
    startDate: string,
    endDate: string,
    timezone?: string,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<CalendarFreeSlot[]>(`/calendars/${encodeURIComponent(calendarId)}/free-slots`, {
      signal: options.signal,
      timeoutMs: 8000,
      params: {
        startDate,
        endDate,
        timezone,
      },
    });
  }

  getCalendarUsers(options: { signal?: AbortSignal } = {}) {
    return this.request<{ users?: CalendarUser[] }>('/highlevel/users', {
      signal: options.signal,
      timeoutMs: 8000,
    });
  }

  getCalendarUsersByIds(userIds: string[], options: { signal?: AbortSignal } = {}) {
    // The backend route is POST and reads req.body.userIds (an array); the old
    // GET with a comma-joined query string 404'd, so team names never loaded.
    return this.request<{ users?: CalendarUser[] }>('/highlevel/users/by-ids', {
      method: 'POST',
      signal: options.signal,
      timeoutMs: 8000,
      body: JSON.stringify({ userIds }),
    });
  }

  createAppointment(appointmentData: Record<string, unknown> & { calendarId: string }, clientRequestId?: string) {
    return this.request<CalendarEventItem>('/calendars/appointments', {
      method: 'POST',
      body: JSON.stringify({
        ...appointmentData,
        ...(clientRequestId ? { clientRequestId } : {}),
      }),
    });
  }

  updateAppointment(eventId: string, updateData: Record<string, unknown>) {
    return this.request<CalendarEventItem>(`/calendars/appointments/${encodeURIComponent(eventId)}`, {
      method: 'PUT',
      body: JSON.stringify(updateData),
    });
  }

  deleteCalendarEvent(eventId: string) {
    return this.request<{ success?: boolean }>(`/calendars/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
    });
  }

  getConfig(keys: string[]) {
    return this.request<{ config?: Record<string, ConfigValue> } | Record<string, ConfigValue>>('/config', {
      params: {
        keys: keys.join(','),
      },
    });
  }

  getTimezone() {
    return this.request<{ timezone?: string; source?: string }>('/settings/timezone');
  }

  setConfig(key: string, value: ConfigValue) {
    return this.request<{ success?: boolean; message?: string }>('/config', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    });
  }

  getUserConfig(keys: string[]) {
    return this.request<{ config?: Record<string, ConfigValue> }>('/user-config', {
      params: {
        keys: keys.join(','),
      },
    });
  }

  setUserConfig(key: string, value: ConfigValue) {
    return this.request<{ success?: boolean; message?: string }>('/user-config', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    });
  }

  getWhatsAppTemplates(status?: string | null) {
    return this.request<WhatsAppApiTemplatesResponse>('/whatsapp-api/templates', {
      params: {
        status: status || undefined,
      },
    });
  }

  getCustomFieldDefinitions(includeArchived = false) {
    return this.request<ContactCustomFieldDefinition[]>('/contacts/custom-fields', {
      params: {
        includeArchived: includeArchived ? 'true' : undefined,
      },
    });
  }

  createCustomFieldDefinition(label: string) {
    const key = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return this.request<ContactCustomFieldDefinition>('/settings/custom-fields', {
      method: 'POST',
      body: JSON.stringify({ label, key, dataType: 'text' }),
    });
  }

  deleteCustomFieldDefinition(definitionId: string) {
    return this.request(`/settings/custom-fields/${definitionId}`, { method: 'DELETE' });
  }

  getContactAutomations() {
    return this.request<ContactAutomationsOverview>('/automations');
  }

  enrollContactInAutomation(automationId: string, contactId: string) {
    return this.request<{ enrollment?: unknown }>(`/automations/${automationId}/enroll-contact`, {
      method: 'POST',
      body: JSON.stringify({ contactId, mode: 'now' }),
    });
  }

  getAIAgentConfig() {
    return this.request<AIAgentConfigStatus>('/ai-agent/config');
  }

  saveAIAgentConfig(config: { apiKey?: string; model?: string }) {
    return this.request<AIAgentConfigStatus>('/ai-agent/config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  saveAIAgentBusinessContext(answer: string) {
    return this.request<AIAgentBusinessContextAnswerResult>('/ai-agent/business-context-answer', {
      method: 'POST',
      body: JSON.stringify({
        field: 'businessContext',
        answer,
      }),
    });
  }

  sendAIAgentMessage(messages: AIAgentMessage[], viewContext: AIAgentViewContext, category = 'auto') {
    return this.request<AIAgentChatResult>('/ai-agent/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages,
        viewContext,
        category,
      }),
    });
  }

  async transcribeAIAgentAudio(audioUri: string, mimeType = 'audio/m4a') {
    const headers: Record<string, string> = {
      'Content-Type': mimeType,
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const uploadResult = await FileSystem.uploadAsync(this.buildUrl('/ai-agent/transcribe'), audioUri, {
      httpMethod: 'POST',
      headers,
      mimeType,
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    });

    let payload: unknown = null;
    try {
      payload = uploadResult.body ? JSON.parse(uploadResult.body) : null;
    } catch {
      payload = null;
    }

    if (uploadResult.status < 200 || uploadResult.status >= 300) {
      const message = payload && typeof payload === 'object'
        ? String((payload as { error?: unknown; message?: unknown }).error || (payload as { message?: unknown }).message || `HTTP ${uploadResult.status}`)
        : `HTTP ${uploadResult.status}`;
      const error = new Error(message || `HTTP ${uploadResult.status}`) as ApiError;
      error.status = uploadResult.status;
      error.body = payload;
      throw error;
    }

    if (payload && typeof payload === 'object' && 'success' in payload && 'data' in payload) {
      return (payload as { data: AIAgentTranscriptionResult }).data;
    }

    return payload as AIAgentTranscriptionResult;
  }

  getWhatsAppStatus() {
    return this.request<WhatsAppApiStatus>('/whatsapp-api/status');
  }

  refreshWhatsAppStatus() {
    return this.request<WhatsAppApiStatus>('/whatsapp-api/refresh', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  setDefaultWhatsAppPhoneNumber(phoneNumberId: string) {
    return this.request<WhatsAppApiStatus>('/whatsapp-api/phone-numbers/default', {
      method: 'POST',
      body: JSON.stringify({ phoneNumberId }),
    });
  }

  getPushPublicConfig() {
    return this.request<WebPushPublicConfig>('/push/public-key');
  }

  saveMobilePushDevice(payload: SaveMobilePushDevicePayload) {
    return this.request<{ id?: string; enabled?: boolean; calendarIds?: string[] }>('/push/mobile-devices', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  deleteMobilePushDevice(token: string) {
    return this.request<{ disabled?: boolean }>('/push/mobile-devices', {
      method: 'DELETE',
      body: JSON.stringify({ token }),
    });
  }
}

export async function resolveMobileTenant(identifier: string): Promise<RuntimeTenant> {
  const cleanIdentifier = identifier.trim();
  if (cleanIdentifier.length < 3) {
    throw new Error('Escribe tu correo de Ristak.');
  }

  const response = await fetch(buildInstallerUrl('/api/mobile/resolve'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: cleanIdentifier }),
  });

  let payload: InstallerTenantResponse = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  const appUrl = cleanBaseUrl(payload.tenant?.app_url || '');
  if (!response.ok || !payload.success || !appUrl) {
    throw new Error(payload.message || 'No encontre una app activa para ese correo.');
  }

  return {
    clientId: payload.tenant?.client_id || '',
    installationId: payload.tenant?.installation_id || '',
    name: payload.tenant?.name || '',
    email: payload.tenant?.email || '',
    appUrl,
  };
}

export async function loginWithResolvedTenant(identifier: string, password: string) {
  const cleanIdentifier = identifier.trim();
  if (!cleanIdentifier || !password) {
    throw new Error('Escribe tu correo y contrasena.');
  }

  const tenant = await resolveMobileTenant(cleanIdentifier);
  const response = await new RistakApiClient(tenant.appUrl).login(cleanIdentifier, password);

  if (response.token && response.user) {
    return {
      baseUrl: tenant.appUrl,
      token: response.token,
      user: response.user,
      tenant,
    };
  }

  if (response.code === 'license_blocked') {
    const error = new Error(response.message || 'Tu licencia de Ristak no esta activa.') as ApiError;
    error.code = response.code;
    throw error;
  }

  throw new Error(response.message || 'Correo o contrasena incorrectos.');
}

export function getUserDisplayName(user?: RistakUser | null) {
  return user?.name || user?.email || 'Ristak';
}
