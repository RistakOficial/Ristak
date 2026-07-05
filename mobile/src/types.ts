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

export type ChatMessage = {
  id: string;
  contactId: string;
  date: string;
  direction: 'inbound' | 'outbound';
  text: string;
  channel: string;
  status?: string;
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
  paymentProvider?: string;
  paymentMode?: string;
  paymentUrl?: string;
  publicPaymentId?: string;
  date?: string;
  createdAt?: string;
  paymentDate?: string;
  dueDate?: string;
  metadata?: Record<string, unknown>;
};

export type PaymentGatewayProvider = 'stripe' | 'conekta' | 'mercadopago' | 'clip' | 'rebill';

export type PaymentGatewayStatus = {
  configured?: boolean;
  connected?: boolean;
  mode?: 'test' | 'live' | string;
  accountLabel?: string | null;
};

export type IntegrationsStatus = {
  highlevel?: PaymentGatewayStatus;
  stripe?: PaymentGatewayStatus;
  conekta?: PaymentGatewayStatus;
  mercadopago?: PaymentGatewayStatus;
  clip?: PaymentGatewayStatus;
  rebill?: PaymentGatewayStatus;
  [key: string]: unknown;
};

export type CreateProductPayload = {
  name: string;
  description?: string;
  currency?: string;
  prices: Array<{
    id?: string;
    localId?: string;
    name: string;
    amount: number;
    currency?: string;
    type?: string;
  }>;
};

export type CreateTransactionPayload = {
  date?: string;
  contactId?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  amount: number;
  currency?: string;
  method?: string;
  paymentMethod?: string;
  status?: string;
  reference?: string;
  title?: string;
  description?: string;
  dueDate?: string;
  metadata?: Record<string, unknown>;
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
  contact: {
    id: string;
    name?: string;
    email?: string;
    phone?: string;
  };
  totalAmount: number;
  currency?: string;
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
  cardSetupAmount?: number;
  source?: string;
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
  contactId?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  name: string;
  description?: string;
  status?: string;
  amount: number;
  currency?: string;
  intervalType: string;
  intervalCount: number;
  startDate?: string | null;
  nextRunAt?: string | null;
  paymentMethod?: string;
  paymentProvider?: string;
  paymentMode?: string;
  source?: string;
};

export type CalendarItem = {
  id?: string;
  _id?: string;
  name?: string;
  title?: string;
  color?: string;
};

export type CalendarEventItem = {
  id?: string;
  _id?: string;
  title?: string;
  contactName?: string;
  start?: string;
  startTime?: string;
  end?: string;
  calendarId?: string;
  status?: string;
};

export type ConfigValue = string | number | boolean | string[] | Record<string, unknown> | null;

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
