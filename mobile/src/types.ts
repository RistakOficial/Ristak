export type NativeAccessLevel = 'none' | 'read' | 'write';
export type NativeAccessConfig = Record<string, NativeAccessLevel>;
export type NativeLicenseFeatures = Record<string, boolean | undefined>;

export type RistakUser = {
  id: string;
  name?: string;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  phone?: string;
  businessName?: string;
  role?: string;
  accessConfig?: NativeAccessConfig | null;
  licenseEnforced?: boolean;
  licensePlan?: string | null;
  licenseFeaturesSourceValid?: boolean;
  licenseFeatures?: NativeLicenseFeatures | null;
  licenseLimits?: Record<string, unknown> | null;
  licenseExternalModules?: Record<string, unknown> | null;
};

export type LoginResponse = {
  success?: boolean;
  token?: string;
  apiToken?: string;
  user?: RistakUser;
  code?: string;
  message?: string;
};

export type VerifyResponse = {
  success?: boolean;
  user?: RistakUser;
};

export type LicenseStatusResponse = {
  success?: boolean;
  enforced?: boolean;
  allowed?: boolean;
  plan?: string | null;
  features?: Record<string, unknown>;
  expires_at?: string | null;
};

export type RuntimeTenant = {
  clientId: string;
  installationId: string;
  name: string;
  email: string;
  appUrl: string;
};

export type ContactMetaAttribution = {
  source?: string | null;
  matchType?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  adsetId?: string | null;
  adsetName?: string | null;
  adId?: string | null;
  adAccountId?: string | null;
  adName?: string | null;
  creativeThumbnailUrl?: string | null;
  creativeImageUrl?: string | null;
  creativeVideoUrl?: string | null;
  creativePreviewUrl?: string | null;
  date?: string | null;
};

export type ChatContact = {
  id: string;
  phone?: string;
  email?: string;
  status?: string;
  source?: string;
  attribution_session_source?: string;
  whatsappAttributionPlatform?: string;
  purchases?: number;
  ltv?: number;
  hasAppointments?: boolean;
  nextAppointmentDate?: string | null;
  hasCommentMessage?: boolean;
  hasPrivateDm?: boolean;
  metaAttribution?: ContactMetaAttribution | null;
  name?: string;
  contactName?: string;
  displayName?: string;
  profileName?: string;
  socialName?: string;
  fullName?: string;
  full_name?: string;
  firstName?: string;
  first_name?: string;
  lastName?: string;
  last_name?: string;
  profilePhotoUrl?: string | null;
  avatarUrl?: string | null;
  photoUrl?: string | null;
  pictureUrl?: string | null;
  lastMessageText?: string;
  lastMessageType?: string;
  lastMessageChannel?: string;
  lastMessageTransport?: string;
  lastMessageDate?: string;
  lastMessageDirection?: string;
  lastBusinessPhone?: string;
  lastBusinessPhoneNumberId?: string;
  preferredWhatsAppPhoneNumberId?: string;
  preferred_whatsapp_phone_number_id?: string;
  routingSource?: string;
  routingReason?: string;
  unreadCount?: number;
  messageCount?: number;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  customFields?: Array<{
    id?: string;
    definitionId?: string;
    fieldId?: string;
    field_id?: string;
    key?: string;
    fieldKey?: string;
    dataType?: string;
    name?: string;
    label?: string;
    value?: unknown;
  }>;
};

export type ContactTag = {
  id: string;
  name: string;
  isSystem?: boolean;
  usageCount?: number;
};

export type ContactAutomationSummary = {
  id: string;
  name: string;
  status: string;
  description?: string;
};

export type ContactAutomationsOverview = {
  automations?: ContactAutomationSummary[];
};

export type ConversationAgentState = {
  id?: string;
  contactId?: string;
  agentId?: string | null;
  agentName?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  status?: string | null;
  signal?: string | null;
  signalReason?: string | null;
  signalSummary?: string | null;
  signalAt?: string | null;
  pausedUntilAt?: string | null;
  lastReplyAt?: string | null;
  lastAnsweredInboundMessageId?: string | null;
  updatedAt?: string | null;
  activatedAt?: string | null;
};

export type ConversationalCapabilityId =
  | 'schedule_appointment'
  | 'collect_payment'
  | 'send_link'
  | 'handoff_human'
  | 'custom_goal';

export type ConversationalPromptConfig = {
  schemaVersion: 1;
  templateVersion: string;
  editableText: string;
};

export type ConversationalCapabilityConfigItem = {
  id: ConversationalCapabilityId;
  enabled: boolean;
  [key: string]: unknown;
};

export type ConversationalCapabilitiesConfig = {
  schemaVersion: 1;
  items: ConversationalCapabilityConfigItem[];
};

export type ConversationalCapabilityManifestItem = {
  id: ConversationalCapabilityId;
  label: string;
  locked: true;
  enabled: boolean;
  ready: boolean;
  summary: string;
  missingConfiguration: string[];
};

export type ConversationalAgentDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  promptConfig?: ConversationalPromptConfig;
  capabilitiesConfig?: ConversationalCapabilitiesConfig;
  capabilityManifest?: ConversationalCapabilityManifestItem[];
  aiProvider?: string;
  model?: string;
  position?: number;
  hideAttendedNotifications?: boolean;
  contactScope?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type JourneyEvent = {
  type: string;
  date: string;
  cursorKey?: string;
  data?: Record<string, unknown>;
};

export type ConversationHistoryCursor = {
  beforeMessageDate: string;
  beforeMessageCursor?: string;
};

export type ChatAttachment = {
  type: 'image' | 'video' | 'audio' | 'document' | 'file';
  clientId?: string;
  url?: string;
  dataUrl?: string;
  name?: string;
  mimeType?: string;
  isGif?: boolean;
  durationMs?: number;
  size?: number;
  caption?: string;
};

export type ChatLocation = {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
  url?: string;
};

export type ChatReaction = {
  id: string;
  emoji: string;
  direction?: 'inbound' | 'outbound' | 'system';
};

export type ChatMessage = {
  id: string;
  /** Identidad estable del globo creado antes de que termine el POST. */
  optimisticId?: string;
  /** Id de la fila persistida; nunca reemplaza `id` mientras el globo está visible. */
  serverMessageId?: string;
  contactId: string;
  date: string;
  direction: 'inbound' | 'outbound' | 'system';
  text: string;
  channel: string;
  status?: string;
  transport?: string;
  errorReason?: string;
  providerMessageId?: string;
  sentAt?: string;
  deliveredAt?: string;
  readAt?: string;
  scheduledAt?: string;
  scheduledMessageId?: string;
  messageType?: string;
  businessPhone?: string;
  businessPhoneNumberId?: string;
  routingReason?: string;
  sentByAgent?: boolean;
  agentId?: string;
  replyToMessageId?: string;
  replyToProviderMessageId?: string;
  reactionEmoji?: string;
  reactionTargetMessageId?: string;
  reactionTargetProviderMessageId?: string;
  reactions?: ChatReaction[];
  attachment?: ChatAttachment;
  location?: ChatLocation;
  isComment?: boolean;
  commentReplyMode?: 'public' | 'private';
  commentId?: string;
  commentPlatform?: 'instagram' | 'messenger';
  commentPost?: {
    message?: string;
    imageUrl?: string;
    permalink?: string;
    deleted?: boolean;
  };
  linkPreview?: {
    kind?: string;
    title?: string;
    subtitle?: string;
    amountLabel?: string;
    providerLabel?: string;
    url?: string;
  };
  paymentPreview?: {
    kind?: string;
    title?: string;
    subtitle?: string;
    amountLabel?: string;
    providerLabel?: string;
    url?: string;
  };
  emailDetails?: {
    subject: string;
    fromEmail: string;
    toEmail: string;
    ccEmail?: string;
    bccEmail?: string;
    replyTo: string;
    status: string;
    transport: string;
    body: string;
    bodyHtml?: string;
  };
  pending?: boolean;
  failed?: boolean;
};

export type SendTextResponse = {
  id?: string;
  localMessageId?: string | null;
  status?: string;
  transport?: string;
  channel?: string;
  message?: unknown;
  fallbackReason?: string;
  routingReason?: string;
  audio?: {
    link?: string;
    url?: string;
    mimeType?: string;
    mimetype?: string;
    durationMs?: number;
    voice?: boolean;
  };
  localMedia?: {
    publicUrl?: string;
    publicPath?: string;
    mimeType?: string;
    filename?: string;
  } | null;
};

export type NativeMessageChannel = 'whatsapp' | 'sms' | 'messenger' | 'instagram' | 'email';

export type WhatsAppTemplate = {
  id?: string;
  name?: string;
  description?: string;
  language?: string;
  status?: string | null;
  category?: string;
  bodyText?: string;
  body?: string;
  text?: string;
  localText?: string;
  source?: 'whatsapp' | 'local';
};

export type WhatsAppTemplatesResponse = {
  total?: number;
  approved?: number;
  blocked?: number;
  items?: WhatsAppTemplate[];
};

export type MessageTemplate = {
  id: string;
  name: string;
  description?: string;
  status?: string;
  bodyText?: string;
  body?: string;
  footerText?: string;
};

export type MessageTemplateBundle = {
  templates?: MessageTemplate[];
};

export type BankClabeAccount = {
  id: string;
  alias: string;
  clabe: string;
  bank?: string;
  accountHolder?: string;
};

export type PaymentLinkDeliveryOptions = {
  channels?: Record<string, {
    enabled?: boolean;
    label?: string;
    reason?: string;
  }>;
};

export type ScheduledChatMessage = {
  id?: string;
  text?: string;
  scheduledAt?: string;
  status?: string;
  channel?: string;
  transport?: string;
  externalId?: string;
};

export type CreateAppointmentInput = {
  title: string;
  contactId: string;
  contactName?: string;
  calendarId?: string;
  startTime: string;
  endTime: string;
  notes?: string;
  appointmentStatus?: string;
};

export type CreateTransactionInput = {
  amount: number;
  currency: string;
  status: string;
  paymentMethod: string;
  paymentMode?: string;
  title: string;
  description?: string;
  contactId: string;
  contactName?: string;
  email?: string;
  phone?: string;
  date?: string;
  metadata?: Record<string, unknown>;
};

export type PhoneSection = 'settings' | 'chat' | 'calendar' | 'payments' | 'analytics';

export type DashboardKpi = {
  value?: number;
  variation?: number;
};

export type DashboardMetrics = {
  ingresosNetos?: DashboardKpi;
  gastosPublicidad?: DashboardKpi;
  gananciaBruta?: DashboardKpi;
  roas?: DashboardKpi;
  totalCostos?: DashboardKpi;
  gananciaNeta?: DashboardKpi;
  reembolsos?: DashboardKpi;
  ltvPromedio?: DashboardKpi;
};

export type DashboardSeriesPoint = {
  label: string;
  value: number;
};

export type DashboardFinancialPoint = {
  label: string;
  value: number;
  value2: number;
};

export type DashboardFunnelScope = 'all' | 'attribution' | 'campaigns';

export type DashboardFunnelRow = {
  stage: string;
  value: number;
};

export type SourceDatum = {
  name: string;
  value: number;
  color?: string;
};

export type WhatsAppNumberOriginDatum = SourceDatum & {
  phoneNumberId?: string | null;
  phoneNumber?: string | null;
  displayPhoneNumber?: string | null;
  status?: string | null;
  apiSendEnabled?: boolean;
  qrSendEnabled?: boolean;
};

export type OriginDistributionData = {
  traffic: {
    sources: SourceDatum[];
    platforms: SourceDatum[];
    devices: SourceDatum[];
    placements: SourceDatum[];
    browsers: SourceDatum[];
    os: SourceDatum[];
  };
  leads: SourceDatum[];
  appointments: SourceDatum[];
  conversions: SourceDatum[];
  whatsappNumbers?: WhatsAppNumberOriginDatum[];
};

export type WhatsAppApiPhoneNumberAvailability = {
  apiAvailable?: boolean;
  apiReason?: string;
  qrReady?: boolean;
  available?: boolean;
};

export type WhatsAppApiPhoneNumber = {
  id: string;
  waba_id?: string | null;
  phone_number?: string | null;
  display_phone_number?: string | null;
  verified_name?: string | null;
  profile_picture_url?: string | null;
  business_profile_json?: string | null;
  quality_rating?: string | null;
  messaging_limit?: string | null;
  status?: string | null;
  label?: string | null;
  is_default_sender?: boolean;
  api_send_enabled?: boolean;
  qr_send_enabled?: boolean;
  qr_status?: string | null;
  qr_connected_phone?: string | null;
  qr_last_error?: string | null;
  updated_at?: string | null;
  availability?: WhatsAppApiPhoneNumberAvailability;
  provider?: 'ycloud' | 'meta_direct' | string;
};

export type WhatsAppApiStatus = {
  provider?: 'ycloud' | 'meta_direct' | string;
  activeProvider?: 'ycloud' | 'meta_direct' | string;
  source?: 'WhatsApp_API' | string;
  connected?: boolean;
  configured?: boolean;
  requiresPhoneSelection?: boolean;
  status?: 'connected' | 'needs_phone' | 'disabled' | 'disconnected' | string;
  sender?: {
    phone?: string | null;
    phoneNumberId?: string | null;
    wabaId?: string | null;
  };
  phoneNumbers?: WhatsAppApiPhoneNumber[];
  selectedPhone?: WhatsAppApiPhoneNumber | null;
  needsDefaultSelection?: boolean;
  lastError?: string | null;
};

export type CustomLabels = {
  customer: string;
  customers: string;
  lead: string;
  leads: string;
};

export type ProductPrice = {
  id?: string;
  _id?: string;
  localId?: string;
  name?: string;
  amount?: number;
  price?: number;
  currency?: string;
  type?: string;
};

export type ProductItem = {
  id?: string;
  _id?: string;
  localId?: string;
  name?: string;
  description?: string;
  currency?: string;
  productType?: string;
  source?: string;
  syncStatus?: string;
  syncError?: string | null;
  prices?: ProductPrice[];
};

export type TransactionItem = {
  id?: string;
  _id?: string;
  date?: string;
  contactId?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  concept?: string;
  title?: string;
  description?: string;
  amount?: number;
  total?: number;
  currency?: string;
  status?: string;
  method?: string;
  paymentMethod?: string;
  paymentMode?: string;
  paymentProvider?: string;
  reference?: string;
  createdAt?: string;
  updatedAt?: string;
  paymentDate?: string;
  paidAt?: string;
  dueDate?: string;
  publicPaymentId?: string;
  paymentUrl?: string;
  metadata?: Record<string, unknown>;
};

export type PaymentGatewayProvider = 'stripe' | 'conekta' | 'mercadopago' | 'clip' | 'rebill';

export type PaymentGatewayStatus = {
  configured?: boolean;
  connected?: boolean;
  mode?: 'test' | 'live' | string;
  accountLabel?: string | null;
};

export type MetaIntegrationStatus = {
  configured?: boolean;
  connected?: boolean;
  adAccountId?: string | null;
  pixelId?: string | null;
  pageId?: string | null;
  instagramAccountId?: string | null;
};

export type IntegrationsStatus = {
  highlevel?: PaymentGatewayStatus;
  meta?: MetaIntegrationStatus;
  whatsapp?: PaymentGatewayStatus;
  stripe?: PaymentGatewayStatus;
  conekta?: PaymentGatewayStatus;
  mercadopago?: PaymentGatewayStatus;
  clip?: PaymentGatewayStatus;
  rebill?: PaymentGatewayStatus;
  [key: string]: unknown;
};

export type PaymentLinkPayload = {
  contactId: string;
  contactName?: string;
  email?: string;
  phone?: string;
  amount: number;
  currency?: string;
  applyTax?: boolean;
  taxCalculationMode?: string;
  title: string;
  description?: string;
  dueDate?: string;
  source?: string;
  lineItems?: Array<Record<string, unknown>>;
  installments?: {
    enabled?: boolean;
    maxInstallments?: number;
  };
};

export type PaymentLinkResponse = {
  payment?: TransactionItem;
  paymentUrl?: string;
  publicPaymentId?: string;
  cardSetupLink?: string;
  cardSetupPaymentId?: string;
  cardSetupAmount?: number;
  firstPaymentLink?: string;
  firstPaymentPaymentId?: string;
  scheduledPayments?: unknown[];
  [key: string]: unknown;
};

export type SavedCardPaymentPayload = {
  contactId: string;
  contactName?: string;
  email?: string;
  phone?: string;
  amount: number;
  currency?: string;
  applyTax?: boolean;
  taxCalculationMode?: string;
  title: string;
  description?: string;
  dueDate?: string;
  source?: string;
  lineItems?: Array<Record<string, unknown>>;
  paymentMethodId?: string;
  paymentSourceId?: string;
  rebillCardId?: string;
  clientRequestId?: string;
  installments?: {
    enabled?: boolean;
    maxInstallments?: number;
  };
};

export type PaymentTaxSettings = {
  enabled: boolean;
  taxName?: string;
  rateValue?: number;
  calculationMode?: 'exclusive' | 'inclusive';
};

export type PaymentSettingsResponse = {
  taxes?: PaymentTaxSettings;
};

export type SavedCardPaymentResponse = {
  payment?: TransactionItem;
  transaction?: TransactionItem;
  id?: string;
  provider?: string;
  status?: string;
  [key: string]: unknown;
};

export type HighLevelInvoiceResponse = {
  success?: boolean;
  invoice?: {
    id?: string;
    _id?: string;
    invoiceNumber?: string;
    paymentLink?: string;
    total?: number;
    amount?: number;
    currency?: string;
    [key: string]: unknown;
  };
  error?: string;
  message?: string;
};

export type HighLevelSendInvoiceResponse = {
  success?: boolean;
  message?: string;
  paymentLink?: string;
  error?: string;
};

export type HighLevelRecordPaymentPayload = {
  amount: number;
  currency: string;
  paymentDate?: string;
  paymentMethod?: string;
  reference?: string;
  notes?: string;
};

export type PaymentPlanPayload = {
  idempotencyKey?: string;
  contact: {
    id: string;
    name?: string;
    email?: string;
    phone?: string;
  };
  totalAmount: number;
  currency?: string;
  applyTax?: boolean;
  taxCalculationMode?: string;
  description?: string;
  title?: string;
  invoicePayload?: Record<string, unknown>;
  firstPayment: {
    enabled: boolean;
    type?: string;
    value?: number;
    amount: number;
    date?: string;
    frequency?: string;
    method?: string;
  };
  remainingAutomatic?: boolean;
  remainingFrequency?: string;
  remainingPayments: Array<{
    sequence: number;
    type?: string;
    value?: number;
    amount: number;
    percentage?: number | null;
    dueDate: string;
    frequency?: string;
  }>;
  channels?: Record<string, boolean>;
  paymentMethodId?: string;
  paymentSourceId?: string;
  rebillCardId?: string;
  cardSetupAmount?: number;
  source?: string;
};

export type SavedPaymentMethodItem = {
  id: string;
  contactId?: string;
  stripePaymentMethodId?: string;
  conektaPaymentSourceId?: string;
  rebillCardId?: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  mode?: 'test' | 'live' | string;
  isDefault?: boolean;
  label?: string;
  expiresLabel?: string;
  [key: string]: unknown;
};

export type PaymentSubscription = {
  id: string;
  contactId?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  name?: string;
  description?: string | null;
  status?: string;
  amount?: number;
  currency?: string;
  intervalType?: string;
  intervalCount?: number;
  startDate?: string | null;
  nextRunAt?: string | null;
  paymentMethod?: string | null;
  paymentProvider?: string | null;
  paymentMode?: string | null;
  stripeCheckoutUrl?: string | null;
  conektaCheckoutUrl?: string | null;
  mercadoPagoInitPoint?: string | null;
  mercadoPagoSandboxInitPoint?: string | null;
  rebillPaymentLinkUrl?: string | null;
  rebillCheckoutUrl?: string | null;
  subscriptionStartUrl?: string | null;
};

export type SubscriptionPayload = {
  id?: string;
  contactId?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  name: string;
  description?: string;
  status?: string;
  amount: number;
  currency?: string;
  applyTax?: boolean;
  taxCalculationMode?: string;
  intervalType: string;
  intervalCount: number;
  startDate?: string | null;
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

export type CalendarItem = {
  id?: string;
  _id?: string;
  name?: string;
  title?: string;
  color?: string;
  eventColor?: string;
  event_color?: string;
  isActive?: boolean;
  active?: boolean;
  source?: string;
  provider?: string;
  ghlCalendarId?: string | null;
  ghl_calendar_id?: string | null;
  calendarType?: string;
  calendar_type?: string;
  eventTitle?: string;
  event_title?: string;
  slotDuration?: number;
  slot_duration?: number;
  slotDurationUnit?: string;
  slot_duration_unit?: string;
  slotInterval?: number;
  slot_interval?: number;
  slotIntervalUnit?: string;
  slot_interval_unit?: string;
  teamMembers?: Array<{
    id?: string;
    userId?: string;
    user_id?: string;
    name?: string;
    email?: string;
  }>;
};

export type CalendarUser = {
  id?: string;
  _id?: string;
  userId?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
};

export type CalendarFreeSlot = {
  date?: string;
  startTime?: string;
  endTime?: string;
  start?: string;
  end?: string;
  reason?: string;
  title?: string;
  slots?: string[];
};

export type CalendarEventItem = {
  id?: string;
  _id?: string;
  ghlAppointmentId?: string | null;
  ghl_appointment_id?: string | null;
  title?: string;
  name?: string;
  contactName?: string;
  contact_name?: string;
  start?: string;
  startTime?: string;
  start_time?: string;
  end?: string;
  endTime?: string;
  end_time?: string;
  calendarId?: string;
  calendar_id?: string;
  contactId?: string;
  contact_id?: string;
  assignedUserId?: string;
  assigned_user_id?: string;
  timeZone?: string;
  timezone?: string;
  time_zone?: string;
  status?: string;
  appointmentStatus?: string;
  appointment_status?: string;
  syncStatus?: string;
  sync_status?: string;
  syncError?: string | null;
  sync_error?: string | null;
  location?: string;
  address?: string;
  notes?: string;
  description?: string;
};

export type ConfigValue = string | number | boolean | string[] | Record<string, unknown> | null;

export type PhoneThemePreference = 'system' | 'light' | 'dark' | 'auto';

export type WhatsAppApiTemplate = {
  id: string;
  name: string;
  language?: string;
  status?: string | null;
  reason?: string | null;
  status_update_event?: string | null;
  components?: Array<Record<string, unknown>>;
};

export type WhatsAppApiTemplatesResponse = {
  total?: number;
  approved?: number;
  blocked?: number;
  items?: WhatsAppApiTemplate[];
};

export type ContactCustomFieldDefinition = {
  definitionId?: string;
  key?: string;
  fieldKey?: string;
  label?: string;
  name?: string;
  dataType?: string;
  options?: Array<{ label: string; value: string }>;
  folderId?: string;
  folderName?: string;
  sourceType?: string;
  system?: boolean;
  systemManaged?: boolean;
  locked?: boolean;
  editable?: boolean;
  deletable?: boolean;
  archived?: boolean;
};

export type AIAgentConfigStatus = {
  configured?: boolean;
  credentialStatus?: 'missing' | 'ready' | 'reconnect_required' | string;
  needsReconnect?: boolean;
  businessContext?: string;
};

export type AIAgentBusinessContextAnswerResult = {
  text?: string;
  status?: AIAgentConfigStatus;
};

export type AIAgentTranscriptionResult = {
  text?: string;
  model?: string;
};

export type AIAgentRole = 'user' | 'assistant';

export type AIAgentSource = {
  title: string;
  url: string;
};

export type AIAgentAttachmentKind = 'image' | 'video' | 'pdf' | 'text' | 'file';

export type AIAgentAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AIAgentAttachmentKind;
  dataUrl?: string;
  text?: string;
  thumbnailDataUrl?: string;
};

export type AIAgentTraceSummary = {
  traceId?: string;
  status?: string;
  detailUrl?: string;
};

export type AIAgentClarificationOption = {
  label: string;
  value: string;
  description?: string;
};

export type AIAgentSelectedClarificationOption = {
  label: string;
  value: string;
  description?: string;
  assistantMessageId?: string;
};

export type AIAgentMessage = {
  id?: string;
  role: AIAgentRole;
  content: string;
  attachments?: AIAgentAttachment[];
  sources?: AIAgentSource[];
  clarificationOptions?: AIAgentClarificationOption[];
  selectedClarificationOption?: AIAgentSelectedClarificationOption;
  trace?: AIAgentTraceSummary | null;
  createdAt?: string;
};

export type AIAgentViewContext = {
  path: string;
  title: string;
  routeLabel: string;
  visibleText: string;
};

export type AIAgentChatResult = {
  reply?: string;
  model?: string;
  category?: string;
  sources?: AIAgentSource[];
  clarificationOptions?: AIAgentClarificationOption[];
  trace?: AIAgentTraceSummary | null;
};

export type WebPushPublicConfig = {
  configured: boolean;
  publicKey: string;
  nativeConfigured?: boolean;
  iosConfigured?: boolean;
  androidConfigured?: boolean;
};

export type SaveMobilePushDevicePayload = {
  token: string;
  platform: 'android';
  clientType?: 'expo' | 'native';
  appPackage?: string;
  calendarIds?: string[];
  appVersion?: string;
  appBuild?: string;
  deviceModel?: string;
  osVersion?: string;
};
