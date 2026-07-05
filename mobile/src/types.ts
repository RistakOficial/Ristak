export type RistakUser = {
  id: string;
  name?: string;
  email?: string;
  role?: string;
};

export type LoginResponse = {
  success?: boolean;
  token?: string;
  user?: RistakUser;
  message?: string;
};

export type VerifyResponse = {
  success?: boolean;
  user?: RistakUser;
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
};

export type ProductItem = {
  id?: string;
  _id?: string;
  localId?: string;
  name?: string;
  description?: string;
  currency?: string;
  prices?: ProductPrice[];
};

export type TransactionItem = {
  id?: string;
  _id?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  concept?: string;
  amount?: number;
  total?: number;
  currency?: string;
  status?: string;
  paymentMethod?: string;
  createdAt?: string;
  paymentDate?: string;
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
