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
  ContactCustomFieldDefinition,
  CustomLabels,
  AIAgentTranscriptionResult,
  AIAgentBusinessContextAnswerResult,
  AIAgentConfigStatus,
  ConversationAgentState,
  CreateTransactionInput,
  DashboardFinancialPoint,
  DashboardFunnelRow,
  DashboardFunnelScope,
  DashboardMetrics,
  DashboardSeriesPoint,
  HighLevelInvoiceResponse,
  HighLevelRecordPaymentPayload,
  HighLevelSendInvoiceResponse,
  IntegrationsStatus,
  OriginDistributionData,
  JourneyEvent,
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
  ScheduledChatMessage,
  SendTextResponse,
  TransactionItem,
  VerifyResponse,
  WebPushPublicConfig,
  WhatsAppTemplate,
  WhatsAppApiTemplatesResponse,
  WhatsAppApiStatus,
} from './types';
import { cleanBaseUrl } from './format';

const DEFAULT_INSTALLER_API_BASE_URL = 'https://www.ristak.com';
const PAYMENT_BANK_CLABES_CONFIG_KEY = 'payment_bank_clabes';

type RequestOptions = RequestInit & {
  params?: Record<string, string | number | boolean | undefined>;
};

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
  firstPayment?: Record<string, unknown>;
  remainingAutomatic?: boolean;
  remainingFrequency?: string;
  remainingPayments?: Array<Record<string, unknown>>;
  source?: string;
};

type SubscriptionPayload = {
  contactId?: string | null;
  contactName?: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  name: string;
  description?: string;
  status?: string;
  amount: number;
  currency: string;
  intervalType: string;
  intervalCount: number;
  startDate: string;
  nextRunAt?: string | null;
  paymentMethod?: string;
  paymentProvider?: string;
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
  return cleanBaseUrl(process.env.EXPO_PUBLIC_INSTALLER_API_URL || DEFAULT_INSTALLER_API_BASE_URL);
}

function buildInstallerUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getInstallerApiBaseUrl()}${normalizedPath}`;
}

function getNativeContactChannel(contact: ChatContact) {
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

function getHighLevelChannel(channel: NativeMessageChannel) {
  if (channel === 'sms') return 'sms_qr';
  if (channel === 'messenger') return 'messenger';
  if (channel === 'instagram') return 'instagram';
  if (channel === 'email') return 'email';
  return 'whatsapp_api';
}

export class RistakApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token = '',
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
    const headers = new Headers(options.headers);
    const hasBody = options.body !== undefined && options.body !== null;
    if (hasBody && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }

    const response = await fetch(this.buildUrl(path, options.params), {
      ...options,
      headers,
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message = getErrorMessage(payload, response.statusText);
      const error = new Error(message || `HTTP ${response.status}`) as ApiError;
      error.status = response.status;
      error.body = payload;
      if (payload && typeof payload === 'object') {
        error.code = String((payload as { code?: unknown }).code || '');
      }
      throw error;
    }

    if (payload && typeof payload === 'object' && 'success' in payload && 'data' in payload) {
      return (payload as { data: T }).data;
    }

    return payload as T;
  }

  login(email: string, password: string) {
    return this.request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  verify(token: string) {
    return new RistakApiClient(this.baseUrl).request<VerifyResponse>('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  }

  getChats(query = '', offset = 0, limit = 50) {
    return this.request<ChatContact[]>('/contacts/chats', {
      params: {
        q: query.trim() || undefined,
        limit,
        offset: offset > 0 ? offset : undefined,
      },
    });
  }

  searchContacts(query: string) {
    return this.request<ChatContact[]>('/contacts/search', {
      params: {
        q: query.trim(),
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

  getConversation(contactId: string, limit = 50) {
    return this.request<JourneyEvent[]>(`/contacts/${encodeURIComponent(contactId)}/journey`, {
      params: {
        includeBusinessMessages: true,
        refreshExternalStatuses: false,
        chatMessagesOnly: true,
        messageLimit: limit,
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

  updateAgentState(contactId: string, action: 'activate' | 'pause' | 'take_over' | 'skip') {
    return this.request<ConversationAgentState>(`/conversational-agent/states/${encodeURIComponent(contactId)}`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
  }

  sendText(contact: ChatContact, text: string, channel: NativeMessageChannel = 'whatsapp') {
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
          externalId: `native-${channel}-${Date.now()}`,
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
          externalId: `native-sms-${Date.now()}`,
        }),
      });
    }

    return this.request<SendTextResponse>('/whatsapp-api/messages/text', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: contact.lastBusinessPhone || undefined,
        contactId: contact.id,
        text,
        externalId: `native-${Date.now()}`,
        phoneNumberId: contact.lastBusinessPhoneNumberId || undefined,
        messageOrigin: 'native_mobile_chat',
      }),
    });
  }

  getPaymentLinkDeliveryOptions(contactId: string) {
    return this.request<PaymentLinkDeliveryOptions>(`/contacts/${encodeURIComponent(contactId)}/payment-link-delivery-options`);
  }

  sendImage(contact: ChatContact, imageDataUrl: string, caption = '') {
    return this.request<SendTextResponse>('/whatsapp-api/messages/image', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: contact.lastBusinessPhone || undefined,
        contactId: contact.id,
        imageDataUrl,
        caption,
        externalId: `native-image-${Date.now()}`,
        phoneNumberId: contact.lastBusinessPhoneNumberId || undefined,
        messageOrigin: 'native_mobile_chat',
      }),
    });
  }

  sendDocument(contact: ChatContact, documentDataUrl: string, filename: string, mimeType = '', caption = '') {
    return this.request<SendTextResponse>('/whatsapp-api/messages/document', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: contact.lastBusinessPhone || undefined,
        contactId: contact.id,
        documentDataUrl,
        filename,
        mimeType: mimeType || undefined,
        caption,
        externalId: `native-document-${Date.now()}`,
        phoneNumberId: contact.lastBusinessPhoneNumberId || undefined,
        messageOrigin: 'native_mobile_chat',
      }),
    });
  }

  sendVideo(contact: ChatContact, videoDataUrl: string, caption = '') {
    return this.request<SendTextResponse>('/whatsapp-api/messages/video', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: contact.lastBusinessPhone || undefined,
        contactId: contact.id,
        videoDataUrl,
        caption,
        externalId: `native-video-${Date.now()}`,
        phoneNumberId: contact.lastBusinessPhoneNumberId || undefined,
        messageOrigin: 'native_mobile_chat',
      }),
    });
  }

  sendAudio(contact: ChatContact, audioDataUrl: string, durationMs?: number) {
    return this.request<SendTextResponse>('/whatsapp-api/messages/audio', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: contact.lastBusinessPhone || undefined,
        contactId: contact.id,
        audioDataUrl,
        durationMs,
        voice: true,
        externalId: `native-audio-${Date.now()}`,
        phoneNumberId: contact.lastBusinessPhoneNumberId || undefined,
        messageOrigin: 'native_mobile_chat',
      }),
    });
  }

  sendLocation(contact: ChatContact, latitude: number, longitude: number, name = 'Ubicación', address = '') {
    return this.request<SendTextResponse>('/whatsapp-api/messages/location', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: contact.lastBusinessPhone || undefined,
        contactId: contact.id,
        latitude,
        longitude,
        name,
        address,
        externalId: `native-location-${Date.now()}`,
        phoneNumberId: contact.lastBusinessPhoneNumberId || undefined,
        messageOrigin: 'native_mobile_chat',
      }),
    });
  }

  sendReaction(contact: ChatContact, message: ChatMessage, emoji: string) {
    return this.request<SendTextResponse>('/whatsapp-api/messages/reaction', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: contact.lastBusinessPhone || undefined,
        contactId: contact.id,
        messageId: message.providerMessageId || message.id,
        emoji,
        externalId: `native-reaction-${Date.now()}`,
        phoneNumberId: contact.lastBusinessPhoneNumberId || undefined,
        messageOrigin: 'native_mobile_chat',
      }),
    });
  }

  scheduleText(contact: ChatContact, text: string, scheduledAt: string, channel?: NativeMessageChannel) {
    return this.request('/whatsapp-api/messages/scheduled', {
      method: 'POST',
      body: JSON.stringify({
        contactId: contact.id,
        channel: channel ? getHighLevelChannel(channel) : getNativeContactChannel(contact),
        transport: 'native',
        messageType: 'text',
        text,
        toPhone: contact.phone || undefined,
        fromPhone: contact.lastBusinessPhone || undefined,
        businessPhoneNumberId: contact.lastBusinessPhoneNumberId || undefined,
        scheduledAt,
        externalId: `native-scheduled-${Date.now()}`,
      }),
    });
  }

  getScheduledMessages(contactId: string) {
    return this.request<ScheduledChatMessage[]>('/whatsapp-api/messages/scheduled', {
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

  sendWhatsAppTemplate(contact: ChatContact, template: WhatsAppTemplate) {
    return this.request<SendTextResponse>('/whatsapp-api/templates/send', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: contact.lastBusinessPhone || undefined,
        contactId: contact.id,
        templateId: template.id || undefined,
        templateName: template.name || undefined,
        language: template.language || 'es_MX',
        externalId: `native-template-${Date.now()}`,
        phoneNumberId: contact.lastBusinessPhoneNumberId || undefined,
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

  createInstallmentFlow(payload: InstallmentFlowPayload) {
    return this.request('/transactions/payment-flows/installments', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  createSubscription(payload: SubscriptionPayload) {
    return this.request<PaymentSubscription>('/subscriptions', {
      method: 'POST',
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
      body: JSON.stringify(payload),
    });
  }

  getIntegrationsStatus() {
    return this.request<IntegrationsStatus>('/integrations/status');
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

  getFunnelData(startDate: string, endDate: string, scope: DashboardFunnelScope = 'all') {
    return this.request<DashboardFunnelRow[]>('/dashboard/funnel', {
      params: {
        startDate,
        endDate,
        scope,
      },
    });
  }

  getOriginDistribution(startDate: string, endDate: string) {
    return this.request<OriginDistributionData>('/dashboard/origin-distribution', {
      params: {
        startDate,
        endDate,
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

  getCalendarEvents(startTime: number, endTime: number, calendarId?: string) {
    return this.request<CalendarEventItem[] | { events?: CalendarEventItem[] }>('/calendars/events', {
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
    return this.request<CalendarFreeSlot[]>(`/calendars/${encodeURIComponent(calendarId)}/free-slots`, {
      params: {
        startTime,
        endTime,
      },
    });
  }

  getFreeSlots(calendarId: string, startDate: string, endDate: string, timezone?: string) {
    return this.request<CalendarFreeSlot[]>(`/calendars/${encodeURIComponent(calendarId)}/free-slots`, {
      params: {
        startDate,
        endDate,
        timezone,
      },
    });
  }

  getCalendarUsers() {
    return this.request<{ users?: CalendarUser[] }>('/highlevel/users');
  }

  getCalendarUsersByIds(userIds: string[]) {
    return this.request<{ users?: CalendarUser[] }>('/highlevel/users/by-ids', {
      params: {
        userIds: userIds.join(','),
      },
    });
  }

  createAppointment(appointmentData: Record<string, unknown>) {
    return this.request<CalendarEventItem>('/calendars/appointments', {
      method: 'POST',
      body: JSON.stringify(appointmentData),
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

  getAIAgentConfig() {
    return this.request<AIAgentConfigStatus>('/ai-agent/config');
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

  async transcribeAIAgentAudio(audioUri: string, mimeType = 'audio/m4a') {
    const audioResponse = await fetch(audioUri);
    const audioBlob = await audioResponse.blob();
    const headers = new Headers({
      'Content-Type': audioBlob.type || mimeType,
    });

    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }

    const response = await fetch(this.buildUrl('/ai-agent/transcribe'), {
      method: 'POST',
      headers,
      body: audioBlob,
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message = payload && typeof payload === 'object'
        ? String((payload as { error?: unknown; message?: unknown }).error || (payload as { message?: unknown }).message || response.statusText)
        : response.statusText;
      const error = new Error(message || `HTTP ${response.status}`) as ApiError;
      error.status = response.status;
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
