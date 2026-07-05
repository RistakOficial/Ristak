export type RistakUser = {
  id: string;
  name?: string;
  email?: string;
  role?: string;
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

export type RuntimeTenant = {
  clientId: string;
  installationId: string;
  name: string;
  email: string;
  appUrl: string;
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
  unreadCount?: number;
  messageCount?: number;
  tags?: string[];
};

export type ContactTag = {
  id: string;
  name: string;
  isSystem?: boolean;
  usageCount?: number;
};

export type ConversationAgentState = {
  id?: string;
  contactId?: string;
  agentId?: string | null;
  agentName?: string | null;
  status?: string | null;
  signal?: string | null;
  updatedAt?: string | null;
  activatedAt?: string | null;
};

export type JourneyEvent = {
  type: string;
  date: string;
  data?: Record<string, unknown>;
};

export type ChatAttachment = {
  type: 'image' | 'video' | 'audio' | 'document' | 'file';
  url?: string;
  dataUrl?: string;
  name?: string;
  mimeType?: string;
  isGif?: boolean;
  durationMs?: number;
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
  pending?: boolean;
  failed?: boolean;
};

export type SendTextResponse = {
  status?: string;
  transport?: string;
  message?: unknown;
  fallbackReason?: string;
  routingReason?: string;
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

export type WhatsAppApiPhoneNumber = {
  id?: string;
  phone_number?: string | null;
  display_phone_number?: string | null;
  verified_name?: string | null;
  label?: string | null;
  api_send_enabled?: boolean;
  qr_send_enabled?: boolean;
  qr_status?: string | null;
  qr_connected_phone?: string | null;
};

export type WhatsAppApiStatus = {
  phoneNumbers?: WhatsAppApiPhoneNumber[];
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
};

export type CalendarEventItem = {
  id?: string;
  _id?: string;
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
  folderName?: string;
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

export type WebPushPublicConfig = {
  configured: boolean;
  publicKey: string;
  nativeConfigured?: boolean;
  androidConfigured?: boolean;
  iosConfigured?: boolean;
};

export type SaveMobilePushDevicePayload = {
  token: string;
  platform: 'ios' | 'android';
  calendarIds?: string[];
  appVersion?: string;
  appBuild?: string;
  deviceModel?: string;
  osVersion?: string;
};
