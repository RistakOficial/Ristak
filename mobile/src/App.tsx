import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Appearance,
  Easing,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  Vibration,
  useWindowDimensions,
} from 'react-native';
import type { GestureResponderEvent, ImageSourcePropType, ImageStyle, LayoutChangeEvent } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import {
  Archive,
  Activity,
  Banknote,
  BarChart3,
  Bell,
  BellRing,
  BellOff,
  Bot,
  CalendarDays,
  Camera,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  CircleAlert,
  Clock,
  Copy,
  CreditCard,
  DollarSign,
  Edit3,
  FileText,
  FilePlus,
  Forward,
  Image as ImageIcon,
  Info,
  ListChecks,
  LogOut,
  Mail,
  MapPin,
  MessageCircle,
  Mic,
  MoreHorizontal,
  Moon,
  Package,
  Pause,
  Phone,
  Pencil,
  Play,
  Reply,
  Smile,
  Plus,
  RefreshCw,
  Repeat2,
  Save,
  Search,
  Send,
  Settings,
  Smartphone,
  Sparkles,
  Square,
  Star,
  Sun,
  Tag,
  Target,
  Trash2,
  TrendingDown,
  TrendingUp,
  User,
  Users,
  Video,
  WalletCards,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import Svg, { Circle, Line, Path, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import {
  clearAuthToken,
  clearRuntimeState,
  readApiBaseUrl,
  readAuthToken,
  readJsonValue,
  writeApiBaseUrl,
  writeAuthToken,
  writeJsonValue,
} from './storage';
import { RistakApiClient, getUserDisplayName, loginWithResolvedTenant } from './api';
import {
  configureNativeNotificationListeners,
  getNativePushPermissionStatus,
  subscribeToNativePushNotifications,
  type NativePushPermissionStatus,
} from './notifications';
import {
  buildMessagesFromJourney,
  addBusinessDateOnlyDays,
  addBusinessDateOnlyMonths,
  buildBusinessMonthCells,
  dateOnlyFromCalendarDate,
  dateOnlyToCalendarDate,
  addMinutesToBusinessDateTime,
  formatBusinessDayHeader,
  formatBusinessMonthTitle,
  formatBusinessShortMonthTitle,
  formatBusinessYear,
  formatCalendarEventTime,
  formatCalendarEventTimeRange,
  formatChatListDate,
  formatCompactBusinessDate,
  formatCompactCurrency,
  formatCompactNumber,
  formatConversationDayLabel,
  formatCurrency,
  formatMessageTime,
  formatNumber,
  formatRoas,
  formatShortDate,
  getConversationDayKey,
  getContactAvatar,
  getContactName,
  getTodayRange,
  getBusinessDateOnly,
  getBusinessDateTimeParts,
  getBusinessMonthRange,
  isoToBusinessDateTimeFields,
  localBusinessDateTimeToUTCISOString,
  resolveBusinessTimezone,
  todayDateOnlyInBusinessTimezone,
} from './format';
import type {
  BankClabeAccount,
  CalendarFreeSlot,
  CalendarEventItem,
  CalendarItem,
  CalendarUser,
  ChatContact,
  ChatMessage,
  ChatAttachment,
  ConfigValue,
  ContactCustomFieldDefinition,
  ContactTag,
  CustomLabels,
  ConversationAgentState,
  AIAgentConfigStatus,
  MessageTemplate,
  NativeMessageChannel,
  DashboardFunnelRow,
  DashboardFunnelScope,
  DashboardMetrics,
  OriginDistributionData,
  PhoneSection,
  PhoneThemePreference,
  ProductItem,
  ProductPrice,
  RistakUser,
  ScheduledChatMessage,
  SourceDatum,
  TransactionItem,
  WhatsAppTemplate,
  WhatsAppApiTemplate,
  WhatsAppApiPhoneNumber,
  WhatsAppApiStatus,
  WhatsAppNumberOriginDatum,
} from './types';

const COLORS = {
  bg: '#06123a',
  panel: '#0a1f5c',
  panelSoft: '#102a78',
  border: 'rgba(199,226,255,0.14)',
  text: '#f3f8ff',
  muted: '#aac0e7',
  accent: '#00a8f8',
  accentSoft: 'rgba(0,168,248,0.18)',
  primary: '#46b9ff',
  danger: '#ff5d6c',
  dangerSoft: '#6f2030',
  meta: '#bddcff',
  white: '#ffffff',
};

const RISTAK_NIGHT_MODE_LOGO: ImageSourcePropType = require('../assets/ristak-night-mode-sin-fondo.webp');

type SessionState = {
  baseUrl: string;
  token: string;
  user: RistakUser | null;
};

type Screen = 'boot' | 'login' | 'shell';
type ChatFilterId = string;
type ChatSheetMode = 'chatMore' | 'newChat' | 'cameraShare' | 'tag' | 'schedule' | null;
type ConversationSheetMode = 'attachments' | 'messageActions' | 'chatMore' | 'tag' | 'schedule' | 'channel' | 'templates' | 'clabe' | 'payment' | 'appointment' | null;
type CalendarViewMode = 'day' | 'week' | 'month' | 'year' | 'years';
type CalendarSheetMode = 'calendar' | 'contactPicker' | 'event' | 'appointmentForm' | null;
type AppointmentFormMode = 'create' | 'edit';
type ComposerChannelOption = {
  value: NativeMessageChannel;
  label: string;
  description: string;
  kind: ChannelBadgeKind;
  disabledReason?: string;
};
type AppointmentScheduleMode = 'default' | 'custom';
type AppointmentAdvancedPicker = 'date' | 'time' | 'duration' | null;
type PendingAppointmentDefaults = {
  dateOnly: string;
  startTime: string;
  durationMinutes: number;
  title: string;
};
type AppointmentGuest = {
  id: string;
  name: string;
  contact: string;
  contactId?: string;
};
type TimelineSelectionState = {
  dateOnly: string;
  startMinutes: number;
  endMinutes: number;
};
type TimelinePendingTouch = {
  dateOnly: string;
  startMinutes: number;
  x: number;
  y: number;
  timerId: ReturnType<typeof setTimeout>;
};
type AgentAction = 'activate' | 'pause' | 'take_over' | 'skip';
type ChannelBadgeKind = 'whatsapp' | 'instagram' | 'messenger' | 'facebook_comment' | 'instagram_comment' | 'email' | 'sms' | 'unknown';
type PaymentView = 'select' | 'single' | 'partial' | 'subscription' | 'products';
type RecentPaymentsPeriod = 'today' | '7d' | '30d' | '90d';
type ProductFormMode = 'create' | 'edit' | null;
type SettingsPanel = 'numbers' | 'templates' | 'agent' | 'chats' | 'custom-fields' | 'appearance' | 'notifications' | null;
type BusinessVoiceState = 'idle' | 'recording' | 'processing';
type ConversationDraftAttachment = {
  id: string;
  uri: string;
  dataUrl: string;
  kind: 'image' | 'video' | 'audio' | 'document';
  name: string;
  mimeType: string;
  size?: number;
  durationMs?: number;
};
type ConversationListItem =
  | { type: 'day'; id: string; label: string }
  | { type: 'message'; id: string; message: ChatMessage };
type ChatFilterPreset = {
  id: ChatFilterId;
  label: string;
  description: string;
  section: string;
  locked?: boolean;
  separatorBefore?: boolean;
};
type AnalyticsPeriod = '30d' | '60d' | '180d' | 'year' | 'custom';
type AnalyticsChartView = 'revenue-spend' | 'visitors-leads' | 'leads-appointments' | 'appointments-attendances' | 'attendances-sales';
type AnalyticsOriginTab = 'traffic' | 'leads' | 'appointments' | 'conversions';
type AnalyticsChartPoint = {
  label: string;
  value: number;
  value2: number;
};
type AnalyticsChartMeta = {
  label1: string;
  label2: string;
  color1: string;
  color2: string;
  currency: boolean;
};
type AnalyticsMetricCardConfig = {
  key: keyof DashboardMetrics;
  title: string;
  Icon: LucideIcon;
  tone: 'green' | 'black' | 'blue' | 'gold' | 'red';
  formatter: (value: number) => string;
};
type AnalyticsPhoneNumberOriginRow = {
  key: string;
  name: string;
  phone: string;
  value: number;
  statusLabel: string;
};
type AppointmentDraft = {
  eventId?: string;
  title: string;
  appointmentStatus: string;
  dateOnly: string;
  startTime: string;
  durationMinutes: number;
  address: string;
  notes: string;
  contactId: string;
  contact?: ChatContact | null;
  calendarId: string;
  assignedUserId?: string;
  guests: AppointmentGuest[];
};

const PHONE_NAV_ITEMS: Array<{ key: PhoneSection; label: string; Icon: LucideIcon }> = [
  { key: 'settings', label: 'Ajustes', Icon: Settings },
  { key: 'chat', label: 'Chats', Icon: MessageCircle },
  { key: 'calendar', label: 'Citas', Icon: CalendarDays },
  { key: 'payments', label: 'Pagos', Icon: CircleDollarSign },
  { key: 'analytics', label: 'Analíticas', Icon: BarChart3 },
];

const DEFAULT_CHAT_FILTER_IDS = ['all', 'unread', 'appointments', 'customers', 'leads', 'comments'];
const CHAT_FILTERS_MORE_VALUE = '__filters_more__';
const CHAT_FILTERS_STORAGE_KEY = 'ristak.native.chat.visibleFilterIds.v1';
const ARCHIVED_CHAT_IDS_STORAGE_KEY = 'ristak.native.chat.archivedIds.v1';
const MUTED_CHAT_IDS_STORAGE_KEY = 'ristak.native.chat.mutedIds.v1';
const CHAT_SWIPE_ACTION_WIDTH = 184;
const CHAT_SWIPE_MORE_WIDTH = 84;
const CHAT_SWIPE_ARCHIVE_WIDTH = CHAT_SWIPE_ACTION_WIDTH - CHAT_SWIPE_MORE_WIDTH;
const CHAT_SWIPE_GESTURE_START_DISTANCE = 3;
const CHAT_SWIPE_OPEN_TRIGGER_DISTANCE = 2;
const CHAT_SWIPE_CLOSE_TRIGGER_DISTANCE = 2;
const CHAT_SWIPE_OPEN_DURATION_MS = 250;
const CHAT_SWIPE_CLOSE_DURATION_MS = 180;
const CHAT_ROW_MIN_HEIGHT = 86;
const CHAT_AVATAR_SIZE = 58;
const CHAT_AVATAR_INNER_SIZE = 50;
const CHAT_CHANNEL_BADGE_SIZE = 22;
const CHAT_SHEET_OPEN_DURATION_MS = 260;
const CHAT_SHEET_CLOSE_DURATION_MS = 280;
const CHAT_SHEET_HIDDEN_TRANSLATE_Y = 860;
const MESSAGE_REACTION_EMOJIS = ['❤️', '👍', '😂', '😮', '🙏'];
const CONVERSATION_ATTACHMENT_LIMIT = 4;
const MEDIA_ATTACHMENT_MAX_BYTES = 16 * 1024 * 1024;
const DOCUMENT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const VIDEO_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const CALENDAR_SELECTED_ID_STORAGE_KEY = 'ristak.native.calendar.selectedCalendarId.v1';
const CALENDAR_EVENTS_CACHE_STORAGE_KEY = 'ristak.native.calendar.eventsCache.v1';
const CALENDAR_WEEKDAYS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
const CALENDAR_WEEKDAY_ROW_HEIGHT = 28;
const CALENDAR_MONTH_GRID_TOP_PADDING = 2;
const CALENDAR_MONTH_DAY_CELL_HEIGHT = 39;
const CALENDAR_VIEW_OPTIONS: Array<{ view: Exclude<CalendarViewMode, 'years'>; label: string }> = [
  { view: 'day', label: 'Día' },
  { view: 'week', label: 'Semana' },
  { view: 'month', label: 'Mes' },
  { view: 'year', label: 'Año' },
];
const YEAR_GRID_SIZE = 12;
const MONTH_SWIPE_MIN_PX = 56;
const MONTH_SWIPE_COMMIT_RATIO = 0.18;
const MONTH_SWIPE_MAX_OFFSET_RATIO = 0.92;
const TIMELINE_HOUR_HEIGHT = 54;
const TIMELINE_TOTAL_MINUTES = 24 * 60;
const TIMELINE_GRID_HEIGHT = TIMELINE_HOUR_HEIGHT * 24;
const TIMELINE_LONG_PRESS_DELAY_MS = 380;
const TIMELINE_PENDING_MOVE_CANCEL_PX = 12;
const TIMELINE_PENDING_VERTICAL_CANCEL_PX = 30;
const TIMELINE_TAP_MOVE_TOLERANCE_PX = 10;
const TIMELINE_TOUCH_ANCHOR_OFFSET_PX = 18;
const APPOINTMENT_GUESTS_NOTE_HEADER = 'Invitados:';
const APPOINTMENT_DATE_MONTH_OPTIONS = [
  { value: 1, label: 'Enero' },
  { value: 2, label: 'Febrero' },
  { value: 3, label: 'Marzo' },
  { value: 4, label: 'Abril' },
  { value: 5, label: 'Mayo' },
  { value: 6, label: 'Junio' },
  { value: 7, label: 'Julio' },
  { value: 8, label: 'Agosto' },
  { value: 9, label: 'Septiembre' },
  { value: 10, label: 'Octubre' },
  { value: 11, label: 'Noviembre' },
  { value: 12, label: 'Diciembre' },
];
const APPOINTMENT_TIME_HOUR_OPTIONS = Array.from({ length: 12 }, (_, index) => index + 1);
const APPOINTMENT_TIME_MINUTE_OPTIONS = Array.from({ length: 60 }, (_, index) => index);
const APPOINTMENT_DURATION_HOUR_OPTIONS = Array.from({ length: 24 }, (_, index) => index + 1);
const APPOINTMENT_DURATION_MINUTE_OPTIONS = [0, 15, 30, 45];
const FREE_SLOT_DATE_CHIP_SPAN = 140;
const AI_AGENT_CHAT_ID = 'ristak-ai-agent-mobile-chat';
const AI_AGENT_CHAT_DISPLAY_NAME = 'Asistente Personal AI';
const AI_AGENT_CHAT_SUBTITLE = 'Te ayuda dentro de Ristak';
const AI_AGENT_CHAT_SEARCH_TEXT = 'asistente personal ai ristak ai agente inteligencia artificial ia';
const ACCOUNT_CURRENCY_CONFIG_KEY = 'account_currency';
const DEFAULT_ACCOUNT_CURRENCY = 'MXN';
const DEFAULT_BUSINESS_TIMEZONE = 'America/Mexico_City';
const SUCCESS_PAYMENT_STATUSES = new Set(['paid', 'partial', 'succeeded', 'completed', 'complete', 'fulfilled', 'success']);
const RECENT_PAYMENT_PERIODS: Array<{ id: RecentPaymentsPeriod; label: string; days: number }> = [
  { id: 'today', label: 'Hoy', days: 0 },
  { id: '7d', label: '7 días', days: 7 },
  { id: '30d', label: '30 días', days: 30 },
  { id: '90d', label: '90 días', days: 90 },
];
const SETTINGS_APP_CONFIG_KEYS = [
  'mobile_chat_ai_agent_enabled',
  'mobile_chat_ai_reply_suggestions_enabled',
  'mobile_chat_show_archived',
  'mobile_chat_sort_mode',
  'mobile_chat_show_last_preview',
  'mobile_chat_show_unread_indicators',
  'mobile_chat_theme_preference',
  'mobile_chat_selected_whatsapp_phone_id',
];
const SETTINGS_USER_CONFIG_KEYS = [
  'chat_push_notifications_enabled',
  'calendar_push_notifications_enabled',
  'appointment_confirmation_push_notifications_enabled',
  'payment_push_notifications_enabled',
  'push_notification_sound_enabled',
  'push_notification_vibration_enabled',
  'calendar_push_notification_calendar_ids',
];
const TEMPLATE_BLOCKED_STATUSES = new Set(['REJECTED', 'PAUSED', 'DISABLED']);
const PHONE_CHAT_THEME_OPTIONS: Array<{
  id: PhoneThemePreference;
  label: string;
  description: string;
  Icon: LucideIcon;
}> = [
  { id: 'system', label: 'Sistema', description: 'Usa el modo que tiene tu celular.', Icon: Smartphone },
  { id: 'light', label: 'Claro', description: 'Mantiene la app con fondo claro.', Icon: Sun },
  { id: 'dark', label: 'Noche', description: 'Mantiene la app oscura todo el tiempo.', Icon: Moon },
  { id: 'auto', label: 'Horario', description: 'Claro de día y noche después de las 7 PM.', Icon: Clock },
];
const DEFAULT_CUSTOM_LABELS: CustomLabels = {
  customer: 'Cliente',
  customers: 'Clientes',
  lead: 'Interesado',
  leads: 'Interesados',
};
const ANALYTICS_PERIOD_OPTIONS: Array<{ id: AnalyticsPeriod; label: string; menuLabel: string; days?: number }> = [
  { id: '30d', label: '30 días', menuLabel: 'Últimos 30 días', days: 30 },
  { id: '60d', label: '60 días', menuLabel: 'Últimos 60 días', days: 60 },
  { id: '180d', label: '180 días', menuLabel: 'Últimos 180 días', days: 180 },
  { id: 'year', label: 'Año', menuLabel: 'Último año', days: 365 },
  { id: 'custom', label: 'Personalizado', menuLabel: 'Fecha personalizada' },
];
const ANALYTICS_SCOPE_OPTIONS: Array<{ id: DashboardFunnelScope; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'attribution', label: 'Al registro' },
  { id: 'campaigns', label: 'Anuncios' },
];
const EMPTY_ORIGIN_DATA: OriginDistributionData = {
  traffic: { sources: [], platforms: [], devices: [], placements: [], browsers: [], os: [] },
  leads: [],
  appointments: [],
  conversions: [],
  whatsappNumbers: [],
};
const CHAT_FILTER_LIBRARY: ChatFilterPreset[] = [
  { id: 'all', label: 'Todos', description: 'Muestra todas las conversaciones activas.', section: 'Rápidos', locked: true },
  { id: 'unread', label: 'No leídos', description: 'Sólo conversaciones con mensajes pendientes.', section: 'Rápidos' },
  { id: 'appointments', label: 'Agendados', description: 'Contactos con cita guardada.', section: 'Rápidos' },
  { id: 'customers', label: 'Clientes', description: 'Contactos marcados como clientes o con compras.', section: 'Rápidos' },
  { id: 'leads', label: 'Leads', description: 'Contactos interesados que todavía no son clientes ni citados.', section: 'Rápidos' },
  { id: 'comments', label: 'Comentarios', description: 'Abre la bandeja de comentarios de Facebook e Instagram.', section: 'Rápidos', separatorBefore: true },
  { id: 'advanced:channel:whatsapp', label: 'Canal: WhatsApp', description: 'Filtra chats con actividad de WhatsApp.', section: 'Canal' },
  { id: 'advanced:channel:messenger', label: 'Canal: Messenger', description: 'Filtra chats de Messenger.', section: 'Canal' },
  { id: 'advanced:channel:instagram', label: 'Canal: Instagram', description: 'Filtra chats de Instagram.', section: 'Canal' },
  { id: 'advanced:channel:email', label: 'Canal: Correo', description: 'Filtra conversaciones por correo.', section: 'Canal' },
  { id: 'advanced:channel:sms', label: 'Canal: SMS', description: 'Filtra conversaciones SMS.', section: 'Canal' },
  { id: 'advanced:activity:payments', label: 'Actividad: Pagos', description: 'Contactos con compras o valor registrado.', section: 'Actividad' },
  { id: 'advanced:activity:appointments', label: 'Actividad: Citas', description: 'Contactos con citas.', section: 'Actividad' },
  { id: 'advanced:activity:with_source', label: 'Actividad: Con origen', description: 'Contactos con fuente rastreada.', section: 'Actividad' },
  { id: 'advanced:activity:no_phone', label: 'Actividad: Sin teléfono', description: 'Contactos sin teléfono guardado.', section: 'Actividad' },
];

const CHANNEL_BADGE_COLORS: Record<ChannelBadgeKind, string> = {
  whatsapp: '#22c55e',
  instagram: '#d62976',
  messenger: '#1877f2',
  facebook_comment: '#1877f2',
  instagram_comment: '#d62976',
  email: '#8b5cf6',
  sms: '#0ea5e9',
  unknown: '#27c7d8',
};
const PHONE_DOCK_HORIZONTAL_PADDING = 8;
const PHONE_DOCK_SWIPE_START_DISTANCE = 6;
const PHONE_DOCK_CLICK_SUPPRESS_MS = 140;
const PHONE_DOCK_RESERVED_SPACE = 132;

export default function RistakNativeApp() {
  const [screen, setScreen] = useState<Screen>('boot');
  const [session, setSession] = useState<SessionState>({ baseUrl: '', token: '', user: null });
  const api = useMemo(() => new RistakApiClient(session.baseUrl, session.token), [session.baseUrl, session.token]);

  const bootstrap = useCallback(async () => {
    const [storedBaseUrl, storedToken] = await Promise.all([
      readApiBaseUrl(),
      readAuthToken(),
    ]);

    if (!storedBaseUrl) {
      setSession({ baseUrl: '', token: '', user: null });
      setScreen('login');
      return;
    }

    if (!storedToken) {
      setSession({ baseUrl: storedBaseUrl, token: '', user: null });
      setScreen('login');
      return;
    }

    try {
      const verifier = new RistakApiClient(storedBaseUrl);
      const verified = await verifier.verify(storedToken);
      if (verified.success && verified.user) {
        setSession({ baseUrl: storedBaseUrl, token: storedToken, user: verified.user });
        setScreen('shell');
        return;
      }
    } catch {
      await clearAuthToken();
    }

    setSession({ baseUrl: storedBaseUrl, token: '', user: null });
    setScreen('login');
  }, []);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(COLORS.bg).catch(() => undefined);
    void bootstrap();
  }, [bootstrap]);

  const handleLogin = async (email: string, password: string) => {
    const response = await loginWithResolvedTenant(email, password);
    await writeApiBaseUrl(response.baseUrl);
    await writeAuthToken(response.token);
    setSession({ baseUrl: response.baseUrl, token: response.token, user: response.user });
    setScreen('shell');
  };

  const logout = async () => {
    await clearAuthToken();
    setSession((current) => ({ ...current, token: '', user: null }));
    setScreen('login');
  };

  const resetServer = async () => {
    await clearRuntimeState();
    setSession({ baseUrl: '', token: '', user: null });
    setScreen('login');
  };

  if (screen === 'boot') {
    return <BootScreen />;
  }

  if (screen === 'login') {
    return (
      <LoginScreen
        onLogin={handleLogin}
      />
    );
  }

  return (
    <PhoneShell
      api={api}
      user={session.user}
      baseUrl={session.baseUrl}
      onLogout={logout}
      onChangeServer={resetServer}
    />
  );
}

function PhoneShell({
  api,
  user,
  baseUrl,
  onLogout,
  onChangeServer,
}: {
  api: RistakApiClient;
  user: RistakUser | null;
  baseUrl: string;
  onLogout: () => Promise<void>;
  onChangeServer: () => Promise<void>;
}) {
  const [activeSection, setActiveSection] = useState<PhoneSection>('chat');
  const [chatUnreadTotal, setChatUnreadTotal] = useState(0);
  const [notificationContactId, setNotificationContactId] = useState('');
  const autoRegisteredPushKeyRef = useRef('');
  const clearNotificationContactId = useCallback(() => setNotificationContactId(''), []);
  const dock = (
    <PhoneDock
      active={activeSection}
      badges={{ chat: chatUnreadTotal }}
      onSelect={setActiveSection}
    />
  );

  useEffect(() => configureNativeNotificationListeners((intent) => {
    if (!intent.contactId) return;
    setNotificationContactId(intent.contactId);
    setActiveSection('chat');
  }), []);

  useEffect(() => {
    const userId = String(user?.id || user?.email || '').trim();
    if (!baseUrl || !userId) return undefined;

    const registrationKey = `${baseUrl}:${userId}`;
    if (autoRegisteredPushKeyRef.current === registrationKey) return undefined;
    autoRegisteredPushKeyRef.current = registrationKey;

    let cancelled = false;
    const registerIfAllowedOrPending = async () => {
      const permission = await getNativePushPermissionStatus();
      if (cancelled || (permission !== 'granted' && permission !== 'prompt')) return;
      await subscribeToNativePushNotifications(api).catch(() => undefined);
    };

    void registerIfAllowedOrPending();

    return () => {
      cancelled = true;
    };
  }, [api, baseUrl, user?.email, user?.id]);

  if (activeSection === 'chat') {
    return (
      <ChatScreen
        api={api}
        footer={dock}
        notificationContactId={notificationContactId}
        onNotificationHandled={clearNotificationContactId}
        onUnreadTotalChange={setChatUnreadTotal}
        onNavigate={setActiveSection}
      />
    );
  }

  if (activeSection === 'calendar') {
    return (
      <CalendarSection
        api={api}
        footer={dock}
      />
    );
  }

  if (activeSection === 'payments') {
    return (
      <AppFrame>
        <PaymentsSection api={api} />
        {dock}
      </AppFrame>
    );
  }

  if (activeSection === 'analytics') {
    return (
      <AppFrame>
        <AnalyticsSection api={api} />
        {dock}
      </AppFrame>
    );
  }

  if (activeSection === 'settings') {
    return (
      <SettingsScreen
        api={api}
        user={user}
        baseUrl={baseUrl}
        footer={dock}
        onLogout={onLogout}
        onChangeServer={onChangeServer}
      />
    );
  }

  return (
    <AppFrame>
      <SectionHeader
        section={activeSection}
        user={user}
        baseUrl={baseUrl}
        onLogout={onLogout}
        onChangeServer={onChangeServer}
      />
      {dock}
    </AppFrame>
  );
}

function PhoneDock({
  active,
  badges = {},
  onSelect,
}: {
  active: PhoneSection;
  badges?: Partial<Record<PhoneSection, number>>;
  onSelect: (section: PhoneSection) => void;
}) {
  const activeIndex = Math.max(0, PHONE_NAV_ITEMS.findIndex((item) => item.key === active));
  const [dockWidth, setDockWidth] = useState(0);
  const [visualIndex, setVisualIndex] = useState(activeIndex);
  const [swiping, setSwiping] = useState(false);
  const dockRef = useRef<View>(null);
  const indicatorX = useRef(new Animated.Value(0)).current;
  const dragStartXRef = useRef(0);
  const dockPageXRef = useRef(0);
  const visualIndexRef = useRef(activeIndex);
  const swipingRef = useRef(false);
  const suppressPressRef = useRef(false);
  const suppressPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabWidth = dockWidth > 0
    ? (dockWidth - (PHONE_DOCK_HORIZONTAL_PADDING * 2)) / PHONE_NAV_ITEMS.length
    : 0;

  const clearSuppressPressTimer = useCallback(() => {
    if (suppressPressTimerRef.current) {
      clearTimeout(suppressPressTimerRef.current);
      suppressPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearSuppressPressTimer, [clearSuppressPressTimer]);

  const animateIndicatorTo = useCallback((index: number) => {
    if (!tabWidth) return;
    Animated.timing(indicatorX, {
      toValue: index * tabWidth,
      duration: 360,
      easing: Easing.bezier(0.2, 0.88, 0.2, 1),
      useNativeDriver: true,
    }).start();
  }, [indicatorX, tabWidth]);

  useEffect(() => {
    visualIndexRef.current = activeIndex;
    setVisualIndex(activeIndex);
    if (swipingRef.current) return;
    animateIndicatorTo(activeIndex);
  }, [activeIndex, animateIndicatorTo]);

  useEffect(() => {
    if (!tabWidth || swipingRef.current) return;
    indicatorX.setValue(activeIndex * tabWidth);
  }, [activeIndex, indicatorX, tabWidth]);

  const resolveDockIndex = useCallback((locationX: number) => {
    if (!tabWidth || !dockWidth) return activeIndex;
    const minCenter = PHONE_DOCK_HORIZONTAL_PADDING + (tabWidth / 2);
    const maxCenter = dockWidth - PHONE_DOCK_HORIZONTAL_PADDING - (tabWidth / 2);
    const clampedCenter = Math.max(minCenter, Math.min(locationX, maxCenter));
    return Math.max(0, Math.min(
      PHONE_NAV_ITEMS.length - 1,
      Math.round((clampedCenter - minCenter) / tabWidth),
    ));
  }, [activeIndex, dockWidth, tabWidth]);

  const updateDragIndicator = useCallback((locationX: number) => {
    if (!tabWidth || !dockWidth) return;
    const minCenter = PHONE_DOCK_HORIZONTAL_PADDING + (tabWidth / 2);
    const maxCenter = dockWidth - PHONE_DOCK_HORIZONTAL_PADDING - (tabWidth / 2);
    const clampedCenter = Math.max(minCenter, Math.min(locationX, maxCenter));
    const nextIndex = resolveDockIndex(locationX);
    indicatorX.setValue(clampedCenter - minCenter);
    if (nextIndex !== visualIndexRef.current) {
      Vibration.vibrate(8);
      visualIndexRef.current = nextIndex;
      setVisualIndex(nextIndex);
    }
  }, [dockWidth, indicatorX, resolveDockIndex, tabWidth]);

  const suppressNextPress = useCallback(() => {
    suppressPressRef.current = true;
    clearSuppressPressTimer();
    suppressPressTimerRef.current = setTimeout(() => {
      suppressPressRef.current = false;
      suppressPressTimerRef.current = null;
    }, PHONE_DOCK_CLICK_SUPPRESS_MS);
  }, [clearSuppressPressTimer]);

  const finishSwipe = useCallback((nextIndex: number) => {
    swipingRef.current = false;
    setSwiping(false);
    suppressNextPress();
    const nextItem = PHONE_NAV_ITEMS[nextIndex];
    if (nextItem && nextItem.key !== active) {
      onSelect(nextItem.key);
      return;
    }
    visualIndexRef.current = activeIndex;
    setVisualIndex(activeIndex);
    animateIndicatorTo(activeIndex);
  }, [active, activeIndex, animateIndicatorTo, onSelect, suppressNextPress]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => (
      Math.abs(gestureState.dx) >= PHONE_DOCK_SWIPE_START_DISTANCE
      && Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.25
    ),
    onPanResponderGrant: (event) => {
      indicatorX.stopAnimation();
      swipingRef.current = true;
      setSwiping(true);
      const locationX = Number(event.nativeEvent.locationX) || 0;
      const pageX = Number(event.nativeEvent.pageX);
      dockPageXRef.current = Number.isFinite(pageX) ? pageX - locationX : dockPageXRef.current;
      dockRef.current?.measureInWindow((x) => {
        dockPageXRef.current = x;
      });
      dragStartXRef.current = locationX;
      visualIndexRef.current = visualIndex;
      updateDragIndicator(dragStartXRef.current);
    },
    onPanResponderMove: (_, gestureState) => {
      const absoluteLocationX = Number(gestureState.moveX) - dockPageXRef.current;
      updateDragIndicator(Number.isFinite(absoluteLocationX)
        ? absoluteLocationX
        : dragStartXRef.current + gestureState.dx);
    },
    onPanResponderRelease: () => finishSwipe(visualIndexRef.current),
    onPanResponderTerminationRequest: () => true,
    onPanResponderTerminate: () => finishSwipe(activeIndex),
  }), [activeIndex, finishSwipe, indicatorX, updateDragIndicator, visualIndex]);

  const handlePress = (section: PhoneSection, index: number) => {
    if (suppressPressRef.current) {
      suppressPressRef.current = false;
      clearSuppressPressTimer();
      return;
    }
    visualIndexRef.current = index;
    setVisualIndex(index);
    animateIndicatorTo(index);
    if (section !== active) onSelect(section);
  };

  return (
    <View style={styles.phoneDockWrap} pointerEvents="box-none">
      <View
        ref={dockRef}
        {...panResponder.panHandlers}
        onLayout={(event) => setDockWidth(event.nativeEvent.layout.width)}
        style={[styles.phoneDock, swiping && styles.phoneDockSwiping]}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            styles.phoneDockIndicator,
            {
              opacity: tabWidth ? 1 : 0,
              width: tabWidth || 0,
              transform: [{ translateX: indicatorX }],
            },
          ]}
        />
        {PHONE_NAV_ITEMS.map((item, index) => {
          const selected = index === visualIndex;
          const badgeCount = Math.max(0, Number(badges[item.key] || 0));
          const DockIcon = item.Icon;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: item.key === active }}
              onPress={() => handlePress(item.key, index)}
              style={({ pressed }) => [
                styles.phoneDockItem,
                selected && styles.phoneDockItemActive,
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.phoneDockIconWrap, selected && styles.phoneDockIconWrapActive]}>
                <DockIcon
                  size={item.key === 'chat' ? 26 : 24}
                  color={selected ? COLORS.accent : COLORS.muted}
                  strokeWidth={selected ? 2.35 : 2.05}
                />
                {badgeCount > 0 ? (
                  <View style={styles.phoneDockBadge}>
                    <Text style={styles.phoneDockBadgeText}>{badgeCount > 99 ? '99+' : String(badgeCount)}</Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function SectionHeader({
  section,
  user,
  baseUrl,
  onLogout,
  onChangeServer,
}: {
  section: PhoneSection;
  user: RistakUser | null;
  baseUrl: string;
  onLogout: () => Promise<void>;
  onChangeServer: () => Promise<void>;
}) {
  const item = PHONE_NAV_ITEMS.find((navItem) => navItem.key === section);

  return (
    <View style={styles.header}>
      <View>
        <Text style={styles.kicker}>Ristak Phone</Text>
        <Text style={styles.headerTitle}>{item?.label || 'Ristak'}</Text>
        <Text style={styles.caption}>{getUserDisplayName(user)}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          Alert.alert('Sesion', baseUrl, [
            { text: 'Cancelar', style: 'cancel' },
            { text: 'Cambiar app', onPress: () => void onChangeServer() },
            { text: 'Salir', style: 'destructive', onPress: () => void onLogout() },
          ]);
        }}
        style={styles.roundButton}
      >
        <Text style={styles.roundButtonLabel}>...</Text>
      </Pressable>
    </View>
  );
}

function AppFrame({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      {children}
    </SafeAreaView>
  );
}

function BootScreen() {
  return (
    <AppFrame>
      <View style={styles.centerScreen}>
        <Image
          source={RISTAK_NIGHT_MODE_LOGO}
          style={styles.bootLogo}
          resizeMode="contain"
          accessibilityLabel="Ristak"
        />
        <ActivityIndicator color={COLORS.accent} accessibilityLabel="Cargando" />
      </View>
    </AppFrame>
  );
}

function LoginScreen({
  onLogin,
}: {
  onLogin: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!email.trim() || !password) {
      setError('Escribe tu correo y contrasena.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      await onLogin(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar sesion.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppFrame>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.authWrap}>
        <ScrollView contentContainerStyle={styles.authScroller} keyboardShouldPersistTaps="handled">
          <View style={styles.authPanel}>
            <Image
              source={RISTAK_NIGHT_MODE_LOGO}
              style={styles.authLogo}
              resizeMode="contain"
              accessibilityLabel="Ristak"
            />
            <Text style={styles.kicker}>Ristak</Text>
            <Text style={styles.title}>Iniciar sesion</Text>
            <Text style={styles.bodyText}>
              Entra con el correo y la contrasena de tu cuenta.
            </Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="correo@negocio.com"
              placeholderTextColor={COLORS.muted}
              style={styles.input}
            />
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="Contrasena"
              placeholderTextColor={COLORS.muted}
              style={styles.input}
            />
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <PrimaryButton label="Entrar" busy={busy} onPress={submit} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </AppFrame>
  );
}

function ChatScreen({
  api,
  footer,
  notificationContactId,
  onNotificationHandled,
  onUnreadTotalChange,
  onNavigate,
}: {
  api: RistakApiClient;
  footer?: React.ReactNode;
  notificationContactId?: string;
  onNotificationHandled?: () => void;
  onUnreadTotalChange?: (count: number) => void;
  onNavigate?: (section: PhoneSection) => void;
}) {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<ChatFilterId>('all');
  const [visibleFilterIds, setVisibleFilterIds] = useState<ChatFilterId[]>(DEFAULT_CHAT_FILTER_IDS);
  const [filterManagerOpen, setFilterManagerOpen] = useState(false);
  const [archivedChatIds, setArchivedChatIds] = useState<string[]>([]);
  const [mutedChatIds, setMutedChatIds] = useState<string[]>([]);
  const [archivedViewOpen, setArchivedViewOpen] = useState(false);
  const [chatPrefsHydrated, setChatPrefsHydrated] = useState(false);
  const [openSwipeChatId, setOpenSwipeChatId] = useState<string | null>(null);
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [selectionActionsOpen, setSelectionActionsOpen] = useState(false);
  const [bulkActionBusy, setBulkActionBusy] = useState(false);
  const [activeSheet, setActiveSheet] = useState<ChatSheetMode>(null);
  const [closingSheet, setClosingSheet] = useState<ChatSheetMode>(null);
  const [sheetContact, setSheetContact] = useState<ChatContact | null>(null);
  const [contactQuery, setContactQuery] = useState('');
  const [contactResults, setContactResults] = useState<ChatContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [chatTags, setChatTags] = useState<ContactTag[]>([]);
  const [chatTagsLoading, setChatTagsLoading] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const [tagBusy, setTagBusy] = useState(false);
  const [scheduleText, setScheduleText] = useState('');
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [agentStatesByContactId, setAgentStatesByContactId] = useState<Record<string, ConversationAgentState[]>>({});
  const [agentStateLoadingId, setAgentStateLoadingId] = useState<string | null>(null);
  const [agentBusyAction, setAgentBusyAction] = useState<AgentAction | null>(null);
  const [cameraAsset, setCameraAsset] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [chats, setChats] = useState<ChatContact[]>([]);
  const [businessTimezone, setBusinessTimezone] = useState(resolveBusinessTimezone());
  const [accountCurrency, setAccountCurrency] = useState(DEFAULT_ACCOUNT_CURRENCY);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<ChatContact | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  const sheetCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadChats = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const data = await api.getChats(query, 0, 50);
      setChats(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar la bandeja.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api, query]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadChats();
    }, query.trim() ? 240 : 0);
    return () => clearTimeout(timer);
  }, [loadChats, query]);

  useEffect(() => {
    void Promise.all([
      readJsonValue<string[]>(CHAT_FILTERS_STORAGE_KEY, DEFAULT_CHAT_FILTER_IDS),
      readJsonValue<string[]>(ARCHIVED_CHAT_IDS_STORAGE_KEY, []),
      readJsonValue<string[]>(MUTED_CHAT_IDS_STORAGE_KEY, []),
    ]).then(([savedFilterIds, savedArchivedIds, savedMutedIds]) => {
      const availableIds = new Set(CHAT_FILTER_LIBRARY.map((preset) => preset.id));
      const next = savedFilterIds.filter((id, index, list) => availableIds.has(id) && list.indexOf(id) === index);
      setVisibleFilterIds(next.includes('all') ? next : ['all', ...next]);
      setArchivedChatIds(savedArchivedIds.filter((id, index, list) => typeof id === 'string' && id.trim() && list.indexOf(id) === index));
      setMutedChatIds(savedMutedIds.filter((id, index, list) => typeof id === 'string' && id.trim() && list.indexOf(id) === index));
      setChatPrefsHydrated(true);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getConfig(['account_timezone', 'account_currency'])
      .then((response) => {
        if (cancelled) return;
        const values = response && typeof response === 'object' && 'config' in response
          ? response.config
          : response;
        const timezone = values && typeof values === 'object' && 'account_timezone' in values
          ? values.account_timezone
          : '';
        const currency = values && typeof values === 'object' && 'account_currency' in values
          ? values.account_currency
          : '';
        setBusinessTimezone(resolveBusinessTimezone(typeof timezone === 'string' ? timezone : ''));
        setAccountCurrency(typeof currency === 'string' ? normalizeCurrencyCode(currency) : DEFAULT_ACCOUNT_CURRENCY);
      })
      .catch(() => {
        if (!cancelled) {
          setBusinessTimezone(resolveBusinessTimezone());
          setAccountCurrency(DEFAULT_ACCOUNT_CURRENCY);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!chatPrefsHydrated) return;
    void writeJsonValue(CHAT_FILTERS_STORAGE_KEY, visibleFilterIds);
  }, [chatPrefsHydrated, visibleFilterIds]);

  useEffect(() => {
    if (!chatPrefsHydrated) return;
    void writeJsonValue(ARCHIVED_CHAT_IDS_STORAGE_KEY, archivedChatIds);
  }, [archivedChatIds, chatPrefsHydrated]);

  useEffect(() => {
    if (!chatPrefsHydrated) return;
    void writeJsonValue(MUTED_CHAT_IDS_STORAGE_KEY, mutedChatIds);
  }, [chatPrefsHydrated, mutedChatIds]);

  useEffect(() => {
    if (activeSheet !== 'newChat' && activeSheet !== 'cameraShare') {
      setContactsLoading(false);
      return;
    }
    const trimmed = contactQuery.trim();
    if (trimmed.length < 2) {
      setContactResults([]);
      setContactsLoading(false);
      return;
    }

    let cancelled = false;
    setContactsLoading(true);
    const timer = setTimeout(() => {
      api.searchContacts(trimmed)
        .then((results) => {
          if (!cancelled) setContactResults(Array.isArray(results) ? results : []);
        })
        .catch(() => {
          if (!cancelled) setContactResults([]);
        })
        .finally(() => {
          if (!cancelled) setContactsLoading(false);
        });
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeSheet, api, contactQuery]);

  const refresh = () => {
    setRefreshing(true);
    void loadChats(true);
  };

  const unreadTotal = useMemo(
    () => chats.reduce((total, contact) => (
      archivedChatIds.includes(contact.id) ? total : total + getUnreadCount(contact)
    ), 0),
    [archivedChatIds, chats],
  );

  useEffect(() => {
    onUnreadTotalChange?.(unreadTotal);
  }, [onUnreadTotalChange, unreadTotal]);

  const listBaseChats = useMemo(
    () => chats.filter((contact) => (
      archivedViewOpen ? archivedChatIds.includes(contact.id) : !archivedChatIds.includes(contact.id)
    )),
    [archivedChatIds, archivedViewOpen, chats],
  );

  const filteredChats = useMemo(
    () => listBaseChats.filter((contact) => chatMatchesFilter(contact, archivedViewOpen ? 'all' : activeFilter)),
    [activeFilter, archivedViewOpen, listBaseChats],
  );
  const visibleChatIdSet = useMemo(() => new Set(filteredChats.map((contact) => contact.id)), [filteredChats]);
  const selectedChatIdSet = useMemo(() => new Set(selectedChatIds), [selectedChatIds]);
  const mutedChatIdSet = useMemo(() => new Set(mutedChatIds), [mutedChatIds]);
  const selectedChatContacts = useMemo(
    () => filteredChats.filter((contact) => selectedChatIdSet.has(contact.id)),
    [filteredChats, selectedChatIdSet],
  );
  const selectionActive = selectedChatIds.length > 0;
  const selectedVisibleChatCount = selectedChatContacts.length;
  const allVisibleChatsSelected = filteredChats.length > 0 && filteredChats.every((contact) => selectedChatIdSet.has(contact.id));
  const archivedChatCount = archivedChatIds.length;
  const filterPresetMap = useMemo(
    () => new Map(CHAT_FILTER_LIBRARY.map((preset) => [preset.id, preset])),
    [],
  );
  const visibleFilters = useMemo(
    () => visibleFilterIds.map((id) => filterPresetMap.get(id)).filter((filter): filter is ChatFilterPreset => Boolean(filter)),
    [filterPresetMap, visibleFilterIds],
  );
  const normalizedContactQuery = contactQuery.trim().toLowerCase();
  const contactSheetOptions = useMemo(() => {
    const seen = new Set<string>();
    return [...chats, ...contactResults].filter((contact) => {
      if (!contact?.id || seen.has(contact.id)) return false;
      if (normalizedContactQuery) {
        const haystack = [
          getContactName(contact),
          contact.phone,
          contact.email,
          contact.source,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(normalizedContactQuery)) return false;
      }
      seen.add(contact.id);
      return true;
    });
  }, [chats, contactResults, normalizedContactQuery]);

  useEffect(() => {
    const contactId = String(notificationContactId || '').trim();
    if (!contactId) return;

    let cancelled = false;
    onNotificationHandled?.();

    const openNotificationContact = async () => {
      setAssistantOpen(false);
      setSelectedChatIds([]);
      setSelectionActionsOpen(false);
      setOpenSwipeChatId(null);
      setArchivedViewOpen(false);
      setActiveFilter('all');
      setQuery('');
      setActiveSheet(null);
      setClosingSheet(null);
      setSheetContact(null);

      const existingContact = chats.find((contact) => contact.id === contactId);
      if (existingContact) {
        if (!cancelled) setSelected(existingContact);
        return;
      }

      const fetchedContact = await api.getContact(contactId);
      if (cancelled) return;
      setChats((current) => (
        current.some((contact) => contact.id === fetchedContact.id)
          ? current
          : [fetchedContact, ...current]
      ));
      setSelected(fetchedContact);
    };

    void openNotificationContact()
      .catch((err) => {
        if (!cancelled) {
          Alert.alert('Notificación', err instanceof Error ? err.message : 'No pude abrir este chat.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, chats, notificationContactId, onNotificationHandled]);

  const showAssistantRow = !archivedViewOpen && !selectionActive && activeFilter === 'all' && (
    !query.trim() || AI_AGENT_CHAT_SEARCH_TEXT.includes(query.trim().toLowerCase())
  );
  const showArchiveRow = !selectionActive && !query.trim() && (archivedViewOpen || activeFilter === 'all');
  const chatListHasRows = selectionActive || showAssistantRow || showArchiveRow || filteredChats.length > 0;

  const applyFilter = (filterId: ChatFilterId) => {
    if (filterId === CHAT_FILTERS_MORE_VALUE) {
      setFilterManagerOpen(true);
      return;
    }
    setSelectedChatIds([]);
    setSelectionActionsOpen(false);
    setOpenSwipeChatId(null);
    setArchivedViewOpen(false);
    setActiveFilter(filterId);
  };

  const toggleVisibleFilter = (filterId: ChatFilterId) => {
    const preset = filterPresetMap.get(filterId);
    if (!preset || preset.locked) return;
    setVisibleFilterIds((current) => {
      if (current.includes(filterId)) {
        const next = current.filter((id) => id !== filterId);
        return next.includes('all') ? next : ['all', ...next];
      }
      return [...current, filterId];
    });
  };

  const archiveChat = (contact: ChatContact) => {
    setArchivedChatIds((current) => (
      current.includes(contact.id) ? current : [contact.id, ...current]
    ));
    setOpenSwipeChatId(null);
  };

  const restoreChat = (contact: ChatContact) => {
    setArchivedChatIds((current) => current.filter((id) => id !== contact.id));
    setOpenSwipeChatId(null);
  };

  const clearSheetCloseTimer = useCallback(() => {
    if (sheetCloseTimerRef.current) {
      clearTimeout(sheetCloseTimerRef.current);
      sheetCloseTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearSheetCloseTimer, [clearSheetCloseTimer]);

  const openSheet = useCallback((sheet: Exclude<ChatSheetMode, null>) => {
    clearSheetCloseTimer();
    setClosingSheet(null);
    setActiveSheet(sheet);
  }, [clearSheetCloseTimer]);

  const closeSheet = useCallback(() => {
    if (!activeSheet) return;
    const sheet = activeSheet;
    clearSheetCloseTimer();
    setClosingSheet(sheet);
    setActiveSheet(null);
    sheetCloseTimerRef.current = setTimeout(() => {
      sheetCloseTimerRef.current = null;
      setClosingSheet(null);
      setSheetContact(null);
      if (sheet === 'cameraShare') {
        setCameraAsset(null);
      }
    }, CHAT_SHEET_CLOSE_DURATION_MS + 40);
  }, [activeSheet, clearSheetCloseTimer]);

  const resetSheetState = () => {
    clearSheetCloseTimer();
    setClosingSheet(null);
  };

  const openNewChatSheet = () => {
    resetSheetState();
    setOpenSwipeChatId(null);
    setContactQuery('');
    setContactResults([]);
    setCameraAsset(null);
    setSheetContact(null);
    openSheet('newChat');
  };

  const openCameraShareSheet = (asset: ImagePicker.ImagePickerAsset) => {
    resetSheetState();
    setOpenSwipeChatId(null);
    setContactQuery('');
    setContactResults([]);
    setCameraAsset(asset);
    setSheetContact(null);
    openSheet('cameraShare');
  };

  const openChatMoreActions = (contact: ChatContact) => {
    resetSheetState();
    setOpenSwipeChatId(null);
    setSheetContact(contact);
    openSheet('chatMore');
    setAgentStateLoadingId(contact.id);
    api.getAgentStates(contact.id)
      .then((states) => {
        setAgentStatesByContactId((current) => ({ ...current, [contact.id]: Array.isArray(states) ? states : [] }));
      })
      .catch(() => {
        setAgentStatesByContactId((current) => ({ ...current, [contact.id]: [] }));
      })
      .finally(() => {
        setAgentStateLoadingId((current) => (current === contact.id ? null : current));
      });
  };

  const openTagSheet = (contact: ChatContact) => {
    resetSheetState();
    setOpenSwipeChatId(null);
    setSheetContact(contact);
    setTagQuery('');
    setChatTagsLoading(true);
    openSheet('tag');
    api.getContactTags()
      .then((tags) => setChatTags(Array.isArray(tags) ? tags : []))
      .catch((err) => {
        setChatTags([]);
        Alert.alert('Etiquetas', err instanceof Error ? err.message : 'No se cargaron las etiquetas.');
      })
      .finally(() => setChatTagsLoading(false));
  };

  const openScheduleSheet = (contact: ChatContact) => {
    resetSheetState();
    setOpenSwipeChatId(null);
    setSheetContact(contact);
    setScheduleText('');
    openSheet('schedule');
  };

  const navigateToContactTool = (contact: ChatContact, section: PhoneSection) => {
    closeSheet();
    onNavigate?.(section);
    Alert.alert(
      section === 'calendar' ? 'Agendar cita' : 'Registrar pagos',
      `${section === 'calendar' ? 'Abriendo Citas' : 'Abriendo Pagos'} para continuar con ${getContactName(contact)}.`,
    );
  };

  const toggleMuteChat = (contact: ChatContact) => {
    setMutedChatIds((current) => (
      current.includes(contact.id)
        ? current.filter((id) => id !== contact.id)
        : [contact.id, ...current]
    ));
    closeSheet();
  };

  const applyTagToContact = async (contact: ChatContact, tag: ContactTag) => {
    if (tagBusy) return;
    if ((contact.tags || []).includes(tag.id)) {
      Alert.alert('Etiqueta', `${getContactName(contact)} ya tiene ${tag.name}.`);
      return;
    }

    setTagBusy(true);
    try {
      await api.addContactTag(contact.id, tag.id);
      const nextTags = Array.from(new Set([...(contact.tags || []), tag.id]));
      setChats((current) => current.map((item) => (
        item.id === contact.id ? { ...item, tags: nextTags } : item
      )));
      closeSheet();
      Alert.alert('Etiqueta agregada', `${tag.name} quedó en ${getContactName(contact)}.`);
    } catch (err) {
      Alert.alert('Etiqueta', err instanceof Error ? err.message : 'No se pudo agregar la etiqueta.');
    } finally {
      setTagBusy(false);
    }
  };

  const createAndApplyTag = async (contact: ChatContact) => {
    const name = tagQuery.trim();
    if (!name || tagBusy) return;
    setTagBusy(true);
    try {
      const tag = await api.createContactTag(name);
      setChatTags((current) => [tag, ...current.filter((item) => item.id !== tag.id)]);
      await api.addContactTag(contact.id, tag.id);
      const nextTags = Array.from(new Set([...(contact.tags || []), tag.id]));
      setChats((current) => current.map((item) => (
        item.id === contact.id ? { ...item, tags: nextTags } : item
      )));
      closeSheet();
      Alert.alert('Etiqueta creada', `${tag.name} quedó en ${getContactName(contact)}.`);
    } catch (err) {
      Alert.alert('Etiqueta', err instanceof Error ? err.message : 'No se pudo crear la etiqueta.');
    } finally {
      setTagBusy(false);
    }
  };

  const scheduleMessageForContact = async (contact: ChatContact) => {
    const text = scheduleText.trim();
    if (!text || scheduleBusy) return;
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    setScheduleBusy(true);
    try {
      await api.scheduleText(contact, text, scheduledAt);
      closeSheet();
      Alert.alert('Mensaje programado', `Se programó para enviarse en 1 hora a ${getContactName(contact)}.`);
    } catch (err) {
      Alert.alert('Programar mensaje', err instanceof Error ? err.message : 'No se pudo programar el mensaje.');
    } finally {
      setScheduleBusy(false);
    }
  };

  const runAgentAction = async (contact: ChatContact, action: AgentAction) => {
    if (agentBusyAction) return;
    setAgentBusyAction(action);
    try {
      const state = await api.updateAgentState(contact.id, action);
      setAgentStatesByContactId((current) => ({ ...current, [contact.id]: [state] }));
      closeSheet();
      Alert.alert('Agente conversacional', getAgentActionSuccess(action, getContactName(contact)));
    } catch (err) {
      Alert.alert('Agente conversacional', err instanceof Error ? err.message : 'No se pudo actualizar el agente.');
    } finally {
      setAgentBusyAction(null);
    }
  };

  const markChatAsRead = (contact: ChatContact) => {
    setChats((current) => current.map((item) => (
      item.id === contact.id ? { ...item, unreadCount: 0 } : item
    )));
    void api.markChatRead(contact.id).catch((err) => {
      Alert.alert('Chat', err instanceof Error ? err.message : 'No se pudo marcar como leído.');
    });
  };

  const openCamera = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Cámara', 'Necesito permiso de cámara para tomar fotos desde la app.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.86,
    });
    if (result.canceled || !result.assets?.[0]) return;
    openCameraShareSheet(result.assets[0]);
  };

  const openContactFromSheet = (contact: ChatContact) => {
    setChats((current) => (
      current.some((item) => item.id === contact.id) ? current : [contact, ...current]
    ));
    closeSheet();
    setSelected(contact);
  };

  const chooseCameraRecipient = (contact: ChatContact) => {
    setSheetContact(contact);
    Alert.alert(
      'Foto lista',
      `La foto quedó lista para enviar a ${getContactName(contact)}. El envío multimedia completo sigue pendiente de conectar al composer nativo.`,
    );
  };

  const clearChatSelection = () => {
    setSelectedChatIds([]);
    setSelectionActionsOpen(false);
  };

  const startChatSelection = (contact: ChatContact) => {
    setOpenSwipeChatId(null);
    setSelectionActionsOpen(false);
    setSelectedChatIds((current) => (
      current.includes(contact.id) ? current : [...current, contact.id]
    ));
  };

  const toggleChatSelection = (contact: ChatContact) => {
    setOpenSwipeChatId(null);
    setSelectedChatIds((current) => (
      current.includes(contact.id)
        ? current.filter((id) => id !== contact.id)
        : [...current, contact.id]
    ));
  };

  const toggleVisibleChatSelection = () => {
    const visibleIds = filteredChats.map((contact) => contact.id);
    setOpenSwipeChatId(null);
    setSelectionActionsOpen(false);
    setSelectedChatIds((current) => {
      if (visibleIds.length && visibleIds.every((id) => current.includes(id))) {
        return current.filter((id) => !visibleChatIdSet.has(id));
      }
      return Array.from(new Set([...current, ...visibleIds]));
    });
  };

  const handleChatPress = (contact: ChatContact) => {
    if (selectionActive) {
      toggleChatSelection(contact);
      return;
    }
    if (openSwipeChatId === contact.id) {
      setOpenSwipeChatId(null);
      return;
    }
    if (openSwipeChatId) {
      setOpenSwipeChatId(null);
      return;
    }
    setSelected(contact);
  };

  const markSelectedChatsAsRead = async () => {
    const contactIds = selectedChatContacts.map((contact) => contact.id);
    if (!contactIds.length || bulkActionBusy) return;
    setBulkActionBusy(true);
    setChats((current) => current.map((contact) => (
      contactIds.includes(contact.id) ? { ...contact, unreadCount: 0 } : contact
    )));
    try {
      await api.markChatsRead(contactIds);
      clearChatSelection();
    } catch (err) {
      Alert.alert('Chat', err instanceof Error ? err.message : 'No se pudieron marcar como leídos.');
    } finally {
      setBulkActionBusy(false);
    }
  };

  const archiveSelectedChats = () => {
    const contactIds = selectedChatContacts.map((contact) => contact.id);
    if (!contactIds.length) return;
    setArchivedChatIds((current) => {
      const selectedSet = new Set(contactIds);
      if (archivedViewOpen) {
        return current.filter((id) => !selectedSet.has(id));
      }
      return Array.from(new Set([...contactIds, ...current]));
    });
    clearChatSelection();
  };

  useEffect(() => {
    setOpenSwipeChatId(null);
    setSelectedChatIds([]);
    setSelectionActionsOpen(false);
  }, [activeFilter, archivedViewOpen, query]);

  useEffect(() => {
    if (!selectionActive) {
      setSelectionActionsOpen(false);
      return;
    }
    setOpenSwipeChatId(null);
    setSelectedChatIds((current) => {
      const next = current.filter((id) => visibleChatIdSet.has(id));
      return next.length === current.length ? current : next;
    });
  }, [selectionActive, visibleChatIdSet]);

  if (assistantOpen) {
    return <AssistantConversationScreen onBack={() => setAssistantOpen(false)} />;
  }

  if (selected) {
    return (
      <NativeConversationScreen
        api={api}
        contact={selected}
        accountCurrency={accountCurrency}
        archived={archivedChatIds.includes(selected.id)}
        muted={mutedChatIds.includes(selected.id)}
        timezone={businessTimezone}
        onArchiveToggle={(contact) => {
          if (archivedChatIds.includes(contact.id)) {
            restoreChat(contact);
          } else {
            archiveChat(contact);
          }
        }}
        onBack={() => {
          setSelected(null);
          void loadChats(true);
        }}
        onContactPatch={(contactId, patch) => {
          setSelected((current) => (current?.id === contactId ? { ...current, ...patch } : current));
          setChats((current) => current.map((item) => (
            item.id === contactId ? { ...item, ...patch } : item
          )));
        }}
        onNavigate={onNavigate}
        onRefreshChats={() => void loadChats(true)}
        onToggleMute={toggleMuteChat}
      />
    );
  }

  const chatMoreSheetOpen = activeSheet === 'chatMore' || closingSheet === 'chatMore';
  const chatMoreSheetClosing = activeSheet !== 'chatMore' && closingSheet === 'chatMore';
  const contactPickerSheet = activeSheet === 'cameraShare' || closingSheet === 'cameraShare'
    ? 'cameraShare'
    : activeSheet === 'newChat' || closingSheet === 'newChat'
      ? 'newChat'
      : null;
  const contactPickerClosing = !activeSheet && (closingSheet === 'newChat' || closingSheet === 'cameraShare');
  const tagSheetOpen = activeSheet === 'tag' || closingSheet === 'tag';
  const scheduleSheetOpen = activeSheet === 'schedule' || closingSheet === 'schedule';
  const tagSheetClosing = activeSheet !== 'tag' && closingSheet === 'tag';
  const scheduleSheetClosing = activeSheet !== 'schedule' && closingSheet === 'schedule';
  const sheetAgentState = sheetContact ? selectPrimaryAgentState(agentStatesByContactId[sheetContact.id]) : null;

  return (
    <AppFrame>
      <View style={styles.chatListHeader}>
        <View style={styles.chatTopActionRow}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              Alert.alert('Agente conversacional', 'La bandeja nativa ya respeta los chats del agente. La configuración fina vive en Ajustes.');
            }}
            style={({ pressed }) => [styles.agentRoundButton, pressed && styles.pressed]}
          >
            <Bot size={22} color={COLORS.primary} strokeWidth={2.3} />
          </Pressable>
          <View style={styles.chatHeaderActions}>
            <Pressable
              accessibilityRole="button"
              onPress={() => void openCamera()}
              style={({ pressed }) => [styles.headerIconButton, pressed && styles.pressed]}
            >
              <Camera size={23} color={COLORS.primary} strokeWidth={2.3} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={openNewChatSheet}
              style={({ pressed }) => [styles.newChatButton, pressed && styles.pressed]}
            >
              <Plus size={31} color={COLORS.white} strokeWidth={2.45} />
            </Pressable>
          </View>
        </View>
        <View style={styles.chatTitleRow}>
          <View style={styles.chatTitleMain}>
            <Text style={styles.chatTitle}>Chats</Text>
          </View>
        </View>
        <View style={styles.searchBox}>
          <Search size={21} color={COLORS.muted} strokeWidth={2.3} />
          <TextInput
            ref={searchInputRef}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Buscar chats"
            placeholderTextColor={COLORS.muted}
            style={styles.searchInput}
          />
          {query ? (
            <Pressable accessibilityRole="button" onPress={() => setQuery('')} style={styles.clearSearchButton}>
              <X size={17} color={COLORS.muted} strokeWidth={2.45} />
            </Pressable>
          ) : null}
        </View>
        {!selectionActive ? (
          <ChatFilterBar
            active={activeFilter}
            filters={visibleFilters}
            unreadTotal={unreadTotal}
            onChange={applyFilter}
          />
        ) : null}
      </View>
      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator color={COLORS.accent} />
          <Text style={styles.caption}>Cargando chats...</Text>
        </View>
      ) : error ? (
        <View style={styles.centerState}>
          <Text style={styles.errorText}>{error}</Text>
          <SecondaryButton label="Reintentar" onPress={() => void loadChats()} />
        </View>
      ) : (
        <FlatList
          data={filteredChats}
          keyExtractor={(item) => item.id}
          extraData={`${openSwipeChatId || ''}|${selectedChatIds.join(',')}|${archivedChatIds.join(',')}|${businessTimezone}|${selectionActive ? 'selecting' : 'normal'}`}
          refreshControl={<RefreshControl tintColor={COLORS.accent} refreshing={refreshing} onRefresh={refresh} />}
          onScrollBeginDrag={() => {
            if (openSwipeChatId) setOpenSwipeChatId(null);
          }}
          contentContainerStyle={chatListHasRows ? styles.chatList : styles.emptyList}
          ListHeaderComponent={(
            selectionActive ? (
              <ChatSelectionPanel
                allVisibleSelected={allVisibleChatsSelected}
                archiveLabel={archivedViewOpen ? 'Restaurar seleccionados' : 'Archivar seleccionados'}
                busy={bulkActionBusy}
                count={selectedVisibleChatCount}
                menuOpen={selectionActionsOpen}
                onArchiveSelected={archiveSelectedChats}
                onClear={clearChatSelection}
                onMarkRead={() => void markSelectedChatsAsRead()}
                onToggleMenu={() => setSelectionActionsOpen((current) => !current)}
                onToggleVisible={toggleVisibleChatSelection}
              />
            ) : (
              <>
                {showAssistantRow ? <AssistantChatRow onPress={() => setAssistantOpen(true)} /> : null}
                {showArchiveRow ? (
                  <ArchiveRow
                    active={archivedViewOpen}
                    count={archivedChatCount}
                    onPress={() => setArchivedViewOpen((current) => !current)}
                  />
                ) : null}
              </>
            )
          )}
          renderItem={({ item }) => (
            <ChatRow
              contact={item}
              archived={archivedChatIds.includes(item.id)}
              selectionActive={selectionActive}
              selected={selectedChatIdSet.has(item.id)}
              swipeOpen={openSwipeChatId === item.id}
              timezone={businessTimezone}
              onArchiveToggle={() => {
                if (archivedChatIds.includes(item.id)) restoreChat(item);
                else archiveChat(item);
              }}
              onLongPress={() => startChatSelection(item)}
              onMore={() => openChatMoreActions(item)}
              onPress={() => handleChatPress(item)}
              onSwipeClose={() => setOpenSwipeChatId(null)}
              onSwipeOpen={() => setOpenSwipeChatId(item.id)}
              onSwipeStart={() => {
                if (openSwipeChatId && openSwipeChatId !== item.id) setOpenSwipeChatId(null);
              }}
            />
          )}
          ListEmptyComponent={
            <View style={styles.emptyChats}>
              <View style={styles.emptyChatsIcon}>
                <MessageCircle size={28} color={COLORS.accent} strokeWidth={2.4} />
              </View>
              <Text style={styles.emptyChatsTitle}>
                {chats.length ? 'No hay chats en este filtro' : 'Aún no hay chats'}
              </Text>
              <Text style={styles.emptyChatsCopy}>
                {chats.length ? 'Cambia el filtro o busca otro contacto para encontrar la conversación.' : 'Cuando llegue un mensaje de WhatsApp, Messenger o Instagram aparecerá aquí.'}
              </Text>
            </View>
          }
        />
      )}
      <FilterManagerSheet
        activeFilter={activeFilter}
        visibleFilterIds={visibleFilterIds}
        open={filterManagerOpen}
        onClose={() => setFilterManagerOpen(false)}
        onApply={(filterId) => {
          if (!visibleFilterIds.includes(filterId)) {
            setVisibleFilterIds((current) => [...current, filterId]);
          }
          setActiveFilter(filterId);
          setFilterManagerOpen(false);
        }}
        onToggleVisible={toggleVisibleFilter}
      />
      <ChatMoreSheet
        contact={sheetContact}
        open={chatMoreSheetOpen}
        closing={chatMoreSheetClosing}
        archived={sheetContact ? archivedChatIds.includes(sheetContact.id) : false}
        agentBusyAction={agentBusyAction}
        agentLoading={sheetContact ? agentStateLoadingId === sheetContact.id : false}
        agentState={sheetAgentState}
        muted={sheetContact ? mutedChatIdSet.has(sheetContact.id) : false}
        unread={sheetContact ? getUnreadCount(sheetContact) : 0}
        onAgentAction={runAgentAction}
        onAppointment={(contact) => navigateToContactTool(contact, 'calendar')}
        onArchiveToggle={(contact) => {
          if (archivedChatIds.includes(contact.id)) restoreChat(contact);
          else archiveChat(contact);
          closeSheet();
        }}
        onClose={closeSheet}
        onPayment={(contact) => navigateToContactTool(contact, 'payments')}
        onSchedule={openScheduleSheet}
        onTag={openTagSheet}
        onToggleMute={toggleMuteChat}
        onMarkRead={(contact) => {
          markChatAsRead(contact);
          closeSheet();
        }}
        onSelect={(contact) => {
          closeSheet();
          startChatSelection(contact);
        }}
      />
      <ContactTagSheet
        busy={tagBusy}
        closing={tagSheetClosing}
        contact={sheetContact}
        loading={chatTagsLoading}
        open={tagSheetOpen}
        query={tagQuery}
        tags={chatTags}
        onApply={applyTagToContact}
        onChangeQuery={setTagQuery}
        onClose={closeSheet}
        onCreate={createAndApplyTag}
      />
      <ScheduleMessageSheet
        busy={scheduleBusy}
        closing={scheduleSheetClosing}
        contact={sheetContact}
        open={scheduleSheetOpen}
        text={scheduleText}
        onChangeText={setScheduleText}
        onClose={closeSheet}
        onSubmit={scheduleMessageForContact}
      />
      <ContactPickerSheet
        asset={contactPickerSheet === 'cameraShare' ? cameraAsset : null}
        contacts={contactSheetOptions}
        closing={contactPickerClosing}
        loading={contactsLoading}
        open={Boolean(contactPickerSheet)}
        query={contactQuery}
        title={contactPickerSheet === 'cameraShare' ? 'Enviar foto' : 'Nuevo chat'}
        onChangeQuery={setContactQuery}
        onClose={closeSheet}
        onSelect={contactPickerSheet === 'cameraShare' ? chooseCameraRecipient : openContactFromSheet}
      />
      {footer}
    </AppFrame>
  );
}

function PaymentsSection({ api }: { api: RistakApiClient }) {
  const [view, setView] = useState<PaymentView>('select');
  const [accountCurrency, setAccountCurrency] = useState(DEFAULT_ACCOUNT_CURRENCY);
  const [businessTimezone, setBusinessTimezone] = useState(DEFAULT_BUSINESS_TIMEZONE);
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsRefreshing, setProductsRefreshing] = useState(false);
  const [productsError, setProductsError] = useState('');
  const [productFormMode, setProductFormMode] = useState<ProductFormMode>(null);
  const [editingProduct, setEditingProduct] = useState<ProductItem | null>(null);
  const [productForm, setProductForm] = useState(() => createEmptyProductForm());
  const [savingProduct, setSavingProduct] = useState(false);
  const [deletingProductId, setDeletingProductId] = useState<string | null>(null);
  const [recentPaymentsOpen, setRecentPaymentsOpen] = useState(false);
  const [recentPaymentsPeriod, setRecentPaymentsPeriod] = useState<RecentPaymentsPeriod>('30d');
  const [recentPayments, setRecentPayments] = useState<TransactionItem[]>([]);
  const [recentPaymentsLoading, setRecentPaymentsLoading] = useState(false);
  const [recentPaymentsRefreshing, setRecentPaymentsRefreshing] = useState(false);
  const [selectedRecentPaymentId, setSelectedRecentPaymentId] = useState<string | null>(null);

  const loadAccountContext = useCallback(async () => {
    try {
      const [configResponse, timezoneResponse] = await Promise.all([
        api.getConfig([ACCOUNT_CURRENCY_CONFIG_KEY]).catch(() => ({})),
        api.getTimezone().catch(() => null),
      ]);
      const config = getConfigMap(configResponse);
      setAccountCurrency(normalizeCurrencyCode(config[ACCOUNT_CURRENCY_CONFIG_KEY], DEFAULT_ACCOUNT_CURRENCY));
      if (timezoneResponse?.timezone) setBusinessTimezone(String(timezoneResponse.timezone));
    } catch {
      setAccountCurrency(DEFAULT_ACCOUNT_CURRENCY);
      setBusinessTimezone(DEFAULT_BUSINESS_TIMEZONE);
    }
  }, [api]);

  const loadProducts = useCallback(async ({ refresh = false }: { refresh?: boolean } = {}) => {
    if (refresh) setProductsRefreshing(true);
    else setProductsLoading(true);
    setProductsError('');
    try {
      const productsResponse = await api.getProducts();
      setProducts(Array.isArray(productsResponse.products) ? productsResponse.products : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudieron cargar los productos.';
      setProductsError(message);
    } finally {
      setProductsLoading(false);
      setProductsRefreshing(false);
    }
  }, [api]);

  const loadRecentPayments = useCallback(async () => {
    const { startDate, endDate } = getRecentPaymentRange(recentPaymentsPeriod, businessTimezone);
    if (recentPayments.length) setRecentPaymentsRefreshing(true);
    else setRecentPaymentsLoading(true);
    try {
      const transactionsResponse = await api.getTransactions({ startDate, endDate, sync: false });
      const receivedPayments = normalizeTransactionsResponse(transactionsResponse)
        .filter((transaction) => getPaymentAmount(transaction) > 0 && SUCCESS_PAYMENT_STATUSES.has(normalizeProbe(transaction.status)))
        .sort((left, right) => getPaymentSortTime(right) - getPaymentSortTime(left));
      setRecentPayments(receivedPayments);
      setSelectedRecentPaymentId((current) => (
        current && receivedPayments.some((payment) => getTransactionId(payment) === current) ? current : null
      ));
    } catch {
      setRecentPayments([]);
      setSelectedRecentPaymentId(null);
    } finally {
      setRecentPaymentsLoading(false);
      setRecentPaymentsRefreshing(false);
    }
  }, [api, businessTimezone, recentPayments.length, recentPaymentsPeriod]);

  useEffect(() => {
    void loadAccountContext();
  }, [loadAccountContext]);

  useEffect(() => {
    if (view === 'products') void loadProducts();
  }, [loadProducts, view]);

  useEffect(() => {
    if (recentPaymentsOpen) void loadRecentPayments();
  }, [loadRecentPayments, recentPaymentsOpen]);

  const openCreateProduct = () => {
    setEditingProduct(null);
    setProductForm(createEmptyProductForm());
    setProductFormMode('create');
  };

  const openEditProduct = (product: ProductItem) => {
    const price = getPrimaryPrice(product);
    setEditingProduct(product);
    setProductForm({
      name: product.name || '',
      description: product.description || '',
      priceName: price?.name || 'Precio base',
      amount: getPriceAmount(price) ? String(getPriceAmount(price)) : '',
    });
    setProductFormMode('edit');
  };

  const closeProductForm = () => {
    setProductFormMode(null);
    setEditingProduct(null);
    setProductForm(createEmptyProductForm());
  };

  const handleSaveProduct = async () => {
    const name = productForm.name.trim();
    const amount = normalizeAmountInput(productForm.amount);
    if (!name) {
      Alert.alert('Falta el nombre', 'Escribe cómo se llama el producto.');
      return;
    }
    if (amount <= 0) {
      Alert.alert('Falta el precio', 'Escribe un precio válido para poder cobrarlo.');
      return;
    }

    const currentPrice = editingProduct ? getPrimaryPrice(editingProduct) : null;
    const payload = {
      name,
      description: productForm.description.trim(),
      currency: accountCurrency,
      prices: [
        {
          id: getPriceId(currentPrice),
          localId: currentPrice?.localId,
          name: productForm.priceName.trim() || 'Precio base',
          amount,
          currency: accountCurrency,
          type: 'one_time',
        },
      ],
    };

    setSavingProduct(true);
    try {
      if (productFormMode === 'edit' && editingProduct) {
        await api.updateProduct(getProductId(editingProduct), payload);
      } else {
        await api.createProduct(payload);
      }
      closeProductForm();
      await loadProducts({ refresh: true });
    } catch (err) {
      Alert.alert('No se guardó el producto', err instanceof Error ? err.message : 'Intenta otra vez.');
    } finally {
      setSavingProduct(false);
    }
  };

  const handleDeleteProduct = (product: ProductItem) => {
    const productId = getProductId(product);
    if (!productId) return;
    Alert.alert(
      'Eliminar producto',
      `Se quitará "${product.name || 'Producto'}" de la lista para cobrar. Los pagos anteriores no se borran.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: () => {
            setDeletingProductId(productId);
            api.deleteProduct(productId)
              .then(() => {
                setProducts((current) => current.filter((item) => getProductId(item) !== productId));
                if (editingProduct && getProductId(editingProduct) === productId) closeProductForm();
              })
              .catch((err) => {
                Alert.alert('No se eliminó', err instanceof Error ? err.message : 'Intenta otra vez.');
              })
              .finally(() => setDeletingProductId(null));
          },
        },
      ],
    );
  };

  if (view === 'products') {
    return (
      <PaymentsProductsView
        accountCurrency={accountCurrency}
        deletingProductId={deletingProductId}
        editingProduct={editingProduct}
        form={productForm}
        formMode={productFormMode}
        loading={productsLoading}
        products={products}
        productsError={productsError}
        refreshing={productsRefreshing}
        saving={savingProduct}
        onBack={() => setView('select')}
        onChangeForm={(field, value) => setProductForm((current) => ({ ...current, [field]: value }))}
        onCloseForm={closeProductForm}
        onCreateProduct={openCreateProduct}
        onDeleteProduct={handleDeleteProduct}
        onEditProduct={openEditProduct}
        onRefresh={() => void loadProducts({ refresh: true })}
        onSaveProduct={() => void handleSaveProduct()}
      />
    );
  }

  if (view === 'single' || view === 'partial' || view === 'subscription') {
    return (
      <PaymentFormView
        api={api}
        currency={accountCurrency}
        mode={view}
        timezone={businessTimezone}
        onBack={() => setView('select')}
        onSaved={() => {
          setView('select');
          if (recentPaymentsOpen) void loadRecentPayments();
        }}
      />
    );
  }

  const selectedRecentPeriod = RECENT_PAYMENT_PERIODS.find((period) => period.id === recentPaymentsPeriod) || RECENT_PAYMENT_PERIODS[2];
  const selectedRecentPayment = recentPayments.find((payment) => getTransactionId(payment) === selectedRecentPaymentId) || null;

  return (
    <ScrollView
      contentContainerStyle={styles.paymentsSelectStack}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.paymentsSelectTitle}>Elige cómo quieres pagar</Text>

      <PaymentChoiceCard
        Icon={CreditCard}
        iconTone="green"
        title="Registrar pago único"
        subtitle="Cobro único: envía una liga de pago o registra un pago manual."
        onPress={() => setView('single')}
      />
      <PaymentChoiceCard
        Icon={CalendarDays}
        title="Planes de pago"
        subtitle="Parcialidades automáticas con enganche y cobros recurrentes."
        onPress={() => setView('partial')}
      />
      <PaymentChoiceCard
        Icon={Repeat2}
        title="Suscripción"
        subtitle="Cobros recurrentes con Stripe, Conekta o Mercado Pago."
        onPress={() => setView('subscription')}
      />
      <PaymentChoiceCard
        Icon={Package}
        title="Precios Guardados"
        subtitle="Revisa, crea, modifica o elimina precios para cobrarlos desde el celular."
        onPress={() => setView('products')}
      />

      <View style={styles.recentPaymentsSection}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: recentPaymentsOpen }}
          onPress={() => setRecentPaymentsOpen((open) => !open)}
          style={({ pressed }) => [styles.recentPaymentsToggle, pressed && styles.pressed]}
        >
          <View style={styles.recentPaymentsToggleCopy}>
            <Text numberOfLines={1} style={styles.recentPaymentsToggleTitle}>
              {recentPaymentsOpen ? 'Ocultar últimos pagos' : 'Mostrar últimos pagos'}
            </Text>
            <Text numberOfLines={1} style={styles.recentPaymentsToggleSubtitle}>
              {selectedRecentPayment
                ? `${formatCurrency(getPaymentAmount(selectedRecentPayment), selectedRecentPayment.currency || accountCurrency)} seleccionado`
                : `${selectedRecentPeriod.label} recientes`}
            </Text>
          </View>
          <ChevronDown
            size={22}
            color={COLORS.text}
            strokeWidth={2.45}
            style={recentPaymentsOpen ? styles.recentPaymentsChevronOpen : undefined}
          />
        </Pressable>

        {recentPaymentsOpen ? (
          <View style={styles.recentPaymentsPanel}>
            <View style={styles.recentPeriodPicker}>
              {RECENT_PAYMENT_PERIODS.map((period) => {
                const active = period.id === recentPaymentsPeriod;
                return (
                  <Pressable
                    key={period.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => setRecentPaymentsPeriod(period.id)}
                    style={[styles.recentPeriodButton, active && styles.recentPeriodButtonActive]}
                  >
                    <Text style={[styles.recentPeriodText, active && styles.recentPeriodTextActive]}>{period.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {recentPaymentsLoading && recentPayments.length === 0 ? (
              <View style={styles.recentPaymentsState}>
                <ActivityIndicator color={COLORS.accent} />
                <Text style={styles.caption}>Cargando...</Text>
              </View>
            ) : recentPayments.length === 0 ? (
              <View style={styles.recentPaymentsState}>
                {recentPaymentsRefreshing ? <ActivityIndicator color={COLORS.accent} /> : null}
                <Text style={styles.caption}>No hay pagos recibidos en este periodo.</Text>
              </View>
            ) : (
              <View style={styles.recentPaymentsList}>
                {recentPaymentsRefreshing ? (
                  <View style={styles.recentPaymentsRefresh}>
                    <ActivityIndicator color={COLORS.muted} size="small" />
                    <Text style={styles.recentPaymentsRefreshText}>Actualizando pagos</Text>
                  </View>
                ) : null}
                {recentPayments.slice(0, 24).map((payment) => {
                  const paymentId = getTransactionId(payment);
                  const selected = selectedRecentPaymentId === paymentId;
                  return (
                    <Pressable
                      key={paymentId}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => setSelectedRecentPaymentId(selected ? null : paymentId)}
                      style={({ pressed }) => [styles.recentPaymentItem, selected && styles.recentPaymentItemSelected, pressed && styles.pressed]}
                    >
                      <View style={styles.recentPaymentMain}>
                        <Text numberOfLines={1} style={styles.recentPaymentAmount}>
                          {formatCurrency(getPaymentAmount(payment), payment.currency || accountCurrency)}
                        </Text>
                        <Text numberOfLines={1} style={styles.recentPaymentContact}>{getPaymentContactLabel(payment)}</Text>
                      </View>
                      <View style={styles.recentPaymentMeta}>
                        <Text numberOfLines={1} style={styles.recentPaymentDate}>
                          {formatPaymentDate(payment.date || payment.paymentDate || payment.createdAt, businessTimezone)}
                        </Text>
                        <Text numberOfLines={1} style={styles.recentPaymentMethod}>
                          {getPaymentMethodLabel(payment.method || payment.paymentMethod)} · {getPaymentStatusLabel(payment.status)}
                        </Text>
                      </View>
                      {selected ? <Check size={18} color={COLORS.accent} strokeWidth={2.7} /> : null}
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        ) : null}
      </View>
      <View style={styles.paymentsBottomSpacer} />
    </ScrollView>
  );
}

function PaymentChoiceCard({
  Icon,
  iconTone = 'blue',
  title,
  subtitle,
  onPress,
}: {
  Icon: LucideIcon;
  iconTone?: 'blue' | 'green';
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.paymentChoiceCard, pressed && styles.pressed]}>
      <View style={styles.paymentChoiceIcon}>
        <Icon size={26} color={iconTone === 'green' ? '#25d366' : COLORS.text} strokeWidth={2.4} />
      </View>
      <View style={styles.paymentChoiceCopy}>
        <Text numberOfLines={2} style={styles.paymentChoiceTitle}>{title}</Text>
        <Text numberOfLines={3} style={styles.paymentChoiceSubtitle}>{subtitle}</Text>
      </View>
      <ChevronRight size={20} color={COLORS.muted} strokeWidth={2.4} />
    </Pressable>
  );
}

function PaymentsProductsView({
  accountCurrency,
  deletingProductId,
  form,
  formMode,
  loading,
  products,
  productsError,
  refreshing,
  saving,
  onBack,
  onChangeForm,
  onCloseForm,
  onCreateProduct,
  onDeleteProduct,
  onEditProduct,
  onRefresh,
  onSaveProduct,
}: {
  accountCurrency: string;
  deletingProductId: string | null;
  editingProduct: ProductItem | null;
  form: ReturnType<typeof createEmptyProductForm>;
  formMode: ProductFormMode;
  loading: boolean;
  products: ProductItem[];
  productsError: string;
  refreshing: boolean;
  saving: boolean;
  onBack: () => void;
  onChangeForm: (field: keyof ReturnType<typeof createEmptyProductForm>, value: string) => void;
  onCloseForm: () => void;
  onCreateProduct: () => void;
  onDeleteProduct: (product: ProductItem) => void;
  onEditProduct: (product: ProductItem) => void;
  onRefresh: () => void;
  onSaveProduct: () => void;
}) {
  return (
    <ScrollView
      contentContainerStyle={styles.productsHost}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.productsTopBar}>
        <Pressable accessibilityRole="button" onPress={onBack} style={({ pressed }) => [styles.paymentsBackButton, pressed && styles.pressed]}>
          <ChevronLeft size={19} color={COLORS.text} strokeWidth={2.5} />
          <Text style={styles.paymentsBackText}>Atrás</Text>
        </Pressable>
      </View>

      <View style={styles.productsToolbar}>
        <View style={styles.productsToolbarCopy}>
          <Text style={styles.productsToolbarTitle}>Precios Guardados</Text>
          <Text style={styles.productsToolbarSubtitle}>
            {products.length === 1 ? '1 disponible' : `${products.length} disponibles`}
          </Text>
        </View>
        <View style={styles.productsToolbarActions}>
          <Pressable
            accessibilityRole="button"
            disabled={loading || refreshing}
            onPress={onRefresh}
            style={[styles.productIconButton, (loading || refreshing) && styles.disabledButton]}
          >
            {refreshing ? <ActivityIndicator color={COLORS.text} size="small" /> : <RefreshCw size={18} color={COLORS.text} strokeWidth={2.45} />}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={onCreateProduct}
            style={[styles.productPrimaryButton, saving && styles.disabledButton]}
          >
            <Plus size={17} color={COLORS.white} strokeWidth={2.6} />
            <Text style={styles.productPrimaryButtonText}>Nuevo</Text>
          </Pressable>
        </View>
      </View>

      {formMode ? (
        <View style={styles.productForm}>
          <View style={styles.productFormHeader}>
            <View style={styles.productFormHeaderCopy}>
              <Text style={styles.productFormTitle}>{formMode === 'edit' ? 'Editar producto' : 'Nuevo producto'}</Text>
              <Text style={styles.productFormSubtitle}>Estos datos aparecerán al cobrar desde Guardados.</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={onCloseForm} style={styles.sheetCloseButton}>
              <X size={18} color={COLORS.text} strokeWidth={2.5} />
            </Pressable>
          </View>
          <PaymentTextField label="Nombre del producto" value={form.name} onChangeText={(value) => onChangeForm('name', value)} placeholder="Ej. Consulta inicial" />
          <PaymentTextField label={`Precio (${accountCurrency})`} value={form.amount} onChangeText={(value) => onChangeForm('amount', value)} placeholder="0.00" keyboardType="decimal-pad" />
          <PaymentTextField label="Nombre del precio" value={form.priceName} onChangeText={(value) => onChangeForm('priceName', value)} placeholder="Precio base" />
          <PaymentTextField label="Descripción" value={form.description} onChangeText={(value) => onChangeForm('description', value)} placeholder="Agrega una nota corta para reconocerlo." multiline />
          <View style={styles.productFormActions}>
            <Pressable accessibilityRole="button" disabled={saving} onPress={onCloseForm} style={[styles.productSecondaryButton, saving && styles.disabledButton]}>
              <Text style={styles.productSecondaryButtonText}>Cancelar</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={saving} onPress={onSaveProduct} style={[styles.productPrimaryButton, styles.productFormPrimaryButton, saving && styles.disabledButton]}>
              {saving ? <ActivityIndicator color={COLORS.white} size="small" /> : <Save size={17} color={COLORS.white} strokeWidth={2.6} />}
              <Text style={styles.productPrimaryButtonText}>Guardar</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {loading && products.length === 0 ? (
        <View style={styles.productsState}>
          <ActivityIndicator color={COLORS.accent} />
          <Text style={styles.caption}>Cargando...</Text>
        </View>
      ) : productsError && products.length === 0 ? (
        <View style={styles.productsState}>
          <Text style={styles.emptyChatsTitle}>No se pudieron cargar</Text>
          <Text style={styles.emptyChatsCopy}>{productsError}</Text>
        </View>
      ) : products.length === 0 ? (
        <View style={styles.productsEmpty}>
          <View style={styles.productsEmptyIcon}>
            <Package size={28} color={COLORS.accent} strokeWidth={2.4} />
          </View>
          <Text style={styles.emptyChatsTitle}>Sin productos todavía</Text>
          <Text style={styles.emptyChatsCopy}>Crea tu primer producto para cobrarlo rápido desde el celular.</Text>
          <Pressable accessibilityRole="button" onPress={onCreateProduct} style={styles.productPrimaryButton}>
            <Plus size={17} color={COLORS.white} strokeWidth={2.6} />
            <Text style={styles.productPrimaryButtonText}>Crear producto</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.productsList}>
          {products.map((product) => (
            <ProductListItem
              key={getProductId(product) || product.name}
              accountCurrency={accountCurrency}
              deleting={deletingProductId === getProductId(product)}
              product={product}
              onDelete={() => onDeleteProduct(product)}
              onEdit={() => onEditProduct(product)}
            />
          ))}
        </View>
      )}
      <View style={styles.paymentsBottomSpacer} />
    </ScrollView>
  );
}

function ProductListItem({
  accountCurrency,
  deleting,
  product,
  onDelete,
  onEdit,
}: {
  accountCurrency: string;
  deleting: boolean;
  product: ProductItem;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const price = getPrimaryPrice(product);
  const amount = getPriceAmount(price);
  return (
    <View style={styles.productItem}>
      <View style={styles.productItemMain}>
        <View style={styles.productItemIcon}>
          <Package size={20} color="#15803d" strokeWidth={2.4} />
        </View>
        <View style={styles.productItemCopy}>
          <Text numberOfLines={1} style={styles.productItemTitle}>{product.name || 'Producto sin nombre'}</Text>
          <Text numberOfLines={1} style={styles.productItemDescription}>{product.description || 'Sin descripción'}</Text>
          <Text numberOfLines={1} style={styles.productItemPrice}>
            {price ? `${price.name || 'Precio'} · ${formatCurrency(amount, price.currency || product.currency || accountCurrency)}` : 'Sin precio guardado'}
          </Text>
        </View>
      </View>
      <View style={styles.productItemActions}>
        <Pressable accessibilityRole="button" onPress={onEdit} style={styles.productItemActionButton}>
          <Pencil size={17} color={COLORS.text} strokeWidth={2.4} />
        </Pressable>
        <Pressable accessibilityRole="button" disabled={deleting} onPress={onDelete} style={[styles.productItemActionButton, styles.productDeleteButton, deleting && styles.disabledButton]}>
          {deleting ? <ActivityIndicator color={COLORS.danger} size="small" /> : <Trash2 size={17} color={COLORS.danger} strokeWidth={2.4} />}
        </Pressable>
      </View>
    </View>
  );
}

function PaymentFormView({
  api,
  currency,
  mode,
  timezone,
  onBack,
  onSaved,
}: {
  api: RistakApiClient;
  currency: string;
  mode: Exclude<PaymentView, 'select' | 'products'>;
  timezone: string;
  onBack: () => void;
  onSaved: () => void;
}) {
  const [selectedContact, setSelectedContact] = useState<ChatContact | null>(null);
  const [contactQuery, setContactQuery] = useState('');
  const [contactResults, setContactResults] = useState<ChatContact[]>([]);
  const [contactSearching, setContactSearching] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [concept, setConcept] = useState('');
  const [method, setMethod] = useState('cash');
  const [status, setStatus] = useState('paid');
  const [firstPayment, setFirstPayment] = useState('');
  const [paymentCount, setPaymentCount] = useState('3');
  const [frequency, setFrequency] = useState('monthly');
  const [provider, setProvider] = useState('stripe');
  const [intervalType, setIntervalType] = useState('monthly');
  const [intervalCount, setIntervalCount] = useState('1');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const query = contactQuery.trim();
    if (selectedContact || query.length < 2) {
      setContactResults([]);
      setContactSearching(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setContactSearching(true);
      api.searchContacts(query)
        .then((results) => {
          if (!cancelled) setContactResults(Array.isArray(results) ? results.slice(0, 8) : []);
        })
        .catch(() => {
          if (!cancelled) setContactResults([]);
        })
        .finally(() => {
          if (!cancelled) setContactSearching(false);
        });
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, contactQuery, selectedContact]);

  const resolvedContactName = selectedContact ? getContactName(selectedContact) : contactName.trim();
  const resolvedContactEmail = selectedContact?.email || contactEmail.trim();
  const resolvedContactPhone = selectedContact?.phone || contactPhone.trim();
  const title = mode === 'single'
    ? 'Registrar pago único'
    : mode === 'partial'
      ? 'Planes de pago'
      : 'Suscripción';
  const subtitle = mode === 'single'
    ? 'Cobro manual inmediato desde el celular.'
    : mode === 'partial'
      ? 'Define enganche y cobros restantes.'
      : 'Crea un cobro recurrente con la pasarela disponible.';

  const clearSelectedContact = () => {
    setSelectedContact(null);
    setContactQuery('');
    setContactResults([]);
  };

  const submit = async () => {
    const parsedAmount = normalizeAmountInput(amount);
    const paymentConcept = concept.trim() || (mode === 'subscription' ? 'Suscripción' : mode === 'partial' ? 'Plan de parcialidades' : 'Pago');
    if (parsedAmount <= 0) {
      Alert.alert('Falta el monto', 'Escribe un monto válido para continuar.');
      return;
    }
    if (!resolvedContactName && !resolvedContactEmail && !resolvedContactPhone) {
      Alert.alert('Falta el cliente', 'Selecciona un contacto o escribe nombre, correo o teléfono.');
      return;
    }

    setSaving(true);
    try {
      if (mode === 'single') {
        await api.createTransaction({
          id: `native_payment_${Date.now()}`,
          amount: parsedAmount,
          currency,
          method,
          status,
          title: paymentConcept,
          description: paymentConcept,
          date: new Date().toISOString(),
          contactId: selectedContact?.id,
          contactName: resolvedContactName,
          email: resolvedContactEmail,
          phone: resolvedContactPhone,
          metadata: { source: 'native_mobile_payments' },
        });
        Alert.alert('Pago registrado', `${formatCurrency(parsedAmount, currency)} quedó guardado.`);
        onSaved();
        return;
      }

      if (mode === 'partial') {
        if (!selectedContact?.id) {
          Alert.alert('Selecciona un contacto', 'Las parcialidades necesitan un contacto guardado para crear el flujo.');
          return;
        }
        const today = todayDateOnlyInTimezone(timezone);
        const count = Math.max(1, Math.round(Number(paymentCount) || 1));
        const firstAmount = Math.min(parsedAmount, Math.max(0, normalizeAmountInput(firstPayment)));
        const remainingTotal = Math.max(0, Math.round((parsedAmount - firstAmount) * 100) / 100);
        if (remainingTotal <= 0) {
          Alert.alert('Faltan pagos restantes', 'Deja una parte del total para los cobros restantes.');
          return;
        }
        const installmentAmount = Math.round((remainingTotal / count) * 100) / 100;
        const remainderFix = Math.round((remainingTotal - installmentAmount * count) * 100) / 100;
        const stepDays = frequency === 'weekly' ? 7 : frequency === 'biweekly' ? 14 : 30;
        await api.createInstallmentFlow({
          contact: {
            id: selectedContact.id,
            name: getContactName(selectedContact),
            email: selectedContact.email,
            phone: selectedContact.phone,
          },
          totalAmount: parsedAmount,
          currency,
          concept: paymentConcept,
          description: paymentConcept,
          firstPayment: firstAmount > 0
            ? { enabled: true, type: 'amount', value: firstAmount, amount: firstAmount, date: today, method }
            : { enabled: false },
          remainingAutomatic: false,
          remainingFrequency: 'custom',
          remainingPayments: Array.from({ length: count }).map((_, index) => ({
            sequence: index + 1,
            type: 'amount',
            amount: index === count - 1 ? Math.round((installmentAmount + remainderFix) * 100) / 100 : installmentAmount,
            dueDate: addDateOnlyDays(today, stepDays * (index + 1)),
            paymentMethod: 'manual',
          })),
          source: 'native_mobile_payments',
        });
        Alert.alert('Plan creado', 'Las parcialidades quedaron guardadas.');
        onSaved();
        return;
      }

      const startDate = todayDateOnlyInTimezone(timezone);
      await api.createSubscription({
        contactId: selectedContact?.id || null,
        contactName: resolvedContactName,
        contactEmail: resolvedContactEmail || null,
        contactPhone: resolvedContactPhone || null,
        name: paymentConcept,
        description: paymentConcept,
        status: provider === 'mercadopago' || provider === 'clip' ? 'incomplete' : 'active',
        amount: parsedAmount,
        currency,
        intervalType,
        intervalCount: Math.max(1, Math.round(Number(intervalCount) || 1)),
        startDate,
        nextRunAt: provider === 'mercadopago' || provider === 'clip' ? null : startDate,
        paymentMethod: getSubscriptionPaymentMethod(provider),
        paymentProvider: provider,
      });
      Alert.alert('Suscripción creada', `${paymentConcept} quedó guardada.`);
      onSaved();
    } catch (err) {
      Alert.alert('No se guardó', err instanceof Error ? err.message : 'Intenta otra vez.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.paymentFormHost} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <View style={styles.productsTopBar}>
        <Pressable accessibilityRole="button" onPress={onBack} style={({ pressed }) => [styles.paymentsBackButton, pressed && styles.pressed]}>
          <ChevronLeft size={19} color={COLORS.text} strokeWidth={2.5} />
          <Text style={styles.paymentsBackText}>Atrás</Text>
        </Pressable>
      </View>
      <View style={styles.paymentFormHeader}>
        <Text style={styles.paymentFormTitle}>{title}</Text>
        <Text style={styles.paymentFormSubtitle}>{subtitle}</Text>
      </View>

      <View style={styles.paymentFormBlock}>
        <Text style={styles.paymentFormBlockTitle}>Cliente</Text>
        {selectedContact ? (
          <View style={styles.selectedContactCard}>
            <View style={styles.selectedContactIcon}>
              <User size={22} color={COLORS.accent} strokeWidth={2.4} />
            </View>
            <View style={styles.selectedContactCopy}>
              <Text numberOfLines={1} style={styles.selectedContactName}>{getContactName(selectedContact)}</Text>
              <Text numberOfLines={1} style={styles.selectedContactDetail}>{selectedContact.email || selectedContact.phone || 'Contacto guardado'}</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={clearSelectedContact} style={styles.clearSearchButton}>
              <X size={17} color={COLORS.muted} strokeWidth={2.45} />
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.sheetSearchBox}>
              <Search size={19} color={COLORS.muted} strokeWidth={2.4} />
              <TextInput
                value={contactQuery}
                onChangeText={setContactQuery}
                placeholder="Buscar contacto"
                placeholderTextColor={COLORS.muted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.sheetSearchInput}
              />
            </View>
            {contactSearching ? (
              <View style={styles.paymentInlineLoading}>
                <ActivityIndicator color={COLORS.accent} size="small" />
                <Text style={styles.caption}>Buscando...</Text>
              </View>
            ) : contactResults.length ? (
              <View style={styles.contactSearchResults}>
                {contactResults.map((contact) => (
                  <ContactPickerRow
                    key={contact.id}
                    contact={contact}
                    onPress={() => {
                      setSelectedContact(contact);
                      setContactQuery('');
                      setContactResults([]);
                    }}
                  />
                ))}
              </View>
            ) : null}
            <PaymentTextField label="Nombre manual" value={contactName} onChangeText={setContactName} placeholder="Cliente sin guardar" />
            <PaymentTextField label="Correo" value={contactEmail} onChangeText={setContactEmail} placeholder="correo@cliente.com" keyboardType="email-address" />
            <PaymentTextField label="Teléfono" value={contactPhone} onChangeText={setContactPhone} placeholder="+52..." keyboardType="phone-pad" />
          </>
        )}
      </View>

      <View style={styles.paymentFormBlock}>
        <Text style={styles.paymentFormBlockTitle}>Cobro</Text>
        <PaymentTextField label={`Monto (${currency})`} value={amount} onChangeText={setAmount} placeholder="0.00" keyboardType="decimal-pad" />
        <PaymentTextField label={mode === 'subscription' ? 'Nombre de la suscripción' : 'Concepto'} value={concept} onChangeText={setConcept} placeholder="Ej. Consulta inicial" />

        {mode === 'single' ? (
          <>
            <PaymentOptionGroup label="Método" value={method} options={PAYMENT_METHOD_OPTIONS} onChange={setMethod} />
            <PaymentOptionGroup label="Estado" value={status} options={PAYMENT_STATUS_OPTIONS} onChange={setStatus} />
          </>
        ) : null}

        {mode === 'partial' ? (
          <>
            <PaymentTextField label={`Primer pago (${currency})`} value={firstPayment} onChangeText={setFirstPayment} placeholder="0.00" keyboardType="decimal-pad" />
            <PaymentTextField label="Pagos restantes" value={paymentCount} onChangeText={setPaymentCount} placeholder="3" keyboardType="number-pad" />
            <PaymentOptionGroup label="Frecuencia" value={frequency} options={PAYMENT_FREQUENCY_OPTIONS} onChange={setFrequency} />
            <PaymentOptionGroup label="Método del primer pago" value={method} options={PAYMENT_METHOD_OPTIONS} onChange={setMethod} />
          </>
        ) : null}

        {mode === 'subscription' ? (
          <>
            <PaymentOptionGroup label="Pasarela" value={provider} options={SUBSCRIPTION_PROVIDER_OPTIONS} onChange={setProvider} />
            <PaymentOptionGroup label="Frecuencia" value={intervalType} options={SUBSCRIPTION_INTERVAL_OPTIONS} onChange={setIntervalType} />
            <PaymentTextField label="Cada cuántos periodos" value={intervalCount} onChangeText={setIntervalCount} placeholder="1" keyboardType="number-pad" />
          </>
        ) : null}
      </View>

      <Pressable accessibilityRole="button" disabled={saving} onPress={() => void submit()} style={[styles.paymentSubmitButton, saving && styles.disabledButton]}>
        {saving ? <ActivityIndicator color={COLORS.white} /> : <DollarSign size={20} color={COLORS.white} strokeWidth={2.6} />}
        <Text style={styles.paymentSubmitText}>{saving ? 'Guardando...' : mode === 'single' ? 'Registrar pago' : mode === 'partial' ? 'Crear plan' : 'Crear suscripción'}</Text>
      </Pressable>
      <View style={styles.paymentsBottomSpacer} />
    </ScrollView>
  );
}

function PaymentTextField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  multiline,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'decimal-pad' | 'number-pad';
  multiline?: boolean;
}) {
  return (
    <View style={styles.paymentField}>
      <Text style={styles.paymentFieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={COLORS.muted}
        keyboardType={keyboardType}
        multiline={multiline}
        autoCapitalize="sentences"
        style={[styles.paymentFieldInput, multiline && styles.paymentFieldInputMultiline]}
      />
    </View>
  );
}

function PaymentOptionGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ label: string; value: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.paymentField}>
      <Text style={styles.paymentFieldLabel}>{label}</Text>
      <View style={styles.paymentOptionGrid}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => onChange(option.value)}
              style={[styles.paymentOptionPill, selected && styles.paymentOptionPillActive]}
            >
              <Text style={[styles.paymentOptionText, selected && styles.paymentOptionTextActive]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function unwrapConfigValues(response: Awaited<ReturnType<RistakApiClient['getConfig']>>): Record<string, unknown> {
  if (response && typeof response === 'object' && 'config' in response) {
    return response.config && typeof response.config === 'object'
      ? response.config as Record<string, unknown>
      : {};
  }
  return response && typeof response === 'object' && !Array.isArray(response)
    ? response as Record<string, unknown>
    : {};
}

function getCalendarKey(calendar?: CalendarItem | null) {
  return String(calendar?.id || calendar?._id || '').trim();
}

function getCalendarTitle(calendar?: CalendarItem | null) {
  return String(calendar?.name || calendar?.title || 'Calendario').trim();
}

function getCalendarColor(calendar?: CalendarItem | null) {
  const value = String(calendar?.eventColor || calendar?.event_color || calendar?.color || '').trim();
  return value.startsWith('#') || value.startsWith('rgb') ? value : COLORS.accent;
}

function getCalendarType(calendar?: CalendarItem | null) {
  return String(calendar?.calendarType || calendar?.calendar_type || '').trim().toLowerCase();
}

function isRoundRobinCalendar(calendar?: CalendarItem | null) {
  return getCalendarType(calendar) === 'round_robin';
}

function isHighLevelCalendar(calendar?: CalendarItem | null) {
  return String(calendar?.source || calendar?.provider || '').trim().toLowerCase() === 'ghl'
    || Boolean(calendar?.ghlCalendarId || calendar?.ghl_calendar_id);
}

function calendarIsActive(calendar: CalendarItem) {
  if (calendar.isActive === false || calendar.active === false) return false;
  return true;
}

function getCalendarTeamMemberId(member: NonNullable<CalendarItem['teamMembers']>[number]) {
  return String(member.userId || member.user_id || member.id || '').trim();
}

function getCalendarUserId(user?: CalendarUser | null) {
  return String(user?.id || user?._id || user?.userId || '').trim();
}

function getCalendarUserLabel(user?: CalendarUser | null) {
  const firstLast = `${String(user?.firstName || '').trim()} ${String(user?.lastName || '').trim()}`.trim();
  return String(user?.name || firstLast || user?.email || getCalendarUserId(user) || 'Usuario').trim();
}

function getCalendarUserDetail(user?: CalendarUser | null) {
  return String(user?.email || getCalendarUserId(user)).trim();
}

function unwrapCalendarUsers(response: Awaited<ReturnType<RistakApiClient['getCalendarUsers']>>) {
  const users = response && Array.isArray(response.users) ? response.users : [];
  return users.filter((user) => getCalendarUserId(user));
}

function unwrapCalendars(response: Awaited<ReturnType<RistakApiClient['getCalendars']>>) {
  const raw = Array.isArray(response)
    ? response
    : Array.isArray(response.calendars) ? response.calendars : [];
  return raw.filter((calendar) => getCalendarKey(calendar));
}

function unwrapCalendarEvents(response: Awaited<ReturnType<RistakApiClient['getCalendarEvents']>>) {
  return Array.isArray(response)
    ? response
    : Array.isArray(response.events) ? response.events : [];
}

function getEventKey(event: CalendarEventItem, index = 0) {
  return String(event.id || event._id || `${getEventStart(event)}-${index}`);
}

function getEventId(event?: CalendarEventItem | null) {
  return String(event?.id || event?._id || '').trim();
}

function getEventTitle(event: CalendarEventItem) {
  return String(event.title || event.name || event.contactName || event.contact_name || 'Cita').trim();
}

function getEventStatus(event: CalendarEventItem) {
  const raw = String(event.appointmentStatus || event.appointment_status || event.status || 'confirmed').toLowerCase();
  const labels: Record<string, string> = {
    confirmed: 'Confirmada',
    pending: 'Pendiente',
    cancelled: 'Cancelada',
    canceled: 'Cancelada',
    showed: 'Asistió',
    noshow: 'No asistió',
    no_show: 'No asistió',
    rescheduled: 'Reprogramada',
  };
  return labels[raw] || raw || 'Programada';
}

function getEventStart(event: CalendarEventItem) {
  return event.startTime || event.start_time || event.start || '';
}

function getEventEnd(event: CalendarEventItem) {
  return event.endTime || event.end_time || event.end || getEventStart(event);
}

function getEventCalendarId(event: CalendarEventItem) {
  return String(event.calendarId || event.calendar_id || '').trim();
}

function getEventContactId(event?: CalendarEventItem | null) {
  return String(event?.contactId || event?.contact_id || '').trim();
}

function getEventTimezone(event?: CalendarEventItem | null) {
  return String(event?.timeZone || event?.timezone || event?.time_zone || '').trim();
}

function getEventDetail(event: CalendarEventItem) {
  return String(event.address || event.location || event.notes || event.description || '').trim();
}

function sortCalendarEvents(left: CalendarEventItem, right: CalendarEventItem) {
  return getEventStart(left).localeCompare(getEventStart(right));
}

function getDefaultAppointmentStartTime(dateOnly: string, timezone: string) {
  const nowParts = getBusinessDateTimeParts(new Date(), timezone);
  if (!nowParts || formatBusinessYear(dateOnly) !== String(nowParts.year)) return '09:00';
  const today = `${nowParts.year}-${String(nowParts.month).padStart(2, '0')}-${String(nowParts.day).padStart(2, '0')}`;
  if (today !== dateOnly) return '09:00';
  const nextHalfHour = Math.ceil((nowParts.hour * 60 + nowParts.minute + 15) / 30) * 30;
  const clamped = Math.min(23 * 60, Math.max(8 * 60, nextHalfHour));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

function getBusinessRangeTimestamps(startDateOnly: string, endDateOnly: string, timezone: string) {
  const startIso = localBusinessDateTimeToUTCISOString(startDateOnly, '00:00', timezone);
  const endExclusiveIso = localBusinessDateTimeToUTCISOString(addBusinessDateOnlyDays(endDateOnly, 1), '00:00', timezone);
  const startTime = startIso ? new Date(startIso).getTime() : Number.NaN;
  const endTime = endExclusiveIso ? new Date(endExclusiveIso).getTime() - 1 : Number.NaN;
  return { startTime, endTime };
}

function formatCalendarAgendaDate(dateOnly: string) {
  const label = formatBusinessDayHeader(dateOnly);
  if (!label) return '';
  const capitalized = `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
  return capitalized;
}

function getDateOnlyYear(dateOnly: string) {
  const date = dateOnlyToCalendarDate(dateOnly);
  return date?.getFullYear() || new Date().getFullYear();
}

function getDateOnlyMonthIndex(dateOnly: string) {
  const date = dateOnlyToCalendarDate(dateOnly);
  return date?.getMonth() || 0;
}

function buildYearMonthDateOnly(year: number, monthIndex: number) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`;
}

function getBusinessWeekRange(dateOnly: string) {
  const selectedDate = dateOnlyToCalendarDate(dateOnly) || new Date();
  const start = new Date(selectedDate);
  start.setDate(selectedDate.getDate() - selectedDate.getDay());
  const days = Array.from({ length: 7 }).map((_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return dateOnlyFromCalendarDate(day);
  });
  return {
    days,
    startDate: days[0] || dateOnly,
    endDate: days[6] || dateOnly,
  };
}

function getYearsGridForDate(dateOnly: string) {
  const selectedYear = getDateOnlyYear(dateOnly);
  const startYear = Math.floor(selectedYear / YEAR_GRID_SIZE) * YEAR_GRID_SIZE;
  return Array.from({ length: YEAR_GRID_SIZE }).map((_, index) => startYear + index);
}

function normalizeCalendarMinutes(value?: number | null, unit?: string | null) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const normalizedUnit = String(unit || 'mins').toLowerCase();
  if (normalizedUnit.startsWith('hour')) return amount * 60;
  return amount;
}

function getCalendarSlotDurationMinutes(calendar?: CalendarItem | null) {
  return Math.max(
    15,
    Math.min(
      TIMELINE_TOTAL_MINUTES,
      normalizeCalendarMinutes(calendar?.slotDuration || calendar?.slot_duration, calendar?.slotDurationUnit || calendar?.slot_duration_unit) || 60,
    ),
  );
}

function getCalendarSnapMinutes(calendar?: CalendarItem | null) {
  return Math.max(
    5,
    Math.min(
      60,
      normalizeCalendarMinutes(calendar?.slotInterval || calendar?.slot_interval, calendar?.slotIntervalUnit || calendar?.slot_interval_unit)
        || normalizeCalendarMinutes(calendar?.slotDuration || calendar?.slot_duration, calendar?.slotDurationUnit || calendar?.slot_duration_unit)
        || 15,
    ),
  );
}

function parseTimeToMinutes(value?: string | null) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function formatMinutesAsTime(minutes: number) {
  const clamped = Math.max(0, Math.min(TIMELINE_TOTAL_MINUTES - 1, Math.round(minutes)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

function formatTimelineHour(hour: number) {
  if (hour === 0) return '12 a.m.';
  if (hour === 12) return '12 p.m.';
  return hour > 12 ? `${hour - 12} p.m.` : `${hour} a.m.`;
}

function formatAppointmentDateField(dateOnly: string) {
  const day = formatDateOnlyDayNumber(dateOnly);
  const month = formatBusinessShortMonthTitle(dateOnly);
  const year = formatBusinessYear(dateOnly);
  if (!day || !month || !year) return dateOnly;
  return `${day} ${month.charAt(0).toUpperCase()}${month.slice(1)} ${year}`;
}

function formatAppointmentTimeField(time: string) {
  const minutes = parseTimeToMinutes(time);
  if (minutes === null) return time;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const period = hour >= 12 ? 'p.m.' : 'a.m.';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${period}`;
}

function formatAppointmentDurationLabel(minutes: number) {
  if (minutes === 60) return '1 hora';
  if (minutes < 60) return `${minutes} minutos`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} horas`;
}

function createAppointmentGuestId() {
  return `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getContactDelivery(contact?: ChatContact | null) {
  return String(contact?.phone || contact?.email || '').trim();
}

function getDaysInMonth(year: number, month: number) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return 31;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildDateOnlyFromParts(year: number, month: number, day: number) {
  const safeMonth = Math.max(1, Math.min(12, Math.round(month || 1)));
  const safeDay = Math.max(1, Math.min(getDaysInMonth(year, safeMonth), Math.round(day || 1)));
  return `${String(Math.round(year)).padStart(4, '0')}-${String(safeMonth).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

function buildAppointmentGuestNotes(guests: AppointmentGuest[] = []) {
  const lines = guests
    .map((guest) => {
      const name = guest.name.trim();
      const contact = guest.contact.trim();
      return name && contact ? `- ${name}: ${contact}` : '';
    })
    .filter(Boolean);
  return lines.length ? `${APPOINTMENT_GUESTS_NOTE_HEADER}\n${lines.join('\n')}` : '';
}

function splitAppointmentNotesAndGuests(value?: string | null): { notes: string; guests: AppointmentGuest[] } {
  const raw = String(value || '').trim();
  if (!raw) return { notes: '', guests: [] };
  const spacedMarker = `\n\n${APPOINTMENT_GUESTS_NOTE_HEADER}\n`;
  const directMarker = `${APPOINTMENT_GUESTS_NOTE_HEADER}\n`;
  let markerIndex = raw.lastIndexOf(spacedMarker);
  let notes = raw;
  let guestBlock = '';
  if (markerIndex >= 0) {
    notes = raw.slice(0, markerIndex).trimEnd();
    guestBlock = raw.slice(markerIndex + spacedMarker.length);
  } else if (raw.startsWith(directMarker)) {
    notes = '';
    guestBlock = raw.slice(directMarker.length);
  }

  if (!guestBlock) return { notes: raw, guests: [] };
  const guests = guestBlock
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^-\s*(.+?):\s*(.+)$/);
      if (!match) return null;
      return {
        id: createAppointmentGuestId(),
        name: match[1].trim(),
        contact: match[2].trim(),
      };
    })
    .filter((guest): guest is AppointmentGuest => Boolean(guest?.name && guest?.contact));
  return { notes, guests };
}

function buildAppointmentNotesWithGuests(notes: string, guests: AppointmentGuest[] = []) {
  const baseNotes = String(notes || '').trim();
  const guestNotes = buildAppointmentGuestNotes(guests);
  return [baseNotes, guestNotes].filter(Boolean).join('\n\n');
}

function triggerTimelineSelectionHaptic() {
  void Haptics.selectionAsync().catch(() => {
    Vibration.vibrate(12);
  });
}

function formatDateOnlyDayNumber(dateOnly: string) {
  const date = dateOnlyToCalendarDate(dateOnly);
  return date?.getDate() || 0;
}

function getTimelineMinutesFromY(y: number, snapMinutes: number) {
  const anchorAdjustedY = Math.max(0, Math.min(TIMELINE_GRID_HEIGHT, y - TIMELINE_TOUCH_ANCHOR_OFFSET_PX));
  const rawMinutes = (anchorAdjustedY / TIMELINE_GRID_HEIGHT) * TIMELINE_TOTAL_MINUTES;
  const roundedMinutes = Math.round(rawMinutes / snapMinutes) * snapMinutes;
  return Math.max(0, Math.min(TIMELINE_TOTAL_MINUTES - 15, roundedMinutes));
}

function getEventTimelineEntry(event: CalendarEventItem, timezone: string) {
  const startFields = isoToBusinessDateTimeFields(getEventStart(event), timezone);
  const endFields = isoToBusinessDateTimeFields(getEventEnd(event), timezone);
  const startMinutes = parseTimeToMinutes(startFields.time);
  const rawEndMinutes = parseTimeToMinutes(endFields.time);
  if (startMinutes === null) return null;
  const endMinutes = Math.max(startMinutes + 30, rawEndMinutes === null ? startMinutes + 60 : rawEndMinutes);
  const visibleStart = Math.max(0, startMinutes);
  const visibleEnd = Math.min(TIMELINE_TOTAL_MINUTES, endMinutes);
  return {
    top: (visibleStart / TIMELINE_TOTAL_MINUTES) * TIMELINE_GRID_HEIGHT,
    height: Math.max(28, ((visibleEnd - visibleStart) / TIMELINE_TOTAL_MINUTES) * TIMELINE_GRID_HEIGHT),
  };
}

function getNowMinutesForDate(dateOnly: string, timezone: string) {
  const parts = getBusinessDateTimeParts(new Date(), timezone);
  if (!parts) return null;
  const today = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  if (today !== dateOnly) return null;
  return parts.hour * 60 + parts.minute;
}

function extractAppointmentIdFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('open') === 'appointment'
      ? parsed.searchParams.get('id') || ''
      : '';
  } catch {
    const openMatch = url.match(/[?&]open=appointment(?:&|$)/);
    const idMatch = url.match(/[?&]id=([^&#]+)/);
    return openMatch && idMatch ? decodeURIComponent(idMatch[1] || '') : '';
  }
}

function CalendarSection({ api, footer }: { api: RistakApiClient; footer?: React.ReactNode }) {
  const initialToday = useMemo(() => todayDateOnlyInBusinessTimezone(), []);
  const { width: viewportWidth } = useWindowDimensions();
  const [businessTimezone, setBusinessTimezone] = useState(resolveBusinessTimezone());
  const [calendarView, setCalendarView] = useState<CalendarViewMode>('month');
  const [currentMonthDateOnly, setCurrentMonthDateOnly] = useState(initialToday);
  const [selectedDateOnly, setSelectedDateOnly] = useState(initialToday);
  const [calendars, setCalendars] = useState<CalendarItem[]>([]);
  const [selectedCalendarId, setSelectedCalendarId] = useState('');
  const [calendarReady, setCalendarReady] = useState(false);
  const [events, setEvents] = useState<CalendarEventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [activeSheet, setActiveSheet] = useState<CalendarSheetMode>(null);
  const [closingSheet, setClosingSheet] = useState<CalendarSheetMode>(null);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEventItem | null>(null);
  const [appointmentMode, setAppointmentMode] = useState<AppointmentFormMode>('create');
  const [appointmentDraft, setAppointmentDraft] = useState<AppointmentDraft | null>(null);
  const [appointmentBusy, setAppointmentBusy] = useState(false);
  const [contactQuery, setContactQuery] = useState('');
  const [contactResults, setContactResults] = useState<ChatContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [pendingAppointmentDefaults, setPendingAppointmentDefaults] = useState<PendingAppointmentDefaults | null>(null);
  const [timelineSelection, setTimelineSelection] = useState<TimelineSelectionState | null>(null);
  const [monthSwipeWidth, setMonthSwipeWidth] = useState(0);
  const monthSwipeTranslate = useRef(new Animated.Value(0)).current;
  const timelineSelectionRef = useRef<TimelineSelectionState | null>(null);
  const timelinePendingTouchRef = useRef<TimelinePendingTouch | null>(null);
  const timelineSwipeRef = useRef<{ dateOnly: string; x: number; y: number; dx: number; dy: number } | null>(null);
  const handledOpenAppointmentRef = useRef('');
  const lastDayTapRef = useRef<{ dateOnly: string; at: number } | null>(null);
  const sheetCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeCalendars = useMemo(() => calendars.filter(calendarIsActive), [calendars]);
  const selectedCalendar = useMemo(() => {
    return calendars.find((calendar) => getCalendarKey(calendar) === selectedCalendarId) || activeCalendars[0] || calendars[0] || null;
  }, [activeCalendars, calendars, selectedCalendarId]);
  const selectedCalendarKey = getCalendarKey(selectedCalendar);
  const todayDateOnly = useMemo(() => todayDateOnlyInBusinessTimezone(businessTimezone), [businessTimezone]);
  const monthPages = useMemo(() => [-1, 0, 1].map((offset) => {
    const pageDateOnly = addBusinessDateOnlyMonths(currentMonthDateOnly, offset);
    return {
      key: `${pageDateOnly}-${offset}`,
      offset,
      dateOnly: pageDateOnly,
      cells: buildBusinessMonthCells(pageDateOnly, todayDateOnly),
    };
  }), [currentMonthDateOnly, todayDateOnly]);
  const headerTitleSwipeWidth = monthSwipeWidth || Math.max(1, viewportWidth - 30);
  const monthRange = useMemo(() => getBusinessMonthRange(currentMonthDateOnly), [currentMonthDateOnly]);
  const weekRange = useMemo(() => getBusinessWeekRange(selectedDateOnly), [selectedDateOnly]);
  const yearsGrid = useMemo(() => getYearsGridForDate(currentMonthDateOnly), [currentMonthDateOnly]);
  const eventRange = useMemo(() => {
    if (calendarView === 'year' || calendarView === 'years') {
      const year = getDateOnlyYear(currentMonthDateOnly);
      return {
        startDate: `${year}-01-01`,
        endDate: `${year}-12-31`,
      };
    }

    if (calendarView === 'week') {
      return {
        startDate: weekRange.startDate,
        endDate: weekRange.endDate,
      };
    }

    if (calendarView === 'day') {
      return {
        startDate: selectedDateOnly,
        endDate: selectedDateOnly,
      };
    }

    return {
      startDate: monthRange.gridStart,
      endDate: monthRange.gridEnd,
    };
  }, [calendarView, currentMonthDateOnly, monthRange.gridEnd, monthRange.gridStart, selectedDateOnly, weekRange.endDate, weekRange.startDate]);
  const eventRangeTimestamps = useMemo(
    () => getBusinessRangeTimestamps(eventRange.startDate, eventRange.endDate, businessTimezone),
    [businessTimezone, eventRange.endDate, eventRange.startDate],
  );
  const calendarEventCacheKey = useMemo(() => [
    selectedCalendarKey || 'none',
    businessTimezone,
    eventRange.startDate,
    eventRange.endDate,
  ].join('|'), [businessTimezone, eventRange.endDate, eventRange.startDate, selectedCalendarKey]);

  const eventsByDate = useMemo(() => {
    const grouped: Record<string, CalendarEventItem[]> = {};
    events.forEach((event) => {
      const dateOnly = getBusinessDateOnly(getEventStart(event), businessTimezone);
      if (!dateOnly) return;
      if (!grouped[dateOnly]) grouped[dateOnly] = [];
      grouped[dateOnly].push(event);
    });
    Object.keys(grouped).forEach((dateOnly) => {
      grouped[dateOnly].sort(sortCalendarEvents);
    });
    return grouped;
  }, [businessTimezone, events]);

  const weekDays = useMemo(() => weekRange.days.map((dateOnly) => ({
    dateOnly,
    events: eventsByDate[dateOnly] || [],
  })), [eventsByDate, weekRange.days]);

  const selectedDayEvents = useMemo(
    () => eventsByDate[selectedDateOnly] || [],
    [eventsByDate, selectedDateOnly],
  );

  const weekEvents = useMemo(() => {
    if (calendarView !== 'week') return [];
    return events
      .filter((event) => {
        const dateOnly = getBusinessDateOnly(getEventStart(event), businessTimezone);
        return dateOnly >= eventRange.startDate && dateOnly <= eventRange.endDate;
      })
      .slice()
      .sort(sortCalendarEvents);
  }, [businessTimezone, calendarView, eventRange.endDate, eventRange.startDate, events]);

  const agendaEvents = calendarView === 'week' ? weekEvents : selectedDayEvents;

  const nextUpcomingEvents = useMemo(() => {
    return events
      .filter((event) => getEventStart(event))
      .slice()
      .sort(sortCalendarEvents)
      .slice(0, 6);
  }, [events]);

  const selectDate = useCallback((dateOnly: string) => {
    setSelectedDateOnly(dateOnly);
    setCurrentMonthDateOnly(dateOnly);
    if (calendarView === 'year' || calendarView === 'years') setCalendarView('month');
  }, [calendarView]);

  const movePeriod = useCallback((direction: -1 | 1) => {
    if (calendarView === 'month' || calendarView === 'year' || calendarView === 'years') {
      const next = calendarView === 'years'
        ? addBusinessDateOnlyMonths(currentMonthDateOnly, direction * YEAR_GRID_SIZE * 12)
        : calendarView === 'year'
        ? addBusinessDateOnlyMonths(currentMonthDateOnly, direction * 12)
        : addBusinessDateOnlyMonths(currentMonthDateOnly, direction);
      setCurrentMonthDateOnly(next);
      setSelectedDateOnly((current) => {
        const currentDate = dateOnlyToCalendarDate(current);
        const nextDate = dateOnlyToCalendarDate(next);
        if (!currentDate || !nextDate) return next;
        const targetMonthEnd = getBusinessMonthRange(next).monthEnd;
        const daysInTargetMonth = formatDateOnlyDayNumber(targetMonthEnd) || 28;
        const target = new Date(
          nextDate.getFullYear(),
          nextDate.getMonth(),
          Math.min(currentDate.getDate(), daysInTargetMonth),
          12,
          0,
          0,
          0,
        );
        return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
      });
      return;
    }

    const days = calendarView === 'week' ? 7 : 1;
    const next = addBusinessDateOnlyDays(selectedDateOnly, direction * days);
    setSelectedDateOnly(next);
    setCurrentMonthDateOnly(next);
  }, [calendarView, currentMonthDateOnly, selectedDateOnly]);

  const handleNavigateUp = useCallback(() => {
    if (calendarView === 'month') {
      setCalendarView('year');
      return;
    }
    if (calendarView === 'year') {
      setCalendarView('years');
      return;
    }
    if (calendarView === 'years') {
      setCalendarView('year');
      return;
    }
    setCurrentMonthDateOnly(selectedDateOnly);
    setCalendarView('month');
  }, [calendarView, selectedDateOnly]);

  const handleQuickReturn = useCallback(() => {
    const today = todayDateOnlyInBusinessTimezone(businessTimezone);
    setSelectedDateOnly(today);
    setCurrentMonthDateOnly(today);
    if (calendarView === 'year') {
      setCalendarView('month');
      return;
    }
    if (calendarView === 'years') {
      setCalendarView('year');
      return;
    }
    setCalendarView('day');
  }, [businessTimezone, calendarView]);

  const handleSelectCalendarView = useCallback((view: Exclude<CalendarViewMode, 'years'>) => {
    setCalendarView(view);
    setCurrentMonthDateOnly(selectedDateOnly);
  }, [selectedDateOnly]);

  const handleSelectMonthFromYear = useCallback((monthIndex: number) => {
    const year = getDateOnlyYear(currentMonthDateOnly);
    const currentDate = dateOnlyToCalendarDate(selectedDateOnly);
    const selectedDay = currentDate?.getDate() || 1;
    const targetMonthStart = buildYearMonthDateOnly(year, monthIndex);
    const range = getBusinessMonthRange(targetMonthStart);
    const daysInMonth = formatDateOnlyDayNumber(range.monthEnd);
    const nextDateOnly = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(Math.min(selectedDay, daysInMonth)).padStart(2, '0')}`;
    setSelectedDateOnly(nextDateOnly);
    setCurrentMonthDateOnly(nextDateOnly);
    setCalendarView('month');
  }, [currentMonthDateOnly, selectedDateOnly]);

  const handleSelectYear = useCallback((year: number) => {
    const selectedMonth = getDateOnlyMonthIndex(selectedDateOnly);
    const selectedDay = formatDateOnlyDayNumber(selectedDateOnly) || 1;
    const targetMonthStart = buildYearMonthDateOnly(year, selectedMonth);
    const range = getBusinessMonthRange(targetMonthStart);
    const daysInMonth = formatDateOnlyDayNumber(range.monthEnd);
    const nextDateOnly = `${year}-${String(selectedMonth + 1).padStart(2, '0')}-${String(Math.min(selectedDay, daysInMonth)).padStart(2, '0')}`;
    setSelectedDateOnly(nextDateOnly);
    setCurrentMonthDateOnly(nextDateOnly);
    setCalendarView('year');
  }, [selectedDateOnly]);

  useLayoutEffect(() => {
    if (monthSwipeWidth > 0) {
      monthSwipeTranslate.setValue(-monthSwipeWidth);
    }
  }, [currentMonthDateOnly, monthSwipeTranslate, monthSwipeWidth]);

  const finishMonthSwipe = useCallback((direction: -1 | 1) => {
    if (!monthSwipeWidth) return;
    Animated.timing(monthSwipeTranslate, {
      toValue: direction > 0 ? -monthSwipeWidth * 2 : 0,
      duration: 230,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      movePeriod(direction);
    });
  }, [monthSwipeTranslate, monthSwipeWidth, movePeriod]);

  const reboundMonthSwipe = useCallback(() => {
    if (!monthSwipeWidth) return;
    Animated.timing(monthSwipeTranslate, {
      toValue: -monthSwipeWidth,
      duration: 190,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [monthSwipeTranslate, monthSwipeWidth]);

  const monthPanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => (
      calendarView === 'month'
      && monthSwipeWidth > 0
      && Math.abs(gestureState.dx) > 8
      && Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.18
    ),
    onPanResponderGrant: () => {
      monthSwipeTranslate.stopAnimation();
    },
    onPanResponderMove: (_, gestureState) => {
      if (!monthSwipeWidth) return;
      const maxOffset = monthSwipeWidth * MONTH_SWIPE_MAX_OFFSET_RATIO;
      const offset = Math.sign(gestureState.dx) * Math.min(Math.abs(gestureState.dx), maxOffset);
      monthSwipeTranslate.setValue(-monthSwipeWidth + offset);
    },
    onPanResponderRelease: (_, gestureState) => {
      if (!monthSwipeWidth) return;
      const shouldCommit = Math.abs(gestureState.dx) >= Math.max(MONTH_SWIPE_MIN_PX, monthSwipeWidth * MONTH_SWIPE_COMMIT_RATIO);
      if (shouldCommit) {
        finishMonthSwipe(gestureState.dx < 0 ? 1 : -1);
        return;
      }
      reboundMonthSwipe();
    },
    onPanResponderTerminate: reboundMonthSwipe,
    onPanResponderTerminationRequest: () => false,
  }), [calendarView, finishMonthSwipe, monthSwipeTranslate, monthSwipeWidth, reboundMonthSwipe]);

  const handleMonthLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.max(1, event.nativeEvent.layout.width);
    setMonthSwipeWidth(width);
    monthSwipeTranslate.setValue(-width);
  }, [monthSwipeTranslate]);

  const openSheet = useCallback((sheet: Exclude<CalendarSheetMode, null>) => {
    if (sheetCloseTimerRef.current) {
      clearTimeout(sheetCloseTimerRef.current);
      sheetCloseTimerRef.current = null;
    }
    setClosingSheet(null);
    setActiveSheet(sheet);
  }, []);

  const closeSheet = useCallback(() => {
    const sheet = activeSheet;
    if (!sheet) return;
    setActiveSheet(null);
    setClosingSheet(sheet);
    sheetCloseTimerRef.current = setTimeout(() => {
      sheetCloseTimerRef.current = null;
      setClosingSheet(null);
      if (sheet === 'event') setSelectedEvent(null);
      if (sheet === 'appointmentForm') setAppointmentDraft(null);
    }, CHAT_SHEET_CLOSE_DURATION_MS);
  }, [activeSheet]);

  useEffect(() => {
    return () => {
      if (sheetCloseTimerRef.current) clearTimeout(sheetCloseTimerRef.current);
    };
  }, []);

  const chooseCalendar = useCallback((calendar: CalendarItem) => {
    const id = getCalendarKey(calendar);
    setSelectedCalendarId(id);
    void writeJsonValue(CALENDAR_SELECTED_ID_STORAGE_KEY, id);
    closeSheet();
  }, [closeSheet]);

  const loadCalendars = useCallback(async () => {
    const [configResponse, savedCalendarId, calendarsResponse] = await Promise.all([
      api.getConfig(['account_timezone', 'default_calendar_id']),
      readJsonValue(CALENDAR_SELECTED_ID_STORAGE_KEY, ''),
      api.getCalendars(),
    ]);
    const configValues = unwrapConfigValues(configResponse);
    const timezone = typeof configValues.account_timezone === 'string'
      ? configValues.account_timezone
      : '';
    const defaultCalendarId = typeof configValues.default_calendar_id === 'string'
      ? configValues.default_calendar_id
      : '';
    const nextTimezone = resolveBusinessTimezone(timezone);
    const calendarList = unwrapCalendars(calendarsResponse);
    const preferredId = [selectedCalendarId, savedCalendarId, defaultCalendarId]
      .map((value) => String(value || '').trim())
      .find((value) => value && calendarList.some((calendar) => getCalendarKey(calendar) === value && calendarIsActive(calendar)));
    const fallbackCalendar = calendarList.find(calendarIsActive) || calendarList[0] || null;
    const nextCalendarId = preferredId || getCalendarKey(fallbackCalendar);

    setBusinessTimezone(nextTimezone);
    setCalendars(calendarList);
    setSelectedCalendarId(nextCalendarId);
    setCalendarReady(true);
    if (nextCalendarId) {
      void writeJsonValue(CALENDAR_SELECTED_ID_STORAGE_KEY, nextCalendarId);
    }
  }, [api, selectedCalendarId]);

  const loadEvents = useCallback(async (silent = false) => {
    if (!selectedCalendarKey) {
      setEvents([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (!silent) setLoading(true);
    setError('');
    try {
      if (!Number.isFinite(eventRangeTimestamps.startTime) || !Number.isFinite(eventRangeTimestamps.endTime)) {
        throw new Error('Rango de calendario inválido.');
      }
      if (!silent) {
        const cache = await readJsonValue<Record<string, CalendarEventItem[]>>(CALENDAR_EVENTS_CACHE_STORAGE_KEY, {});
        const cachedEvents = Array.isArray(cache[calendarEventCacheKey]) ? cache[calendarEventCacheKey] : [];
        if (cachedEvents.length) {
          setEvents(cachedEvents);
        }
      }
      const response = await api.getCalendarEvents(eventRangeTimestamps.startTime, eventRangeTimestamps.endTime, selectedCalendarKey);
      const nextEvents = unwrapCalendarEvents(response);
      setEvents(nextEvents);
      const cache = await readJsonValue<Record<string, CalendarEventItem[]>>(CALENDAR_EVENTS_CACHE_STORAGE_KEY, {});
      await writeJsonValue(CALENDAR_EVENTS_CACHE_STORAGE_KEY, {
        ...cache,
        [calendarEventCacheKey]: nextEvents,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las citas.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api, calendarEventCacheKey, eventRangeTimestamps.endTime, eventRangeTimestamps.startTime, selectedCalendarKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    loadCalendars()
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'No se pudieron cargar los calendarios.');
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadCalendars]);

  useEffect(() => {
    if (!calendarReady) return;
    void loadEvents(false);
  }, [calendarReady, loadEvents]);

  useEffect(() => {
    if (activeSheet !== 'contactPicker') {
      setContactsLoading(false);
      return;
    }

    let cancelled = false;
    const trimmed = contactQuery.trim();
    setContactsLoading(true);
    const timer = setTimeout(() => {
      const request = trimmed.length >= 2
        ? api.searchContacts(trimmed)
        : api.getChats('', 0, 60);
      request
        .then((results) => {
          if (!cancelled) setContactResults(Array.isArray(results) ? results : []);
        })
        .catch(() => {
          if (!cancelled) setContactResults([]);
        })
        .finally(() => {
          if (!cancelled) setContactsLoading(false);
        });
    }, trimmed ? 180 : 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeSheet, api, contactQuery]);

  const openAppointmentFromLink = useCallback(async (url: string) => {
    const appointmentId = extractAppointmentIdFromUrl(url);
    if (!appointmentId || handledOpenAppointmentRef.current === appointmentId) return;
    handledOpenAppointmentRef.current = appointmentId;
    try {
      const appointment = await api.getAppointment(appointmentId);
      if (!appointment) return;
      const eventDateOnly = getBusinessDateOnly(getEventStart(appointment), businessTimezone);
      if (eventDateOnly) {
        setSelectedDateOnly(eventDateOnly);
        setCurrentMonthDateOnly(eventDateOnly);
        setCalendarView('month');
      }
      const eventCalendarId = getEventCalendarId(appointment);
      if (eventCalendarId && calendars.some((calendar) => getCalendarKey(calendar) === eventCalendarId)) {
        setSelectedCalendarId(eventCalendarId);
      }
      setSelectedEvent(appointment);
      openSheet('event');
    } catch {
      Alert.alert('No se abrió la cita', 'El calendario abrió, pero los detalles no cargaron.');
    }
  }, [api, businessTimezone, calendars, openSheet]);

  useEffect(() => {
    void Linking.getInitialURL().then((url) => {
      if (url) void openAppointmentFromLink(url);
    });
    const subscription = Linking.addEventListener('url', ({ url }) => {
      void openAppointmentFromLink(url);
    });
    return () => subscription.remove();
  }, [openAppointmentFromLink]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void Promise.resolve()
      .then(() => loadCalendars())
      .then(() => loadEvents(true))
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'No se pudo actualizar el calendario.');
        setRefreshing(false);
        setLoading(false);
      });
  }, [loadCalendars, loadEvents]);

  const goToday = handleQuickReturn;

  const openCreateAppointmentRange = useCallback((dateOnly: string, startMinutes: number, endMinutes: number) => {
    if (!selectedCalendarKey) {
      Alert.alert('Selecciona calendario', 'Elige un calendario activo antes de agendar.');
      return;
    }
    const normalizedStart = Math.max(0, Math.min(TIMELINE_TOTAL_MINUTES - 15, Math.min(startMinutes, endMinutes)));
    const normalizedEnd = Math.max(normalizedStart + 15, Math.min(TIMELINE_TOTAL_MINUTES, Math.max(startMinutes, endMinutes)));
    setSelectedDateOnly(dateOnly);
    setCurrentMonthDateOnly(dateOnly);
    setPendingAppointmentDefaults({
      dateOnly,
      startTime: formatMinutesAsTime(normalizedStart),
      durationMinutes: normalizedEnd - normalizedStart,
      title: selectedCalendar?.eventTitle || selectedCalendar?.event_title || '',
    });
    setContactQuery('');
    setContactResults([]);
    openSheet('contactPicker');
  }, [openSheet, selectedCalendar, selectedCalendarKey]);

  const openCreateAppointmentForDateOnly = useCallback((dateOnly: string) => {
    const startTime = getDefaultAppointmentStartTime(dateOnly, businessTimezone);
    const startMinutes = parseTimeToMinutes(startTime) ?? 9 * 60;
    openCreateAppointmentRange(dateOnly, startMinutes, startMinutes + getCalendarSlotDurationMinutes(selectedCalendar));
  }, [businessTimezone, openCreateAppointmentRange, selectedCalendar]);

  const handleDayPress = useCallback((dateOnly: string) => {
    const now = Date.now();
    const previous = lastDayTapRef.current;
    selectDate(dateOnly);
    if (previous?.dateOnly === dateOnly && now - previous.at <= 320) {
      lastDayTapRef.current = null;
      openCreateAppointmentForDateOnly(dateOnly);
      return;
    }
    lastDayTapRef.current = { dateOnly, at: now };
  }, [openCreateAppointmentForDateOnly, selectDate]);

  const setTimelineSelectionValue = useCallback((nextSelection: TimelineSelectionState | null) => {
    timelineSelectionRef.current = nextSelection;
    setTimelineSelection(nextSelection);
  }, []);

  const clearTimelinePendingTouch = useCallback(() => {
    const pending = timelinePendingTouchRef.current;
    if (!pending) return null;
    clearTimeout(pending.timerId);
    timelinePendingTouchRef.current = null;
    return pending;
  }, []);

  useEffect(() => () => {
    clearTimelinePendingTouch();
    timelineSelectionRef.current = null;
    timelineSwipeRef.current = null;
  }, [clearTimelinePendingTouch]);

  const handleTimelineGrant = useCallback((dateOnly: string, event: GestureResponderEvent) => {
    if (!selectedCalendarKey) {
      Alert.alert('Selecciona calendario', 'Elige un calendario activo antes de agendar.');
      return;
    }
    setSelectedDateOnly(dateOnly);
    setCurrentMonthDateOnly(dateOnly);
    clearTimelinePendingTouch();
    timelineSwipeRef.current = null;
    setTimelineSelectionValue(null);
    const startMinutes = getTimelineMinutesFromY(event.nativeEvent.locationY, getCalendarSnapMinutes(selectedCalendar));
    const pending: TimelinePendingTouch = {
      dateOnly,
      startMinutes,
      x: event.nativeEvent.pageX,
      y: event.nativeEvent.pageY,
      timerId: setTimeout(() => {
        if (timelinePendingTouchRef.current !== pending) return;
        timelinePendingTouchRef.current = null;
        setSelectedDateOnly(dateOnly);
        setCurrentMonthDateOnly(dateOnly);
        triggerTimelineSelectionHaptic();
        setTimelineSelectionValue({ dateOnly, startMinutes, endMinutes: startMinutes });
      }, TIMELINE_LONG_PRESS_DELAY_MS),
    };
    timelinePendingTouchRef.current = pending;
  }, [clearTimelinePendingTouch, selectedCalendar, selectedCalendarKey, setTimelineSelectionValue]);

  const handleTimelineMove = useCallback((dateOnly: string, event: GestureResponderEvent) => {
    const pending = timelinePendingTouchRef.current;
    if (pending) {
      const dx = event.nativeEvent.pageX - pending.x;
      const dy = event.nativeEvent.pageY - pending.y;
      const horizontalSwipe = Math.abs(dx) > TIMELINE_PENDING_MOVE_CANCEL_PX && Math.abs(dx) > Math.abs(dy) * 1.2;
      const verticalScroll = Math.abs(dy) > TIMELINE_PENDING_VERTICAL_CANCEL_PX && Math.abs(dy) > Math.abs(dx) * 1.15;
      if (horizontalSwipe || verticalScroll) {
        if (horizontalSwipe) timelineSwipeRef.current = { dateOnly, x: pending.x, y: pending.y, dx, dy };
        clearTimelinePendingTouch();
      }
      return;
    }

    const timelineSwipe = timelineSwipeRef.current;
    if (timelineSwipe && timelineSwipe.dateOnly === dateOnly) {
      timelineSwipe.dx = event.nativeEvent.pageX - timelineSwipe.x;
      timelineSwipe.dy = event.nativeEvent.pageY - timelineSwipe.y;
      return;
    }

    const activeSelection = timelineSelectionRef.current;
    if (!activeSelection || activeSelection.dateOnly !== dateOnly) return;
    const endMinutes = getTimelineMinutesFromY(event.nativeEvent.locationY, getCalendarSnapMinutes(selectedCalendar));
    setTimelineSelectionValue({ ...activeSelection, endMinutes });
  }, [clearTimelinePendingTouch, selectedCalendar, setTimelineSelectionValue]);

  const handleTimelineRelease = useCallback((dateOnly: string, event: GestureResponderEvent) => {
    const pending = clearTimelinePendingTouch();
    if (pending) {
      const dx = event.nativeEvent.pageX - pending.x;
      const dy = event.nativeEvent.pageY - pending.y;
      const isTap = Math.abs(dx) <= TIMELINE_TAP_MOVE_TOLERANCE_PX && Math.abs(dy) <= TIMELINE_TAP_MOVE_TOLERANCE_PX;
      if (isTap) {
        openCreateAppointmentRange(
          pending.dateOnly,
          pending.startMinutes,
          pending.startMinutes + getCalendarSlotDurationMinutes(selectedCalendar),
        );
      }
      return;
    }

    const timelineSwipe = timelineSwipeRef.current;
    if (timelineSwipe && timelineSwipe.dateOnly === dateOnly) {
      const dx = event.nativeEvent.pageX - timelineSwipe.x;
      const dy = event.nativeEvent.pageY - timelineSwipe.y;
      timelineSwipeRef.current = null;
      if (Math.abs(dx) >= MONTH_SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.35) {
        movePeriod(dx < 0 ? 1 : -1);
      }
      return;
    }

    const activeSelection = timelineSelectionRef.current;
    if (!activeSelection || activeSelection.dateOnly !== dateOnly) return;
    setTimelineSelectionValue(null);
    const sameSlot = activeSelection.startMinutes === activeSelection.endMinutes;
    const endMinutes = sameSlot
      ? activeSelection.startMinutes + getCalendarSlotDurationMinutes(selectedCalendar)
      : activeSelection.endMinutes + 15;
    openCreateAppointmentRange(activeSelection.dateOnly, activeSelection.startMinutes, endMinutes);
  }, [clearTimelinePendingTouch, movePeriod, openCreateAppointmentRange, selectedCalendar, setTimelineSelectionValue]);

  const handleTimelineCancel = useCallback(() => {
    clearTimelinePendingTouch();
    timelineSwipeRef.current = null;
    setTimelineSelectionValue(null);
  }, [clearTimelinePendingTouch, setTimelineSelectionValue]);

  const openCreateSheet = useCallback(() => {
    setPendingAppointmentDefaults(null);
    setContactQuery('');
    setContactResults([]);
    openSheet('contactPicker');
  }, [openSheet]);

  const openCreateAppointmentForContact = useCallback((contact: ChatContact) => {
    if (!selectedCalendarKey) {
      Alert.alert('Selecciona calendario', 'Elige un calendario activo antes de agendar.');
      return;
    }
    const title = getContactName(contact);
    const defaults = pendingAppointmentDefaults;
    setAppointmentMode('create');
    setAppointmentDraft({
      title: defaults?.title || title,
      appointmentStatus: 'confirmed',
      dateOnly: defaults?.dateOnly || selectedDateOnly,
      startTime: defaults?.startTime || getDefaultAppointmentStartTime(selectedDateOnly, businessTimezone),
      durationMinutes: defaults?.durationMinutes || 60,
      address: '',
      notes: '',
      contactId: contact.id,
      contact,
      calendarId: selectedCalendarKey,
      assignedUserId: '',
      guests: [],
    });
    setPendingAppointmentDefaults(null);
    openSheet('appointmentForm');
  }, [businessTimezone, openSheet, pendingAppointmentDefaults, selectedCalendarKey, selectedDateOnly]);

  const openEditAppointment = useCallback((event: CalendarEventItem) => {
    const eventId = getEventId(event);
    const start = getEventStart(event);
    const end = getEventEnd(event);
    const startFields = isoToBusinessDateTimeFields(start, businessTimezone);
    const startMs = start ? new Date(start).getTime() : Number.NaN;
    const endMs = end ? new Date(end).getTime() : Number.NaN;
    const durationMinutes = Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(15, Math.round((endMs - startMs) / 60000))
      : 60;

    if (!eventId) {
      Alert.alert('No se puede editar', 'Esta cita no tiene un ID válido del backend.');
      return;
    }
    const parsedNotes = splitAppointmentNotesAndGuests(String(event.notes || event.description || ''));

    setAppointmentMode('edit');
    setAppointmentDraft({
      eventId,
      title: getEventTitle(event),
      appointmentStatus: String(event.appointmentStatus || event.appointment_status || event.status || 'confirmed'),
      dateOnly: startFields.dateOnly || selectedDateOnly,
      startTime: startFields.time || getDefaultAppointmentStartTime(selectedDateOnly, businessTimezone),
      durationMinutes,
      address: String(event.address || event.location || ''),
      notes: parsedNotes.notes,
      contactId: getEventContactId(event),
      contact: null,
      calendarId: getEventCalendarId(event) || selectedCalendarKey,
      assignedUserId: String(event.assignedUserId || event.assigned_user_id || ''),
      guests: parsedNotes.guests,
    });
    openSheet('appointmentForm');
  }, [businessTimezone, openSheet, selectedCalendarKey, selectedDateOnly]);

  const getDraftBlockedConflict = useCallback(async (
    draft: AppointmentDraft,
    calendarId: string,
    startIso: string,
    endIso: string,
  ) => {
    const draftCalendar = calendars.find((calendar) => getCalendarKey(calendar) === calendarId) || selectedCalendar;
    if (isHighLevelCalendar(draftCalendar)) return null;

    const startFields = isoToBusinessDateTimeFields(startIso, businessTimezone);
    const endFields = isoToBusinessDateTimeFields(endIso, businessTimezone);
    const startMinutes = parseTimeToMinutes(startFields.time);
    const endMinutes = parseTimeToMinutes(endFields.time);
    if (startMinutes === null || endMinutes === null) return null;

    const range = getBusinessRangeTimestamps(draft.dateOnly, draft.dateOnly, businessTimezone);
    if (!Number.isFinite(range.startTime) || !Number.isFinite(range.endTime)) return null;

    const blockedSlots = await api.getBlockedSlots(calendarId, range.startTime, range.endTime);
    for (const slot of blockedSlots) {
      const slotDateOnly = String(slot.date || getBusinessDateOnly(String(slot.startTime || ''), businessTimezone) || '').trim();
      if (slotDateOnly && slotDateOnly !== draft.dateOnly) continue;

      const slotStartFields = isoToBusinessDateTimeFields(String(slot.startTime || ''), businessTimezone);
      const slotEndFields = isoToBusinessDateTimeFields(String(slot.endTime || ''), businessTimezone);
      const slotStart = parseTimeToMinutes(slotStartFields.time || String(slot.startTime || ''));
      const slotEnd = parseTimeToMinutes(slotEndFields.time || String(slot.endTime || ''));
      if (slotStart === null || slotEnd === null) continue;

      if (startMinutes < slotEnd && endMinutes > slotStart) {
        return slot;
      }
    }
    return null;
  }, [api, businessTimezone, calendars, selectedCalendar]);

  const saveAppointmentDraft = useCallback(async (draft: AppointmentDraft) => {
    if (appointmentBusy) return;
    const calendarId = draft.calendarId || selectedCalendarKey;
    const draftCalendar = calendars.find((calendar) => getCalendarKey(calendar) === calendarId) || selectedCalendar;
    if (!calendarId) {
      Alert.alert('Selecciona calendario', 'Elige un calendario activo antes de guardar.');
      return;
    }
    if (appointmentMode === 'create' && !draft.contactId) {
      Alert.alert('Contacto requerido', 'Selecciona un contacto para crear la cita.');
      return;
    }
    if (appointmentMode === 'create' && isRoundRobinCalendar(draftCalendar) && !draft.assignedUserId) {
      Alert.alert('Persona del equipo requerida', 'Selecciona quién atenderá esta cita.');
      return;
    }

    const endFields = addMinutesToBusinessDateTime(draft.dateOnly, draft.startTime, draft.durationMinutes);
    const startIso = localBusinessDateTimeToUTCISOString(draft.dateOnly, draft.startTime, businessTimezone);
    const endIso = localBusinessDateTimeToUTCISOString(endFields.dateOnly, endFields.time, businessTimezone);
    if (!startIso || !endIso) {
      Alert.alert('Horario inválido', 'Usa fecha YYYY-MM-DD y hora HH:mm.');
      return;
    }

    setAppointmentBusy(true);
    try {
      const blockedSlot = await getDraftBlockedConflict(draft, calendarId, startIso, endIso);
      if (blockedSlot) {
        Alert.alert(
          'Horario bloqueado',
          String(blockedSlot.reason || blockedSlot.title || 'Este horario no está disponible. Selecciona otro horario.'),
        );
        return;
      }

      const resolvedTitle = draft.title.trim()
        || (draft.contact ? getContactName(draft.contact) : '')
        || 'Cita';
      const payload: Record<string, unknown> = {
        title: resolvedTitle,
        appointmentStatus: draft.appointmentStatus,
        startTime: startIso,
        endTime: endIso,
        notes: buildAppointmentNotesWithGuests(draft.notes, draft.guests),
        address: draft.address.trim(),
        timeZone: businessTimezone,
      };
      if (appointmentMode === 'create') {
        payload.calendarId = calendarId;
        payload.contactId = draft.contactId;
      }
      if (draft.assignedUserId) {
        payload.assignedUserId = draft.assignedUserId;
      }

      if (appointmentMode === 'edit') {
        if (!draft.eventId) throw new Error('La cita no tiene ID.');
        await api.updateAppointment(draft.eventId, payload);
      } else {
        await api.createAppointment(payload);
      }
      closeSheet();
      setSelectedEvent(null);
      await loadEvents(true);
      Alert.alert(appointmentMode === 'edit' ? 'Cita actualizada' : 'Cita agendada', 'Los cambios ya están guardados.');
    } catch (err) {
      Alert.alert('No se pudo guardar', err instanceof Error ? err.message : 'Intenta otra vez.');
    } finally {
      setAppointmentBusy(false);
    }
  }, [api, appointmentBusy, appointmentMode, businessTimezone, calendars, closeSheet, getDraftBlockedConflict, loadEvents, selectedCalendar, selectedCalendarKey]);

  const deleteAppointment = useCallback((event: CalendarEventItem) => {
    const eventId = getEventId(event);
    if (!eventId || appointmentBusy) return;
    Alert.alert('Eliminar cita', 'Esta acción borra la cita del calendario.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Eliminar',
        style: 'destructive',
        onPress: async () => {
          setAppointmentBusy(true);
          try {
            await api.deleteCalendarEvent(eventId);
            closeSheet();
            setSelectedEvent(null);
            await loadEvents(true);
            Alert.alert('Cita eliminada', 'Ya no aparece en el calendario.');
          } catch (err) {
            Alert.alert('No se pudo eliminar', err instanceof Error ? err.message : 'Intenta otra vez.');
          } finally {
            setAppointmentBusy(false);
          }
        },
      },
    ]);
  }, [api, appointmentBusy, closeSheet, loadEvents]);

  const openEventDetails = useCallback((event: CalendarEventItem) => {
    setSelectedEvent(event);
    openSheet('event');
  }, [openSheet]);

  const calendarSheetOpen = activeSheet === 'calendar' || closingSheet === 'calendar';
  const calendarSheetClosing = activeSheet !== 'calendar' && closingSheet === 'calendar';
  const contactPickerOpen = activeSheet === 'contactPicker' || closingSheet === 'contactPicker';
  const contactPickerClosing = activeSheet !== 'contactPicker' && closingSheet === 'contactPicker';
  const eventSheetOpen = activeSheet === 'event' || closingSheet === 'event';
  const eventSheetClosing = activeSheet !== 'event' && closingSheet === 'event';
  const appointmentFormOpen = activeSheet === 'appointmentForm' || closingSheet === 'appointmentForm';
  const appointmentFormClosing = activeSheet !== 'appointmentForm' && closingSheet === 'appointmentForm';
  const weekStartLabel = formatCompactBusinessDate(weekRange.startDate);
  const weekEndLabel = formatCompactBusinessDate(weekRange.endDate);
  const displayMonthTitle = calendarView === 'month'
    ? formatBusinessMonthTitle(currentMonthDateOnly)
    : calendarView === 'year'
      ? formatBusinessYear(currentMonthDateOnly)
      : calendarView === 'years'
        ? `${yearsGrid[0]} - ${yearsGrid[yearsGrid.length - 1]}`
        : calendarView === 'week'
          ? `${weekStartLabel} - ${weekEndLabel}`
          : formatCompactBusinessDate(selectedDateOnly);
  const displayMonthSubtitle = calendarView === 'week'
      ? `${formatBusinessMonthTitle(selectedDateOnly)} ${formatBusinessYear(selectedDateOnly)}`
      : '';
  const periodChipLabel = calendarView === 'month'
    ? formatBusinessYear(currentMonthDateOnly)
    : calendarView === 'year'
      ? 'Años'
      : calendarView === 'years'
        ? 'Año'
        : formatBusinessMonthTitle(selectedDateOnly);
  const quickReturnLabel = calendarView === 'year' ? 'Mes' : calendarView === 'years' ? 'Año' : 'Hoy';
  const listData = calendarView === 'month'
    ? agendaEvents
    : calendarView === 'year'
      ? nextUpcomingEvents
      : [];

  return (
    <AppFrame>
      <View style={styles.calendarPage}>
        <View style={styles.calendarHeader}>
          <View style={styles.calendarToolbar}>
            <Pressable
              accessibilityRole="button"
              onPress={handleNavigateUp}
              style={({ pressed }) => [styles.calendarPeriodChip, pressed && styles.pressed]}
            >
              <ChevronLeft size={15} color={COLORS.text} strokeWidth={2.8} />
              <Text numberOfLines={1} style={styles.calendarPeriodText}>
                {periodChipLabel}
              </Text>
            </Pressable>
            <View style={styles.calendarHeaderCapsule}>
              <Pressable
                accessibilityRole="button"
                onPress={goToday}
                style={({ pressed }) => [styles.calendarCapsuleTodayButton, pressed && styles.pressed]}
              >
                <Text style={styles.calendarTodayButtonText}>{quickReturnLabel}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => openSheet('calendar')}
                style={({ pressed }) => [styles.calendarCapsuleIconButton, pressed && styles.pressed]}
              >
                <CalendarDays size={19} color={COLORS.text} strokeWidth={2.35} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={openCreateSheet}
                style={({ pressed }) => [styles.calendarCapsuleIconButton, pressed && styles.pressed]}
              >
                <Plus size={22} color={COLORS.text} strokeWidth={2.25} />
              </Pressable>
            </View>
          </View>
          <View style={styles.calendarTitleRow}>
            <Pressable
              accessibilityRole="button"
              onPress={handleNavigateUp}
              style={[
                styles.calendarTitleButton,
                calendarView === 'month' && monthSwipeWidth > 0 && styles.calendarTitleSwipeViewport,
                calendarView === 'month' && monthSwipeWidth > 0 && { width: headerTitleSwipeWidth, maxWidth: headerTitleSwipeWidth },
              ]}
            >
              {calendarView === 'month' && monthSwipeWidth > 0 ? (
                <Animated.View
                  style={[
                    styles.calendarTitleSwipeTrack,
                    {
                      width: headerTitleSwipeWidth * 3,
                      transform: [{ translateX: monthSwipeTranslate }],
                    },
                  ]}
                >
                  {monthPages.map((page) => (
                    <View key={`title-${page.key}`} style={[styles.calendarTitleSwipePage, { width: headerTitleSwipeWidth }]}>
                      <Text numberOfLines={1} style={styles.calendarTitle}>{formatBusinessMonthTitle(page.dateOnly)}</Text>
                    </View>
                  ))}
                </Animated.View>
              ) : (
                <Text numberOfLines={1} style={styles.calendarTitle}>{displayMonthTitle}</Text>
              )}
              {displayMonthSubtitle ? <Text numberOfLines={1} style={styles.calendarSubtitle}>{displayMonthSubtitle}</Text> : null}
            </Pressable>
          </View>
        </View>

        {loading && !calendarReady ? (
          <View style={styles.calendarCenterState}>
            <ActivityIndicator color={COLORS.accent} />
            <Text style={styles.caption}>Cargando citas...</Text>
          </View>
        ) : (
          <FlatList
            data={listData}
            keyExtractor={(item, index) => getEventKey(item, index)}
            refreshControl={<RefreshControl tintColor={COLORS.accent} refreshing={refreshing} onRefresh={refresh} />}
            scrollEnabled={!timelineSelection}
            contentContainerStyle={styles.calendarScrollBody}
            ListHeaderComponent={(
              <>
                {calendarView === 'month' ? (
                  <CalendarMonthSwipe
                    eventsByDate={eventsByDate}
                    monthPages={monthPages}
                    panHandlers={monthPanResponder.panHandlers}
                    selectedDateOnly={selectedDateOnly}
                    translateX={monthSwipeTranslate}
                    width={monthSwipeWidth}
                    onLayout={handleMonthLayout}
                    onSelectDate={handleDayPress}
                  />
                ) : null}
                {calendarView === 'year' ? (
                  <CalendarYearOverview
                    currentMonthDateOnly={currentMonthDateOnly}
                    eventsByDate={eventsByDate}
                    selectedDateOnly={selectedDateOnly}
                    todayDateOnly={todayDateOnly}
                    onSelectMonth={handleSelectMonthFromYear}
                  />
                ) : null}
                {calendarView === 'years' ? (
                  <CalendarYearsOverview
                    currentYear={getDateOnlyYear(todayDateOnly)}
                    selectedYear={getDateOnlyYear(selectedDateOnly)}
                    years={yearsGrid}
                    onSelectYear={handleSelectYear}
                  />
                ) : null}
                {calendarView === 'day' || calendarView === 'week' ? (
                  <CalendarTimelineView
                    calendarColor={getCalendarColor(selectedCalendar)}
                    calendarView={calendarView}
                    eventsByDate={eventsByDate}
                    selectedDateOnly={selectedDateOnly}
                    timelineSelection={timelineSelection}
                    todayDateOnly={todayDateOnly}
                    timezone={businessTimezone}
                    weekDays={weekDays}
                    onCancelTouch={handleTimelineCancel}
                    onGrant={handleTimelineGrant}
                    onMove={handleTimelineMove}
                    onOpenEvent={openEventDetails}
                    onRelease={handleTimelineRelease}
                    onSelectDate={selectDate}
                    onSelectDateForCreate={openCreateAppointmentForDateOnly}
                  />
                ) : null}
                {calendarView === 'month' ? (
                  <View style={styles.calendarAgendaHeader}>
                    <View style={styles.calendarAgendaHeaderCopy}>
                      <Text style={styles.calendarAgendaDate}>{formatCalendarAgendaDate(selectedDateOnly)}</Text>
                      <Text style={styles.calendarAgendaTitle}>
                        {agendaEvents.length ? `${agendaEvents.length} cita${agendaEvents.length === 1 ? '' : 's'}` : 'Sin citas'}
                      </Text>
                    </View>
                    {loading || refreshing ? <ActivityIndicator color={COLORS.text} /> : null}
                  </View>
                ) : null}
                {calendarView === 'year' ? (
                  <View style={styles.calendarAgendaHeader}>
                    <View style={styles.calendarAgendaHeaderCopy}>
                      <Text style={styles.calendarAgendaDate}>Próximas citas</Text>
                      <Text style={styles.calendarAgendaTitle}>{nextUpcomingEvents.length} en este rango</Text>
                    </View>
                    {loading || refreshing ? <ActivityIndicator color={COLORS.text} /> : null}
                  </View>
                ) : null}
              </>
            )}
            renderItem={({ item }) => (
              <CalendarEventCard
                event={item}
                timezone={businessTimezone}
                calendarColor={getCalendarColor(selectedCalendar)}
                onPress={() => openEventDetails(item)}
              />
            )}
            ListEmptyComponent={(
              error ? (
                <CalendarErrorState message={error} onRetry={refresh} />
              ) : calendarView === 'year' ? (
                <CalendarEmptyState
                  title="No hay citas próximas"
                  subtitle="Cambia de calendario o crea una cita nueva."
                />
              ) : calendarView === 'month' ? (
                <CalendarEmptyState
                  title="No hay citas este día"
                />
              ) : null
            )}
          />
        )}

        <CalendarPickerSheet
          activeView={calendarView}
          calendars={calendars}
          closing={calendarSheetClosing}
          open={calendarSheetOpen}
          selectedCalendarId={selectedCalendarKey}
          onClose={closeSheet}
          onSelect={chooseCalendar}
          onSelectView={handleSelectCalendarView}
        />
        <AppointmentContactPickerSheet
          closing={contactPickerClosing}
          contacts={contactResults}
          loading={contactsLoading}
          open={contactPickerOpen}
          query={contactQuery}
          selectedDateOnly={selectedDateOnly}
          onChangeQuery={setContactQuery}
          onClose={closeSheet}
          onSelect={openCreateAppointmentForContact}
        />
        <CalendarEventDetailsSheet
          busy={appointmentBusy}
          calendarColor={getCalendarColor(selectedCalendar)}
          closing={eventSheetClosing}
          event={selectedEvent}
          open={eventSheetOpen}
          timezone={businessTimezone}
          onClose={closeSheet}
          onDelete={deleteAppointment}
          onEdit={openEditAppointment}
        />
        <AppointmentFormSheet
          api={api}
          busy={appointmentBusy}
          calendar={selectedCalendar}
          closing={appointmentFormClosing}
          draft={appointmentDraft}
          mode={appointmentMode}
          open={appointmentFormOpen}
          timezone={businessTimezone}
          onChange={setAppointmentDraft}
          onClose={closeSheet}
          onSave={saveAppointmentDraft}
        />
      </View>
      {footer}
    </AppFrame>
  );
}

function CalendarMonthSwipe({
  eventsByDate,
  monthPages,
  panHandlers,
  selectedDateOnly,
  translateX,
  width,
  onLayout,
  onSelectDate,
}: {
  eventsByDate: Record<string, CalendarEventItem[]>;
  monthPages: Array<{
    key: string;
    offset: number;
    dateOnly: string;
    cells: ReturnType<typeof buildBusinessMonthCells>;
  }>;
  panHandlers: ReturnType<typeof PanResponder.create>['panHandlers'];
  selectedDateOnly: string;
  translateX: Animated.Value;
  width: number;
  onLayout: (event: LayoutChangeEvent) => void;
  onSelectDate: (dateOnly: string) => void;
}) {
  const currentPage = monthPages.find((page) => page.offset === 0) || monthPages[1] || monthPages[0];
  const monthRowCount = Math.max(1, Math.ceil((currentPage?.cells.length || 35) / 7));
  const monthHeight = CALENDAR_WEEKDAY_ROW_HEIGHT + CALENDAR_MONTH_GRID_TOP_PADDING + (monthRowCount * CALENDAR_MONTH_DAY_CELL_HEIGHT);
  return (
    <View style={[styles.calendarMonthSwipeViewport, { height: monthHeight }]} onLayout={onLayout} {...panHandlers}>
      <Animated.View
        style={[
          styles.calendarMonthSwipeTrack,
          width ? { width: width * 3, height: monthHeight, transform: [{ translateX }] } : { height: monthHeight },
        ]}
      >
        {monthPages.map((page) => (
          <View key={page.key} style={[styles.calendarMonthSwipePage, width ? { width, height: monthHeight } : { height: monthHeight }]}>
            <CalendarMonthGrid
              cells={page.cells}
              eventsByDate={eventsByDate}
              muted={page.offset !== 0}
              selectedDateOnly={selectedDateOnly}
              onSelectDate={onSelectDate}
            />
          </View>
        ))}
      </Animated.View>
    </View>
  );
}

function CalendarMonthGrid({
  cells,
  eventsByDate,
  muted,
  selectedDateOnly,
  onSelectDate,
}: {
  cells: ReturnType<typeof buildBusinessMonthCells>;
  eventsByDate: Record<string, CalendarEventItem[]>;
  muted?: boolean;
  selectedDateOnly: string;
  onSelectDate: (dateOnly: string) => void;
}) {
  return (
    <View style={[styles.calendarSurface, muted && styles.calendarSurfaceMuted]}>
      <View style={styles.calendarWeekdayRow}>
        {CALENDAR_WEEKDAYS.map((day, index) => (
          <Text key={`${day}-${index}`} style={styles.calendarWeekdayText}>{day}</Text>
        ))}
      </View>
      <View style={styles.calendarMonthGrid}>
        {cells.map((cell, index) => {
          const selected = cell.dateOnly === selectedDateOnly;
          const dayEvents = eventsByDate[cell.dateOnly] || [];
          const weekend = index % 7 === 0 || index % 7 === 6;
          return (
            <Pressable
              key={cell.dateOnly}
              accessibilityRole="button"
              onPress={() => onSelectDate(cell.dateOnly)}
              style={({ pressed }) => [
                styles.calendarDayCell,
                !cell.isCurrentMonth && styles.calendarDayCellMuted,
                weekend && styles.calendarDayCellWeekend,
                pressed && styles.pressed,
              ]}
            >
              <View style={[
                styles.calendarDayNumberWrap,
                cell.isToday && styles.calendarDayNumberToday,
                selected && styles.calendarDayNumberSelected,
              ]}>
                <Text style={[
                  styles.calendarDayNumber,
                  !cell.isCurrentMonth && styles.calendarDayNumberMuted,
                  weekend && styles.calendarDayNumberWeekend,
                  cell.isToday && styles.calendarDayNumberTodayText,
                  selected && styles.calendarDayNumberSelectedText,
                ]}>
                  {cell.day}
                </Text>
              </View>
              <View style={styles.calendarDayMarkers}>
                {dayEvents.slice(0, 3).map((event, index) => (
                  <View key={`${getEventKey(event, index)}-dot`} style={styles.calendarDayMarker} />
                ))}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function CalendarYearOverview({
  currentMonthDateOnly,
  eventsByDate,
  selectedDateOnly,
  todayDateOnly,
  onSelectMonth,
}: {
  currentMonthDateOnly: string;
  eventsByDate: Record<string, CalendarEventItem[]>;
  selectedDateOnly: string;
  todayDateOnly: string;
  onSelectMonth: (monthIndex: number) => void;
}) {
  const year = getDateOnlyYear(currentMonthDateOnly);

  return (
    <View style={styles.calendarYearGrid}>
      {Array.from({ length: 12 }).map((_, monthIndex) => {
        const dateOnly = `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`;
        const range = getBusinessMonthRange(dateOnly);
        const cells = buildBusinessMonthCells(dateOnly, todayDateOnly);
        const selected = selectedDateOnly >= range.monthStart && selectedDateOnly <= range.monthEnd;
        const today = todayDateOnly >= range.monthStart && todayDateOnly <= range.monthEnd;

        return (
          <Pressable
            key={dateOnly}
            accessibilityRole="button"
            onPress={() => onSelectMonth(monthIndex)}
            style={({ pressed }) => [
              styles.calendarYearMonth,
              selected && styles.calendarYearMonthSelected,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[
              styles.calendarYearMonthTitle,
              today && styles.calendarYearMonthToday,
              selected && styles.calendarYearMonthTitleSelected,
            ]}>
              {formatBusinessShortMonthTitle(dateOnly)}
            </Text>
            <View style={styles.calendarMiniMonthGrid}>
              {cells.map((cell) => {
                const events = eventsByDate[cell.dateOnly] || [];
                return (
                  <View
                    key={cell.dateOnly}
                    style={[
                      styles.calendarMiniDay,
                      !cell.isCurrentMonth && styles.calendarMiniDayMuted,
                      cell.dateOnly === selectedDateOnly && styles.calendarMiniDaySelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.calendarMiniDayText,
                        !cell.isCurrentMonth && styles.calendarMiniDayTextMuted,
                        cell.dateOnly === todayDateOnly && styles.calendarMiniDayTextToday,
                        cell.dateOnly === selectedDateOnly && styles.calendarMiniDayTextSelected,
                      ]}
                    >
                      {cell.day}
                    </Text>
                    {events.length ? <View style={styles.calendarMiniDayDot} /> : null}
                  </View>
                );
              })}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function CalendarYearsOverview({
  currentYear,
  selectedYear,
  years,
  onSelectYear,
}: {
  currentYear: number;
  selectedYear: number;
  years: number[];
  onSelectYear: (year: number) => void;
}) {
  return (
    <View style={styles.calendarYearsGrid}>
      {years.map((year) => {
        const selected = year === selectedYear;
        const today = year === currentYear;
        return (
          <Pressable
            key={year}
            accessibilityRole="button"
            onPress={() => onSelectYear(year)}
            style={({ pressed }) => [
              styles.calendarYearButton,
              selected && styles.calendarYearButtonSelected,
              pressed && styles.pressed,
            ]}
          >
            <Text
              style={[
                styles.calendarYearButtonText,
                today && styles.calendarYearButtonTodayText,
                selected && styles.calendarYearButtonSelectedText,
              ]}
            >
              {year}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function CalendarViewPicker({
  activeView,
  onSelectView,
}: {
  activeView: CalendarViewMode;
  onSelectView: (view: Exclude<CalendarViewMode, 'years'>) => void;
}) {
  return (
    <View style={styles.calendarViewPicker}>
      {CALENDAR_VIEW_OPTIONS.map(({ view, label }) => {
        const selected = activeView === view || (activeView === 'years' && view === 'year');
        return (
          <Pressable
            key={view}
            accessibilityRole="button"
            onPress={() => onSelectView(view)}
            style={({ pressed }) => [
              styles.calendarViewPickerButton,
              selected && styles.calendarViewPickerButtonActive,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.calendarViewPickerText, selected && styles.calendarViewPickerTextActive]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function CalendarTimelineView({
  calendarColor,
  calendarView,
  eventsByDate,
  selectedDateOnly,
  timelineSelection,
  todayDateOnly,
  timezone,
  weekDays,
  onCancelTouch,
  onGrant,
  onMove,
  onOpenEvent,
  onRelease,
  onSelectDate,
  onSelectDateForCreate,
}: {
  calendarColor: string;
  calendarView: 'day' | 'week';
  eventsByDate: Record<string, CalendarEventItem[]>;
  selectedDateOnly: string;
  timelineSelection: TimelineSelectionState | null;
  todayDateOnly: string;
  timezone: string;
  weekDays: Array<{ dateOnly: string; events: CalendarEventItem[] }>;
  onCancelTouch: () => void;
  onGrant: (dateOnly: string, event: GestureResponderEvent) => void;
  onMove: (dateOnly: string, event: GestureResponderEvent) => void;
  onOpenEvent: (event: CalendarEventItem) => void;
  onRelease: (dateOnly: string, event: GestureResponderEvent) => void;
  onSelectDate: (dateOnly: string) => void;
  onSelectDateForCreate: (dateOnly: string) => void;
}) {
  const dayColumns = calendarView === 'week'
    ? weekDays
    : [{ dateOnly: selectedDateOnly, events: eventsByDate[selectedDateOnly] || [] }];
  const hours = Array.from({ length: 24 }).map((_, index) => index);

  return (
    <View style={styles.calendarTimelinePanel}>
      {calendarView === 'week' ? (
        <View style={styles.calendarWeekTimelineHeader}>
          <View style={styles.calendarWeekTimelineSpacer} />
          {weekDays.map(({ dateOnly, events }) => {
            const selected = dateOnly === selectedDateOnly;
            const today = dateOnly === todayDateOnly;
            return (
              <Pressable
                key={dateOnly}
                accessibilityRole="button"
                onPress={() => onSelectDate(dateOnly)}
                onLongPress={() => onSelectDateForCreate(dateOnly)}
                style={({ pressed }) => [
                  styles.calendarWeekDayButton,
                  selected && styles.calendarWeekDayButtonSelected,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.calendarWeekDayLabel, today && styles.calendarWeekDayToday]}>{CALENDAR_WEEKDAYS[dateOnlyToCalendarDate(dateOnly)?.getDay() || 0]}</Text>
                <Text style={[styles.calendarWeekDayNumber, selected && styles.calendarWeekDayNumberSelected]}>{formatDateOnlyDayNumber(dateOnly)}</Text>
                {events.length ? <Text style={styles.calendarWeekDayCount}>{events.length}</Text> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <View style={styles.calendarTimelineBody}>
        <View style={styles.calendarTimelineHourColumn}>
          {hours.map((hour) => (
            <Text key={hour} style={styles.calendarTimelineHourText}>{formatTimelineHour(hour)}</Text>
          ))}
        </View>
        <View style={styles.calendarTimelineColumns}>
          {dayColumns.map(({ dateOnly, events }) => (
            <CalendarTimelineGrid
              key={dateOnly}
              calendarColor={calendarColor}
              dateOnly={dateOnly}
              events={events}
              hours={hours}
              selection={timelineSelection}
              timezone={timezone}
              onCancelTouch={onCancelTouch}
              onGrant={onGrant}
              onMove={onMove}
              onOpenEvent={onOpenEvent}
              onRelease={onRelease}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

function CalendarTimelineGrid({
  calendarColor,
  dateOnly,
  events,
  hours,
  selection,
  timezone,
  onCancelTouch,
  onGrant,
  onMove,
  onOpenEvent,
  onRelease,
}: {
  calendarColor: string;
  dateOnly: string;
  events: CalendarEventItem[];
  hours: number[];
  selection: TimelineSelectionState | null;
  timezone: string;
  onCancelTouch: () => void;
  onGrant: (dateOnly: string, event: GestureResponderEvent) => void;
  onMove: (dateOnly: string, event: GestureResponderEvent) => void;
  onOpenEvent: (event: CalendarEventItem) => void;
  onRelease: (dateOnly: string, event: GestureResponderEvent) => void;
}) {
  const nowMinutes = getNowMinutesForDate(dateOnly, timezone);
  const nowTop = nowMinutes === null ? null : (nowMinutes / TIMELINE_TOTAL_MINUTES) * TIMELINE_GRID_HEIGHT;
  const selectionForDay = selection?.dateOnly === dateOnly ? selection : null;
  const selectionStart = selectionForDay ? Math.min(selectionForDay.startMinutes, selectionForDay.endMinutes) : 0;
  const selectionEnd = selectionForDay ? Math.max(selectionForDay.startMinutes, selectionForDay.endMinutes + 15) : 0;

  return (
    <View style={styles.calendarTimelineGrid}>
      <View
        style={styles.calendarTimelineResponderLayer}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => false}
        onResponderGrant={(event) => onGrant(dateOnly, event)}
        onResponderMove={(event) => onMove(dateOnly, event)}
        onResponderRelease={(event) => onRelease(dateOnly, event)}
        onResponderTerminate={onCancelTouch}
        onResponderTerminationRequest={() => !selectionForDay}
      >
        {hours.map((hour) => (
          <View key={hour} style={[styles.calendarTimelineHourLine, { top: hour * TIMELINE_HOUR_HEIGHT }]} />
        ))}
        {selectionForDay ? (
          <View
            pointerEvents="none"
            style={[
              styles.calendarTimelineSelection,
              {
                top: (selectionStart / TIMELINE_TOTAL_MINUTES) * TIMELINE_GRID_HEIGHT,
                height: Math.max(18, ((selectionEnd - selectionStart) / TIMELINE_TOTAL_MINUTES) * TIMELINE_GRID_HEIGHT),
              },
            ]}
          />
        ) : null}
        {nowTop !== null ? (
          <View pointerEvents="none" style={[styles.calendarTimelineNowLine, { top: nowTop }]}>
            <Text style={styles.calendarTimelineNowText}>{formatCalendarEventTime(new Date().toISOString(), timezone)}</Text>
          </View>
        ) : null}
      </View>
      <View pointerEvents="box-none" style={styles.calendarTimelineEventLayer}>
        {events.map((event, index) => {
          const timeline = getEventTimelineEntry(event, timezone);
          if (!timeline) return null;
          return (
            <Pressable
              key={getEventKey(event, index)}
              accessibilityRole="button"
              onPress={() => onOpenEvent(event)}
              style={({ pressed }) => [
                styles.calendarTimelineEvent,
                {
                  top: timeline.top,
                  height: timeline.height,
                  borderLeftColor: calendarColor,
                },
                pressed && styles.pressed,
              ]}
            >
              <Text numberOfLines={1} style={styles.calendarTimelineEventTitle}>{getEventTitle(event)}</Text>
              <Text numberOfLines={1} style={styles.calendarTimelineEventTime}>
                {formatCalendarEventTimeRange(getEventStart(event), getEventEnd(event), timezone)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function CalendarEventCard({
  calendarColor,
  event,
  timezone,
  onPress,
}: {
  calendarColor: string;
  event: CalendarEventItem;
  timezone: string;
  onPress: () => void;
}) {
  const detail = getEventDetail(event);
  const startTime = formatCalendarEventTime(getEventStart(event), timezone);
  const endTime = formatCalendarEventTime(getEventEnd(event), timezone);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.calendarEventCard, pressed && styles.pressed]}
    >
      <View style={[styles.calendarEventAccent, { backgroundColor: calendarColor }]} />
      <View style={styles.calendarEventCopy}>
        <Text numberOfLines={1} style={styles.calendarEventTitle}>{getEventTitle(event)}</Text>
        <Text numberOfLines={1} style={styles.calendarEventMeta}>
          {getEventStatus(event)}
          {detail ? ` · ${detail}` : ''}
        </Text>
      </View>
      <View style={styles.calendarEventTimeStack}>
        <Text style={styles.calendarEventTimeStart}>{startTime}</Text>
        <Text style={styles.calendarEventTimeEnd}>{endTime}</Text>
      </View>
    </Pressable>
  );
}

function CalendarEmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.calendarEmpty}>
      <View style={styles.calendarEmptyIcon}>
        <CalendarDays size={29} color={COLORS.accent} strokeWidth={2.3} />
      </View>
      <Text style={styles.calendarEmptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.calendarEmptyText}>{subtitle}</Text> : null}
    </View>
  );
}

function CalendarErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.calendarEmpty}>
      <Text style={styles.calendarErrorText}>{message}</Text>
      <SecondaryButton label="Reintentar" onPress={onRetry} />
    </View>
  );
}

function CalendarPickerSheet({
  activeView,
  calendars,
  closing,
  open,
  selectedCalendarId,
  onClose,
  onSelect,
  onSelectView,
}: {
  activeView: CalendarViewMode;
  calendars: CalendarItem[];
  closing: boolean;
  open: boolean;
  selectedCalendarId: string;
  onClose: () => void;
  onSelect: (calendar: CalendarItem) => void;
  onSelectView: (view: Exclude<CalendarViewMode, 'years'>) => void;
}) {
  return (
    <BottomActionSheet
      closing={closing}
      open={open}
      title="Calendarios"
      subtitle="Elige el calendario activo para esta vista"
      onClose={onClose}
    >
      <ScrollView contentContainerStyle={styles.calendarSheetList} showsVerticalScrollIndicator={false}>
        <CalendarViewPicker activeView={activeView} onSelectView={onSelectView} />
        {calendars.map((calendar) => {
          const id = getCalendarKey(calendar);
          const selected = id === selectedCalendarId;
          return (
            <Pressable
              key={id}
              accessibilityRole="button"
              onPress={() => onSelect(calendar)}
              style={({ pressed }) => [
                styles.calendarSheetRow,
                selected && styles.calendarSheetRowSelected,
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.calendarSheetDot, { backgroundColor: getCalendarColor(calendar) }]} />
              <View style={styles.calendarSheetCopy}>
                <Text numberOfLines={1} style={styles.calendarSheetTitle}>{getCalendarTitle(calendar)}</Text>
                <Text numberOfLines={1} style={styles.calendarSheetSubtitle}>
                  {calendarIsActive(calendar) ? 'Activo' : 'Inactivo'}
                  {calendar.provider || calendar.source ? ` · ${calendar.provider || calendar.source}` : ''}
                </Text>
              </View>
              {selected ? <Check size={21} color={COLORS.accent} strokeWidth={2.8} /> : null}
            </Pressable>
          );
        })}
        {!calendars.length ? (
          <Text style={styles.contactPickerEmpty}>No hay calendarios conectados.</Text>
        ) : null}
      </ScrollView>
    </BottomActionSheet>
  );
}

function AppointmentContactPickerSheet({
  closing,
  contacts,
  loading,
  open,
  query,
  selectedDateOnly,
  onChangeQuery,
  onClose,
  onSelect,
}: {
  closing: boolean;
  contacts: ChatContact[];
  loading: boolean;
  open: boolean;
  query: string;
  selectedDateOnly: string;
  onChangeQuery: (value: string) => void;
  onClose: () => void;
  onSelect: (contact: ChatContact) => void;
}) {
  return (
    <BottomActionSheet
      closing={closing}
      open={open}
      title="Nueva cita"
      subtitle={formatBusinessDayHeader(selectedDateOnly)}
      onClose={onClose}
    >
      <View style={styles.contactPickerBody}>
        <View style={styles.sheetSearchBox}>
          <Search size={19} color={COLORS.muted} strokeWidth={2.35} />
          <TextInput
            value={query}
            onChangeText={onChangeQuery}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Buscar contacto"
            placeholderTextColor={COLORS.muted}
            style={styles.sheetSearchInput}
          />
        </View>
        {loading ? (
          <View style={styles.sheetInlineState}>
            <ActivityIndicator color={COLORS.accent} />
            <Text style={styles.caption}>Buscando contactos...</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.contactPickerList} keyboardShouldPersistTaps="handled">
            {contacts.map((contact) => (
              <ContactPickerRow key={contact.id} contact={contact} showSendIcon={false} onPress={() => onSelect(contact)} />
            ))}
            {!contacts.length ? (
              <View style={styles.sheetInlineState}>
                <User size={26} color={COLORS.accent} strokeWidth={2.3} />
                <Text style={styles.contactPickerEmpty}>Busca un contacto para agendar.</Text>
              </View>
            ) : null}
          </ScrollView>
        )}
      </View>
    </BottomActionSheet>
  );
}

function CalendarEventDetailsSheet({
  busy,
  calendarColor,
  closing,
  event,
  open,
  timezone,
  onClose,
  onDelete,
  onEdit,
}: {
  busy: boolean;
  calendarColor: string;
  closing: boolean;
  event: CalendarEventItem | null;
  open: boolean;
  timezone: string;
  onClose: () => void;
  onDelete: (event: CalendarEventItem) => void;
  onEdit: (event: CalendarEventItem) => void;
}) {
  if (!event) {
    return (
      <BottomActionSheet closing={closing} open={open} title="Cita" onClose={onClose}>
        <View style={styles.sheetInlineState}>
          <Text style={styles.caption}>No hay detalles para mostrar.</Text>
        </View>
      </BottomActionSheet>
    );
  }

  const start = getEventStart(event);
  const dateOnly = getBusinessDateOnly(start, timezone);
  const detail = getEventDetail(event);

  return (
    <BottomActionSheet
      closing={closing}
      open={open}
      title={getEventTitle(event)}
      subtitle={getEventStatus(event)}
      onClose={onClose}
    >
      <View style={styles.eventDetailsBody}>
        <View style={styles.eventDetailsHero}>
          <View style={[styles.eventDetailsAccent, { backgroundColor: calendarColor }]} />
          <View style={styles.eventDetailsCopy}>
            <Text style={styles.eventDetailsDate}>{formatBusinessDayHeader(dateOnly)}</Text>
            <Text style={styles.eventDetailsTime}>
              {formatCalendarEventTimeRange(getEventStart(event), getEventEnd(event), timezone) || 'Sin hora'}
            </Text>
          </View>
        </View>
        <View style={styles.sheetActionRow}>
          <View style={styles.sheetActionIcon}>
            <Clock size={18} color={COLORS.accent} strokeWidth={2.7} />
          </View>
          <View style={styles.sheetActionCopy}>
            <Text style={styles.sheetActionTitle}>Estado</Text>
            <Text style={styles.sheetActionSubtitle}>{getEventStatus(event)}</Text>
          </View>
        </View>
        {detail ? (
          <View style={styles.sheetActionRow}>
            <View style={styles.sheetActionIcon}>
              <CalendarDays size={18} color={COLORS.accent} strokeWidth={2.7} />
            </View>
            <View style={styles.sheetActionCopy}>
              <Text style={styles.sheetActionTitle}>Detalle</Text>
              <Text style={styles.sheetActionSubtitle}>{detail}</Text>
            </View>
          </View>
        ) : null}
        <View style={styles.sheetSectionDivider}>
          <Text style={styles.sheetSectionLabel}>Acciones</Text>
        </View>
        <SheetActionRow
          Icon={FileText}
          title="Editar cita"
          subtitle="Cambiar título, estado, horario, dirección o notas."
          disabled={busy}
          onPress={() => onEdit(event)}
        />
        <SheetActionRow
          Icon={Trash2}
          title="Eliminar cita"
          subtitle="Borra esta cita del calendario."
          danger
          busy={busy}
          onPress={() => onDelete(event)}
        />
      </View>
    </BottomActionSheet>
  );
}

function AppointmentFormSheet({
  api,
  busy,
  calendar,
  closing,
  draft,
  mode,
  open,
  timezone,
  onChange,
  onClose,
  onSave,
}: {
  api: RistakApiClient;
  busy: boolean;
  calendar: CalendarItem | null;
  closing: boolean;
  draft: AppointmentDraft | null;
  mode: AppointmentFormMode;
  open: boolean;
  timezone: string;
  onChange: (draft: AppointmentDraft | null) => void;
  onClose: () => void;
  onSave: (draft: AppointmentDraft) => void;
}) {
  const [scheduleMode, setScheduleMode] = useState<AppointmentScheduleMode>('default');
  const [advancedPicker, setAdvancedPicker] = useState<AppointmentAdvancedPicker>(null);
  const [freeSlots, setFreeSlots] = useState<CalendarFreeSlot[]>([]);
  const [freeSlotsLoading, setFreeSlotsLoading] = useState(false);
  const [freeSlotsError, setFreeSlotsError] = useState('');
  const [selectedSlotDate, setSelectedSlotDate] = useState('');
  const [selectedSlot, setSelectedSlot] = useState('');
  const [guestSearchQuery, setGuestSearchQuery] = useState('');
  const [guestContacts, setGuestContacts] = useState<ChatContact[]>([]);
  const [guestSearching, setGuestSearching] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [guestContact, setGuestContact] = useState('');
  const [guestCreating, setGuestCreating] = useState(false);
  const [assignmentUsers, setAssignmentUsers] = useState<CalendarUser[]>([]);
  const [assignmentLoading, setAssignmentLoading] = useState(false);
  const [assignmentError, setAssignmentError] = useState('');
  const freeSlotDateScrollRef = useRef<ScrollView | null>(null);
  const preferredSlotDateRef = useRef('');

  const updateDraft = useCallback((updates: Partial<AppointmentDraft>) => {
    if (!draft) return;
    onChange({ ...draft, ...updates });
  }, [draft, onChange]);

  const loadFreeSlots = useCallback(async () => {
    const calendarId = getCalendarKey(calendar);
    if (!calendarId) return;
    setFreeSlotsLoading(true);
    setFreeSlotsError('');
    try {
      const startDate = todayDateOnlyInBusinessTimezone(timezone);
      const endDate = addBusinessDateOnlyDays(startDate, 30);
      const response = await api.getFreeSlots(calendarId, startDate, endDate, timezone);
      const nextSlots = Array.isArray(response) ? response.filter((group) => Array.isArray(group.slots) && group.slots.length > 0) : [];
      const preferredDate = preferredSlotDateRef.current;
      setFreeSlots(nextSlots);
      setSelectedSlotDate((current) => {
        if (current && nextSlots.some((group) => group.date === current)) return current;
        if (preferredDate && nextSlots.some((group) => group.date === preferredDate)) return preferredDate;
        return nextSlots[0]?.date || '';
      });
    } catch (err) {
      setFreeSlots([]);
      setFreeSlotsError(err instanceof Error ? err.message : 'No se pudieron cargar slots.');
    } finally {
      setFreeSlotsLoading(false);
    }
  }, [api, calendar, timezone]);

  const loadAssignmentUsers = useCallback(async () => {
    const teamMemberIds = (calendar?.teamMembers || [])
      .map(getCalendarTeamMemberId)
      .filter(Boolean);

    setAssignmentLoading(true);
    setAssignmentError('');
    try {
      const response = teamMemberIds.length > 0 && isRoundRobinCalendar(calendar)
        ? await api.getCalendarUsersByIds(teamMemberIds)
        : await api.getCalendarUsers();
      let users = unwrapCalendarUsers(response);
      if (!users.length && teamMemberIds.length) {
        users = teamMemberIds.map((id) => ({ id, name: `Usuario ${id.slice(0, 8)}...` }));
      }
      setAssignmentUsers(users);
    } catch (err) {
      setAssignmentUsers(teamMemberIds.map((id) => ({ id, name: `Usuario ${id.slice(0, 8)}...` })));
      setAssignmentError(err instanceof Error ? err.message : 'No se pudo cargar el equipo.');
    } finally {
      setAssignmentLoading(false);
    }
  }, [api, calendar]);

  useEffect(() => {
    if (!open || !draft) return;
    preferredSlotDateRef.current = draft.dateOnly;
    setScheduleMode(mode === 'create' ? 'default' : 'custom');
    setAdvancedPicker(null);
    setSelectedSlot('');
    setGuestSearchQuery('');
    setGuestContacts([]);
    setGuestSearching(false);
    setGuestName('');
    setGuestContact('');
  }, [draft?.contactId, draft?.eventId, mode, open]);

  useEffect(() => {
    if (!open || !draft) {
      setScheduleMode('default');
      setAdvancedPicker(null);
      setFreeSlots([]);
      setSelectedSlotDate('');
      setSelectedSlot('');
      setGuestSearchQuery('');
      setGuestContacts([]);
      setGuestSearching(false);
      setGuestName('');
      setGuestContact('');
      setAssignmentUsers([]);
      setAssignmentError('');
      return;
    }
    if (scheduleMode === 'default') {
      void loadFreeSlots();
    }
  }, [Boolean(draft), loadFreeSlots, open, scheduleMode]);

  useEffect(() => {
    if (!open || !draft || (!draft.assignedUserId && !isRoundRobinCalendar(calendar))) return;
    void loadAssignmentUsers();
  }, [calendar, draft?.assignedUserId, draft?.calendarId, loadAssignmentUsers, open]);

  useEffect(() => {
    if (!open || !draft || !selectedSlotDate || scheduleMode !== 'default') return;
    const index = freeSlots.findIndex((group) => group.date === selectedSlotDate);
    if (index <= 0) return;
    const scrollX = Math.max(0, index * FREE_SLOT_DATE_CHIP_SPAN - 22);
    requestAnimationFrame(() => {
      freeSlotDateScrollRef.current?.scrollTo({ x: scrollX, animated: true });
    });
  }, [draft, freeSlots, open, scheduleMode, selectedSlotDate]);

  useEffect(() => {
    const query = guestSearchQuery.trim();
    if (!open || !draft || query.length < 2) {
      setGuestContacts([]);
      setGuestSearching(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setGuestSearching(true);
      api.searchContacts(query)
        .then((results) => {
          if (!cancelled) setGuestContacts(Array.isArray(results) ? results.slice(0, 6) : []);
        })
        .catch(() => {
          if (!cancelled) setGuestContacts([]);
        })
        .finally(() => {
          if (!cancelled) setGuestSearching(false);
        });
    }, 160);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, Boolean(draft), guestSearchQuery, open]);

  const selectedDateParts = useMemo(() => {
    const fallbackDateOnly = todayDateOnlyInBusinessTimezone(timezone);
    const date = dateOnlyToCalendarDate(draft?.dateOnly || '') || dateOnlyToCalendarDate(fallbackDateOnly);
    return {
      year: date?.getFullYear() || Number(formatBusinessYear(fallbackDateOnly)) || 2026,
      month: (date?.getMonth() ?? 0) + 1,
      day: date?.getDate() || 1,
    };
  }, [draft?.dateOnly, timezone]);
  const selectedTimeMinutes = parseTimeToMinutes(draft?.startTime) ?? 9 * 60;
  const selectedTimeHour24 = Math.floor(selectedTimeMinutes / 60);
  const selectedTimeMinute = selectedTimeMinutes % 60;
  const selectedTimePeriod: 'AM' | 'PM' = selectedTimeHour24 >= 12 ? 'PM' : 'AM';
  const selectedTimeHour12 = selectedTimeHour24 % 12 || 12;
  const selectedDuration = Math.max(60, Math.min(TIMELINE_TOTAL_MINUTES, draft?.durationMinutes || 60));
  const selectedDurationHours = Math.max(1, Math.min(24, Math.floor(selectedDuration / 60) || 1));
  const selectedDurationMinutes = APPOINTMENT_DURATION_MINUTE_OPTIONS.includes(selectedDuration % 60) ? selectedDuration % 60 : 0;
  const dateDayOptions = useMemo(
    () => Array.from({ length: getDaysInMonth(selectedDateParts.year, selectedDateParts.month) }, (_, index) => index + 1),
    [selectedDateParts.month, selectedDateParts.year],
  );
  const dateYearOptions = useMemo(() => (
    Array.from({ length: 9 }, (_, index) => selectedDateParts.year - 3 + index)
  ), [selectedDateParts.year]);
  const selectedSlotGroup = freeSlots.find((group) => group.date === selectedSlotDate) || null;
  const assignmentRequired = mode === 'create' && isRoundRobinCalendar(calendar);
  const showAssignmentPicker = Boolean(draft && (
    assignmentRequired ||
    draft.assignedUserId ||
    (isRoundRobinCalendar(calendar) && (assignmentUsers.length || assignmentLoading || assignmentError))
  ));

  const setScheduleModeSafely = useCallback((nextMode: AppointmentScheduleMode) => {
    setScheduleMode(nextMode);
    setAdvancedPicker(null);
  }, []);

  const applyDatePart = useCallback((updates: Partial<typeof selectedDateParts>) => {
    const year = updates.year ?? selectedDateParts.year;
    const month = updates.month ?? selectedDateParts.month;
    const day = updates.day ?? selectedDateParts.day;
    updateDraft({ dateOnly: buildDateOnlyFromParts(year, month, day) });
  }, [selectedDateParts, updateDraft]);

  const applyTimePart = useCallback((updates: { hour?: number; minute?: number; period?: 'AM' | 'PM' }) => {
    const nextHour12 = updates.hour ?? selectedTimeHour12;
    const nextMinute = updates.minute ?? selectedTimeMinute;
    const nextPeriod = updates.period ?? selectedTimePeriod;
    const hour24 = nextPeriod === 'PM'
      ? (nextHour12 % 12) + 12
      : nextHour12 % 12;
    updateDraft({ startTime: formatMinutesAsTime(hour24 * 60 + nextMinute) });
  }, [selectedTimeHour12, selectedTimeMinute, selectedTimePeriod, updateDraft]);

  const applyDurationPart = useCallback((hours: number, minutes: number) => {
    const safeHours = Math.max(1, Math.min(24, Math.round(hours || 1)));
    const safeMinutes = APPOINTMENT_DURATION_MINUTE_OPTIONS.includes(minutes) ? minutes : 0;
    const total = Math.min(TIMELINE_TOTAL_MINUTES, safeHours * 60 + safeMinutes);
    updateDraft({ durationMinutes: total });
  }, [updateDraft]);

  const addGuestToDraft = useCallback((guest: Omit<AppointmentGuest, 'id'> & { id?: string }) => {
    if (!draft) return;
    const name = guest.name.trim();
    const contactValue = guest.contact.trim();
    if (!name || !contactValue) {
      Alert.alert('Invitado incompleto', 'Agrega nombre y teléfono o correo para poder invitarlo.');
      return;
    }
    const normalizedContact = contactValue.toLowerCase();
    const exists = draft.guests.some((item) => item.contact.trim().toLowerCase() === normalizedContact);
    if (exists) return;
    updateDraft({
      guests: [
        ...draft.guests,
        {
          id: guest.id || createAppointmentGuestId(),
          name,
          contact: contactValue,
          contactId: guest.contactId,
        },
      ],
    });
  }, [draft, updateDraft]);

  const selectGuestContact = useCallback((contact: ChatContact) => {
    const delivery = getContactDelivery(contact);
    if (!delivery) {
      Alert.alert('Sin contacto', 'Este contacto no tiene teléfono ni correo registrado.');
      return;
    }
    addGuestToDraft({
      name: getContactName(contact),
      contact: delivery,
      contactId: contact.id,
    });
    setGuestSearchQuery('');
    setGuestContacts([]);
  }, [addGuestToDraft]);

  const createGuestContact = useCallback(async () => {
    const searchValue = guestSearchQuery.trim();
    const contactValue = (guestContact.trim() || (searchValue.includes('@') || /\d/.test(searchValue) ? searchValue : '')).trim();
    const nameValue = (guestName.trim() || (!contactValue && searchValue ? searchValue : '')).trim();
    if (!nameValue || !contactValue) {
      Alert.alert('Faltan datos', 'Escribe el nombre y el teléfono o correo del invitado.');
      return;
    }

    setGuestCreating(true);
    try {
      const isEmail = contactValue.includes('@');
      const created = await api.createContact({
        name: nameValue,
        full_name: nameValue,
        email: isEmail ? contactValue : undefined,
        phone: isEmail ? undefined : contactValue,
        source: 'mobile_native_appointment_guest',
      });
      addGuestToDraft({
        name: getContactName(created) || nameValue,
        contact: getContactDelivery(created) || contactValue,
        contactId: created.id,
      });
      setGuestSearchQuery('');
      setGuestContacts([]);
      setGuestName('');
      setGuestContact('');
    } catch (err) {
      Alert.alert('No se creó el contacto', err instanceof Error ? err.message : 'Intenta de nuevo.');
    } finally {
      setGuestCreating(false);
    }
  }, [addGuestToDraft, api, guestContact, guestName, guestSearchQuery]);

  const removeGuest = useCallback((guestId: string) => {
    if (!draft) return;
    updateDraft({ guests: draft.guests.filter((guest) => guest.id !== guestId) });
  }, [draft, updateDraft]);

  const renderPickerChip = (
    label: string,
    selected: boolean,
    onPress: () => void,
    key?: string | number,
  ) => (
    <Pressable
      key={key ?? label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.appointmentPickerChip,
        selected && styles.appointmentPickerChipActive,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.appointmentPickerText, selected && styles.appointmentPickerTextActive]}>{label}</Text>
    </Pressable>
  );

  const renderAdvancedPicker = () => {
    if (!advancedPicker) return null;

    if (advancedPicker === 'date') {
      return (
        <View style={styles.appointmentAdvancedPanel}>
          <View style={styles.appointmentPickerGroup}>
            <Text style={styles.appointmentPickerTitle}>Día</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.appointmentPickerRow}>
              {dateDayOptions.map((day) => renderPickerChip(String(day), selectedDateParts.day === day, () => applyDatePart({ day }), `day-${day}`))}
            </ScrollView>
          </View>
          <View style={styles.appointmentPickerGroup}>
            <Text style={styles.appointmentPickerTitle}>Mes</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.appointmentPickerRow}>
              {APPOINTMENT_DATE_MONTH_OPTIONS.map((month) => renderPickerChip(month.label, selectedDateParts.month === month.value, () => applyDatePart({ month: month.value }), `month-${month.value}`))}
            </ScrollView>
          </View>
          <View style={styles.appointmentPickerGroup}>
            <Text style={styles.appointmentPickerTitle}>Año</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.appointmentPickerRow}>
              {dateYearOptions.map((year) => renderPickerChip(String(year), selectedDateParts.year === year, () => applyDatePart({ year }), `year-${year}`))}
            </ScrollView>
          </View>
        </View>
      );
    }

    if (advancedPicker === 'time') {
      return (
        <View style={styles.appointmentAdvancedPanel}>
          <View style={styles.appointmentPickerGroup}>
            <Text style={styles.appointmentPickerTitle}>Hora</Text>
            <View style={styles.appointmentPickerWrap}>
              {APPOINTMENT_TIME_HOUR_OPTIONS.map((hour) => renderPickerChip(String(hour), selectedTimeHour12 === hour, () => applyTimePart({ hour }), `hour-${hour}`))}
            </View>
          </View>
          <View style={styles.appointmentPickerGroup}>
            <Text style={styles.appointmentPickerTitle}>Minutos</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.appointmentPickerRow}>
              {APPOINTMENT_TIME_MINUTE_OPTIONS.map((minute) => renderPickerChip(String(minute).padStart(2, '0'), selectedTimeMinute === minute, () => applyTimePart({ minute }), `minute-${minute}`))}
            </ScrollView>
          </View>
          <View style={styles.appointmentPickerGroup}>
            <Text style={styles.appointmentPickerTitle}>AM / PM</Text>
            <View style={styles.appointmentPickerWrap}>
              {(['AM', 'PM'] as const).map((period) => renderPickerChip(period, selectedTimePeriod === period, () => applyTimePart({ period }), period))}
            </View>
          </View>
        </View>
      );
    }

    return (
      <View style={styles.appointmentAdvancedPanel}>
        <View style={styles.appointmentPickerGroup}>
          <Text style={styles.appointmentPickerTitle}>Horas</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.appointmentPickerRow}>
            {APPOINTMENT_DURATION_HOUR_OPTIONS.map((hours) => renderPickerChip(`${hours} h`, selectedDurationHours === hours, () => applyDurationPart(hours, selectedDurationMinutes), `duration-hour-${hours}`))}
          </ScrollView>
        </View>
        <View style={styles.appointmentPickerGroup}>
          <Text style={styles.appointmentPickerTitle}>Minutos</Text>
          <View style={styles.appointmentPickerWrap}>
            {APPOINTMENT_DURATION_MINUTE_OPTIONS.map((minutes) => renderPickerChip(`${minutes} min`, selectedDurationMinutes === minutes, () => applyDurationPart(selectedDurationHours, minutes), `duration-minute-${minutes}`))}
          </View>
        </View>
      </View>
    );
  };

  const renderGuestsSection = () => (
    <View style={styles.appointmentGuestSection}>
      <View style={styles.appointmentGuestHeader}>
        <AppointmentFieldLabel label="Invitados" />
        {draft?.guests.length ? <Text style={styles.appointmentGuestCount}>{draft.guests.length}</Text> : null}
      </View>
      <View style={styles.sheetSearchBox}>
        <Search size={18} color={COLORS.muted} strokeWidth={2.4} />
        <TextInput
          value={guestSearchQuery}
          onChangeText={setGuestSearchQuery}
          placeholder="Buscar o crear invitado"
          placeholderTextColor={COLORS.muted}
          autoCapitalize="words"
          autoCorrect={false}
          style={styles.sheetSearchInput}
        />
      </View>
      {guestSearching ? (
        <View style={styles.appointmentInlineLoading}>
          <ActivityIndicator color={COLORS.accent} />
          <Text style={styles.caption}>Buscando contactos...</Text>
        </View>
      ) : guestContacts.length ? (
        <View style={styles.appointmentGuestResults}>
          {guestContacts.map((contact) => (
            <ContactPickerRow
              key={contact.id}
              contact={contact}
              showSendIcon={false}
              onPress={() => selectGuestContact(contact)}
            />
          ))}
        </View>
      ) : guestSearchQuery.trim().length >= 2 ? (
        <Text style={styles.appointmentHint}>No aparece en contactos. Créalo aquí mismo.</Text>
      ) : null}
      <View style={styles.appointmentGuestManual}>
        <AppointmentTextField
          compact
          label="Nombre"
          value={guestName}
          placeholder="Nombre del invitado"
          onChangeText={setGuestName}
        />
        <AppointmentTextField
          compact
          label="Teléfono o correo"
          value={guestContact}
          placeholder="WhatsApp o email"
          onChangeText={setGuestContact}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={guestCreating}
        onPress={createGuestContact}
        style={({ pressed }) => [
          styles.appointmentGuestAddButton,
          guestCreating && styles.disabledButton,
          pressed && styles.pressed,
        ]}
      >
        {guestCreating ? <ActivityIndicator color={COLORS.text} /> : <Plus size={18} color={COLORS.text} strokeWidth={2.6} />}
        <Text style={styles.appointmentGuestAddText}>Agregar invitado</Text>
      </Pressable>
      {draft?.guests.length ? (
        <View style={styles.appointmentGuestList}>
          {draft.guests.map((guest) => (
            <View key={guest.id} style={styles.appointmentGuestItem}>
              <View style={styles.appointmentGuestAvatar}>
                <Text style={styles.avatarText}>{guest.name.slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={styles.appointmentGuestCopy}>
                <Text numberOfLines={1} style={styles.appointmentGuestName}>{guest.name}</Text>
                <Text numberOfLines={1} style={styles.appointmentGuestContact}>{guest.contact}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={() => removeGuest(guest.id)}
                style={({ pressed }) => [styles.appointmentGuestRemove, pressed && styles.pressed]}
              >
                <X size={16} color={COLORS.muted} strokeWidth={2.6} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );

  return (
    <BottomActionSheet
      closing={closing}
      open={open}
      title={mode === 'edit' ? 'Editar cita' : 'Nueva cita'}
      subtitle={calendar ? getCalendarTitle(calendar) : 'Calendario'}
      onClose={onClose}
    >
      {!draft ? (
        <View style={styles.sheetInlineState}>
          <Text style={styles.caption}>No hay cita para editar.</Text>
        </View>
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView
            contentContainerStyle={styles.appointmentFormBody}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {showAssignmentPicker && scheduleMode === 'custom' ? (
              <View style={styles.appointmentSection}>
                <Text style={styles.appointmentFieldLabel}>
                  {assignmentRequired ? 'Elegir miembro del equipo' : 'Persona asignada'}
                </Text>
                {assignmentLoading ? (
                  <View style={styles.sheetInlineState}>
                    <ActivityIndicator color={COLORS.accent} />
                    <Text style={styles.caption}>Cargando equipo...</Text>
                  </View>
                ) : assignmentUsers.length ? (
                  <View style={styles.appointmentChipRow}>
                    {!assignmentRequired ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => updateDraft({ assignedUserId: '' })}
                        style={({ pressed }) => [
                          styles.appointmentChoiceChip,
                          !draft.assignedUserId && styles.appointmentChoiceChipActive,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={[styles.appointmentChoiceText, !draft.assignedUserId && styles.appointmentChoiceTextActive]}>
                          Sin asignar
                        </Text>
                      </Pressable>
                    ) : null}
                    {assignmentUsers.map((user) => {
                      const id = getCalendarUserId(user);
                      const selected = draft.assignedUserId === id;
                      return (
                        <Pressable
                          key={id}
                          accessibilityRole="button"
                          onPress={() => updateDraft({ assignedUserId: id })}
                          style={({ pressed }) => [
                            styles.appointmentChoiceChip,
                            selected && styles.appointmentChoiceChipActive,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Text numberOfLines={1} style={[styles.appointmentChoiceText, selected && styles.appointmentChoiceTextActive]}>
                            {getCalendarUserLabel(user)}
                          </Text>
                          <Text numberOfLines={1} style={[styles.appointmentChoiceSubtext, selected && styles.appointmentChoiceTextActive]}>
                            {getCalendarUserDetail(user)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : (
                  <Text style={styles.appointmentHint}>
                    {assignmentError || (assignmentRequired ? 'No pudimos cargar el equipo. Reintenta antes de guardar.' : 'No hay equipo para asignar.')}
                  </Text>
                )}
              </View>
            ) : null}

            <View style={styles.appointmentSection}>
              <AppointmentFieldLabel label="Fecha y hora" required />
              <View style={styles.appointmentSegmentedTabs}>
                {[
                  { value: 'default' as const, label: 'Por defecto' },
                  { value: 'custom' as const, label: 'Personalizado' },
                ].map((option) => {
                  const selected = scheduleMode === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      accessibilityRole="button"
                      onPress={() => setScheduleModeSafely(option.value)}
                      style={({ pressed }) => [
                        styles.appointmentSegmentedTab,
                        selected && styles.appointmentSegmentedTabActive,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={[styles.appointmentChoiceText, selected && styles.appointmentChoiceTextActive]}>
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {scheduleMode === 'default' ? (
                <View style={styles.freeSlotPanel}>
                  {freeSlotsLoading ? (
                    <View style={styles.sheetInlineState}>
                      <ActivityIndicator color={COLORS.accent} />
                      <Text style={styles.caption}>Buscando horarios...</Text>
                    </View>
                  ) : freeSlotsError ? (
                    <View style={styles.sheetInlineState}>
                      <Text style={styles.calendarErrorText}>{freeSlotsError}</Text>
                      <SecondaryButton label="Reintentar" onPress={loadFreeSlots} />
                    </View>
                  ) : freeSlots.length ? (
                    <View style={styles.freeSlotStack}>
                      <Text style={styles.appointmentHint}>Elige una fecha disponible</Text>
                      <ScrollView
                        ref={freeSlotDateScrollRef}
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.freeSlotDateRow}
                      >
                        {freeSlots.map((group) => {
                          const groupDate = group.date || '';
                          const groupSlots = group.slots || [];
                          const selected = selectedSlotDate === groupDate;
                          return (
                            <Pressable
                              key={groupDate}
                              accessibilityRole="button"
                              onPress={() => {
                                setSelectedSlotDate(groupDate);
                                setSelectedSlot('');
                              }}
                              style={({ pressed }) => [
                                styles.freeSlotDateChip,
                                selected && styles.freeSlotDateChipActive,
                                pressed && styles.pressed,
                              ]}
                            >
                              <Text numberOfLines={1} style={[styles.freeSlotDate, selected && styles.freeSlotDateActive]}>
                                {formatBusinessDayHeader(groupDate)}
                              </Text>
                              <Text numberOfLines={1} style={[styles.freeSlotCount, selected && styles.freeSlotDateActive]}>
                                {groupSlots.length} horario{groupSlots.length === 1 ? '' : 's'}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </ScrollView>
                      <Text style={styles.appointmentHint}>Horario</Text>
                      <View style={styles.freeSlotTimeGrid}>
                        {(selectedSlotGroup?.slots || []).slice(0, 18).map((slot) => {
                          const fields = isoToBusinessDateTimeFields(slot, timezone);
                          const selected = selectedSlot === slot;
                          const durationMinutes = getCalendarSlotDurationMinutes(calendar);
                          const slotDateOnly = fields.dateOnly || selectedSlotDate || draft.dateOnly;
                          const slotStartTime = fields.time || draft.startTime;
                          const slotEndFields = addMinutesToBusinessDateTime(slotDateOnly, slotStartTime, durationMinutes);
                          return (
                            <Pressable
                              key={slot}
                              accessibilityRole="button"
                              onPress={() => {
                                setSelectedSlot(slot);
                                updateDraft({
                                  dateOnly: slotDateOnly,
                                  startTime: slotStartTime,
                                  durationMinutes,
                                });
                              }}
                              style={({ pressed }) => [
                                styles.freeSlotChip,
                                selected && styles.freeSlotChipActive,
                                pressed && styles.pressed,
                              ]}
                            >
                              <Text numberOfLines={1} style={[styles.freeSlotTime, selected && styles.freeSlotTimeActive]}>
                                {formatCalendarEventTime(slot, timezone)}
                              </Text>
                              <Text numberOfLines={1} style={[styles.freeSlotDate, selected && styles.freeSlotDateActive]}>
                                {slotEndFields.time}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                  ) : (
                    <Text style={styles.appointmentHint}>No hay horarios disponibles en los próximos 30 días.</Text>
                  )}
                </View>
              ) : null}
            </View>

            {scheduleMode === 'custom' ? (
              <View style={styles.appointmentSection}>
                <View style={styles.appointmentFieldGrid}>
                  <AppointmentSelectField
                    compact
                    label="Fecha"
                    value={formatAppointmentDateField(draft.dateOnly)}
                    onPress={() => setAdvancedPicker((current) => (current === 'date' ? null : 'date'))}
                  />
                  <AppointmentSelectField
                    compact
                    label="Hora"
                    value={formatAppointmentTimeField(draft.startTime)}
                    onPress={() => setAdvancedPicker((current) => (current === 'time' ? null : 'time'))}
                  />
                </View>
                <AppointmentSelectField
                  label="Duración"
                  value={formatAppointmentDurationLabel(draft.durationMinutes)}
                  onPress={() => setAdvancedPicker((current) => (current === 'duration' ? null : 'duration'))}
                />
                {renderAdvancedPicker()}
              </View>
            ) : null}

            {renderGuestsSection()}

            <AppointmentTextField
              multiline
              label="Notas"
              value={draft.notes}
              placeholder="Añade instrucciones, acuerdos o detalles importantes..."
              onChangeText={(value) => updateDraft({ notes: value })}
            />

            <PrimaryButton
              label={mode === 'edit' ? 'Guardar cambios' : 'Crear cita'}
              busy={busy}
              onPress={() => onSave(draft)}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </BottomActionSheet>
  );
}

function AppointmentTextField({
  compact,
  editable = true,
  icon: Icon,
  label,
  multiline,
  placeholder,
  value,
  onChangeText,
}: {
  compact?: boolean;
  editable?: boolean;
  icon?: LucideIcon;
  label: string;
  multiline?: boolean;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={[styles.appointmentField, compact && styles.appointmentFieldCompact]}>
      <AppointmentFieldLabel label={label} />
      <View style={[styles.appointmentInputWrap, multiline && styles.appointmentInputWrapMultiline]}>
        {Icon ? <Icon size={17} color={COLORS.muted} strokeWidth={2.4} /> : null}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={COLORS.muted}
          multiline={multiline}
          editable={editable}
          textAlignVertical={multiline ? 'top' : 'center'}
          autoCapitalize="sentences"
          autoCorrect={false}
          style={[styles.appointmentInput, !editable && styles.appointmentInputReadOnly, multiline && styles.appointmentInputMultiline]}
        />
      </View>
    </View>
  );
}

function AppointmentFieldLabel({ label, required }: { label: string; required?: boolean }) {
  return (
    <Text style={styles.appointmentFieldLabel}>
      {label}
      {required ? <Text style={styles.appointmentRequiredStar}> *</Text> : null}
    </Text>
  );
}

function AppointmentSelectField({
  compact,
  icon: Icon,
  label,
  placeholder,
  required,
  value,
  onPress,
}: {
  compact?: boolean;
  icon?: LucideIcon;
  label?: string;
  placeholder?: string;
  required?: boolean;
  value?: string;
  onPress?: () => void;
}) {
  const content = String(value || '').trim();
  return (
    <View style={[styles.appointmentField, compact && styles.appointmentFieldCompact]}>
      {label ? <AppointmentFieldLabel label={label} required={required} /> : null}
      <Pressable
        accessibilityRole={onPress ? 'button' : undefined}
        disabled={!onPress}
        onPress={onPress}
        style={({ pressed }) => [
          styles.appointmentSelectWrap,
          !onPress && styles.appointmentSelectWrapStatic,
          pressed && styles.pressed,
        ]}
      >
        {Icon ? <Icon size={20} color={COLORS.muted} strokeWidth={2.35} /> : null}
        <Text numberOfLines={1} style={[styles.appointmentSelectValue, !content && styles.appointmentSelectPlaceholder]}>
          {content || placeholder || ''}
        </Text>
        {onPress ? <ChevronDown size={18} color={COLORS.muted} strokeWidth={2.45} /> : null}
      </Pressable>
    </View>
  );
}

function isValidDateOnly(value: string) {
  return getDateOnlyUtcTime(value) !== null;
}

function getDateOnlyUtcTime(value: string) {
  const parsed = dateOnlyToCalendarDate(value);
  if (!parsed) return null;
  return Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function getDateOnlySpanDays(startDate: string, endDate: string) {
  const start = getDateOnlyUtcTime(startDate);
  const end = getDateOnlyUtcTime(endDate);
  if (start === null || end === null) return 0;
  return Math.max(0, Math.round((end - start) / 86400000) + 1);
}

function formatDateOnlyRangeLabel(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match || !isValidDateOnly(value)) return value;
  const day = match[3];
  const month = Number(match[2]);
  const monthLabel = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][month - 1] || '';
  return `${day}-${monthLabel}`;
}

function getAnalyticsGroupBy(period: AnalyticsPeriod, startDate?: string, endDate?: string): 'day' | 'month' {
  if (period === 'custom') {
    return getDateOnlySpanDays(startDate || '', endDate || '') > 120 ? 'month' : 'day';
  }

  return period === '180d' || period === 'year' ? 'month' : 'day';
}

function combineAnalyticsSeries(first: Array<{ label: string; value: number }>, second: Array<{ label: string; value: number }>): AnalyticsChartPoint[] {
  const firstMap = new Map(first.map((item) => [item.label, Number(item.value) || 0]));
  const secondMap = new Map(second.map((item) => [item.label, Number(item.value) || 0]));
  const labels = Array.from(new Set([...firstMap.keys(), ...secondMap.keys()])).sort();

  return labels.map((label) => ({
    label,
    value: firstMap.get(label) || 0,
    value2: secondMap.get(label) || 0,
  }));
}

function getVariationLabel(value?: number) {
  const numeric = Number(value || 0);
  const rounded = Math.abs(numeric).toFixed(1);
  if (numeric > 0) return `+${rounded}%`;
  if (numeric < 0) return `-${rounded}%`;
  return '0%';
}

function cleanAnalyticsLabels(labels?: Partial<CustomLabels> | null): CustomLabels {
  return {
    customer: String(labels?.customer || '').trim() || DEFAULT_CUSTOM_LABELS.customer,
    customers: String(labels?.customers || '').trim() || DEFAULT_CUSTOM_LABELS.customers,
    lead: String(labels?.lead || '').trim() || DEFAULT_CUSTOM_LABELS.lead,
    leads: String(labels?.leads || '').trim() || DEFAULT_CUSTOM_LABELS.leads,
  };
}

function normalizeAnalyticsPhone(value?: string | null) {
  return String(value || '').replace(/\D/g, '');
}

function getPhoneStatusLabel(phone?: WhatsAppApiPhoneNumber, row?: WhatsAppNumberOriginDatum) {
  const qrConnected = phone?.qr_status === 'connected' || phone?.qr_send_enabled || row?.qrSendEnabled;
  const apiActive = phone?.api_send_enabled || row?.apiSendEnabled;

  if (qrConnected && apiActive) return 'API y web';
  if (qrConnected) return 'Web activo';
  if (apiActive) return 'API activa';
  return 'Detectado';
}

function getPhoneName(phone: WhatsAppApiPhoneNumber, row?: WhatsAppNumberOriginDatum) {
  return phone.label || phone.verified_name || row?.name || phone.display_phone_number || phone.phone_number || 'Número';
}

function getPhoneDisplay(phone: WhatsAppApiPhoneNumber, row?: WhatsAppNumberOriginDatum) {
  return phone.display_phone_number || phone.phone_number || row?.displayPhoneNumber || row?.phoneNumber || '';
}

function buildPhoneNumberRows(
  apiRows: WhatsAppNumberOriginDatum[],
  detectedPhones: WhatsAppApiPhoneNumber[],
): AnalyticsPhoneNumberOriginRow[] {
  const usedApiRows = new Set<number>();
  const rows: AnalyticsPhoneNumberOriginRow[] = [];

  detectedPhones.forEach((phone) => {
    const phoneId = phone.id || '';
    const phoneDigits = normalizeAnalyticsPhone(phone.phone_number || phone.display_phone_number || phone.qr_connected_phone);
    const matchedIndex = apiRows.findIndex((row, index) => {
      if (usedApiRows.has(index)) return false;
      const rowDigits = normalizeAnalyticsPhone(row.phoneNumber || row.displayPhoneNumber);
      return (phoneId && row.phoneNumberId === phoneId) || (phoneDigits && rowDigits && phoneDigits === rowDigits);
    });
    const matchedRow = matchedIndex >= 0 ? apiRows[matchedIndex] : undefined;

    if (matchedIndex >= 0) usedApiRows.add(matchedIndex);

    rows.push({
      key: phone.id || phone.phone_number || phone.display_phone_number || `phone-${rows.length}`,
      name: getPhoneName(phone, matchedRow),
      phone: getPhoneDisplay(phone, matchedRow),
      value: matchedRow?.value || 0,
      statusLabel: getPhoneStatusLabel(phone, matchedRow),
    });
  });

  apiRows.forEach((row, index) => {
    if (usedApiRows.has(index)) return;

    rows.push({
      key: row.phoneNumberId || row.phoneNumber || row.displayPhoneNumber || `origin-${index}`,
      name: row.name,
      phone: row.displayPhoneNumber || row.phoneNumber || '',
      value: row.value || 0,
      statusLabel: getPhoneStatusLabel(undefined, row),
    });
  });

  return rows;
}

function formatChartDateLabel(label: string) {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
  if (dateOnly) {
    const day = Number(dateOnly[3]);
    const month = Number(dateOnly[2]);
    const monthLabel = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][month - 1] || '';
    return `${day} ${monthLabel}`.trim();
  }

  const monthOnly = /^(\d{4})-(\d{2})$/.exec(label);
  if (monthOnly) {
    const month = Number(monthOnly[2]);
    return ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][month - 1] || label;
  }

  return label;
}

function getAnalyticsToneStyle(tone: AnalyticsMetricCardConfig['tone']) {
  if (tone === 'black') return styles.analyticsToneblack;
  if (tone === 'blue') return styles.analyticsToneblue;
  if (tone === 'gold') return styles.analyticsTonegold;
  if (tone === 'red') return styles.analyticsTonered;
  return styles.analyticsTonegreen;
}

function getAnalyticsIconColor(tone: AnalyticsMetricCardConfig['tone']) {
  return tone === 'black' || tone === 'green' ? COLORS.bg : COLORS.text;
}

function AnalyticsDualLineChart({
  data,
  meta,
  currency,
}: {
  data: AnalyticsChartPoint[];
  meta: AnalyticsChartMeta;
  currency: string;
}) {
  const width = 320;
  const height = 176;
  const padding = { top: 18, right: 14, bottom: 28, left: 14 };
  const maxValue = Math.max(1, ...data.flatMap((item) => [item.value || 0, item.value2 || 0]));
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const buildPoints = (key: 'value' | 'value2') => data.map((point, index) => {
    const x = data.length <= 1
      ? width / 2
      : padding.left + (index / (data.length - 1)) * plotWidth;
    const y = padding.top + plotHeight - ((point[key] || 0) / maxValue) * plotHeight;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');

  const labelIndexes = Array.from(new Set([
    0,
    Math.floor((data.length - 1) / 2),
    data.length - 1,
  ])).filter((index) => index >= 0 && data[index]);

  return (
    <View style={styles.analyticsChartCanvas}>
      <Text style={styles.analyticsChartTopScale}>
        {meta.currency ? formatCompactCurrency(maxValue, currency) : formatCompactNumber(maxValue)}
      </Text>
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
        {[0.25, 0.5, 0.75].map((step) => {
          const y = padding.top + plotHeight * step;
          return (
            <Line
              key={step}
              x1={padding.left}
              x2={width - padding.right}
              y1={y}
              y2={y}
              stroke={COLORS.border}
              strokeWidth={1}
            />
          );
        })}
        <Polyline
          points={buildPoints('value')}
          fill="none"
          stroke={meta.color1}
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Polyline
          points={buildPoints('value2')}
          fill="none"
          stroke={meta.color2}
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {data.map((point, index) => {
          const x = data.length <= 1
            ? width / 2
            : padding.left + (index / (data.length - 1)) * plotWidth;
          const y1 = padding.top + plotHeight - ((point.value || 0) / maxValue) * plotHeight;
          const y2 = padding.top + plotHeight - ((point.value2 || 0) / maxValue) * plotHeight;

          return (
            <React.Fragment key={`${point.label}-${index}`}>
              <Circle cx={x} cy={y1} r={2.8} fill={meta.color1} />
              <Circle cx={x} cy={y2} r={2.8} fill={meta.color2} />
            </React.Fragment>
          );
        })}
        {labelIndexes.map((index) => {
          const x = data.length <= 1
            ? width / 2
            : padding.left + (index / (data.length - 1)) * plotWidth;

          return (
            <SvgText
              key={index}
              x={x}
              y={height - 7}
              fill={COLORS.muted}
              fontSize={10}
              fontWeight="750"
              textAnchor="middle"
            >
              {formatChartDateLabel(data[index]?.label || '')}
            </SvgText>
          );
        })}
      </Svg>
    </View>
  );
}

function AnalyticsSection({ api }: { api: RistakApiClient }) {
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d');
  const [periodMenuOpen, setPeriodMenuOpen] = useState(false);
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [customDraftStartDate, setCustomDraftStartDate] = useState('');
  const [customDraftEndDate, setCustomDraftEndDate] = useState('');
  const [customRangeError, setCustomRangeError] = useState('');
  const [chartView, setChartView] = useState<AnalyticsChartView>('revenue-spend');
  const [financialScope, setFinancialScope] = useState<DashboardFunnelScope>('all');
  const [funnelScope, setFunnelScope] = useState<DashboardFunnelScope>('all');
  const [originTab, setOriginTab] = useState<AnalyticsOriginTab>('traffic');
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [chartData, setChartData] = useState<AnalyticsChartPoint[]>([]);
  const [funnelData, setFunnelData] = useState<DashboardFunnelRow[]>([]);
  const [originData, setOriginData] = useState<OriginDistributionData>(EMPTY_ORIGIN_DATA);
  const [detectedPhones, setDetectedPhones] = useState<WhatsAppApiPhoneNumber[]>([]);
  const [labels, setLabels] = useState<CustomLabels>(DEFAULT_CUSTOM_LABELS);
  const [businessTimezone, setBusinessTimezone] = useState(resolveBusinessTimezone());
  const [accountCurrency, setAccountCurrency] = useState(normalizeCurrencyCode());
  const [loading, setLoading] = useState(true);
  const [chartLoading, setChartLoading] = useState(true);
  const [funnelLoading, setFunnelLoading] = useState(true);
  const [originLoading, setOriginLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const activePeriod = ANALYTICS_PERIOD_OPTIONS.find((option) => option.id === period) || ANALYTICS_PERIOD_OPTIONS[0];
  const defaultCustomRange = useMemo(() => getTodayRange(30, businessTimezone), [businessTimezone]);
  const customRangeLabel = isValidDateOnly(customStartDate) && isValidDateOnly(customEndDate)
    ? `${formatDateOnlyRangeLabel(customStartDate)} - ${formatDateOnlyRangeLabel(customEndDate)}`
    : '';
  const activePeriodLabel = period === 'custom' ? 'Personalizado' : activePeriod.label;
  const range = useMemo(() => {
    if (period === 'custom' && isValidDateOnly(customStartDate) && isValidDateOnly(customEndDate)) {
      return {
        startDate: customStartDate,
        endDate: customEndDate,
      };
    }

    return getTodayRange(activePeriod.days ?? 30, businessTimezone);
  }, [activePeriod.days, businessTimezone, customEndDate, customStartDate, period]);
  const groupBy = useMemo(() => getAnalyticsGroupBy(period, range.startDate, range.endDate), [period, range.endDate, range.startDate]);

  useEffect(() => {
    setCustomStartDate((current) => current || defaultCustomRange.startDate);
    setCustomEndDate((current) => current || defaultCustomRange.endDate);
    setCustomDraftStartDate((current) => current || defaultCustomRange.startDate);
    setCustomDraftEndDate((current) => current || defaultCustomRange.endDate);
  }, [defaultCustomRange.endDate, defaultCustomRange.startDate]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      api.getConfig(['account_timezone', 'account_currency']).catch(() => ({})),
      api.getCustomLabels().catch(() => DEFAULT_CUSTOM_LABELS),
    ]).then(([configResponse, labelsResponse]) => {
      if (cancelled) return;
      const values = configResponse && typeof configResponse === 'object' && 'config' in configResponse
        ? configResponse.config
        : configResponse;
      const timezone = values && typeof values === 'object' && 'account_timezone' in values
        ? values.account_timezone
        : '';
      const currency = values && typeof values === 'object' && 'account_currency' in values
        ? values.account_currency
        : '';
      setBusinessTimezone(resolveBusinessTimezone(typeof timezone === 'string' ? timezone : ''));
      setAccountCurrency(normalizeCurrencyCode(typeof currency === 'string' ? currency : ''));
      setLabels(cleanAnalyticsLabels(labelsResponse));
    });

    return () => {
      cancelled = true;
    };
  }, [api]);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setOriginLoading(true);
    setError('');

    try {
      const [metricsResponse, originResponse, whatsappStatus] = await Promise.all([
        api.getDashboardMetrics(range.startDate, range.endDate),
        api.getOriginDistribution(range.startDate, range.endDate).catch(() => EMPTY_ORIGIN_DATA),
        api.getWhatsAppApiStatus().catch(() => null),
      ]);

      setMetrics(metricsResponse);
      setOriginData({
        ...EMPTY_ORIGIN_DATA,
        ...originResponse,
        traffic: {
          ...EMPTY_ORIGIN_DATA.traffic,
          ...(originResponse?.traffic || {}),
        },
        whatsappNumbers: originResponse?.whatsappNumbers || [],
      });
      setDetectedPhones((whatsappStatus?.phoneNumbers || []).filter((phone) => (
        Boolean(phone.id || phone.phone_number || phone.display_phone_number || phone.qr_connected_phone)
      )));
    } catch (err) {
      setMetrics(null);
      setOriginData(EMPTY_ORIGIN_DATA);
      setDetectedPhones([]);
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las analíticas.');
    } finally {
      setLoading(false);
      setOriginLoading(false);
      setRefreshing(false);
    }
  }, [api, range.endDate, range.startDate]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview, reloadKey]);

  useEffect(() => {
    let active = true;

    const loadChart = async () => {
      setChartLoading(true);

      try {
        if (chartView === 'revenue-spend') {
          const response = await api.getFinancialOverview(range.startDate, range.endDate, financialScope);
          if (!active) return;
          setChartData((response || []).map((item) => ({
            label: item.label,
            value: item.value || 0,
            value2: item.value2 || 0,
          })));
          return;
        }

        let response: AnalyticsChartPoint[] = [];
        if (chartView === 'visitors-leads') {
          const [visitors, leads] = await Promise.all([
            api.getDashboardSeries('visitors', range.startDate, range.endDate, groupBy),
            api.getDashboardSeries('leads', range.startDate, range.endDate, groupBy),
          ]);
          response = combineAnalyticsSeries(visitors, leads);
        } else if (chartView === 'leads-appointments') {
          const [leads, appointments] = await Promise.all([
            api.getDashboardSeries('leads', range.startDate, range.endDate, groupBy),
            api.getDashboardSeries('appointments', range.startDate, range.endDate, groupBy),
          ]);
          response = combineAnalyticsSeries(leads, appointments);
        } else if (chartView === 'appointments-attendances') {
          const [appointments, attendances] = await Promise.all([
            api.getDashboardSeries('appointments', range.startDate, range.endDate, groupBy),
            api.getDashboardSeries('attendances', range.startDate, range.endDate, groupBy),
          ]);
          response = combineAnalyticsSeries(appointments, attendances);
        } else {
          const [attendances, sales] = await Promise.all([
            api.getDashboardSeries('attendances', range.startDate, range.endDate, groupBy),
            api.getDashboardSeries('sales', range.startDate, range.endDate, groupBy),
          ]);
          response = combineAnalyticsSeries(attendances, sales);
        }

        if (active) setChartData(response);
      } catch {
        if (active) setChartData([]);
      } finally {
        if (active) setChartLoading(false);
      }
    };

    void loadChart();

    return () => {
      active = false;
    };
  }, [api, chartView, financialScope, groupBy, range.endDate, range.startDate, reloadKey]);

  useEffect(() => {
    let active = true;
    setFunnelLoading(true);

    api.getFunnelData(range.startDate, range.endDate, funnelScope)
      .then((response) => {
        if (active) setFunnelData(Array.isArray(response) ? response : []);
      })
      .catch(() => {
        if (active) setFunnelData([]);
      })
      .finally(() => {
        if (active) setFunnelLoading(false);
      });

    return () => {
      active = false;
    };
  }, [api, funnelScope, range.endDate, range.startDate, reloadKey]);

  const chartOptions = useMemo<Array<{ id: AnalyticsChartView; label: string }>>(() => ([
    { id: 'revenue-spend', label: 'Ingresos vs gastos' },
    { id: 'visitors-leads', label: `Visitantes vs ${labels.leads}` },
    { id: 'leads-appointments', label: `${labels.leads} vs citas` },
    { id: 'appointments-attendances', label: 'Citas vs asistencias' },
    { id: 'attendances-sales', label: 'Asistencias vs ventas' },
  ]), [labels.leads]);

  const chartMeta = useMemo<AnalyticsChartMeta>(() => {
    if (chartView === 'visitors-leads') {
      return { label1: 'Visitantes', label2: labels.leads, color1: COLORS.primary, color2: COLORS.accent, currency: false };
    }
    if (chartView === 'leads-appointments') {
      return { label1: labels.leads, label2: 'Citas', color1: COLORS.accent, color2: '#ffd166', currency: false };
    }
    if (chartView === 'appointments-attendances') {
      return { label1: 'Citas', label2: 'Asistencias', color1: '#ffd166', color2: COLORS.primary, currency: false };
    }
    if (chartView === 'attendances-sales') {
      return { label1: 'Asistencias', label2: 'Ventas', color1: COLORS.primary, color2: COLORS.accent, currency: false };
    }
    return { label1: 'Ingresos', label2: 'Gastos', color1: COLORS.accent, color2: COLORS.text, currency: true };
  }, [chartView, labels.leads]);

  const metricCards = useMemo<AnalyticsMetricCardConfig[]>(() => ([
    { key: 'ingresosNetos', title: 'Ingresos netos', Icon: DollarSign, tone: 'green', formatter: (value) => formatCurrency(value, accountCurrency) },
    { key: 'gastosPublicidad', title: 'Gastos publicidad', Icon: CreditCard, tone: 'black', formatter: (value) => formatCurrency(value, accountCurrency) },
    { key: 'gananciaBruta', title: 'Ganancia bruta', Icon: TrendingUp, tone: 'blue', formatter: (value) => formatCurrency(value, accountCurrency) },
    { key: 'roas', title: 'ROAS', Icon: Activity, tone: 'gold', formatter: formatRoas },
    { key: 'totalCostos', title: 'Gastos negocio', Icon: WalletCards, tone: 'black', formatter: (value) => formatCurrency(value, accountCurrency) },
    { key: 'gananciaNeta', title: 'Ganancia neta', Icon: CircleDollarSign, tone: 'green', formatter: (value) => formatCurrency(value, accountCurrency) },
    { key: 'reembolsos', title: 'Reembolsos', Icon: TrendingDown, tone: 'red', formatter: (value) => formatCurrency(value, accountCurrency) },
    { key: 'ltvPromedio', title: 'Pago promedio', Icon: Users, tone: 'blue', formatter: (value) => formatCurrency(value, accountCurrency) },
  ]), [accountCurrency]);

  const hasChartData = chartData.some((point) => point.value > 0 || point.value2 > 0);
  const funnelRows = funnelData.length > 0
    ? funnelData
    : [
      { stage: 'Visitantes', value: 0 },
      { stage: labels.leads, value: 0 },
      { stage: 'Citas', value: 0 },
      { stage: 'Asistencias', value: 0 },
      { stage: labels.customers, value: 0 },
    ];
  const funnelMax = Math.max(1, ...funnelRows.map((item) => item.value || 0));
  const totalConversion = funnelRows[0]?.value > 0
    ? ((funnelRows[funnelRows.length - 1].value / funnelRows[0].value) * 100).toFixed(1)
    : '0.0';
  const originOptions = useMemo<Array<{ id: AnalyticsOriginTab; label: string }>>(() => ([
    { id: 'traffic', label: 'Tráfico' },
    { id: 'leads', label: labels.leads },
    { id: 'appointments', label: 'Citas' },
    { id: 'conversions', label: labels.customers },
  ]), [labels.customers, labels.leads]);
  const originRows = useMemo<SourceDatum[]>(() => {
    if (originTab === 'traffic') return originData.traffic.sources || [];
    return originData[originTab] || [];
  }, [originData, originTab]);
  const originMax = Math.max(1, ...originRows.map((item) => item.value || 0));
  const originTotal = originRows.reduce((sum, item) => sum + (item.value || 0), 0);
  const phoneNumberRows = useMemo(
    () => buildPhoneNumberRows(originData.whatsappNumbers || [], detectedPhones),
    [detectedPhones, originData.whatsappNumbers],
  );
  const phoneNumberMax = Math.max(1, ...phoneNumberRows.map((item) => item.value || 0));
  const showPhoneNumberOrigin = phoneNumberRows.length >= 2;

  const refresh = () => {
    setRefreshing(true);
    setReloadKey((current) => current + 1);
  };

  const openCustomRangePicker = () => {
    setCustomDraftStartDate(customStartDate || defaultCustomRange.startDate);
    setCustomDraftEndDate(customEndDate || defaultCustomRange.endDate);
    setCustomRangeError('');
    setPeriodMenuOpen(false);
    setCustomRangeOpen(true);
  };

  const closeCustomRangePicker = () => {
    setCustomRangeOpen(false);
    setCustomRangeError('');
  };

  const applyCustomRange = () => {
    const startDate = customDraftStartDate.trim();
    const endDate = customDraftEndDate.trim();

    if (!isValidDateOnly(startDate) || !isValidDateOnly(endDate)) {
      setCustomRangeError('Usa el formato YYYY-MM-DD.');
      return;
    }

    if ((getDateOnlyUtcTime(startDate) || 0) > (getDateOnlyUtcTime(endDate) || 0)) {
      setCustomRangeError('La fecha inicial no puede ser mayor que la final.');
      return;
    }

    setCustomStartDate(startDate);
    setCustomEndDate(endDate);
    setPeriod('custom');
    setCustomRangeOpen(false);
    setCustomRangeError('');
  };

  return (
    <>
      <ScrollView
        refreshControl={<RefreshControl tintColor={COLORS.accent} refreshing={refreshing} onRefresh={refresh} />}
        contentContainerStyle={styles.analyticsScroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.analyticsHeader}>
          <Text style={styles.analyticsEyebrow}>Ristak</Text>
          <View style={styles.analyticsTitleRow}>
            <Text numberOfLines={1} style={styles.analyticsTitle}>Analíticas</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: periodMenuOpen }}
              onPress={() => setPeriodMenuOpen((open) => !open)}
              style={({ pressed }) => [styles.analyticsPeriodToggle, periodMenuOpen && styles.analyticsPeriodToggleOpen, pressed && styles.pressed]}
            >
              <Text numberOfLines={1} style={styles.analyticsPeriodToggleText}>{activePeriodLabel}</Text>
              <ChevronDown size={16} color={COLORS.text} strokeWidth={2.6} />
            </Pressable>
          </View>
          {period === 'custom' && customRangeLabel ? (
            <Text numberOfLines={1} style={styles.analyticsCustomRangeInline}>{customRangeLabel}</Text>
          ) : null}
          {periodMenuOpen ? (
            <View style={styles.analyticsPeriodMenu}>
              {ANALYTICS_PERIOD_OPTIONS.map((option) => {
                const selected = period === option.id;
                const isCustom = option.id === 'custom';
                return (
                  <Pressable
                    key={option.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      if (isCustom) {
                        openCustomRangePicker();
                        return;
                      }

                      setPeriod(option.id);
                      setPeriodMenuOpen(false);
                    }}
                    style={({ pressed }) => [
                      styles.analyticsPeriodOption,
                      isCustom && styles.analyticsPeriodOptionWide,
                      selected && styles.analyticsPeriodOptionActive,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.analyticsPeriodOptionText, selected && styles.analyticsPeriodOptionTextActive]}>
                      {isCustom && customRangeLabel ? `${option.menuLabel} - ${customRangeLabel}` : option.menuLabel}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </View>

      {error ? (
        <View style={styles.analyticsInlineError}>
          <Text style={styles.errorText}>{error}</Text>
          <SecondaryButton label="Reintentar" onPress={loadOverview} />
        </View>
      ) : null}

      <View style={styles.analyticsMetricsGrid}>
        {metricCards.map(({ key, title, Icon, tone, formatter }) => {
          const metric = metrics?.[key];
          const variation = Number(metric?.variation || 0);
          return (
            <View key={key} style={styles.analyticsMetricCard}>
              <View style={[styles.analyticsMetricIcon, getAnalyticsToneStyle(tone)]}>
                <Icon size={18} color={getAnalyticsIconColor(tone)} strokeWidth={2.55} />
              </View>
              <Text numberOfLines={1} style={styles.analyticsMetricTitle}>{title}</Text>
              <Text numberOfLines={1} adjustsFontSizeToFit style={styles.analyticsMetricValue}>
                {loading || !metric ? '...' : formatter(Number(metric.value || 0))}
              </Text>
              <Text numberOfLines={1} style={[styles.analyticsMetricDelta, variation >= 0 ? styles.analyticsDeltaPositive : styles.analyticsDeltaNegative]}>
                {loading || !metric ? '' : `${getVariationLabel(variation)} vs antes`}
              </Text>
            </View>
          );
        })}
      </View>

      <View style={styles.analyticsPanel}>
        <View style={styles.analyticsPanelHeader}>
          <View style={styles.analyticsPanelTitleWrap}>
            <Text style={styles.analyticsSectionLabel}>Gráfica</Text>
            <Text numberOfLines={2} style={styles.analyticsPanelTitle}>
              {chartOptions.find((option) => option.id === chartView)?.label || 'Ingresos vs gastos'}
            </Text>
          </View>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.analyticsOptionScroll}
          contentContainerStyle={styles.analyticsOptionScroller}
        >
          {chartOptions.map((option) => (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityState={{ selected: chartView === option.id }}
              onPress={() => setChartView(option.id)}
              style={({ pressed }) => [styles.analyticsChip, chartView === option.id && styles.analyticsChipActive, pressed && styles.pressed]}
            >
              <Text numberOfLines={1} style={[styles.analyticsChipText, chartView === option.id && styles.analyticsChipTextActive]}>{option.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {chartView === 'revenue-spend' ? (
          <View style={styles.analyticsSegmentedControl}>
            {ANALYTICS_SCOPE_OPTIONS.map((option) => (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                accessibilityState={{ selected: financialScope === option.id }}
                onPress={() => setFinancialScope(option.id)}
                style={[styles.analyticsSegmentButton, financialScope === option.id && styles.analyticsSegmentButtonActive]}
              >
                <Text numberOfLines={1} style={[styles.analyticsSegmentText, financialScope === option.id && styles.analyticsSegmentTextActive]}>
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={styles.analyticsLegendRow}>
          <View style={styles.analyticsLegendItem}>
            <View style={[styles.analyticsLegendDot, { backgroundColor: chartMeta.color1 }]} />
            <Text style={styles.analyticsLegendText}>{chartMeta.label1}</Text>
          </View>
          <View style={styles.analyticsLegendItem}>
            <View style={[styles.analyticsLegendDot, { backgroundColor: chartMeta.color2 }]} />
            <Text style={styles.analyticsLegendText}>{chartMeta.label2}</Text>
          </View>
        </View>

        {chartLoading ? (
          <View style={styles.analyticsLoadingState}>
            <ActivityIndicator color={COLORS.accent} />
          </View>
        ) : hasChartData ? (
          <AnalyticsDualLineChart data={chartData} meta={chartMeta} currency={accountCurrency} />
        ) : (
          <View style={styles.analyticsEmptyState}>
            <Text style={styles.analyticsEmptyText}>Sin datos para este periodo.</Text>
          </View>
        )}
      </View>

      <View style={styles.analyticsPanel}>
        <View style={styles.analyticsPanelHeader}>
          <View style={styles.analyticsPanelTitleWrap}>
            <Text style={styles.analyticsSectionLabel}>Embudo</Text>
            <Text style={styles.analyticsPanelTitle}>Conversiones</Text>
          </View>
          <View style={styles.analyticsConversionPill}>
            <Text style={styles.analyticsConversionPillText}>{totalConversion}%</Text>
          </View>
        </View>

        <View style={styles.analyticsSegmentedControl}>
          {ANALYTICS_SCOPE_OPTIONS.map((option) => (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityState={{ selected: funnelScope === option.id }}
              onPress={() => setFunnelScope(option.id)}
              style={[styles.analyticsSegmentButton, funnelScope === option.id && styles.analyticsSegmentButtonActive]}
            >
              <Text numberOfLines={1} style={[styles.analyticsSegmentText, funnelScope === option.id && styles.analyticsSegmentTextActive]}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {funnelLoading ? (
          <View style={styles.analyticsLoadingState}>
            <ActivityIndicator color={COLORS.accent} />
          </View>
        ) : (
          <View style={styles.analyticsFunnelList}>
            {funnelRows.map((item, index) => {
              const percentage = ((item.value || 0) / funnelMax) * 100;
              const previous = funnelRows[index - 1]?.value || 0;
              const stepRate = index > 0 && previous > 0 ? ((item.value / previous) * 100).toFixed(1) : '';
              const FunnelIcon = index === 0 ? Users : index === 1 ? Target : index === 2 ? CalendarDays : index === 3 ? CheckCircle2 : DollarSign;

              return (
                <View key={`${item.stage}-${index}`} style={styles.analyticsFunnelItem}>
                  <View style={styles.analyticsFunnelIcon}>
                    <FunnelIcon size={16} color={COLORS.text} strokeWidth={2.45} />
                  </View>
                  <View style={styles.analyticsFunnelContent}>
                    <View style={styles.analyticsFunnelTop}>
                      <Text numberOfLines={1} style={styles.analyticsFunnelTitle}>{item.stage}</Text>
                      <Text style={styles.analyticsFunnelValue}>{formatNumber(item.value || 0)}</Text>
                    </View>
                    <View style={styles.analyticsProgressTrack}>
                      <View style={[styles.analyticsProgressFill, { width: `${percentage}%` }]} />
                    </View>
                    {stepRate ? <Text style={styles.analyticsMiniCaption}>{stepRate}% desde el paso anterior</Text> : null}
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </View>

      <View style={styles.analyticsPanel}>
        <View style={styles.analyticsPanelHeader}>
          <View style={styles.analyticsPanelTitleWrap}>
            <Text style={styles.analyticsSectionLabel}>Origen</Text>
            <Text style={styles.analyticsPanelTitle}>Fuentes</Text>
          </View>
          <View style={styles.analyticsConversionPill}>
            <Text style={styles.analyticsConversionPillText}>{formatNumber(originTotal)}</Text>
          </View>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.analyticsOptionScroll}
          contentContainerStyle={styles.analyticsOptionScroller}
        >
          {originOptions.map((option) => (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityState={{ selected: originTab === option.id }}
              onPress={() => setOriginTab(option.id)}
              style={({ pressed }) => [styles.analyticsChip, originTab === option.id && styles.analyticsChipActive, pressed && styles.pressed]}
            >
              <Text numberOfLines={1} style={[styles.analyticsChipText, originTab === option.id && styles.analyticsChipTextActive]}>{option.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {originLoading ? (
          <View style={styles.analyticsLoadingState}>
            <ActivityIndicator color={COLORS.accent} />
          </View>
        ) : originRows.length > 0 ? (
          <View style={styles.analyticsSourceList}>
            {originRows.slice(0, 8).map((item, index) => (
              <View key={`${item.name}-${index}`} style={styles.analyticsSourceItem}>
                <View style={styles.analyticsSourceTop}>
                  <Text numberOfLines={1} style={styles.analyticsSourceTitle}>{item.name}</Text>
                  <Text style={styles.analyticsSourceValue}>{formatNumber(item.value || 0)}</Text>
                </View>
                <View style={styles.analyticsSourceTrack}>
                  <View style={[styles.analyticsSourceFill, { width: `${((item.value || 0) / originMax) * 100}%`, backgroundColor: item.color || COLORS.accent }]} />
                </View>
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.analyticsEmptyState}>
            <Text style={styles.analyticsEmptyText}>Sin origen detectado en este periodo.</Text>
          </View>
        )}
      </View>

        {showPhoneNumberOrigin ? (
          <View style={styles.analyticsPanel}>
            <View style={styles.analyticsPanelHeader}>
              <View style={styles.analyticsPanelTitleWrap}>
                <Text style={styles.analyticsSectionLabel}>WhatsApp</Text>
                <Text style={styles.analyticsPanelTitle}>Origen por número</Text>
              </View>
            </View>

            <View style={styles.analyticsSourceList}>
              {phoneNumberRows.map((item) => (
                <View key={item.key} style={styles.analyticsSourceItem}>
                  <View style={styles.analyticsPhoneSourceTop}>
                    <View style={styles.analyticsPhoneSourceCopy}>
                      <Text numberOfLines={1} style={styles.analyticsSourceTitle}>{item.name}</Text>
                      <Text numberOfLines={1} style={styles.analyticsMiniCaption}>{item.phone || item.statusLabel}</Text>
                    </View>
                    <Text style={styles.analyticsSourceValue}>{formatNumber(item.value)} personas</Text>
                  </View>
                  <View style={styles.analyticsSourceTrack}>
                    <View style={[styles.analyticsSourceFill, { width: `${((item.value || 0) / phoneNumberMax) * 100}%`, backgroundColor: COLORS.text }]} />
                  </View>
                  <Text numberOfLines={1} style={styles.analyticsMiniCaption}>{item.statusLabel}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
      <BottomActionSheet
        open={customRangeOpen}
        title="Fecha personalizada"
        subtitle="Rango de analíticas"
        onClose={closeCustomRangePicker}
      >
        <View style={styles.analyticsCustomSheetBody}>
          <Text style={styles.analyticsCustomHint}>Escribe el rango en formato YYYY-MM-DD.</Text>
          <View style={styles.analyticsCustomDateRow}>
            <View style={styles.analyticsCustomDateField}>
              <Text style={styles.analyticsCustomDateLabel}>Inicio</Text>
              <TextInput
                value={customDraftStartDate}
                onChangeText={setCustomDraftStartDate}
                placeholder={defaultCustomRange.startDate}
                placeholderTextColor={COLORS.muted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="numbers-and-punctuation"
                style={styles.analyticsCustomDateInput}
              />
            </View>
            <View style={styles.analyticsCustomDateField}>
              <Text style={styles.analyticsCustomDateLabel}>Fin</Text>
              <TextInput
                value={customDraftEndDate}
                onChangeText={setCustomDraftEndDate}
                placeholder={defaultCustomRange.endDate}
                placeholderTextColor={COLORS.muted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="numbers-and-punctuation"
                style={styles.analyticsCustomDateInput}
              />
            </View>
          </View>
          {customRangeError ? <Text style={styles.errorText}>{customRangeError}</Text> : null}
          <View style={styles.analyticsCustomActions}>
            <PrimaryButton label="Aplicar rango" onPress={applyCustomRange} />
            <SecondaryButton label="Cancelar" onPress={closeCustomRangePicker} />
          </View>
        </View>
      </BottomActionSheet>
    </>
  );
}

function unwrapConfigResponse(response: { config?: Record<string, ConfigValue> } | Record<string, ConfigValue> | null | undefined): Record<string, ConfigValue> {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return {};
  const nested = (response as { config?: unknown }).config;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Record<string, ConfigValue>;
  return response as Record<string, ConfigValue>;
}

function coerceConfigBoolean(value: unknown, fallback: boolean) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function coerceConfigString(value: unknown, fallback: string) {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function coerceConfigStringArray(value: unknown, fallback: string[] = []) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : fallback;
  } catch {
    return fallback;
  }
}

function coercePhoneThemePreference(value: unknown): PhoneThemePreference {
  return value === 'light' || value === 'dark' || value === 'auto' || value === 'system' ? value : 'system';
}

function getNativePhoneThemeTone(preference: PhoneThemePreference, systemTone: string | null | undefined = Appearance.getColorScheme()) {
  if (preference === 'light' || preference === 'dark') return preference;
  if (preference === 'auto') {
    const hour = new Date().getHours();
    return hour >= 19 || hour < 6 ? 'dark' : 'light';
  }
  return systemTone === 'light' ? 'light' : 'dark';
}

function getNativePhoneThemeBackground(tone: 'light' | 'dark') {
  return tone === 'light' ? '#fbfaf6' : COLORS.bg;
}

function getThemeMeta(preference: PhoneThemePreference, tone: 'light' | 'dark' = getNativePhoneThemeTone(preference)) {
  const label = tone === 'light' ? 'Claro' : 'Noche';
  if (preference === 'light') return 'Claro';
  if (preference === 'dark') return 'Noche';
  if (preference === 'auto') return `Horario: ${label}`;
  return `Sistema: ${label}`;
}

function getBusinessPhoneValue(phone?: WhatsAppApiPhoneNumber | null) {
  return phone?.phone_number || phone?.display_phone_number || phone?.qr_connected_phone || '';
}

function getBusinessPhoneLabel(phone?: WhatsAppApiPhoneNumber | null) {
  return phone?.label || phone?.verified_name || getBusinessPhoneValue(phone) || 'WhatsApp';
}

function getBusinessPhoneDisplay(phone?: WhatsAppApiPhoneNumber | null) {
  const value = getBusinessPhoneValue(phone);
  const label = getBusinessPhoneLabel(phone);
  if (!value) return label;
  return label && label !== value ? `${label} · ${value}` : value;
}

function getBusinessPhoneStatusLabel(phone: WhatsAppApiPhoneNumber) {
  if (phone.availability && phone.availability.available === false) return phone.availability.apiReason || 'No disponible';
  if (phone.api_send_enabled === false && phone.qr_send_enabled) return 'Respaldo QR';
  if (phone.qr_send_enabled && String(phone.qr_status || '').toLowerCase() === 'connected') return 'QR listo';
  if (phone.is_default_sender) return 'Principal';
  return phone.status || 'Disponible';
}

function getPushPermissionLabel(status: NativePushPermissionStatus) {
  if (status === 'granted') return 'Activo';
  if (status === 'denied') return 'Bloqueado';
  if (status === 'unsupported') return 'No soportado';
  return 'Activar';
}

function getTemplateStatus(template: WhatsAppApiTemplate) {
  return String(template.status || 'UNKNOWN').toUpperCase();
}

function getTemplateStatusLabel(status: string) {
  if (status === 'APPROVED') return 'Aprobada';
  if (status === 'PENDING' || status === 'IN_REVIEW') return 'En revisión';
  if (status === 'REJECTED') return 'Rechazada';
  if (status === 'PAUSED' || status === 'DISABLED') return 'Bloqueada';
  return status === 'UNKNOWN' ? 'Sin estado' : status;
}

function getTemplatePreview(template: WhatsAppApiTemplate) {
  const body = template.components?.find((component) => String(component.type || '').toUpperCase() === 'BODY');
  const text = typeof body?.text === 'string' ? body.text : '';
  return text || template.reason || 'Sin vista previa.';
}

function getSettingsPanelTitle(panel: SettingsPanel) {
  if (panel === 'templates') return 'Plantillas';
  if (panel === 'agent') return AI_AGENT_CHAT_DISPLAY_NAME;
  if (panel === 'chats') return 'Lista de chats';
  if (panel === 'custom-fields') return 'Campos personalizados';
  if (panel === 'appearance') return 'Apariencia';
  if (panel === 'notifications') return 'Notificaciones';
  return 'Ajustes';
}

function getSettingsIconToneStyle(tone: 'green' | 'black' | 'blue' | 'gold' | 'red') {
  if (tone === 'green') return styles.settingsListIcon_green;
  if (tone === 'black') return styles.settingsListIcon_black;
  if (tone === 'gold') return styles.settingsListIcon_gold;
  if (tone === 'red') return styles.settingsListIcon_red;
  return styles.settingsListIcon_blue;
}

function SettingsScreen({
  api,
  user,
  baseUrl,
  footer,
  onLogout,
  onChangeServer,
}: {
  api: RistakApiClient;
  user: RistakUser | null;
  baseUrl: string;
  footer?: React.ReactNode;
  onLogout: () => Promise<void>;
  onChangeServer: () => Promise<void>;
}) {
  const [activePanel, setActivePanel] = useState<SettingsPanel>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [appConfig, setAppConfig] = useState<Record<string, ConfigValue>>({});
  const [userConfig, setUserConfigState] = useState<Record<string, ConfigValue>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [templates, setTemplates] = useState<WhatsAppApiTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState('');
  const [customFields, setCustomFields] = useState<ContactCustomFieldDefinition[]>([]);
  const [customFieldsLoading, setCustomFieldsLoading] = useState(false);
  const [customFieldsError, setCustomFieldsError] = useState('');
  const [calendars, setCalendars] = useState<CalendarItem[]>([]);
  const [calendarsLoading, setCalendarsLoading] = useState(false);
  const [aiAgentConfig, setAiAgentConfig] = useState<AIAgentConfigStatus | null>(null);
  const [aiAgentLoading, setAiAgentLoading] = useState(false);
  const [businessContextDraft, setBusinessContextDraft] = useState('');
  const [savedBusinessContext, setSavedBusinessContext] = useState('');
  const [businessContextSaving, setBusinessContextSaving] = useState(false);
  const [businessContextMessage, setBusinessContextMessage] = useState('');
  const [businessVoiceState, setBusinessVoiceState] = useState<BusinessVoiceState>('idle');
  const businessVoiceRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const businessVoiceActiveRef = useRef(false);
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsAppApiStatus | null>(null);
  const [whatsappLoading, setWhatsappLoading] = useState(false);
  const [whatsappError, setWhatsappError] = useState('');
  const [settingDefaultPhoneId, setSettingDefaultPhoneId] = useState<string | null>(null);
  const [pushPermissionStatus, setPushPermissionStatus] = useState<NativePushPermissionStatus>('prompt');
  const [pushStatusMessage, setPushStatusMessage] = useState('');
  const [requestingPush, setRequestingPush] = useState(false);
  const [nativeThemeTone, setNativeThemeTone] = useState<'light' | 'dark'>(() => getNativePhoneThemeTone('system'));

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [appConfig, userConfig] = await Promise.all([
        api.getConfig(SETTINGS_APP_CONFIG_KEYS),
        api.getUserConfig(SETTINGS_USER_CONFIG_KEYS),
      ]);
      setAppConfig(unwrapConfigResponse(appConfig));
      setUserConfigState(unwrapConfigResponse(userConfig));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los ajustes.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadAIAgentStatus = useCallback(async () => {
    setAiAgentLoading(true);
    try {
      const status = await api.getAIAgentConfig();
      const context = String(status.businessContext || '').trim();
      setAiAgentConfig(status);
      setBusinessContextDraft(context);
      setSavedBusinessContext(context);
    } catch {
      setAiAgentConfig(null);
      setBusinessContextDraft('');
      setSavedBusinessContext('');
    } finally {
      setAiAgentLoading(false);
    }
  }, [api]);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError('');
    try {
      const response = await api.getWhatsAppTemplates(null);
      setTemplates(Array.isArray(response.items) ? response.items : []);
    } catch (err) {
      setTemplates([]);
      setTemplatesError(err instanceof Error ? err.message : 'No se pudieron cargar las plantillas.');
    } finally {
      setTemplatesLoading(false);
    }
  }, [api]);

  const loadWhatsAppStatus = useCallback(async (refresh = false) => {
    setWhatsappLoading(true);
    setWhatsappError('');
    try {
      const status = refresh ? await api.refreshWhatsAppStatus() : await api.getWhatsAppStatus();
      setWhatsappStatus(status);
    } catch (err) {
      setWhatsappStatus(null);
      setWhatsappError(err instanceof Error ? err.message : 'No se pudieron cargar los números de WhatsApp.');
    } finally {
      setWhatsappLoading(false);
    }
  }, [api]);

  const loadCustomFields = useCallback(async () => {
    setCustomFieldsLoading(true);
    setCustomFieldsError('');
    try {
      const definitions = await api.getCustomFieldDefinitions(false);
      setCustomFields(Array.isArray(definitions) ? definitions.filter((definition) => !definition.archived) : []);
    } catch (err) {
      setCustomFields([]);
      setCustomFieldsError(err instanceof Error ? err.message : 'No se pudieron cargar los campos personalizados.');
    } finally {
      setCustomFieldsLoading(false);
    }
  }, [api]);

  const loadPushPermissionStatus = useCallback(async () => {
    const status = await getNativePushPermissionStatus();
    setPushPermissionStatus(status);
  }, []);

  const loadCalendars = useCallback(async () => {
    setCalendarsLoading(true);
    try {
      const response = await api.getCalendars();
      const nextCalendars = Array.isArray(response) ? response : response.calendars || [];
      setCalendars(nextCalendars.filter((calendar) => calendar.isActive !== false));
    } catch {
      setCalendars([]);
    } finally {
      setCalendarsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadAIAgentStatus();
    void loadCalendars();
    void loadWhatsAppStatus();
    void loadPushPermissionStatus();
  }, [loadAIAgentStatus, loadCalendars, loadPushPermissionStatus, loadWhatsAppStatus]);

  useEffect(() => {
    if (activePanel === 'numbers') void loadWhatsAppStatus();
    if (activePanel === 'templates') void loadTemplates();
    if (activePanel === 'custom-fields') void loadCustomFields();
    if (activePanel === 'agent') void loadAIAgentStatus();
    if (activePanel === 'notifications') void loadPushPermissionStatus();
  }, [activePanel, loadAIAgentStatus, loadCustomFields, loadPushPermissionStatus, loadTemplates, loadWhatsAppStatus]);

  useEffect(() => () => {
    if (businessVoiceActiveRef.current || businessVoiceRecorder.isRecording) {
      void businessVoiceRecorder.stop().catch(() => undefined);
      businessVoiceActiveRef.current = false;
    }
  }, [businessVoiceRecorder]);

  const getAppBoolean = (key: string, fallback: boolean) => coerceConfigBoolean(appConfig[key], fallback);
  const getUserBoolean = (key: string, fallback: boolean) => coerceConfigBoolean(userConfig[key], fallback);
  const getUserStringArray = (key: string, fallback: string[] = []) => coerceConfigStringArray(userConfig[key], fallback);

  const saveAppPreference = async (key: string, value: ConfigValue) => {
    const previous = appConfig[key] ?? null;
    setSavingKey(key);
    setAppConfig((current) => ({ ...current, [key]: value }));
    try {
      await api.setConfig(key, value);
    } catch (err) {
      setAppConfig((current) => ({ ...current, [key]: previous }));
      Alert.alert('No se guardó el ajuste', err instanceof Error ? err.message : 'Intenta otra vez.');
    } finally {
      setSavingKey((current) => (current === key ? null : current));
    }
  };

  const saveUserPreference = async (key: string, value: ConfigValue) => {
    const previous = userConfig[key] ?? null;
    setSavingKey(key);
    setUserConfigState((current) => ({ ...current, [key]: value }));
    try {
      await api.setUserConfig(key, value);
    } catch (err) {
      setUserConfigState((current) => ({ ...current, [key]: previous }));
      Alert.alert('No se guardó el ajuste', err instanceof Error ? err.message : 'Intenta otra vez.');
    } finally {
      setSavingKey((current) => (current === key ? null : current));
    }
  };

  const aiReady = Boolean(aiAgentConfig?.configured && !aiAgentConfig?.needsReconnect);
  const aiAgentChatEnabled = getAppBoolean('mobile_chat_ai_agent_enabled', true);
  const aiReplySuggestionsEnabled = getAppBoolean('mobile_chat_ai_reply_suggestions_enabled', false);
  const showArchivedChats = getAppBoolean('mobile_chat_show_archived', true);
  const showLastMessagePreview = getAppBoolean('mobile_chat_show_last_preview', true);
  const showUnreadIndicators = getAppBoolean('mobile_chat_show_unread_indicators', true);
  const conversationSortMode = coerceConfigString(appConfig.mobile_chat_sort_mode, 'recent');
  const themePreference = coercePhoneThemePreference(appConfig.mobile_chat_theme_preference);
  const selectedWhatsAppPhoneId = coerceConfigString(appConfig.mobile_chat_selected_whatsapp_phone_id, 'all');
  const chatPushEnabled = getUserBoolean('chat_push_notifications_enabled', true);
  const calendarPushEnabled = getUserBoolean('calendar_push_notifications_enabled', false);
  const appointmentConfirmationPushEnabled = getUserBoolean('appointment_confirmation_push_notifications_enabled', true);
  const paymentPushEnabled = getUserBoolean('payment_push_notifications_enabled', true);
  const notificationSoundEnabled = getUserBoolean('push_notification_sound_enabled', true);
  const notificationVibrationEnabled = getUserBoolean('push_notification_vibration_enabled', true);
  const pushCalendarIds = getUserStringArray('calendar_push_notification_calendar_ids');
  const whatsAppPhones = Array.isArray(whatsappStatus?.phoneNumbers) ? whatsappStatus.phoneNumbers : [];
  const selectedWhatsAppPhone = selectedWhatsAppPhoneId && selectedWhatsAppPhoneId !== 'all'
    ? whatsAppPhones.find((phone) => phone.id === selectedWhatsAppPhoneId) || null
    : null;
  const defaultWhatsAppPhone = whatsAppPhones.find((phone) => phone.is_default_sender) || whatsappStatus?.selectedPhone || whatsAppPhones[0] || null;
  const whatsappNumbersMode = selectedWhatsAppPhone ? 'separate' : 'together';
  const pushPermissionLabel = getPushPermissionLabel(pushPermissionStatus);
  const selectedCalendarCount = pushCalendarIds.length || calendars.length;
  const customFieldGroups = useMemo(() => {
    const groups = new Map<string, ContactCustomFieldDefinition[]>();
    customFields.forEach((definition) => {
      const title = definition.folderName || 'Campos personalizados';
      const group = groups.get(title) || [];
      group.push(definition);
      groups.set(title, group);
    });
    return [...groups.entries()].map(([title, items]) => ({ title, items }));
  }, [customFields]);
  const blockedTemplates = templates.filter((template) => TEMPLATE_BLOCKED_STATUSES.has(getTemplateStatus(template))).length;
  const notificationCount = [
    chatPushEnabled,
    calendarPushEnabled,
    appointmentConfirmationPushEnabled,
    paymentPushEnabled,
  ].filter(Boolean).length;

  useEffect(() => {
    const applyTheme = () => {
      const tone = getNativePhoneThemeTone(themePreference, Appearance.getColorScheme());
      setNativeThemeTone(tone);
      const background = getNativePhoneThemeBackground(tone);
      void SystemUI.setBackgroundColorAsync(background).catch(() => undefined);
      StatusBar.setBarStyle(tone === 'light' ? 'dark-content' : 'light-content', true);
      if (Platform.OS === 'android') {
        StatusBar.setBackgroundColor(background, true);
      }
    };

    applyTheme();

    const appearanceSubscription = themePreference === 'system'
      ? Appearance.addChangeListener(applyTheme)
      : null;
    const interval = themePreference === 'auto'
      ? setInterval(applyTheme, 60 * 1000)
      : null;

    return () => {
      appearanceSubscription?.remove();
      if (interval) clearInterval(interval);
    };
  }, [themePreference]);

  const handleLogout = () => {
    Alert.alert(
      'Cerrar sesión',
      `¿Seguro que quieres cerrar tu sesión en este dispositivo?\n\n${getUserDisplayName(user)} · ${baseUrl}`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Cambiar app', onPress: () => void onChangeServer() },
        { text: 'Cerrar sesión', style: 'destructive', onPress: () => void onLogout() },
      ],
    );
  };

  const saveRefinedBusinessContext = async (answer: string, successMessage = 'Guardado.') => {
    const draft = answer.trim();
    if (!draft || businessContextSaving || !aiReady) {
      Alert.alert(
        'Asistente Personal AI',
        aiReady ? 'Escribe la descripción del negocio primero.' : 'Conecta OpenAI para pulir y guardar la descripción.',
      );
      return false;
    }
    setBusinessContextSaving(true);
    setBusinessContextMessage('Puliendo y guardando...');
    try {
      const result = await api.saveAIAgentBusinessContext(draft);
      const next = String(result.text || result.status?.businessContext || draft).trim();
      setBusinessContextDraft(next);
      setSavedBusinessContext(next);
      setBusinessContextMessage('Guardado.');
      if (result.status) setAiAgentConfig(result.status);
      if (successMessage !== 'Guardado.') {
        Alert.alert('Descripción guardada', successMessage);
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo guardar la descripción.';
      setBusinessContextMessage(message);
      Alert.alert('No se guardó la descripción', message);
      return false;
    } finally {
      setBusinessContextSaving(false);
    }
  };

  const handleSaveBusinessContext = () => {
    void saveRefinedBusinessContext(businessContextDraft, 'La descripción quedó pulida y guardada.');
  };

  const startBusinessVoiceDictation = async () => {
    if (businessVoiceState !== 'idle' || businessContextSaving || aiAgentLoading) return;

    if (!aiReady) {
      const message = aiAgentConfig?.needsReconnect
        ? 'Reconecta OpenAI para dictar la descripción.'
        : 'Conecta OpenAI para dictar y pulir la descripción.';
      setBusinessContextMessage(message);
      Alert.alert('OpenAI no está listo', message);
      return;
    }

    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        const message = 'Este celular no permitió usar el micrófono.';
        setBusinessContextMessage(message);
        Alert.alert('Micrófono bloqueado', message);
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await businessVoiceRecorder.prepareToRecordAsync();
      businessVoiceRecorder.record();
      businessVoiceActiveRef.current = true;
      setBusinessVoiceState('recording');
      setBusinessContextMessage('Grabando... toca detener cuando termines.');
    } catch (err) {
      businessVoiceActiveRef.current = false;
      void setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      }).catch(() => undefined);
      setBusinessVoiceState('idle');
      const message = err instanceof Error ? err.message : 'No pude activar el micrófono.';
      setBusinessContextMessage(message);
      Alert.alert('Micrófono bloqueado', message);
    }
  };

  const stopBusinessVoiceDictation = async () => {
    if (businessVoiceState !== 'recording') return;

    setBusinessVoiceState('processing');
    setBusinessContextMessage('Transcribiendo audio...');

    try {
      if (!businessVoiceActiveRef.current && !businessVoiceRecorder.isRecording) throw new Error('No encontré la grabación activa.');
      await businessVoiceRecorder.stop();
      businessVoiceActiveRef.current = false;
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      }).catch(() => undefined);

      const audioUri = businessVoiceRecorder.uri;
      if (!audioUri) throw new Error('No se grabó audio. Intenta otra vez.');

      const transcription = await api.transcribeAIAgentAudio(audioUri, 'audio/m4a');
      const transcript = String(transcription.text || '').trim();
      if (!transcript) throw new Error('No se detectó texto en el audio.');

      await saveRefinedBusinessContext(transcript, 'Tu dictado quedó pulido y guardado.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No pude transcribir el audio.';
      setBusinessContextMessage(message);
      Alert.alert('No se pudo usar el dictado', message);
    } finally {
      businessVoiceActiveRef.current = false;
      void setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      }).catch(() => undefined);
      setBusinessVoiceState('idle');
    }
  };

  const handleBusinessVoiceButton = () => {
    if (businessVoiceState === 'recording') {
      void stopBusinessVoiceDictation();
      return;
    }
    void startBusinessVoiceDictation();
  };

  const togglePushCalendar = (calendarId: string) => {
    const next = pushCalendarIds.includes(calendarId)
      ? pushCalendarIds.filter((id) => id !== calendarId)
      : [...pushCalendarIds, calendarId];
    void saveUserPreference('calendar_push_notification_calendar_ids', next);
  };

  const selectWhatsAppNumbersMode = (mode: 'together' | 'separate') => {
    if (mode === 'together') {
      void saveAppPreference('mobile_chat_selected_whatsapp_phone_id', 'all');
      return;
    }

    const fallbackPhone = selectedWhatsAppPhone || defaultWhatsAppPhone;
    if (!fallbackPhone?.id) {
      Alert.alert('Números de WhatsApp', 'No hay un número disponible para separar la bandeja.');
      return;
    }

    void saveAppPreference('mobile_chat_selected_whatsapp_phone_id', fallbackPhone.id);
  };

  const selectChatWhatsAppPhone = (phone: WhatsAppApiPhoneNumber) => {
    if (!phone.id) return;
    void saveAppPreference('mobile_chat_selected_whatsapp_phone_id', phone.id);
  };

  const handleSetDefaultWhatsAppPhone = async (phone: WhatsAppApiPhoneNumber) => {
    if (!phone.id || settingDefaultPhoneId) return;
    setSettingDefaultPhoneId(phone.id);
    try {
      const status = await api.setDefaultWhatsAppPhoneNumber(phone.id);
      setWhatsappStatus(status);
    } catch (err) {
      Alert.alert('No se cambió el número principal', err instanceof Error ? err.message : 'Intenta otra vez.');
    } finally {
      setSettingDefaultPhoneId(null);
    }
  };

  const handleEnableNativePush = async () => {
    if (requestingPush) return;
    setRequestingPush(true);
    setPushStatusMessage('Activando alertas en este celular...');
    try {
      const result = await subscribeToNativePushNotifications(
        api,
        { calendarIds: calendarPushEnabled ? pushCalendarIds : [] },
      );
      await loadPushPermissionStatus();
      if (result.status === 'subscribed') {
        setPushStatusMessage('Alertas activas en este celular.');
        return;
      }
      const message = result.reason || 'No se activaron las alertas en este celular.';
      setPushStatusMessage(message);
      Alert.alert(result.status === 'not_configured' ? 'Falta preparar alertas' : 'No se activaron', message);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Intenta otra vez.';
      setPushStatusMessage(message);
      Alert.alert('No se activaron las alertas', message);
    } finally {
      setRequestingPush(false);
    }
  };

  const renderMainList = () => {
    const items: Array<{
      id: Exclude<SettingsPanel, null>;
      title: string;
      description: string;
      meta: string;
      Icon: LucideIcon;
      tone: 'green' | 'black' | 'blue' | 'gold' | 'red';
    }> = [
      { id: 'numbers', title: 'Números de WhatsApp', description: 'Principal y bandejas por remitente.', meta: whatsAppPhones.length ? `${whatsAppPhones.length}` : 'Revisar', Icon: Smartphone, tone: 'green' },
      { id: 'templates', title: 'Plantillas', description: 'Crear y revisar estados de Meta.', meta: templates.length ? `${templates.length} guardadas` : 'Revisar', Icon: FileText, tone: 'black' },
      { id: 'agent', title: AI_AGENT_CHAT_DISPLAY_NAME, description: 'Chat fijo y sugerencias.', meta: aiReady ? (aiAgentChatEnabled ? 'Activo' : 'Apagado') : 'Sin OpenAI', Icon: Bot, tone: 'blue' },
      { id: 'chats', title: 'Lista de chat', description: 'Orden, archivados y vista previa.', meta: conversationSortMode === 'recent' ? 'Recientes' : 'No leídas', Icon: MessageCircle, tone: 'green' },
      { id: 'custom-fields', title: 'Campos personalizados', description: 'Datos visibles en cada contacto.', meta: customFields.length ? `${customFields.length}` : 'Todos', Icon: ListChecks, tone: 'gold' },
      { id: 'appearance', title: 'Apariencia', description: 'Claro, noche, sistema u horario.', meta: getThemeMeta(themePreference, nativeThemeTone), Icon: Sun, tone: 'blue' },
      { id: 'notifications', title: 'Notificaciones', description: 'Mensajes, citas, sonido y vibración.', meta: pushPermissionLabel, Icon: Bell, tone: 'red' },
    ];

    return (
      <>
        <View style={styles.settingsListGroup}>
          {items.map(({ id, title, description, meta, Icon, tone }) => (
            <Pressable
              key={id}
              accessibilityRole="button"
              onPress={() => setActivePanel(id)}
              style={({ pressed }) => [styles.settingsListItem, pressed && styles.pressed]}
            >
              <View style={[styles.settingsListIcon, getSettingsIconToneStyle(tone)]}>
                <Icon size={19} color={tone === 'black' ? COLORS.white : COLORS.bg} strokeWidth={2.35} />
              </View>
              <View style={styles.settingsListText}>
                <Text numberOfLines={2} style={styles.settingsListTitle}>{title}</Text>
                <Text numberOfLines={1} style={styles.settingsListSubtitle}>{description}</Text>
              </View>
              <View style={styles.settingsListMeta}>
                <Text numberOfLines={1} style={styles.settingsListMetaText}>{meta}</Text>
                <ChevronRight size={18} color={COLORS.muted} strokeWidth={2.6} />
              </View>
            </Pressable>
          ))}
        </View>
        <Pressable accessibilityRole="button" onPress={handleLogout} style={({ pressed }) => [styles.settingsLogoutButton, pressed && styles.pressed]}>
          <LogOut size={18} color={COLORS.danger} strokeWidth={2.4} />
          <Text style={styles.settingsLogoutText}>Cerrar sesión</Text>
        </Pressable>
      </>
    );
  };

  const renderNumbers = () => (
    <>
      <SettingsActionCard
        Icon={Smartphone}
        title="Números de WhatsApp"
        subtitle={whatsappStatus?.connected ? 'Administra remitentes conectados.' : 'Conecta WhatsApp para enviar desde la app móvil.'}
        actionLabel="Actualizar"
        actionIcon={RefreshCw}
        busy={whatsappLoading}
        onPress={() => void loadWhatsAppStatus(true)}
      />
      {whatsappError ? <SettingsAlert message={whatsappError} /> : null}
      {whatsappLoading ? <SettingsInlineLoading label="Cargando números..." /> : null}
      {!whatsappLoading && !whatsappError ? (
        <View style={styles.settingsCard}>
          <Text style={styles.settingsFieldTitle}>Bandeja de chats</Text>
          <Text style={styles.settingsHint}>
            Usa todos juntos para ver la bandeja completa o separa por un remitente cuando necesites trabajar sólo un número.
          </Text>
          <View style={styles.settingsSegmented}>
            <Pressable
              accessibilityRole="button"
              onPress={() => selectWhatsAppNumbersMode('together')}
              style={[styles.settingsSegmentButton, whatsappNumbersMode === 'together' && styles.settingsSegmentButtonActive]}
            >
              <Text style={[styles.settingsSegmentText, whatsappNumbersMode === 'together' && styles.settingsSegmentTextActive]}>Juntos</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => selectWhatsAppNumbersMode('separate')}
              style={[styles.settingsSegmentButton, whatsappNumbersMode === 'separate' && styles.settingsSegmentButtonActive]}
            >
              <Text style={[styles.settingsSegmentText, whatsappNumbersMode === 'separate' && styles.settingsSegmentTextActive]}>Separado</Text>
            </Pressable>
          </View>
          {selectedWhatsAppPhone ? <Text style={styles.settingsHint}>Separado por {getBusinessPhoneDisplay(selectedWhatsAppPhone)}.</Text> : null}
        </View>
      ) : null}
      {!whatsappLoading && !whatsappError && whatsAppPhones.length ? (
        <View style={styles.settingsItemList}>
          {whatsAppPhones.map((phone) => {
            const selected = selectedWhatsAppPhoneId === phone.id;
            const settingDefault = settingDefaultPhoneId === phone.id;
            return (
              <View key={phone.id} style={[styles.phoneNumberRow, selected && styles.phoneNumberRowActive]}>
                <View style={styles.phoneNumberAvatar}>
                  <Text style={styles.phoneNumberAvatarText}>{getBusinessPhoneLabel(phone).slice(0, 2).toUpperCase()}</Text>
                </View>
                <View style={styles.phoneNumberCopy}>
                  <Text numberOfLines={1} style={styles.phoneNumberTitle}>{getBusinessPhoneLabel(phone)}</Text>
                  <Text numberOfLines={1} style={styles.phoneNumberSubtitle}>{getBusinessPhoneValue(phone) || 'Sin número visible'} · {getBusinessPhoneStatusLabel(phone)}</Text>
                </View>
                <View style={styles.phoneNumberActions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => selectChatWhatsAppPhone(phone)}
                    style={[styles.phoneNumberPill, selected && styles.phoneNumberPillActive]}
                  >
                    <Text style={[styles.phoneNumberPillText, selected && styles.phoneNumberPillTextActive]}>{selected ? 'En chats' : 'Usar'}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={phone.is_default_sender || settingDefault}
                    onPress={() => void handleSetDefaultWhatsAppPhone(phone)}
                    style={[styles.phoneNumberPill, phone.is_default_sender && styles.phoneNumberPillActive, (phone.is_default_sender || settingDefault) && styles.disabledButton]}
                  >
                    {settingDefault ? <ActivityIndicator color={COLORS.white} /> : <Text style={[styles.phoneNumberPillText, phone.is_default_sender && styles.phoneNumberPillTextActive]}>{phone.is_default_sender ? 'Principal' : 'Hacer principal'}</Text>}
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
      {!whatsappLoading && !whatsappError && !whatsAppPhones.length ? <SettingsEmptyState label="Todavía no hay números de WhatsApp conectados." /> : null}
    </>
  );

  const renderTemplates = () => (
    <>
      <SettingsActionCard
        Icon={FileText}
        title="Plantillas de WhatsApp"
        subtitle={blockedTemplates ? `${blockedTemplates} necesitan revisión.` : 'Revisa estados y aprobaciones de Meta.'}
        actionLabel="Actualizar"
        actionIcon={RefreshCw}
        busy={templatesLoading}
        onPress={loadTemplates}
      />
      {templatesError ? <SettingsAlert message={templatesError} /> : null}
      {templatesLoading ? <SettingsInlineLoading label="Cargando plantillas..." /> : null}
      {!templatesLoading && templates.length ? (
        <View style={styles.settingsItemList}>
          {templates.map((template, index) => {
            const status = getTemplateStatus(template);
            const blocked = TEMPLATE_BLOCKED_STATUSES.has(status);
            return (
              <View key={`${template.id || template.name}-${template.language || index}`} style={styles.templateRow}>
                <View style={styles.templateIcon}><FileText size={18} color={COLORS.white} strokeWidth={2.2} /></View>
                <View style={styles.templateCopy}>
                  <Text numberOfLines={1} style={styles.templateTitle}>{template.name}</Text>
                  <Text numberOfLines={2} style={styles.templatePreview}>{getTemplatePreview(template)}</Text>
                  {blocked ? <Text numberOfLines={2} style={styles.templateBlockedReason}>{template.reason || template.status_update_event || 'Meta no permite usar esta plantilla por ahora.'}</Text> : null}
                </View>
                <View style={[styles.templateStatus, blocked ? styles.templateStatusBlocked : status === 'APPROVED' ? styles.templateStatusApproved : styles.templateStatusPending]}>
                  <Text style={[styles.templateStatusText, blocked ? styles.templateStatusTextBlocked : status === 'APPROVED' ? styles.templateStatusTextApproved : styles.templateStatusTextPending]}>
                    {getTemplateStatusLabel(status)}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
      {!templatesLoading && !templates.length && !templatesError ? <SettingsEmptyState label="Todavía no hay plantillas guardadas." /> : null}
    </>
  );

  const renderAgent = () => {
    const descriptionChanged = businessContextDraft.trim() !== savedBusinessContext.trim();
    const recording = businessVoiceState === 'recording';
    const busyDescription = aiAgentLoading || businessContextSaving || businessVoiceState === 'processing';
    const micLabel = recording ? 'Detener' : businessVoiceState === 'processing' ? 'Procesando' : 'Dictar';
    return (
      <>
        <View style={styles.businessDescriptionPanel}>
          {!aiReady ? (
            <SettingsEmptyState label={aiAgentConfig?.needsReconnect ? 'Reconecta OpenAI para activar el agente en este celular.' : 'Conecta OpenAI para activar el agente en este celular.'} />
          ) : null}
          <View style={styles.businessDescriptionHeader}>
            <View style={styles.businessDescriptionIcon}><Sparkles size={19} color={COLORS.white} strokeWidth={2.25} /></View>
            <View style={styles.businessDescriptionCopy}>
              <Text style={styles.businessDescriptionTitle}>Descripción del negocio</Text>
              <Text style={styles.businessDescriptionSubtitle}>Dicta tu giro, servicios y clientes; la IA lo pule y lo guarda aquí.</Text>
            </View>
          </View>
          <View style={styles.businessDescriptionField}>
            <TextInput
              value={businessContextDraft}
              onChangeText={(text) => {
                setBusinessContextDraft(text);
                setBusinessContextMessage('');
              }}
              editable={!busyDescription && !recording}
              multiline
              placeholder="Ejemplo: Somos una clínica dental en Ciudad Juárez, atendemos familias..."
              placeholderTextColor={COLORS.muted}
              textAlignVertical="top"
              style={styles.businessDescriptionInput}
            />
            <Pressable
              accessibilityRole="button"
              disabled={!aiReady || businessContextSaving || aiAgentLoading || businessVoiceState === 'processing'}
              onPress={handleBusinessVoiceButton}
              style={({ pressed }) => [
                styles.businessVoiceButton,
                recording && styles.businessVoiceButtonRecording,
                (!aiReady || businessContextSaving || aiAgentLoading || businessVoiceState === 'processing') && styles.disabledButton,
                pressed && styles.pressed,
              ]}
            >
              {businessVoiceState === 'processing' ? <ActivityIndicator color={COLORS.bg} /> : recording ? <Square size={15} color={COLORS.white} fill={COLORS.white} strokeWidth={2.4} /> : <Mic size={17} color={COLORS.bg} strokeWidth={2.4} />}
              <Text style={[styles.businessVoiceButtonText, recording && styles.businessVoiceButtonTextRecording]}>{micLabel}</Text>
            </Pressable>
          </View>
          <View style={styles.businessDescriptionActions}>
            <Text numberOfLines={2} style={styles.businessDescriptionMessage}>
              {aiAgentLoading ? '' : businessContextMessage || (aiReady ? 'El dictado se guarda automático al terminar.' : 'OpenAI debe estar conectado para dictar y pulir.')}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={!aiReady || busyDescription || recording || !descriptionChanged || !businessContextDraft.trim()}
              onPress={handleSaveBusinessContext}
              style={({ pressed }) => [styles.settingsSmallPrimaryButton, (!aiReady || busyDescription || recording || !descriptionChanged || !businessContextDraft.trim()) && styles.disabledButton, pressed && styles.pressed]}
            >
              {businessContextSaving ? <ActivityIndicator color={COLORS.bg} /> : <Save size={16} color={COLORS.bg} strokeWidth={2.4} />}
              <Text style={styles.settingsSmallPrimaryText}>Guardar</Text>
            </Pressable>
          </View>
        </View>
        <SettingsToggleRow
          title="Mostrar como primer chat"
          description="El agente aparece fijo arriba de tus conversaciones."
          checked={aiReady && aiAgentChatEnabled}
          disabled={!aiReady || savingKey === 'mobile_chat_ai_agent_enabled'}
          onChange={(checked) => void saveAppPreference('mobile_chat_ai_agent_enabled', checked)}
        />
        <SettingsToggleRow
          title="Sugerir respuestas"
          description="El agente puede preparar un texto para responder en chats reales."
          checked={aiReady && aiReplySuggestionsEnabled}
          disabled={!aiReady || !aiAgentChatEnabled || savingKey === 'mobile_chat_ai_reply_suggestions_enabled'}
          onChange={(checked) => void saveAppPreference('mobile_chat_ai_reply_suggestions_enabled', checked)}
        />
      </>
    );
  };

  const renderChats = () => (
    <>
      <View style={styles.settingsCard}>
        <Text style={styles.settingsFieldTitle}>Ordenar conversaciones</Text>
        <View style={styles.settingsSegmented}>
          <Pressable
            accessibilityRole="button"
            onPress={() => void saveAppPreference('mobile_chat_sort_mode', 'recent')}
            style={[styles.settingsSegmentButton, conversationSortMode === 'recent' && styles.settingsSegmentButtonActive]}
          >
            <Text style={[styles.settingsSegmentText, conversationSortMode === 'recent' && styles.settingsSegmentTextActive]}>Más recientes</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => void saveAppPreference('mobile_chat_sort_mode', 'unread')}
            style={[styles.settingsSegmentButton, conversationSortMode === 'unread' && styles.settingsSegmentButtonActive]}
          >
            <Text style={[styles.settingsSegmentText, conversationSortMode === 'unread' && styles.settingsSegmentTextActive]}>No leídas</Text>
          </Pressable>
        </View>
      </View>
      <SettingsToggleRow title="Mostrar archivados" description="Deja visible el acceso a chats archivados." checked={showArchivedChats} disabled={savingKey === 'mobile_chat_show_archived'} onChange={(checked) => void saveAppPreference('mobile_chat_show_archived', checked)} />
      <SettingsToggleRow title="Vista previa" description="Muestra un resumen debajo del nombre del contacto." checked={showLastMessagePreview} disabled={savingKey === 'mobile_chat_show_last_preview'} onChange={(checked) => void saveAppPreference('mobile_chat_show_last_preview', checked)} />
      <SettingsToggleRow title="Indicadores de no leídos" description="Muestra el contador cuando hay mensajes nuevos." checked={showUnreadIndicators} disabled={savingKey === 'mobile_chat_show_unread_indicators'} onChange={(checked) => void saveAppPreference('mobile_chat_show_unread_indicators', checked)} />
    </>
  );

  const renderCustomFields = () => (
    <>
      {customFieldsError ? <SettingsAlert message={customFieldsError} /> : null}
      {customFieldsLoading ? <SettingsInlineLoading label="Cargando campos..." /> : null}
      {!customFieldsLoading && customFields.length ? (
        <View style={styles.settingsCard}>
          <Text style={styles.settingsFieldTitle}>Todos aparecen en la info del contacto</Text>
          <Text style={styles.settingsHint}>El chat móvil muestra el catálogo completo, agrupado por carpeta, y cada campo se edita desde la ficha del contacto.</Text>
          <View style={styles.customFieldsList}>
            {customFieldGroups.map((group) => (
              <View key={group.title} style={styles.customFieldGroup}>
                <Text style={styles.customFieldGroupTitle}>{group.title}</Text>
                {group.items.map((definition, index) => (
                  <View key={definition.definitionId || definition.fieldKey || definition.key || `${group.title}-${index}`} style={styles.customFieldRow}>
                    <View style={styles.customFieldCopy}>
                      <Text numberOfLines={1} style={styles.customFieldTitle}>{definition.label || definition.name || `Campo ${index + 1}`}</Text>
                      <Text numberOfLines={1} style={styles.customFieldSubtitle}>{definition.dataType || 'text'}</Text>
                    </View>
                    <Check size={17} color={COLORS.accent} strokeWidth={2.8} />
                  </View>
                ))}
              </View>
            ))}
          </View>
        </View>
      ) : null}
      {!customFieldsLoading && !customFields.length && !customFieldsError ? <SettingsEmptyState label="Todavía no hay campos personalizados guardados." /> : null}
    </>
  );

  const renderAppearance = () => (
    <View style={styles.settingsCard}>
      <View style={styles.settingsCardHeader}>
        <View style={styles.settingsCardHeaderIcon}><Sun size={18} color={COLORS.white} strokeWidth={2.3} /></View>
        <View style={styles.settingsCardHeaderCopy}>
          <Text style={styles.settingsCardTitle}>Color del chat</Text>
          <Text style={styles.settingsCardSubtitle}>Elige cómo quieres ver esta app en este celular.</Text>
        </View>
      </View>
      <View style={styles.settingsChoiceList}>
        {PHONE_CHAT_THEME_OPTIONS.map(({ id, label, description, Icon }) => {
          const selected = themePreference === id;
          return (
            <Pressable
              key={id}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => void saveAppPreference('mobile_chat_theme_preference', id)}
              style={({ pressed }) => [styles.settingsChoiceButton, selected && styles.settingsChoiceActive, pressed && styles.pressed]}
            >
              <View style={styles.settingsChoiceIcon}><Icon size={18} color={COLORS.white} strokeWidth={2.35} /></View>
              <View style={styles.settingsChoiceCopy}>
                <Text style={styles.settingsChoiceTitle}>{label}</Text>
                <Text style={styles.settingsChoiceSubtitle}>{description}</Text>
              </View>
              <View style={styles.settingsChoiceCheck}>{selected ? <Check size={17} color={COLORS.accent} strokeWidth={3} /> : null}</View>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.settingsHint}>Ahorita la app se ve en modo {getThemeMeta(themePreference, nativeThemeTone).toLowerCase()} y el fondo nativo del celular ya sigue esa preferencia.</Text>
    </View>
  );

  const renderNotifications = () => (
    <>
      <View style={[styles.settingsEnabledCard, pushPermissionStatus !== 'granted' && styles.settingsPushCardNeedsAction]}>
        {pushPermissionStatus === 'granted' ? <Check size={18} color="#0f6b3e" strokeWidth={2.6} /> : <BellRing size={18} color={COLORS.text} strokeWidth={2.6} />}
        <View style={styles.settingsPushCopy}>
          <Text style={styles.settingsEnabledText}>
            {pushPermissionStatus === 'granted'
              ? `Alertas activas en este celular · ${notificationCount} tipos prendidos.`
              : `Permiso nativo: ${pushPermissionLabel}.`}
          </Text>
          {pushStatusMessage ? <Text style={styles.settingsPushMessage}>{pushStatusMessage}</Text> : null}
        </View>
        <Pressable
          accessibilityRole="button"
          disabled={requestingPush}
          onPress={handleEnableNativePush}
          style={({ pressed }) => [styles.settingsPushActionButton, requestingPush && styles.disabledButton, pressed && styles.pressed]}
        >
          {requestingPush ? <ActivityIndicator color={COLORS.bg} /> : <Bell size={15} color={COLORS.bg} strokeWidth={2.5} />}
          <Text style={styles.settingsPushActionText}>{pushPermissionStatus === 'granted' ? 'Actualizar' : 'Activar'}</Text>
        </Pressable>
      </View>
      <SettingsToggleRow title="Mensajes del chat" description="Avísame cuando llegue un WhatsApp nuevo." checked={chatPushEnabled} disabled={savingKey === 'chat_push_notifications_enabled'} onChange={(checked) => void saveUserPreference('chat_push_notifications_enabled', checked)} />
      <SettingsToggleRow title="Citas agendadas" description="Avísame cuando alguien reserve una cita nueva." checked={calendarPushEnabled} disabled={savingKey === 'calendar_push_notifications_enabled'} onChange={(checked) => void saveUserPreference('calendar_push_notifications_enabled', checked)} />
      {calendarPushEnabled ? (
        <View style={styles.settingsCard}>
          <View style={styles.calendarPickerHeader}>
            <Text style={styles.settingsFieldTitle}>Calendarios con alertas</Text>
            <Text style={styles.calendarPickerCount}>{pushCalendarIds.length ? `${selectedCalendarCount} seleccionados` : 'Todos'}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => void saveUserPreference('calendar_push_notification_calendar_ids', [])}
            style={[styles.calendarChip, pushCalendarIds.length === 0 && styles.calendarChipActive]}
          >
            <Text style={[styles.calendarChipText, pushCalendarIds.length === 0 && styles.calendarChipTextActive]}>Todos los calendarios</Text>
          </Pressable>
          {calendarsLoading ? <SettingsInlineLoading label="Cargando calendarios..." /> : null}
          {!calendarsLoading && calendars.length ? (
            <View style={styles.calendarChipGrid}>
              {calendars.map((calendar, index) => {
                const id = calendar.id || calendar._id || `calendar-${index}`;
                const active = pushCalendarIds.includes(id);
                return (
                  <Pressable key={id} accessibilityRole="button" onPress={() => togglePushCalendar(id)} style={[styles.calendarChip, active && styles.calendarChipActive]}>
                    <View style={[styles.calendarColorDot, { backgroundColor: calendar.eventColor || calendar.color || COLORS.accent }]} />
                    <Text numberOfLines={1} style={[styles.calendarChipText, active && styles.calendarChipTextActive]}>{calendar.name || calendar.title || 'Calendario'}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {!calendarsLoading && !calendars.length ? <Text style={styles.settingsHint}>No hay calendarios activos para elegir.</Text> : null}
        </View>
      ) : null}
      <SettingsToggleRow title="Citas confirmadas" description="Avísame cuando un cliente confirme que sí asistirá." checked={appointmentConfirmationPushEnabled} disabled={savingKey === 'appointment_confirmation_push_notifications_enabled'} onChange={(checked) => void saveUserPreference('appointment_confirmation_push_notifications_enabled', checked)} />
      <SettingsToggleRow title="Pagos" description="Avísame cuando se registre un pago." checked={paymentPushEnabled} disabled={savingKey === 'payment_push_notifications_enabled'} onChange={(checked) => void saveUserPreference('payment_push_notifications_enabled', checked)} />
      <View style={styles.settingsCard}>
        <View style={styles.settingsCardHeader}>
          <View style={styles.settingsCardHeaderIcon}><BellRing size={18} color={COLORS.white} strokeWidth={2.3} /></View>
          <View style={styles.settingsCardHeaderCopy}>
            <Text style={styles.settingsCardTitle}>Sonido y vibración</Text>
            <Text style={styles.settingsCardSubtitle}>Controla cómo se sienten las alertas en este celular.</Text>
          </View>
        </View>
        <SettingsToggleRow embedded title="Timbre de notificación" description="Hace sonar el celular cuando llegue una alerta." checked={notificationSoundEnabled} disabled={savingKey === 'push_notification_sound_enabled'} onChange={(checked) => void saveUserPreference('push_notification_sound_enabled', checked)} />
        <SettingsToggleRow embedded title="Vibración de notificación" description="Vibra cuando entren mensajes, citas, confirmaciones o pagos." checked={notificationVibrationEnabled} disabled={savingKey === 'push_notification_vibration_enabled'} onChange={(checked) => void saveUserPreference('push_notification_vibration_enabled', checked)} />
      </View>
    </>
  );

  const renderPanel = () => {
    if (activePanel === 'numbers') return renderNumbers();
    if (activePanel === 'templates') return renderTemplates();
    if (activePanel === 'agent') return renderAgent();
    if (activePanel === 'chats') return renderChats();
    if (activePanel === 'custom-fields') return renderCustomFields();
    if (activePanel === 'appearance') return renderAppearance();
    if (activePanel === 'notifications') return renderNotifications();
    return renderMainList();
  };

  return (
    <AppFrame>
      <ScrollView contentContainerStyle={styles.settingsFrame}>
        {activePanel ? (
          <Pressable accessibilityRole="button" onPress={() => setActivePanel(null)} style={({ pressed }) => [styles.settingsBackButton, pressed && styles.pressed]}>
            <ChevronLeft size={22} color={COLORS.text} strokeWidth={2.8} />
            <Text style={styles.settingsBackLabel}>Ajustes</Text>
          </Pressable>
        ) : null}
        <View style={styles.settingsHeader}>
          <Text style={styles.settingsKicker}>Ristak</Text>
          <Text numberOfLines={2} style={styles.settingsTitle}>{getSettingsPanelTitle(activePanel)}</Text>
          {activePanel === 'custom-fields' ? <Text style={styles.settingsHeaderSubtitle}>Elige qué datos quieres ver en la info de cada contacto.</Text> : null}
        </View>
        <SectionState loading={loading} error={error} onRetry={load} />
        {!loading && !error ? <View style={styles.settingsContent}>{renderPanel()}</View> : null}
      </ScrollView>
      {footer}
    </AppFrame>
  );
}

function SettingsActionCard({
  Icon,
  title,
  subtitle,
  actionLabel,
  actionIcon: ActionIcon,
  busy,
  onPress,
}: {
  Icon: LucideIcon;
  title: string;
  subtitle: string;
  actionLabel: string;
  actionIcon: LucideIcon;
  busy?: boolean;
  onPress: () => void;
}) {
  return (
    <View style={styles.settingsActionCard}>
      <View style={styles.settingsActionIcon}>
        <Icon size={18} color={COLORS.white} strokeWidth={2.3} />
      </View>
      <View style={styles.settingsActionCopy}>
        <Text numberOfLines={1} style={styles.settingsActionTitle}>{title}</Text>
        <Text numberOfLines={2} style={styles.settingsActionSubtitle}>{subtitle}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={onPress}
        style={({ pressed }) => [styles.settingsActionButton, busy && styles.disabledButton, pressed && styles.pressed]}
      >
        {busy ? <ActivityIndicator color={COLORS.white} /> : <ActionIcon size={15} color={COLORS.white} strokeWidth={2.5} />}
        <Text style={styles.settingsActionButtonText}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

function SettingsToggleRow({
  title,
  description,
  checked,
  disabled,
  embedded,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  embedded?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={({ pressed }) => [
        styles.settingsToggleRow,
        embedded && styles.settingsToggleRowEmbedded,
        disabled && styles.settingsToggleRowDisabled,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.settingsToggleCopy}>
        <Text style={styles.settingsToggleTitle}>{title}</Text>
        <Text numberOfLines={2} style={styles.settingsToggleSubtitle}>{description}</Text>
      </View>
      <View style={[styles.settingsToggleControl, checked && styles.settingsToggleControlChecked]}>
        {checked ? <Check size={18} color={COLORS.bg} strokeWidth={3} /> : null}
      </View>
    </Pressable>
  );
}

function SettingsAlert({ message }: { message: string }) {
  return (
    <View style={styles.settingsAlert}>
      <CircleAlert size={18} color={COLORS.danger} strokeWidth={2.4} />
      <Text style={styles.settingsAlertText}>{message}</Text>
    </View>
  );
}

function SettingsInlineLoading({ label }: { label: string }) {
  return (
    <View style={styles.settingsInlineState}>
      <ActivityIndicator color={COLORS.accent} />
      <Text style={styles.settingsInlineText}>{label}</Text>
    </View>
  );
}

function SettingsEmptyState({ label }: { label: string }) {
  return (
    <View style={styles.settingsEmptyState}>
      <Text style={styles.settingsEmptyText}>{label}</Text>
    </View>
  );
}

function SectionState({ loading, error, onRetry }: { loading: boolean; error: string; onRetry: () => void }) {
  if (loading) {
    return (
      <View style={styles.inlineState}>
        <ActivityIndicator color={COLORS.accent} />
        <Text style={styles.caption}>Cargando...</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.inlineState}>
        <Text style={styles.errorText}>{error}</Text>
        <SecondaryButton label="Reintentar" onPress={onRetry} />
      </View>
    );
  }
  return null;
}

function SectionBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.sectionBlock}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function InfoRow({
  title,
  subtitle,
  value,
}: {
  title: string;
  subtitle?: string;
  value?: string;
}) {
  return (
    <View style={styles.infoRow}>
      <View style={styles.infoRowText}>
        <Text numberOfLines={1} style={styles.infoRowTitle}>{title}</Text>
        {subtitle ? <Text numberOfLines={1} style={styles.infoRowSubtitle}>{subtitle}</Text> : null}
      </View>
      {value ? <Text style={styles.infoRowValue}>{value}</Text> : null}
    </View>
  );
}

function formatConfigValue(value: unknown) {
  if (value === true) return 'Activo';
  if (value === false) return 'Apagado';
  if (value === null || value === undefined || value === '') return 'Default';
  if (Array.isArray(value)) return `${value.length}`;
  return String(value);
}

function formatPushPermission(value: NativePushPermissionStatus) {
  if (value === 'granted') return 'Permitido';
  if (value === 'denied') return 'Bloqueado';
  if (value === 'prompt') return 'Pendiente';
  return 'No disponible';
}

const PAYMENT_METHOD_OPTIONS = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'bank_transfer', label: 'Transferencia' },
  { value: 'card', label: 'Tarjeta' },
  { value: 'check', label: 'Cheque' },
  { value: 'other', label: 'Otro' },
];

const PAYMENT_STATUS_OPTIONS = [
  { value: 'paid', label: 'Pagado' },
  { value: 'pending', label: 'Pendiente' },
  { value: 'partial', label: 'Parcial' },
];

const PAYMENT_FREQUENCY_OPTIONS = [
  { value: 'weekly', label: 'Semanal' },
  { value: 'biweekly', label: 'Quincenal' },
  { value: 'monthly', label: 'Mensual' },
];

const SUBSCRIPTION_PROVIDER_OPTIONS = [
  { value: 'stripe', label: 'Stripe' },
  { value: 'conekta', label: 'Conekta' },
  { value: 'mercadopago', label: 'Mercado Pago' },
  { value: 'clip', label: 'CLIP' },
];

const SUBSCRIPTION_INTERVAL_OPTIONS = [
  { value: 'daily', label: 'Diaria' },
  { value: 'weekly', label: 'Semanal' },
  { value: 'monthly', label: 'Mensual' },
  { value: 'yearly', label: 'Anual' },
];

function createEmptyProductForm() {
  return {
    name: '',
    description: '',
    priceName: 'Precio base',
    amount: '',
  };
}

function getConfigMap(response: unknown) {
  if (response && typeof response === 'object' && 'config' in response) {
    const config = (response as { config?: unknown }).config;
    return config && typeof config === 'object' ? config as Record<string, unknown> : {};
  }
  return response && typeof response === 'object' ? response as Record<string, unknown> : {};
}

function normalizeCurrencyCode(value: unknown = DEFAULT_ACCOUNT_CURRENCY, fallback = DEFAULT_ACCOUNT_CURRENCY) {
  const normalized = String(value || '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(normalized)) return normalized;
  const fallbackNormalized = String(fallback || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(fallbackNormalized) ? fallbackNormalized : DEFAULT_ACCOUNT_CURRENCY;
}

function normalizeTransactionsResponse(response: TransactionItem[] | { transactions?: TransactionItem[] }) {
  if (Array.isArray(response)) return response;
  return Array.isArray(response?.transactions) ? response.transactions : [];
}

function normalizeAmountInput(value: string | number | null | undefined) {
  const amount = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function getProductId(product?: ProductItem | null) {
  return product?.localId || product?.id || product?._id || '';
}

function getPriceId(price?: ProductPrice | null) {
  return price?.localId || price?.id || price?._id || '';
}

function getPrimaryPrice(product?: ProductItem | null) {
  return product?.prices?.[0] || null;
}

function getPriceAmount(price?: ProductPrice | null) {
  return Number(price?.amount ?? price?.price ?? 0) || 0;
}

function getTransactionId(transaction: TransactionItem) {
  return transaction.id || transaction._id || `${transaction.contactName || transaction.email || 'payment'}-${transaction.date || transaction.createdAt || transaction.paymentDate || ''}`;
}

function getPaymentAmount(transaction: TransactionItem) {
  return Number(transaction.amount ?? transaction.total ?? 0) || 0;
}

function getPaymentSortTime(transaction: TransactionItem) {
  const value = transaction.date || transaction.paymentDate || transaction.paidAt || transaction.createdAt || '';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getPaymentContactLabel(transaction: TransactionItem) {
  return transaction.contactName || transaction.email || transaction.phone || 'Cliente sin nombre';
}

function getPaymentMethodLabel(method?: string | null) {
  const normalized = normalizeProbe(method);
  if (normalized === 'card') return 'Tarjeta';
  if (normalized === 'transfer' || normalized === 'bank_transfer') return 'Transferencia';
  if (normalized === 'cash') return 'Efectivo';
  if (normalized === 'check') return 'Cheque';
  if (normalized === 'paypal') return 'PayPal';
  if (normalized.includes('stripe')) return 'Stripe';
  if (normalized.includes('conekta')) return 'Conekta';
  if (normalized.includes('mercadopago')) return 'Mercado Pago';
  if (normalized.includes('clip')) return 'CLIP';
  return 'Otro';
}

function getPaymentStatusLabel(status?: string | null) {
  const normalized = normalizeProbe(status);
  if (normalized === 'paid' || normalized === 'succeeded') return 'Pagado';
  if (normalized === 'partial') return 'Parcial';
  if (normalized === 'refunded') return 'Reembolsado';
  if (normalized === 'failed') return 'Fallido';
  if (normalized === 'pending') return 'Pendiente';
  return status || 'Sin estado';
}

function getSubscriptionPaymentMethod(provider: string) {
  if (provider === 'mercadopago') return 'mercadopago_subscription';
  if (provider === 'conekta') return 'conekta_subscription';
  if (provider === 'clip') return 'clip_link';
  return 'stripe_saved_card';
}

function getDateOnlyParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return { year, month, day };
}

function formatDateOnlyFromUTC(date: Date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function addDateOnlyDays(dateOnly: string, days: number) {
  const parts = getDateOnlyParts(dateOnly);
  if (!parts) return dateOnly;
  return formatDateOnlyFromUTC(new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days)));
}

function todayDateOnlyInTimezone(timezone: string) {
  const date = new Date();
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || DEFAULT_BUSINESS_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(date);
    const part = (type: string) => parts.find((item) => item.type === type)?.value || '';
    const result = `${part('year')}-${part('month')}-${part('day')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : formatDateOnlyFromUTC(date);
  } catch {
    return formatDateOnlyFromUTC(date);
  }
}

function getRecentPaymentRange(period: RecentPaymentsPeriod, timezone: string) {
  const selected = RECENT_PAYMENT_PERIODS.find((option) => option.id === period) || RECENT_PAYMENT_PERIODS[2];
  const endDate = todayDateOnlyInTimezone(timezone);
  const startDate = selected.days > 0 ? addDateOnlyDays(endDate, -(selected.days - 1)) : endDate;
  return { startDate, endDate };
}

function getCalendarDateOnly(value?: string | null) {
  if (!value) return '';
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T]00:00(?::00(?:\.0+)?)?)?$/.exec(String(value).trim());
  return match?.[1] || '';
}

function formatPaymentDate(value?: string | null, timezone = DEFAULT_BUSINESS_TIMEZONE) {
  if (!value) return 'Sin fecha';
  const dateOnly = getCalendarDateOnly(value);
  try {
    if (dateOnly) {
      const parts = getDateOnlyParts(dateOnly);
      if (!parts) return 'Sin fecha';
      return new Intl.DateTimeFormat('es-MX', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      }).format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)));
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Sin fecha';
    return new Intl.DateTimeFormat('es-MX', {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone || DEFAULT_BUSINESS_TIMEZONE,
    }).format(date);
  } catch {
    return 'Sin fecha';
  }
}

function ChatFilterBar({
  active,
  filters,
  unreadTotal,
  onChange,
}: {
  active: ChatFilterId;
  filters: ChatFilterPreset[];
  unreadTotal: number;
  onChange: (filter: ChatFilterId) => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const filterSignature = useMemo(() => filters.map((filter) => filter.id).join('|'), [filters]);

  useEffect(() => {
    if (active === 'all' || active === 'unread' || active === 'appointments') {
      scrollRef.current?.scrollTo({ x: 0, animated: false });
    }
  }, [active, filterSignature]);

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      contentInsetAdjustmentBehavior="never"
      showsHorizontalScrollIndicator={false}
      style={styles.filterChipScroll}
      contentContainerStyle={styles.filterChipRow}
    >
      {filters.map((filter) => {
        const selected = filter.id === active;
        const count = filter.id === 'unread' && unreadTotal > 0 ? (unreadTotal > 99 ? '99+' : String(unreadTotal)) : '';
        return (
          <React.Fragment key={filter.id}>
            {filter.separatorBefore ? <View style={styles.filterChipSeparator} /> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => onChange(filter.id)}
              style={({ pressed }) => [
                styles.filterChip,
                selected && styles.filterChipActive,
                filter.id === 'comments' && styles.filterChipComments,
                pressed && styles.pressed,
              ]}
            >
              <Text numberOfLines={1} style={[styles.filterChipText, selected && styles.filterChipTextActive]}>{filter.label}</Text>
              {count ? (
                <View style={styles.filterChipCount}>
                  <Text style={styles.filterChipCountText}>{count}</Text>
                </View>
              ) : null}
            </Pressable>
          </React.Fragment>
        );
      })}
      <Pressable
        accessibilityRole="button"
        onPress={() => onChange(CHAT_FILTERS_MORE_VALUE)}
        style={({ pressed }) => [styles.filterChip, styles.filterChipMore, pressed && styles.pressed]}
      >
        <Plus size={17} color={COLORS.muted} strokeWidth={2.6} />
      </Pressable>
    </ScrollView>
  );
}

function FilterManagerSheet({
  activeFilter,
  visibleFilterIds,
  open,
  onClose,
  onApply,
  onToggleVisible,
}: {
  activeFilter: ChatFilterId;
  visibleFilterIds: ChatFilterId[];
  open: boolean;
  onClose: () => void;
  onApply: (filterId: ChatFilterId) => void;
  onToggleVisible: (filterId: ChatFilterId) => void;
}) {
  const sections = useMemo(() => {
    const grouped = new Map<string, ChatFilterPreset[]>();
    CHAT_FILTER_LIBRARY.forEach((preset) => {
      grouped.set(preset.section, [...(grouped.get(preset.section) || []), preset]);
    });
    return Array.from(grouped.entries());
  }, []);

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable style={styles.sheetScrim} onPress={onClose} />
        <View style={styles.filterSheet}>
          <View style={styles.filterSheetHeader}>
            <View>
              <Text style={styles.filterSheetTitle}>Filtros</Text>
              <Text style={styles.filterSheetSubtitle}>Rápidos, canales y actividad</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.sheetCloseButton}>
              <X size={18} color={COLORS.text} strokeWidth={2.5} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.filterSheetBody}>
            {sections.map(([section, presets]) => (
              <View key={section} style={styles.filterManagerSection}>
                <Text style={styles.filterManagerSectionTitle}>{section}</Text>
                {presets.map((preset) => {
                  const selected = preset.id === activeFilter;
                  const visible = visibleFilterIds.includes(preset.id);
                  return (
                    <View key={preset.id} style={[styles.filterManagerRow, selected && styles.filterManagerRowActive]}>
                      <Pressable style={styles.filterManagerCopy} onPress={() => onApply(preset.id)}>
                        <Text numberOfLines={1} style={styles.filterManagerTitle}>{preset.label}</Text>
                        <Text numberOfLines={2} style={styles.filterManagerDescription}>{preset.description}</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        disabled={preset.locked}
                        onPress={() => onToggleVisible(preset.id)}
                        style={[styles.filterManagerToggle, visible && styles.filterManagerToggleActive, preset.locked && styles.disabledButton]}
                      >
                        <Text style={[styles.filterManagerToggleText, visible && styles.filterManagerToggleTextActive]}>
                          {visible ? 'Quitar' : 'Agregar'}
                        </Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function BottomActionSheet({
  children,
  closing = false,
  open,
  title,
  subtitle,
  onClose,
}: {
  children: React.ReactNode;
  closing?: boolean;
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  const sheetProgress = useRef(new Animated.Value(1)).current;
  const dimmerOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!open) {
      sheetProgress.setValue(1);
      dimmerOpacity.setValue(0);
      return;
    }

    Animated.parallel([
      Animated.timing(dimmerOpacity, {
        toValue: closing ? 0 : 1,
        duration: closing ? CHAT_SHEET_CLOSE_DURATION_MS : CHAT_SHEET_OPEN_DURATION_MS,
        easing: closing ? Easing.out(Easing.quad) : Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(sheetProgress, {
        toValue: closing ? 1 : 0,
        duration: closing ? CHAT_SHEET_CLOSE_DURATION_MS : CHAT_SHEET_OPEN_DURATION_MS,
        easing: closing ? Easing.inOut(Easing.cubic) : Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [closing, dimmerOpacity, open, sheetProgress]);

  const translateY = sheetProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, CHAT_SHEET_HIDDEN_TRANSLATE_Y],
  });

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.sheetModalRoot}>
        <Animated.View pointerEvents="none" style={[styles.sheetDimmer, { opacity: dimmerOpacity }]} />
        <Pressable style={styles.sheetScrim} onPress={onClose} />
        <Animated.View style={[styles.actionSheet, { transform: [{ translateY }] }]}>
          <View style={styles.actionSheetHandle} />
          <View style={styles.actionSheetHeader}>
            <View style={styles.actionSheetHeaderCopy}>
              <Text style={styles.actionSheetTitle}>{title}</Text>
              {subtitle ? <Text numberOfLines={1} style={styles.actionSheetSubtitle}>{subtitle}</Text> : null}
            </View>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.sheetCloseButton}>
              <X size={18} color={COLORS.text} strokeWidth={2.5} />
            </Pressable>
          </View>
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

function SheetActionRow({
  Icon,
  title,
  subtitle,
  busy,
  danger,
  disabled,
  onPress,
}: {
  Icon: LucideIcon;
  title: string;
  subtitle: string;
  busy?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.sheetActionRow, (disabled || busy) && styles.disabledButton, pressed && styles.pressed]}
    >
      <View style={[styles.sheetActionIcon, danger && styles.sheetActionIconDanger]}>
        {busy ? (
          <ActivityIndicator color={danger ? COLORS.danger : COLORS.accent} />
        ) : (
          <Icon size={20} color={danger ? COLORS.danger : COLORS.accent} strokeWidth={2.6} />
        )}
      </View>
      <View style={styles.sheetActionCopy}>
        <Text style={styles.sheetActionTitle}>{title}</Text>
        <Text numberOfLines={2} style={styles.sheetActionSubtitle}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

function ChatMoreSheet({
  archived,
  agentBusyAction,
  agentLoading,
  agentState,
  closing,
  contact,
  muted,
  open,
  unread,
  onAgentAction,
  onAppointment,
  onArchiveToggle,
  onClose,
  onMarkRead,
  onPayment,
  onSchedule,
  onSelect,
  onTag,
  onToggleMute,
}: {
  archived: boolean;
  agentBusyAction?: AgentAction | null;
  agentLoading?: boolean;
  agentState?: ConversationAgentState | null;
  closing?: boolean;
  contact: ChatContact | null;
  muted: boolean;
  open: boolean;
  unread: number;
  onAgentAction: (contact: ChatContact, action: AgentAction) => void;
  onAppointment: (contact: ChatContact) => void;
  onArchiveToggle: (contact: ChatContact) => void;
  onClose: () => void;
  onMarkRead: (contact: ChatContact) => void;
  onPayment: (contact: ChatContact) => void;
  onSchedule: (contact: ChatContact) => void;
  onSelect: (contact: ChatContact) => void;
  onTag: (contact: ChatContact) => void;
  onToggleMute: (contact: ChatContact) => void;
}) {
  const inactiveAgent = isInactiveAgentStatus(agentState?.status);
  const primaryAgentAction: AgentAction = inactiveAgent ? 'activate' : 'pause';
  const agentActionBusy = Boolean(agentBusyAction);
  return (
    <BottomActionSheet
      closing={closing}
      open={open && Boolean(contact)}
      title="Más acciones"
      subtitle={contact ? getContactName(contact) : ''}
      onClose={onClose}
    >
      {contact ? (
        <ScrollView contentContainerStyle={styles.sheetActionList} showsVerticalScrollIndicator={false}>
          <SheetActionRow
            Icon={CalendarDays}
            title="Agendar cita"
            subtitle="Crear una cita para este contacto."
            onPress={() => onAppointment(contact)}
          />
          <SheetActionRow
            Icon={CircleDollarSign}
            title="Registrar pagos"
            subtitle="Elegir pago único, plan o suscripción."
            onPress={() => onPayment(contact)}
          />
          <SheetActionRow
            Icon={Clock}
            title="Programar mensaje"
            subtitle="Escribe un mensaje para enviarlo en una hora."
            onPress={() => onSchedule(contact)}
          />
          <SheetActionRow
            Icon={Tag}
            title="Agregar etiqueta"
            subtitle="Clasificar este chat con una etiqueta."
            onPress={() => onTag(contact)}
          />
          <SheetActionRow
            Icon={muted ? Bell : BellOff}
            title={muted ? 'Quitar silencio' : 'Silenciar'}
            subtitle={muted ? 'Quita la marca de silencio de este chat.' : 'Marca este chat como silenciado.'}
            onPress={() => onToggleMute(contact)}
          />
          <View style={styles.sheetSectionDivider}>
            <Text style={styles.sheetSectionLabel}>Agente conversacional</Text>
            {agentLoading ? <ActivityIndicator color={COLORS.accent} /> : null}
          </View>
          <SheetActionRow
            Icon={inactiveAgent ? Play : Pause}
            title={inactiveAgent ? 'Reactivar agente' : 'Pausar agente'}
            subtitle={inactiveAgent ? 'El agente vuelve a atender este chat.' : 'Detiene el agente durante 24 horas.'}
            busy={agentBusyAction === primaryAgentAction}
            disabled={agentLoading || agentActionBusy}
            onPress={() => onAgentAction(contact, primaryAgentAction)}
          />
          <SheetActionRow
            Icon={User}
            title="Tomar chat"
            subtitle="El humano toma esta conversación."
            busy={agentBusyAction === 'take_over'}
            disabled={agentLoading || agentActionBusy}
            onPress={() => onAgentAction(contact, 'take_over')}
          />
          <SheetActionRow
            Icon={X}
            title="Omitir agente"
            subtitle="El agente no vuelve a tomar este chat hasta reactivarlo."
            danger
            busy={agentBusyAction === 'skip'}
            disabled={agentLoading || agentActionBusy}
            onPress={() => onAgentAction(contact, 'skip')}
          />
          <View style={styles.sheetSectionDivider}>
            <Text style={styles.sheetSectionLabel}>Chat</Text>
          </View>
          {unread > 0 ? (
            <SheetActionRow
              Icon={CheckCheck}
              title="Marcar como leído"
              subtitle="Quita los pendientes de esta conversación."
              onPress={() => onMarkRead(contact)}
            />
          ) : null}
          <SheetActionRow
            Icon={Archive}
            title={archived ? 'Restaurar chat' : 'Archivar chat'}
            subtitle={archived ? 'Devuelve la conversación a la bandeja principal.' : 'Mueve la conversación a Archivados.'}
            onPress={() => onArchiveToggle(contact)}
          />
          <SheetActionRow
            Icon={Check}
            title="Seleccionar"
            subtitle="Activa selección múltiple desde esta conversación."
            onPress={() => onSelect(contact)}
          />
        </ScrollView>
      ) : null}
    </BottomActionSheet>
  );
}

function ContactTagSheet({
  busy,
  closing,
  contact,
  loading,
  open,
  query,
  tags,
  onApply,
  onChangeQuery,
  onClose,
  onCreate,
}: {
  busy: boolean;
  closing?: boolean;
  contact: ChatContact | null;
  loading: boolean;
  open: boolean;
  query: string;
  tags: ContactTag[];
  onApply: (contact: ChatContact, tag: ContactTag) => void;
  onChangeQuery: (value: string) => void;
  onClose: () => void;
  onCreate: (contact: ChatContact) => void;
}) {
  const normalized = query.trim().toLowerCase();
  const filteredTags = tags.filter((tag) => (
    !normalized || tag.name.toLowerCase().includes(normalized)
  ));
  const exactTagExists = Boolean(normalized && tags.some((tag) => tag.name.toLowerCase() === normalized));

  return (
    <BottomActionSheet
      closing={closing}
      open={open && Boolean(contact)}
      title="Agregar etiqueta"
      subtitle={contact ? getContactName(contact) : ''}
      onClose={onClose}
    >
      {contact ? (
        <View style={styles.contactPickerBody}>
          <View style={styles.sheetSearchBox}>
            <Search size={19} color={COLORS.muted} strokeWidth={2.4} />
            <TextInput
              value={query}
              onChangeText={onChangeQuery}
              placeholder="Buscar o crear etiqueta"
              placeholderTextColor={COLORS.muted}
              autoCapitalize="sentences"
              autoCorrect={false}
              style={styles.sheetSearchInput}
            />
          </View>
          {loading ? (
            <View style={styles.sheetInlineState}>
              <ActivityIndicator color={COLORS.accent} />
              <Text style={styles.caption}>Cargando etiquetas...</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.sheetActionList} keyboardShouldPersistTaps="handled">
              {filteredTags.map((tag) => (
                <SheetActionRow
                  key={tag.id}
                  Icon={Tag}
                  title={tag.name}
                  subtitle={(contact.tags || []).includes(tag.id) ? 'Ya está agregada.' : 'Agregar a este chat.'}
                  disabled={(contact.tags || []).includes(tag.id)}
                  busy={busy}
                  onPress={() => onApply(contact, tag)}
                />
              ))}
              {normalized && !exactTagExists ? (
                <SheetActionRow
                  Icon={Plus}
                  title={`Crear "${query.trim()}"`}
                  subtitle="Crea la etiqueta y la agrega a este contacto."
                  busy={busy}
                  onPress={() => onCreate(contact)}
                />
              ) : null}
              {!filteredTags.length && !normalized ? (
                <Text style={styles.contactPickerEmpty}>No hay etiquetas para mostrar.</Text>
              ) : null}
            </ScrollView>
          )}
        </View>
      ) : null}
    </BottomActionSheet>
  );
}

function ScheduleMessageSheet({
  busy,
  closing,
  contact,
  open,
  text,
  onChangeText,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  closing?: boolean;
  contact: ChatContact | null;
  open: boolean;
  text: string;
  onChangeText: (value: string) => void;
  onClose: () => void;
  onSubmit: (contact: ChatContact) => void;
}) {
  return (
    <BottomActionSheet
      closing={closing}
      open={open && Boolean(contact)}
      title="Programar mensaje"
      subtitle={contact ? `${getContactName(contact)} - En 1 hora` : ''}
      onClose={onClose}
    >
      {contact ? (
        <View style={styles.scheduleSheetBody}>
          <TextInput
            value={text}
            onChangeText={onChangeText}
            placeholder="Escribe el mensaje"
            placeholderTextColor={COLORS.muted}
            multiline
            textAlignVertical="top"
            style={styles.scheduleTextInput}
          />
          <PrimaryButton
            label="Programar en 1 hora"
            busy={busy}
            onPress={() => onSubmit(contact)}
          />
        </View>
      ) : null}
    </BottomActionSheet>
  );
}

function NativeTemplatesSheet({
  busyId,
  closing,
  contact,
  loading,
  open,
  templates,
  onClose,
  onSend,
}: {
  busyId?: string | null;
  closing?: boolean;
  contact: ChatContact | null;
  loading: boolean;
  open: boolean;
  templates: WhatsAppTemplate[];
  onClose: () => void;
  onSend: (template: WhatsAppTemplate) => void;
}) {
  return (
    <BottomActionSheet
      closing={closing}
      open={open && Boolean(contact)}
      title="Plantillas"
      subtitle={contact ? getContactName(contact) : ''}
      onClose={onClose}
    >
      {contact ? (
        <View style={styles.templatesSheetBody}>
          {loading ? (
            <View style={styles.sheetInlineState}>
              <ActivityIndicator color={COLORS.accent} />
              <Text style={styles.caption}>Cargando plantillas...</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.sheetActionList} keyboardShouldPersistTaps="handled">
              {templates.map((template, index) => {
                const body = getTemplateBody(template);
                const key = template.id || template.name || body || `template-${index}`;
                return (
                  <SheetActionRow
                    key={key}
                    Icon={MessageCircle}
                    title={template.name || 'Plantilla'}
                    subtitle={body || template.category || (template.source === 'local' ? 'Inserta una respuesta guardada.' : 'Enviar plantilla aprobada por WhatsApp.')}
                    busy={busyId === key}
                    onPress={() => onSend(template)}
                  />
                );
              })}
              {!templates.length ? (
                <Text style={styles.contactPickerEmpty}>No hay plantillas aprobadas o guardadas para mostrar.</Text>
              ) : null}
            </ScrollView>
          )}
        </View>
      ) : null}
    </BottomActionSheet>
  );
}

function NativeClabeSheet({
  accounts,
  busyId,
  closing,
  contact,
  draft,
  formOpen,
  loading,
  open,
  onChangeDraft,
  onClose,
  onSave,
  onSend,
  onToggleForm,
}: {
  accounts: BankClabeAccount[];
  busyId?: string | null;
  closing?: boolean;
  contact: ChatContact | null;
  draft: { alias: string; clabe: string; bank: string; accountHolder: string };
  formOpen: boolean;
  loading: boolean;
  open: boolean;
  onChangeDraft: React.Dispatch<React.SetStateAction<{ alias: string; clabe: string; bank: string; accountHolder: string }>>;
  onClose: () => void;
  onSave: () => void;
  onSend: (account: BankClabeAccount) => void;
  onToggleForm: () => void;
}) {
  return (
    <BottomActionSheet
      closing={closing}
      open={open && Boolean(contact)}
      title="Enviar CLABE"
      subtitle={contact ? getContactName(contact) : ''}
      onClose={onClose}
    >
      {contact ? (
        <View style={styles.clabeSheetBody}>
          <SecondaryButton label={formOpen ? 'Ocultar formulario' : 'Agregar CLABE'} onPress={onToggleForm} />
          {formOpen ? (
            <View style={styles.sheetFormBlock}>
              <TextInput
                value={draft.alias}
                onChangeText={(value) => onChangeDraft((current) => ({ ...current, alias: value }))}
                placeholder="Alias"
                placeholderTextColor={COLORS.muted}
                keyboardAppearance="dark"
                style={styles.sheetInput}
              />
              <TextInput
                value={formatClabe(draft.clabe)}
                onChangeText={(value) => onChangeDraft((current) => ({ ...current, clabe: normalizeClabe(value) }))}
                placeholder="CLABE de 18 dígitos"
                placeholderTextColor={COLORS.muted}
                keyboardAppearance="dark"
                keyboardType="number-pad"
                style={styles.sheetInput}
              />
              <TextInput
                value={draft.bank}
                onChangeText={(value) => onChangeDraft((current) => ({ ...current, bank: value }))}
                placeholder="Banco"
                placeholderTextColor={COLORS.muted}
                keyboardAppearance="dark"
                style={styles.sheetInput}
              />
              <TextInput
                value={draft.accountHolder}
                onChangeText={(value) => onChangeDraft((current) => ({ ...current, accountHolder: value }))}
                placeholder="Titular"
                placeholderTextColor={COLORS.muted}
                keyboardAppearance="dark"
                style={styles.sheetInput}
              />
              <PrimaryButton label="Guardar CLABE" busy={Boolean(busyId)} onPress={onSave} />
            </View>
          ) : null}
          {loading ? (
            <View style={styles.sheetInlineState}>
              <ActivityIndicator color={COLORS.accent} />
              <Text style={styles.caption}>Cargando cuentas...</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.sheetActionList} keyboardShouldPersistTaps="handled">
              {accounts.map((account) => (
                <SheetActionRow
                  key={account.id}
                  Icon={Banknote}
                  title={account.alias || `CLABE ${account.clabe.slice(-4)}`}
                  subtitle={[account.bank, account.accountHolder, formatClabe(account.clabe)].filter(Boolean).join(' · ')}
                  busy={busyId === account.id}
                  onPress={() => onSend(account)}
                />
              ))}
              {!accounts.length ? (
                <Text style={styles.contactPickerEmpty}>No hay CLABEs guardadas. Agrega una para enviarla desde el chat.</Text>
              ) : null}
            </ScrollView>
          )}
        </View>
      ) : null}
    </BottomActionSheet>
  );
}

function PaymentEntrySheet({
  accountCurrency,
  busy,
  closing,
  contact,
  draft,
  open,
  onChangeDraft,
  onClose,
  onSubmit,
}: {
  accountCurrency: string;
  busy: boolean;
  closing?: boolean;
  contact: ChatContact | null;
  draft: { amount: string; concept: string; method: string };
  open: boolean;
  onChangeDraft: React.Dispatch<React.SetStateAction<{ amount: string; concept: string; method: string }>>;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const methods = [
    { id: 'cash', label: 'Efectivo' },
    { id: 'transfer', label: 'Transferencia' },
    { id: 'card', label: 'Tarjeta' },
  ];
  return (
    <BottomActionSheet
      closing={closing}
      open={open && Boolean(contact)}
      title="Registrar pago"
      subtitle={contact ? `${getContactName(contact)} · ${accountCurrency || 'Moneda de cuenta'}` : ''}
      onClose={onClose}
    >
      {contact ? (
        <View style={styles.paymentSheetBody}>
          <TextInput
            value={draft.amount}
            onChangeText={(value) => onChangeDraft((current) => ({ ...current, amount: value.replace(/[^\d.,]/g, '') }))}
            placeholder="Monto"
            placeholderTextColor={COLORS.muted}
            keyboardAppearance="dark"
            keyboardType="decimal-pad"
            style={styles.sheetInput}
          />
          <TextInput
            value={draft.concept}
            onChangeText={(value) => onChangeDraft((current) => ({ ...current, concept: value }))}
            placeholder="Concepto"
            placeholderTextColor={COLORS.muted}
            keyboardAppearance="dark"
            style={styles.sheetInput}
          />
          <View style={styles.sheetPillRow}>
            {methods.map((method) => (
              <Pressable
                key={method.id}
                accessibilityRole="button"
                onPress={() => onChangeDraft((current) => ({ ...current, method: method.id }))}
                style={[styles.sheetPill, draft.method === method.id && styles.sheetPillActive]}
              >
                <Text style={[styles.sheetPillText, draft.method === method.id && styles.sheetPillTextActive]}>{method.label}</Text>
              </Pressable>
            ))}
          </View>
          <PrimaryButton label="Registrar pago" busy={busy} onPress={onSubmit} />
        </View>
      ) : null}
    </BottomActionSheet>
  );
}

function AppointmentEntrySheet({
  busy,
  closing,
  contact,
  draft,
  open,
  timezone,
  onChangeDraft,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  closing?: boolean;
  contact: ChatContact | null;
  draft: { title: string; date: string; time: string; durationMinutes: string; notes: string };
  open: boolean;
  timezone: string;
  onChangeDraft: React.Dispatch<React.SetStateAction<{ title: string; date: string; time: string; durationMinutes: string; notes: string }>>;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <BottomActionSheet
      closing={closing}
      open={open && Boolean(contact)}
      title="Agendar cita"
      subtitle={contact ? `${getContactName(contact)} · ${timezone}` : ''}
      onClose={onClose}
    >
      {contact ? (
        <View style={styles.appointmentSheetBody}>
          <TextInput
            value={draft.title}
            onChangeText={(value) => onChangeDraft((current) => ({ ...current, title: value }))}
            placeholder={`Cita con ${getContactName(contact)}`}
            placeholderTextColor={COLORS.muted}
            keyboardAppearance="dark"
            style={styles.sheetInput}
          />
          <View style={styles.sheetInlineInputs}>
            <TextInput
              value={draft.date}
              onChangeText={(value) => onChangeDraft((current) => ({ ...current, date: value }))}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={COLORS.muted}
              keyboardAppearance="dark"
              style={[styles.sheetInput, styles.sheetInputFlex]}
            />
            <TextInput
              value={draft.time}
              onChangeText={(value) => onChangeDraft((current) => ({ ...current, time: value }))}
              placeholder="HH:mm"
              placeholderTextColor={COLORS.muted}
              keyboardAppearance="dark"
              style={[styles.sheetInput, styles.sheetInputShort]}
            />
          </View>
          <TextInput
            value={draft.durationMinutes}
            onChangeText={(value) => onChangeDraft((current) => ({ ...current, durationMinutes: value.replace(/\D+/g, '') }))}
            placeholder="Duración en minutos"
            placeholderTextColor={COLORS.muted}
            keyboardAppearance="dark"
            keyboardType="number-pad"
            style={styles.sheetInput}
          />
          <TextInput
            value={draft.notes}
            onChangeText={(value) => onChangeDraft((current) => ({ ...current, notes: value }))}
            placeholder="Notas"
            placeholderTextColor={COLORS.muted}
            keyboardAppearance="dark"
            multiline
            textAlignVertical="top"
            style={styles.sheetTextArea}
          />
          <PrimaryButton label="Agendar cita" busy={busy} onPress={onSubmit} />
        </View>
      ) : null}
    </BottomActionSheet>
  );
}


function ContactPickerSheet({
  asset,
  closing,
  contacts,
  loading,
  open,
  query,
  title,
  onChangeQuery,
  onClose,
  onSelect,
}: {
  asset?: ImagePicker.ImagePickerAsset | null;
  closing?: boolean;
  contacts: ChatContact[];
  loading: boolean;
  open: boolean;
  query: string;
  title: string;
  onChangeQuery: (value: string) => void;
  onClose: () => void;
  onSelect: (contact: ChatContact) => void;
}) {
  return (
    <BottomActionSheet
      closing={closing}
      open={open}
      title={title}
      subtitle={asset ? 'Elige a quién enviar la foto' : 'Busca por nombre, número o correo'}
      onClose={onClose}
    >
      <View style={styles.contactPickerBody}>
        {asset ? (
          <Image source={{ uri: asset.uri }} style={styles.cameraPreview as ImageStyle} />
        ) : null}
        <View style={styles.sheetSearchBox}>
          <Search size={19} color={COLORS.muted} strokeWidth={2.4} />
          <TextInput
            value={query}
            onChangeText={onChangeQuery}
            placeholder="Buscar contacto"
            placeholderTextColor={COLORS.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.sheetSearchInput}
          />
          {query ? (
            <Pressable accessibilityRole="button" onPress={() => onChangeQuery('')} style={styles.clearSearchButton}>
              <X size={17} color={COLORS.muted} strokeWidth={2.45} />
            </Pressable>
          ) : null}
        </View>
        {loading ? (
          <View style={styles.sheetInlineState}>
            <ActivityIndicator color={COLORS.accent} />
            <Text style={styles.caption}>Buscando contactos...</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.contactPickerList} keyboardShouldPersistTaps="handled">
            {contacts.length ? contacts.slice(0, 40).map((contact) => (
              <ContactPickerRow key={contact.id} contact={contact} onPress={() => onSelect(contact)} />
            )) : (
              <Text style={styles.contactPickerEmpty}>No hay contactos para mostrar.</Text>
            )}
          </ScrollView>
        )}
      </View>
    </BottomActionSheet>
  );
}

function ContactPickerRow({ contact, showSendIcon = true, onPress }: { contact: ChatContact; showSendIcon?: boolean; onPress: () => void }) {
  const avatar = getContactAvatar(contact);
  const channelKind = getContactChannelKind(contact);
  const channelColor = CHANNEL_BADGE_COLORS[channelKind];
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.contactPickerRow, pressed && styles.pressed]}>
      <View style={[styles.contactPickerAvatar, { borderColor: channelColor }]}>
        {avatar ? <Image source={{ uri: avatar }} style={styles.contactPickerAvatarImage as ImageStyle} /> : <Text style={styles.avatarText}>{getContactName(contact).slice(0, 1).toUpperCase()}</Text>}
      </View>
      <View style={styles.contactPickerCopy}>
        <Text numberOfLines={1} style={styles.contactPickerName}>{getContactName(contact)}</Text>
        <Text numberOfLines={1} style={styles.contactPickerSubtitle}>{contact.phone || contact.email || getChatPreview(contact)}</Text>
      </View>
      {showSendIcon ? <Send size={18} color={COLORS.accent} strokeWidth={2.5} /> : null}
    </Pressable>
  );
}

function ArchiveRow({
  active,
  count,
  onPress,
}: {
  active: boolean;
  count: number;
  onPress: () => void;
}) {
  return (
    <Pressable style={({ pressed }) => [styles.archiveRow, active && styles.archiveRowActive, pressed && styles.pressed]} onPress={onPress}>
      <View style={styles.archiveRowIcon}>
        {active ? <ChevronLeft size={23} color={COLORS.text} strokeWidth={2.45} /> : <Archive size={22} color={COLORS.muted} strokeWidth={2.35} />}
      </View>
      <Text style={[styles.archiveRowTitle, active && styles.archiveRowTitleActive]}>Archivados</Text>
      <Text style={[styles.archiveRowCount, active && styles.archiveRowTitleActive]}>{count}</Text>
    </Pressable>
  );
}

function AssistantChatRow({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.aiChatRow, pressed && styles.pressed]}>
      <View pointerEvents="none" style={styles.aiChatDivider} />
      <View style={styles.aiChatAvatarSlot}>
        <View style={styles.aiChatAvatar}>
          <Bot size={23} color={COLORS.accent} strokeWidth={2.4} />
        </View>
      </View>
      <View style={styles.aiChatBody}>
        <Text numberOfLines={1} style={styles.aiChatName}>{AI_AGENT_CHAT_DISPLAY_NAME}</Text>
        <Text numberOfLines={1} style={styles.aiChatSubtitle}>{AI_AGENT_CHAT_SUBTITLE}</Text>
      </View>
      <View style={styles.aiChatMeta}>
        <Text style={styles.aiChatPinned}>Fijo</Text>
      </View>
    </Pressable>
  );
}

function AssistantConversationScreen({ onBack }: { onBack: () => void }) {
  return (
    <AppFrame>
      <View style={styles.conversationHeader}>
        <Pressable onPress={onBack} style={styles.backButton}>
          <Text style={styles.backLabel}>{'<'}</Text>
        </Pressable>
        <View style={styles.conversationTitleWrap}>
          <Text numberOfLines={1} style={styles.headerTitle}>{AI_AGENT_CHAT_DISPLAY_NAME}</Text>
          <Text numberOfLines={1} style={styles.caption}>{AI_AGENT_CHAT_SUBTITLE}</Text>
        </View>
      </View>
      <View style={styles.aiConversationBody}>
        <View style={styles.aiWelcomeBubble}>
          <Bot size={25} color={COLORS.accent} strokeWidth={2.4} />
          <Text style={styles.aiWelcomeTitle}>Chat fijo listo</Text>
          <Text style={styles.aiWelcomeCopy}>
            Esta entrada nativa ya queda en la bandeja. La conexión completa con el asistente de `/movil` sigue pendiente para usar el mismo historial y proveedor.
          </Text>
        </View>
      </View>
    </AppFrame>
  );
}

function getUnreadCount(contact: ChatContact) {
  return Math.max(0, Number(contact.unreadCount || 0));
}

function normalizeProbe(value?: string | null) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function getChannelProbe(contact: ChatContact) {
  return [
    contact.lastMessageChannel,
    contact.lastMessageTransport,
    contact.whatsappAttributionPlatform,
    contact.attribution_session_source,
    contact.source,
  ].map((value) => normalizeProbe(value)).filter(Boolean).join(' ');
}

function contactHasCommentActivity(contact: ChatContact) {
  if (contact.hasCommentMessage !== undefined) return Boolean(contact.hasCommentMessage);
  return normalizeProbe(contact.lastMessageType).startsWith('comment');
}

function getContactChannelKind(contact: ChatContact): ChannelBadgeKind {
  const probe = getChannelProbe(contact);
  if (contactHasCommentActivity(contact)) {
    return probe.includes('instagram') ? 'instagram_comment' : 'facebook_comment';
  }
  if (probe.includes('instagram') || probe.includes('ig_') || probe === 'ig') return 'instagram';
  if (probe.includes('messenger') || probe.includes('fb_messenger')) return 'messenger';
  if (probe.includes('email') || probe.includes('mail') || probe.includes('correo')) return 'email';
  if (probe.includes('sms')) return 'sms';
  if (probe.includes('whatsapp') || probe.includes('api') || probe.includes('qr')) return 'whatsapp';
  return 'unknown';
}

function getDefaultComposerChannel(contact: ChatContact): NativeMessageChannel {
  const kind = getContactChannelKind(contact);
  if (kind === 'instagram' || kind === 'instagram_comment') return 'instagram';
  if (kind === 'messenger' || kind === 'facebook_comment') return 'messenger';
  if (kind === 'sms') return 'sms';
  if (kind === 'email') return 'email';
  return 'whatsapp';
}

function getBackendChannelForComposer(channel: NativeMessageChannel) {
  if (channel === 'sms') return 'sms_qr';
  if (channel === 'email') return 'email';
  if (channel === 'messenger') return 'messenger';
  if (channel === 'instagram') return 'instagram';
  return 'whatsapp_api';
}

function contactProbeIncludes(contact: ChatContact, value: string) {
  return getChannelProbe(contact).includes(value);
}

function getComposerChannelOptions(contact: ChatContact): ComposerChannelOption[] {
  const kind = getContactChannelKind(contact);
  const hasPhone = Boolean(String(contact.phone || '').trim());
  const isMessengerContact = kind === 'messenger' || kind === 'facebook_comment' || contactProbeIncludes(contact, 'messenger');
  const isInstagramContact = kind === 'instagram' || kind === 'instagram_comment' || contactProbeIncludes(contact, 'instagram');

  return [
    {
      value: 'whatsapp',
      label: 'WhatsApp',
      description: contact.lastBusinessPhone ? `Desde ${contact.lastBusinessPhone}` : 'Mensaje por WhatsApp conectado.',
      kind: 'whatsapp',
      disabledReason: hasPhone ? undefined : 'Este contacto no tiene teléfono guardado.',
    },
    {
      value: 'sms',
      label: 'SMS',
      description: 'Envía por SMS cuando el contacto tiene teléfono.',
      kind: 'sms',
      disabledReason: hasPhone ? undefined : 'Este contacto no tiene teléfono guardado.',
    },
    {
      value: 'messenger',
      label: 'Messenger',
      description: 'Responde por Facebook Messenger.',
      kind: 'messenger',
      disabledReason: isMessengerContact ? undefined : 'Disponible cuando este contacto viene de Messenger.',
    },
    {
      value: 'instagram',
      label: 'Instagram DM',
      description: 'Responde por Instagram Direct.',
      kind: 'instagram',
      disabledReason: isInstagramContact ? undefined : 'Disponible cuando este contacto viene de Instagram.',
    },
    {
      value: 'email',
      label: 'Correo',
      description: 'Disponible desde la vista completa de chats.',
      kind: 'email',
      disabledReason: 'El correo todavía se envía desde la vista completa de chats.',
    },
  ];
}

function getContactCustomFieldRows(contact: ChatContact) {
  return (contact.customFields || [])
    .map((field, index) => {
      const rawValue = field.value;
      const value = Array.isArray(rawValue)
        ? rawValue.join(', ')
        : rawValue === null || rawValue === undefined
          ? ''
          : String(rawValue);
      return {
        id: field.id || field.fieldId || field.field_id || `field-${index}`,
        label: field.label || field.name || 'Campo',
        value,
      };
    })
    .filter((field) => field.value.trim());
}

function formatContactMoney(value: number, accountCurrency: string) {
  const amount = Number.isFinite(value) ? value : 0;
  const currency = accountCurrency.trim().toUpperCase();
  if (currency) return formatCurrency(amount, currency);
  return amount.toLocaleString('es-MX', { maximumFractionDigits: 2 });
}


function getMessageTypeLabel(type?: string, fallback = 'Mensaje') {
  const normalized = normalizeProbe(type);
  if (!normalized) return fallback;
  if (normalized.includes('image') || normalized.includes('photo')) return 'Foto';
  if (normalized.includes('video')) return 'Video';
  if (normalized.includes('audio') || normalized.includes('voice')) return 'Audio';
  if (normalized.includes('document') || normalized.includes('file')) return 'Documento';
  if (normalized.includes('location')) return 'Ubicación';
  if (normalized.includes('comment')) return 'Comentario';
  return fallback;
}

function getChannelFallback(contact: ChatContact) {
  const kind = getContactChannelKind(contact);
  if (kind === 'instagram' || kind === 'instagram_comment') return 'Mensaje de Instagram';
  if (kind === 'messenger' || kind === 'facebook_comment') return 'Mensaje de Messenger';
  if (kind === 'email') return 'Correo';
  if (kind === 'sms') return 'SMS';
  return 'Mensaje de WhatsApp';
}

function getChatPreview(contact: ChatContact) {
  const text = String(contact.lastMessageText || '').trim();
  const typeLabel = text || getMessageTypeLabel(contact.lastMessageType, getChannelFallback(contact));
  return normalizeProbe(contact.lastMessageDirection) === 'outbound' ? `Tú: ${typeLabel}` : typeLabel;
}

function chatMatchesFilter(contact: ChatContact, filter: ChatFilterId) {
  if (filter === 'all') return true;
  if (filter === 'unread') return getUnreadCount(contact) > 0;
  if (filter === 'comments') return contactHasCommentActivity(contact);

  const status = normalizeProbe(contact.status);
  const hasCustomerSignal = status === 'customer' || Number(contact.purchases || 0) > 0 || Number(contact.ltv || 0) > 0;
  const hasAppointmentSignal = status === 'appointment' || Boolean(contact.hasAppointments || contact.nextAppointmentDate);

  if (filter === 'appointments') return hasAppointmentSignal;
  if (filter === 'customers') return hasCustomerSignal;
  if (filter === 'leads') return !hasCustomerSignal && !hasAppointmentSignal && (!status || status === 'lead');
  if (filter === 'advanced:channel:whatsapp') return getContactChannelKind(contact) === 'whatsapp';
  if (filter === 'advanced:channel:messenger') return getContactChannelKind(contact) === 'messenger' || getContactChannelKind(contact) === 'facebook_comment';
  if (filter === 'advanced:channel:instagram') return getContactChannelKind(contact) === 'instagram' || getContactChannelKind(contact) === 'instagram_comment';
  if (filter === 'advanced:channel:email') return getContactChannelKind(contact) === 'email';
  if (filter === 'advanced:channel:sms') return getContactChannelKind(contact) === 'sms';
  if (filter === 'advanced:activity:payments') return Number(contact.purchases || 0) > 0 || Number(contact.ltv || 0) > 0;
  if (filter === 'advanced:activity:appointments') return hasAppointmentSignal;
  if (filter === 'advanced:activity:with_source') return Boolean(normalizeProbe(contact.source) || normalizeProbe(contact.attribution_session_source) || normalizeProbe(contact.whatsappAttributionPlatform));
  if (filter === 'advanced:activity:no_phone') return !contact.phone;
  return true;
}

function selectPrimaryAgentState(states?: ConversationAgentState[]) {
  if (!Array.isArray(states) || !states.length) return null;
  return states.find((state) => state.agentId) || states[0] || null;
}

function isInactiveAgentStatus(status?: string | null) {
  return ['paused', 'human', 'skipped', 'completed', 'discarded'].includes(String(status || '').toLowerCase());
}

function getAgentActionSuccess(action: AgentAction, contactName: string) {
  if (action === 'activate') return `El agente volvió a atender a ${contactName}.`;
  if (action === 'pause') return `El agente quedó pausado por 24hrs en ${contactName}.`;
  if (action === 'take_over') return `Tomaste la conversación de ${contactName}.`;
  return `El agente quedó omitido en ${contactName}.`;
}

function ChannelBadgeIcon({ kind, size = 15 }: { kind: ChannelBadgeKind; size?: number }) {
  if (kind === 'email') return <Mail size={size} color={COLORS.white} strokeWidth={2.7} />;
  if (kind === 'sms' || kind === 'unknown') return <MessageCircle size={size} color={COLORS.white} strokeWidth={2.7} />;

  if (kind === 'instagram' || kind === 'instagram_comment') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Rect x="4" y="4" width="16" height="16" rx="5" stroke={COLORS.white} strokeWidth="2.6" />
        <Circle cx="12" cy="12" r="3.8" stroke={COLORS.white} strokeWidth="2.6" />
        <Circle cx="17.2" cy="6.8" r="1.35" fill={COLORS.white} />
      </Svg>
    );
  }

  if (kind === 'messenger') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path
          d="M12 4.5c-4.6 0-8 3.18-8 7.28 0 2.34 1.1 4.38 2.86 5.72v2.72l2.62-1.45c.79.22 1.63.34 2.52.34 4.6 0 8-3.18 8-7.33S16.6 4.5 12 4.5Z"
          stroke={COLORS.white}
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
        <Path d="m7.7 13.38 3.02-3.2 2.25 2.38 3.38-3.15-3.02 4.73-2.31-2.37-3.32 1.61Z" fill={COLORS.white} />
      </Svg>
    );
  }

  if (kind === 'facebook_comment') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path
          d="M14.2 8.05h2.02V4.62c-.35-.05-1.55-.15-2.94-.15-2.9 0-4.88 1.82-4.88 5.18v2.92H5.1v3.84h3.3v7.1h4.05v-7.1h3.18l.5-3.84h-3.68V10.03c0-1.11.3-1.98 1.75-1.98Z"
          fill={COLORS.white}
        />
      </Svg>
    );
  }

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M19.1 4.9A9.7 9.7 0 0 0 3.8 16.62L2.9 21.1l4.6-1.08A9.7 9.7 0 0 0 21.7 11.5a9.6 9.6 0 0 0-2.6-6.6Z"
        stroke={COLORS.white}
        strokeWidth="2.05"
        strokeLinejoin="round"
      />
      <Path
        d="M8.68 8.05c.2-.45.4-.46.6-.46h.52c.16 0 .39.06.6.47.2.41.7 1.62.76 1.73.06.12.1.26.02.42-.08.17-.12.27-.25.42l-.38.45c-.13.13-.26.27-.11.53.14.27.65 1.07 1.4 1.73.96.86 1.78 1.13 2.04 1.27.26.13.42.11.57-.07.16-.18.66-.77.84-1.03.17-.26.35-.22.6-.13.24.09 1.54.73 1.8.86.27.13.45.2.52.31.07.12.07.69-.16 1.35-.23.66-1.34 1.26-1.87 1.34-.5.08-1.15.12-1.86-.12-.43-.14-.98-.32-1.69-.63-2.96-1.28-4.9-4.26-5.05-4.46-.15-.2-1.2-1.6-1.2-3.05 0-1.45.76-2.16 1.03-2.46.27-.3.59-.38.79-.38Z"
        fill={COLORS.white}
      />
    </Svg>
  );
}

function ChatSelectionPanel({
  allVisibleSelected,
  archiveLabel,
  busy,
  count,
  menuOpen,
  onArchiveSelected,
  onClear,
  onMarkRead,
  onToggleMenu,
  onToggleVisible,
}: {
  allVisibleSelected: boolean;
  archiveLabel: string;
  busy: boolean;
  count: number;
  menuOpen: boolean;
  onArchiveSelected: () => void;
  onClear: () => void;
  onMarkRead: () => void;
  onToggleMenu: () => void;
  onToggleVisible: () => void;
}) {
  return (
    <View style={styles.chatSelectionPanel}>
      <View style={styles.chatSelectionPanelTop}>
        <Text numberOfLines={1} style={styles.chatSelectionCount}>
          {count} seleccionado{count === 1 ? '' : 's'}
        </Text>
        <Pressable accessibilityRole="button" onPress={onClear} style={styles.chatSelectionClearButton}>
          <X size={17} color={COLORS.text} strokeWidth={2.5} />
        </Pressable>
      </View>
      <Pressable accessibilityRole="button" onPress={onToggleVisible} style={styles.chatSelectionSelectAll}>
        <View style={[styles.chatSelectionMiniCheck, allVisibleSelected && styles.chatSelectionMiniCheckActive]}>
          {allVisibleSelected ? <Check size={13} color={COLORS.white} strokeWidth={3} /> : null}
        </View>
        <Text numberOfLines={1} style={styles.chatSelectionSelectAllText}>
          {allVisibleSelected ? 'Quitar visibles' : 'Seleccionar visibles'}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={onToggleMenu}
        style={[styles.chatSelectionMoreButton, busy && styles.disabledButton]}
      >
        <MoreHorizontal size={19} color={COLORS.white} strokeWidth={2.8} />
        <Text style={styles.chatSelectionMoreButtonText}>Más acciones</Text>
      </Pressable>
      {menuOpen ? (
        <View style={styles.chatSelectionActionsMenu}>
          <Pressable disabled={busy} onPress={onMarkRead} style={({ pressed }) => [styles.chatSelectionActionRow, pressed && styles.pressed]}>
            <View style={styles.chatSelectionActionIcon}>
              <CheckCheck size={18} color={COLORS.accent} strokeWidth={2.7} />
            </View>
            <View style={styles.chatSelectionActionCopy}>
              <Text style={styles.chatSelectionActionTitle}>Marcar como leídos</Text>
              <Text style={styles.chatSelectionActionSubtitle}>Quita pendientes de los chats seleccionados.</Text>
            </View>
          </Pressable>
          <Pressable disabled={busy} onPress={onArchiveSelected} style={({ pressed }) => [styles.chatSelectionActionRow, pressed && styles.pressed]}>
            <View style={styles.chatSelectionActionIcon}>
              <Archive size={18} color={COLORS.accent} strokeWidth={2.7} />
            </View>
            <View style={styles.chatSelectionActionCopy}>
              <Text style={styles.chatSelectionActionTitle}>{archiveLabel}</Text>
              <Text style={styles.chatSelectionActionSubtitle}>Mueve estos chats fuera o dentro de la bandeja principal.</Text>
            </View>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function ChatRow({
  contact,
  archived,
  selected,
  selectionActive,
  swipeOpen,
  timezone,
  onArchiveToggle,
  onPress,
  onLongPress,
  onMore,
  onSwipeClose,
  onSwipeOpen,
  onSwipeStart,
}: {
  contact: ChatContact;
  archived?: boolean;
  selected: boolean;
  selectionActive: boolean;
  swipeOpen: boolean;
  timezone: string;
  onArchiveToggle: () => void;
  onPress: () => void;
  onLongPress?: () => void;
  onMore: () => void;
  onSwipeClose: () => void;
  onSwipeOpen: () => void;
  onSwipeStart: () => void;
}) {
  const avatar = getContactAvatar(contact);
  const unread = getUnreadCount(contact);
  const channelKind = getContactChannelKind(contact);
  const channelColor = CHANNEL_BADGE_COLORS[channelKind];
  const translateX = useRef(new Animated.Value(0)).current;
  const offsetRef = useRef(0);
  const dragStartOffsetRef = useRef(0);

  const animateSwipeTo = useCallback((toValue: number) => {
    offsetRef.current = toValue;
    Animated.timing(translateX, {
      toValue,
      useNativeDriver: true,
      duration: toValue < 0 ? CHAT_SWIPE_OPEN_DURATION_MS : CHAT_SWIPE_CLOSE_DURATION_MS,
      easing: Easing.out(Easing.cubic),
    }).start();
  }, [translateX]);

  useEffect(() => {
    animateSwipeTo(swipeOpen && !selectionActive ? -CHAT_SWIPE_ACTION_WIDTH : 0);
  }, [animateSwipeTo, selectionActive, swipeOpen]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => {
      if (selectionActive) return false;
      return Math.abs(gestureState.dx) > CHAT_SWIPE_GESTURE_START_DISTANCE
        && Math.abs(gestureState.dx) > Math.abs(gestureState.dy) + 2;
    },
    onPanResponderGrant: () => {
      onSwipeStart();
      translateX.stopAnimation((value) => {
        const currentOffset = Math.max(-CHAT_SWIPE_ACTION_WIDTH, Math.min(0, Number(value) || 0));
        offsetRef.current = currentOffset;
        dragStartOffsetRef.current = currentOffset;
      });
    },
    onPanResponderMove: (_, gestureState) => {
      const nextOffset = Math.max(
        -CHAT_SWIPE_ACTION_WIDTH,
        Math.min(0, dragStartOffsetRef.current + gestureState.dx),
      );
      offsetRef.current = nextOffset;
      translateX.setValue(nextOffset);
    },
    onPanResponderRelease: (_, gestureState) => {
      const startedOpen = dragStartOffsetRef.current <= -CHAT_SWIPE_ACTION_WIDTH + 1;
      const movedLeft = gestureState.dx <= -CHAT_SWIPE_OPEN_TRIGGER_DISTANCE || gestureState.vx < -0.03;
      const movedRight = gestureState.dx >= CHAT_SWIPE_CLOSE_TRIGGER_DISTANCE || gestureState.vx > 0.03;
      if (startedOpen) {
        if (movedRight) {
          onSwipeClose();
          animateSwipeTo(0);
          return;
        }
        onSwipeOpen();
        animateSwipeTo(-CHAT_SWIPE_ACTION_WIDTH);
        return;
      }
      if (movedLeft || offsetRef.current <= -CHAT_SWIPE_OPEN_TRIGGER_DISTANCE) {
        onSwipeOpen();
        animateSwipeTo(-CHAT_SWIPE_ACTION_WIDTH);
        return;
      }
      onSwipeClose();
      animateSwipeTo(0);
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderTerminate: () => {
      if (offsetRef.current <= -CHAT_SWIPE_ACTION_WIDTH / 2) {
        onSwipeOpen();
        animateSwipeTo(-CHAT_SWIPE_ACTION_WIDTH);
        return;
      }
      onSwipeClose();
      animateSwipeTo(0);
    },
  }), [animateSwipeTo, onSwipeClose, onSwipeOpen, onSwipeStart, selectionActive, swipeOpen, translateX]);

  const handlePress = () => {
    if (swipeOpen && !selectionActive) {
      onSwipeClose();
      return;
    }
    onPress();
  };

  return (
    <View style={[styles.chatSwipeRow, selected && styles.chatSwipeRowSelected]} {...panResponder.panHandlers}>
      {!selectionActive ? (
        <View style={styles.chatSwipeActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cerrar acciones del chat"
            onPress={onSwipeClose}
            style={styles.chatSwipeClosePlate}
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              onMore();
            }}
            style={({ pressed }) => [styles.chatSwipeAction, styles.chatSwipeMore, pressed && styles.pressed]}
          >
            <MoreHorizontal size={30} color={COLORS.bg} strokeWidth={2.7} />
            <Text numberOfLines={1} style={[styles.chatSwipeActionText, styles.chatSwipeMoreText]}>Más</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              onArchiveToggle();
            }}
            style={({ pressed }) => [styles.chatSwipeAction, styles.chatSwipeArchive, pressed && styles.pressed]}
          >
            <Archive size={30} color={COLORS.white} strokeWidth={2.7} />
            <Text numberOfLines={1} style={styles.chatSwipeActionText}>{archived ? 'Restaurar' : 'Archivar'}</Text>
          </Pressable>
        </View>
      ) : null}
      <Animated.View
        style={[styles.chatSwipeContent, { transform: [{ translateX }] }]}
      >
        <Pressable
          style={({ pressed }) => [
            styles.chatRow,
            selectionActive && styles.chatRowSelecting,
            selected && styles.chatRowSelected,
            unread > 0 && styles.chatRowUnread,
            archived && styles.chatRowArchived,
            pressed && styles.pressed,
          ]}
          onPress={handlePress}
          onLongPress={selectionActive ? undefined : onLongPress}
          delayLongPress={310}
        >
          {selectionActive ? (
            <View style={[styles.chatSelectionCheck, selected && styles.chatSelectionCheckActive]}>
              {selected ? <Check size={17} color={COLORS.white} strokeWidth={3} /> : null}
            </View>
          ) : null}
          <View style={[styles.avatar, { borderColor: channelColor }]}>
            <View style={styles.avatarCircle}>
              {avatar ? <Image source={{ uri: avatar }} style={styles.avatarImage as ImageStyle} /> : <Text style={styles.avatarText}>{getContactName(contact).slice(0, 1).toUpperCase()}</Text>}
            </View>
            {channelKind !== 'unknown' ? (
              <View style={[styles.avatarChannelBadge, { backgroundColor: channelColor }]}>
                <ChannelBadgeIcon kind={channelKind} />
              </View>
            ) : null}
          </View>
          <View style={styles.chatRowBody}>
            <View style={styles.rowHeader}>
              <Text numberOfLines={1} style={[styles.chatName, unread > 0 && styles.chatNameUnread]}>{getContactName(contact)}</Text>
              <Text style={[styles.rowTime, unread > 0 && styles.rowTimeUnread]}>{formatChatListDate(contact.lastMessageDate, timezone)}</Text>
            </View>
            <View style={styles.rowFooter}>
              <Text numberOfLines={1} style={[styles.lastMessage, unread > 0 && styles.lastMessageUnread]}>{getChatPreview(contact)}</Text>
              {unread > 0 ? <View style={styles.unreadPill}><Text style={styles.unreadText}>{unread > 9 ? '9+' : unread}</Text></View> : null}
            </View>
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

function ConversationScreen({
  api,
  contact,
  onBack,
}: {
  api: RistakApiClient;
  contact: ChatContact;
  onBack: () => void;
}) {
  return (
    <NativeConversationScreen
      api={api}
      archived={false}
      accountCurrency=""
      contact={contact}
      muted={false}
      timezone={resolveBusinessTimezone()}
      onArchiveToggle={() => undefined}
      onBack={onBack}
      onContactPatch={() => undefined}
      onRefreshChats={() => undefined}
      onToggleMute={() => undefined}
    />
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const outbound = message.direction === 'outbound';
  return (
    <View style={[styles.messageRow, outbound ? styles.messageRowOutbound : styles.messageRowInbound]}>
      <View style={[styles.messageBubble, outbound ? styles.outboundBubble : styles.inboundBubble, message.failed && styles.failedBubble]}>
        <Text style={styles.messageText}>{message.text}</Text>
        <Text style={styles.messageMeta}>
          {formatShortDate(message.date)}
          {message.pending ? ' - enviando' : ''}
          {message.failed ? ' - error' : ''}
        </Text>
      </View>
    </View>
  );
}

function NativeContactDetailScreen({
  accountCurrency,
  contact,
  error,
  journeyMessages,
  loading,
  saving,
  timezone,
  onAppointment,
  onBack,
  onPayment,
  onSave,
}: {
  accountCurrency: string;
  contact: ChatContact;
  error?: string;
  journeyMessages: ChatMessage[];
  loading?: boolean;
  saving?: boolean;
  timezone: string;
  onAppointment: () => void;
  onBack: () => void;
  onPayment: () => void;
  onSave: (patch: Partial<ChatContact>) => void;
}) {
  const [nameDraft, setNameDraft] = useState(getContactName(contact));
  const [phoneDraft, setPhoneDraft] = useState(contact.phone || '');

  useEffect(() => {
    setNameDraft(getContactName(contact));
    setPhoneDraft(contact.phone || '');
  }, [contact]);

  const mediaCount = journeyMessages.filter((message) => message.attachment?.type === 'image' || message.attachment?.type === 'video').length;
  const documentCount = journeyMessages.filter((message) => message.attachment?.type === 'document' || message.attachment?.type === 'file').length;
  const linkCount = journeyMessages.filter((message) => /https?:\/\//i.test(message.text || '')).length;
  const customFields = getContactCustomFieldRows(contact);

  const saveName = () => {
    const nextName = nameDraft.trim();
    if (!nextName || nextName === getContactName(contact)) return;
    onSave({ name: nextName, full_name: nextName });
  };

  const savePhone = () => {
    const nextPhone = phoneDraft.trim();
    if (nextPhone === (contact.phone || '')) return;
    Alert.alert(
      'Actualizar teléfono',
      contact.phone ? `Cambiarás ${contact.phone} por ${nextPhone || 'Sin número'}.` : `Guardarás ${nextPhone}.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Guardar', onPress: () => onSave({ phone: nextPhone }) },
      ],
    );
  };

  return (
    <AppFrame>
      <View style={styles.contactDetailHeader}>
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.backButton}>
          <ChevronLeft size={30} color={COLORS.text} strokeWidth={2.5} />
        </Pressable>
        <View style={styles.contactDetailHeaderTitle}>
          <Text style={styles.contactDetailTitle}>Contacto</Text>
          <Text numberOfLines={1} style={styles.contactDetailSubtitle}>{getContactName(contact)}</Text>
        </View>
        {loading ? <ActivityIndicator color={COLORS.accent} /> : <View style={styles.contactDetailHeaderSpacer} />}
      </View>
      <ScrollView contentContainerStyle={styles.contactDetailBody} showsVerticalScrollIndicator={false}>
        <View style={styles.contactDetailHero}>
          <View style={[styles.contactDetailAvatar, { borderColor: CHANNEL_BADGE_COLORS[getContactChannelKind(contact)] }]}>
            {getContactAvatar(contact) ? (
              <Image source={{ uri: getContactAvatar(contact) }} style={styles.contactDetailAvatarImage} />
            ) : (
              <Text style={styles.contactDetailAvatarText}>{getContactName(contact).slice(0, 1).toUpperCase()}</Text>
            )}
          </View>
          <View style={styles.contactDetailNameEditor}>
            <TextInput
              value={nameDraft}
              onChangeText={setNameDraft}
              keyboardAppearance="dark"
              returnKeyType="done"
              onSubmitEditing={saveName}
              style={styles.contactDetailNameInput}
            />
            <Pressable disabled={saving || !nameDraft.trim() || nameDraft.trim() === getContactName(contact)} onPress={saveName} style={[styles.contactDetailSaveButton, (saving || !nameDraft.trim() || nameDraft.trim() === getContactName(contact)) && styles.disabledButton]}>
              {saving ? <ActivityIndicator color={COLORS.white} /> : <Save size={16} color={COLORS.white} strokeWidth={2.55} />}
            </Pressable>
          </View>
          <Text numberOfLines={1} style={styles.contactDetailHeroMeta}>{getContactDetail(contact)}</Text>
          {error ? <Text style={styles.contactDetailError}>{error}</Text> : null}
        </View>

        <View style={styles.contactDetailQuickActions}>
          <Pressable onPress={onAppointment} style={({ pressed }) => [styles.contactDetailQuickAction, pressed && styles.pressed]}>
            <CalendarDays size={20} color={COLORS.accent} strokeWidth={2.45} />
            <Text style={styles.contactDetailQuickActionText}>Agendar cita</Text>
          </Pressable>
          <Pressable onPress={onPayment} style={({ pressed }) => [styles.contactDetailQuickAction, pressed && styles.pressed]}>
            <CircleDollarSign size={20} color={COLORS.accent} strokeWidth={2.45} />
            <Text style={styles.contactDetailQuickActionText}>Cobrar</Text>
          </Pressable>
        </View>

        <View style={styles.contactDetailSection}>
          <Text style={styles.contactDetailSectionTitle}>Datos principales</Text>
          <View style={styles.contactDetailEditableRow}>
            <Phone size={17} color={COLORS.accent} strokeWidth={2.4} />
            <TextInput
              value={phoneDraft}
              onChangeText={setPhoneDraft}
              keyboardAppearance="dark"
              keyboardType="phone-pad"
              placeholder="Sin número"
              placeholderTextColor={COLORS.muted}
              style={styles.contactDetailRowInput}
            />
            <Pressable disabled={saving || phoneDraft.trim() === (contact.phone || '')} onPress={savePhone} style={[styles.contactDetailMiniButton, (saving || phoneDraft.trim() === (contact.phone || '')) && styles.disabledButton]}>
              <Edit3 size={15} color={COLORS.accent} strokeWidth={2.45} />
            </Pressable>
          </View>
          <ContactDetailRow Icon={Mail} label="Correo" value={contact.email || 'Sin correo'} />
          <ContactDetailRow Icon={Tag} label="Estado" value={contact.status || 'Lead'} />
          <ContactDetailRow Icon={Info} label="Origen" value={contact.source || contact.attribution_session_source || 'Sin origen guardado'} />
        </View>

        <View style={styles.contactDetailMetrics}>
          <View style={styles.contactDetailMetric}>
            <Text style={styles.contactDetailMetricLabel}>Total</Text>
            <Text style={styles.contactDetailMetricValue}>{formatContactMoney(Number(contact.ltv || 0), accountCurrency)}</Text>
            <Text style={styles.contactDetailMetricHint}>{Number(contact.purchases || 0)} pago(s)</Text>
          </View>
          <View style={styles.contactDetailMetric}>
            <Text style={styles.contactDetailMetricLabel}>Citas</Text>
            <Text style={styles.contactDetailMetricValue}>{contact.hasAppointments ? 'Activa' : '0'}</Text>
            <Text style={styles.contactDetailMetricHint}>{contact.nextAppointmentDate ? formatConversationDayLabel(contact.nextAppointmentDate, timezone) : 'Sin cita'}</Text>
          </View>
        </View>

        <View style={styles.contactDetailSection}>
          <Text style={styles.contactDetailSectionTitle}>Archivo del chat</Text>
          <ContactDetailRow Icon={ImageIcon} label="Fotos y videos" value={`${mediaCount}`} />
          <ContactDetailRow Icon={FileText} label="Documentos" value={`${documentCount}`} />
          <ContactDetailRow Icon={MapPin} label="Enlaces" value={`${linkCount}`} />
        </View>

        <View style={styles.contactDetailSection}>
          <Text style={styles.contactDetailSectionTitle}>Campos personalizados</Text>
          {customFields.length ? customFields.map((field) => (
            <ContactDetailRow key={field.id} Icon={FileText} label={field.label} value={field.value} />
          )) : <Text style={styles.contactDetailEmpty}>No hay campos personalizados guardados para este contacto.</Text>}
        </View>
      </ScrollView>
    </AppFrame>
  );
}

function ContactDetailRow({
  Icon,
  label,
  value,
}: {
  Icon: LucideIcon;
  label: string;
  value?: string | number | null;
}) {
  return (
    <View style={styles.contactDetailRow}>
      <View style={styles.contactDetailRowIcon}>
        <Icon size={17} color={COLORS.accent} strokeWidth={2.4} />
      </View>
      <View style={styles.contactDetailRowCopy}>
        <Text style={styles.contactDetailRowLabel}>{label}</Text>
        <Text numberOfLines={2} style={styles.contactDetailRowValue}>{value || 'Sin dato'}</Text>
      </View>
    </View>
  );
}

function NativeConversationScreen({
  accountCurrency,
  api,
  archived,
  contact,
  muted,
  timezone,
  onArchiveToggle,
  onBack,
  onContactPatch,
  onNavigate,
  onRefreshChats,
  onToggleMute,
}: {
  accountCurrency: string;
  api: RistakApiClient;
  archived: boolean;
  contact: ChatContact;
  muted: boolean;
  timezone: string;
  onArchiveToggle: (contact: ChatContact) => void;
  onBack: () => void;
  onContactPatch: (contactId: string, patch: Partial<ChatContact>) => void;
  onNavigate?: (section: PhoneSection) => void;
  onRefreshChats: () => void;
  onToggleMute: (contact: ChatContact) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSendChannel, setSelectedSendChannel] = useState<NativeMessageChannel>(() => getDefaultComposerChannel(contact));
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [draftAttachments, setDraftAttachments] = useState<ConversationDraftAttachment[]>([]);
  const [replyingToMessage, setReplyingToMessage] = useState<ChatMessage | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<ChatMessage | null>(null);
  const [activeSheet, setActiveSheet] = useState<ConversationSheetMode>(null);
  const [closingSheet, setClosingSheet] = useState<ConversationSheetMode>(null);
  const [contactInfoOpen, setContactInfoOpen] = useState(false);
  const [contactInfo, setContactInfo] = useState<ChatContact | null>(null);
  const [contactInfoLoading, setContactInfoLoading] = useState(false);
  const [contactInfoSaving, setContactInfoSaving] = useState(false);
  const [contactInfoError, setContactInfoError] = useState('');
  const [chatTags, setChatTags] = useState<ContactTag[]>([]);
  const [chatTagsLoading, setChatTagsLoading] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const [tagBusy, setTagBusy] = useState(false);
  const [scheduleText, setScheduleText] = useState('');
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [agentStates, setAgentStates] = useState<ConversationAgentState[]>([]);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentBusyAction, setAgentBusyAction] = useState<AgentAction | null>(null);
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateBusyId, setTemplateBusyId] = useState<string | null>(null);
  const [bankClabes, setBankClabes] = useState<BankClabeAccount[]>([]);
  const [clabesLoading, setClabesLoading] = useState(false);
  const [clabeBusyId, setClabeBusyId] = useState<string | null>(null);
  const [clabeFormOpen, setClabeFormOpen] = useState(false);
  const [clabeDraft, setClabeDraft] = useState({ alias: '', clabe: '', bank: '', accountHolder: '' });
  const [paymentDraft, setPaymentDraft] = useState({ amount: '', concept: 'Pago', method: 'cash' });
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [appointmentDraft, setAppointmentDraft] = useState(() => createDefaultAppointmentDraft(timezone));
  const [appointmentBusy, setAppointmentBusy] = useState(false);
  const [scheduledMessages, setScheduledMessages] = useState<ChatMessage[]>([]);
  const [starredMessageIds, setStarredMessageIds] = useState<string[]>([]);
  const audioRecorder = useAudioRecorder(RecordingPresets.LOW_QUALITY);
  const audioRecorderState = useAudioRecorderState(audioRecorder, 250);
  const listRef = useRef<FlatList<ConversationListItem>>(null);
  const sheetCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRequestRef = useRef(0);
  const onContactPatchRef = useRef(onContactPatch);
  const unreadCountRef = useRef(contact.unreadCount);

  useEffect(() => {
    onContactPatchRef.current = onContactPatch;
  }, [onContactPatch]);

  useEffect(() => {
    unreadCountRef.current = contact.unreadCount;
  }, [contact.unreadCount]);

  useEffect(() => {
    setSelectedSendChannel(getDefaultComposerChannel(contact));
  }, [contact.id, contact.lastMessageChannel, contact.lastMessageTransport, contact.source]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboardVisible(false));
    const showDid = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hideDid = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
      showDid.remove();
      hideDid.remove();
    };
  }, []);

  const loadConversation = useCallback(async (silent = false) => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const [journey, scheduled] = await Promise.all([
        api.getConversation(contact.id, 100),
        api.getScheduledMessages(contact.id).catch(() => []),
      ]);
      if (requestId !== loadRequestRef.current) return;
      const journeyMessages = buildMessagesFromJourney(contact.id, journey);
      const scheduledItems = buildScheduledMessages(contact.id, scheduled);
      setScheduledMessages(scheduledItems);
      setMessages([...journeyMessages, ...scheduledItems].sort((left, right) => (
        new Date(left.date).getTime() - new Date(right.date).getTime()
      )));
      void api.markChatRead(contact.id).catch(() => undefined);
      if (Number(unreadCountRef.current || 0) > 0) {
        unreadCountRef.current = 0;
        onContactPatchRef.current(contact.id, { unreadCount: 0 });
      }
    } catch (err) {
      if (requestId !== loadRequestRef.current) return;
      Alert.alert('Chat', err instanceof Error ? err.message : 'No se pudo cargar la conversación.');
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [api, contact.id]);

  useEffect(() => {
    void loadConversation();
  }, [loadConversation]);

  useEffect(() => () => {
    if (sheetCloseTimerRef.current) clearTimeout(sheetCloseTimerRef.current);
  }, []);

  const clearSheetCloseTimer = useCallback(() => {
    if (sheetCloseTimerRef.current) {
      clearTimeout(sheetCloseTimerRef.current);
      sheetCloseTimerRef.current = null;
    }
  }, []);

  const openSheet = useCallback((sheet: Exclude<ConversationSheetMode, null>) => {
    clearSheetCloseTimer();
    setClosingSheet(null);
    setActiveSheet(sheet);
  }, [clearSheetCloseTimer]);

  const closeSheet = useCallback(() => {
    if (!activeSheet) return;
    const sheet = activeSheet;
    clearSheetCloseTimer();
    setClosingSheet(sheet);
    setActiveSheet(null);
    sheetCloseTimerRef.current = setTimeout(() => {
      sheetCloseTimerRef.current = null;
      setClosingSheet(null);
      if (sheet === 'messageActions') setSelectedMessage(null);
    }, CHAT_SHEET_CLOSE_DURATION_MS + 40);
  }, [activeSheet, clearSheetCloseTimer]);

  const filteredMessages = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return messages;
    return messages.filter((message) => [
      message.text,
      message.attachment?.name,
      message.channel,
      message.transport,
      message.status,
    ].filter(Boolean).join(' ').toLowerCase().includes(needle));
  }, [messages, searchQuery]);

  const conversationItems = useMemo<ConversationListItem[]>(() => {
    const items: ConversationListItem[] = [];
    let previousDay = '';
    filteredMessages.forEach((message) => {
      const key = getConversationDayKey(message.date, timezone);
      if (key !== previousDay) {
        items.push({
          type: 'day',
          id: `day-${key}`,
          label: formatConversationDayLabel(message.date, timezone) || key,
        });
        previousDay = key;
      }
      items.push({ type: 'message', id: message.id, message });
    });
    return items;
  }, [filteredMessages, timezone]);

  const channelKind = getContactChannelKind(contact);
  const channelColor = CHANNEL_BADGE_COLORS[channelKind];
  const composerChannelOptions = useMemo(() => getComposerChannelOptions(contact), [contact]);
  const selectedChannelOption = composerChannelOptions.find((option) => option.value === selectedSendChannel) || composerChannelOptions[0];
  const selectedChannelKind = selectedChannelOption?.kind || channelKind;
  const selectedChannelColor = CHANNEL_BADGE_COLORS[selectedChannelKind] || COLORS.accent;
  const selectedChannelCanSend = Boolean(selectedChannelOption && !selectedChannelOption.disabledReason);
  const hasComposerContent = Boolean(draft.trim() || draftAttachments.length > 0);
  const composerPlaceholder = selectedChannelCanSend
    ? ''
    : selectedChannelOption?.disabledReason || 'Canal no disponible';

  const updateContactPreview = useCallback((text: string, sentAt: string, channel?: string) => {
    onContactPatch(contact.id, {
      lastMessageText: text,
      lastMessageDate: sentAt,
      lastMessageDirection: 'outbound',
      lastMessageChannel: channel || contact.lastMessageChannel,
      messageCount: Number(contact.messageCount || 0) + 1,
    });
  }, [contact.id, contact.lastMessageChannel, contact.messageCount, onContactPatch]);

  const removeDraftAttachment = (id: string) => {
    setDraftAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  const appendDraftAttachments = (prepared: ConversationDraftAttachment[]) => {
    if (!prepared.length) return;
    setDraftAttachments((current) => [...current, ...prepared].slice(0, CONVERSATION_ATTACHMENT_LIMIT));
    closeSheet();
  };

  const pickMedia = async (source: 'camera' | 'library') => {
    const remaining = CONVERSATION_ATTACHMENT_LIMIT - draftAttachments.length;
    if (remaining <= 0) {
      Alert.alert('Adjuntos', `Puedes preparar hasta ${CONVERSATION_ATTACHMENT_LIMIT} archivos por mensaje.`);
      return;
    }

    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(source === 'camera' ? 'Cámara' : 'Fotos', 'Necesito permiso para usar esta opción.');
      return;
    }

    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.86,
        base64: true,
      })
      : await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.86,
        base64: true,
        allowsMultipleSelection: remaining > 1,
        selectionLimit: remaining,
      });
    if (result.canceled || !result.assets?.length) return;
    try {
      const prepared = await Promise.all(result.assets.slice(0, remaining).map((asset, index) => preparePickedMediaAttachment(asset, index)));
      appendDraftAttachments(prepared.filter(Boolean) as ConversationDraftAttachment[]);
    } catch (err) {
      Alert.alert('Adjuntos', err instanceof Error ? err.message : 'No pude preparar el archivo.');
    }
  };

  const pickDocument = async () => {
    const remaining = CONVERSATION_ATTACHMENT_LIMIT - draftAttachments.length;
    if (remaining <= 0) {
      Alert.alert('Documentos', `Puedes preparar hasta ${CONVERSATION_ATTACHMENT_LIMIT} archivos por mensaje.`);
      return;
    }
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'text/*', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      multiple: remaining > 1,
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.length) return;
    try {
      const prepared = await Promise.all(result.assets.slice(0, remaining).map((asset, index) => preparePickedDocumentAttachment(asset, index)));
      appendDraftAttachments(prepared);
    } catch (err) {
      Alert.alert('Documentos', err instanceof Error ? err.message : 'No pude preparar el documento.');
    }
  };

  const startVoiceRecording = async () => {
    if (audioRecorderState.isRecording) return;
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Audio', 'Necesito permiso de micrófono para grabar notas de voz.');
      return;
    }
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
    } catch (err) {
      Alert.alert('Audio', err instanceof Error ? err.message : 'No pude iniciar la grabación.');
    }
  };

  const finishVoiceRecording = async () => {
    if (!audioRecorderState.isRecording) return;
    try {
      await audioRecorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const uri = audioRecorder.uri;
      if (!uri) throw new Error('La grabación terminó sin archivo.');
      const durationMs = Math.round((audioRecorderState.durationMillis || audioRecorder.currentTime * 1000 || 0));
      appendDraftAttachments([await prepareVoiceAttachment(uri, durationMs)]);
    } catch (err) {
      Alert.alert('Audio', err instanceof Error ? err.message : 'No pude preparar la nota de voz.');
    }
  };

  const send = async () => {
    const text = draft.trim();
    const attachmentsToSend = draftAttachments;
    if ((!text && attachmentsToSend.length === 0) || sending) return;
    if (!selectedChannelCanSend) {
      Alert.alert('Canal no disponible', selectedChannelOption?.disabledReason || 'Elige otro canal para enviar.');
      return;
    }
    if (attachmentsToSend.length > 0 && selectedSendChannel !== 'whatsapp') {
      Alert.alert('Adjuntos', 'Los adjuntos nativos se envían por WhatsApp API/QR. Cambia el canal a WhatsApp para mandar este archivo.');
      return;
    }
    if ((selectedSendChannel === 'whatsapp' || selectedSendChannel === 'sms') && !contact.phone) {
      Alert.alert('Falta teléfono', 'Este contacto no tiene teléfono principal para enviar por este canal.');
      return;
    }

    const optimisticId = `local-${Date.now()}`;
    const sentAt = new Date().toISOString();
    const optimisticChannel = getBackendChannelForComposer(selectedSendChannel);
    const optimisticMessages: ChatMessage[] = attachmentsToSend.length
      ? attachmentsToSend.map((attachment, index) => ({
        id: `${optimisticId}-attachment-${index}`,
        contactId: contact.id,
        date: sentAt,
        direction: 'outbound',
        text: index === 0 ? text : '',
        channel: optimisticChannel,
        transport: 'native',
        status: 'enviando',
        pending: true,
        replyToMessageId: replyingToMessage?.id,
        attachment: {
          type: attachment.kind,
          dataUrl: attachment.dataUrl,
          url: attachment.uri,
          name: attachment.name,
          mimeType: attachment.mimeType,
          durationMs: attachment.durationMs,
          size: attachment.size,
        },
      }))
      : [{
        id: optimisticId,
        contactId: contact.id,
        date: sentAt,
        direction: 'outbound',
        text,
        channel: optimisticChannel,
        transport: 'native',
        status: 'enviando',
        pending: true,
        replyToMessageId: replyingToMessage?.id,
      }];

    setDraft('');
    setDraftAttachments([]);
    setReplyingToMessage(null);
    setMessages((current) => [...current, ...optimisticMessages]);
    updateContactPreview(attachmentsToSend.length ? (text || getAttachmentLabel(attachmentsToSend[0]?.kind)) : text, sentAt, optimisticChannel);
    setSending(true);
    try {
      if (attachmentsToSend.length > 0) {
        const responses = await Promise.all(attachmentsToSend.map((attachment, index) => (
          sendDraftAttachment(api, contact, attachment, index === 0 ? text : '')
        )));
        setMessages((current) => current.map((message) => {
          if (!message.id.startsWith(`${optimisticId}-attachment-`)) return message;
          const index = Number(message.id.replace(`${optimisticId}-attachment-`, ''));
          const response = responses[index];
          return {
            ...message,
            pending: false,
            status: response?.status || 'sent',
            channel: response?.transport || message.channel,
            transport: response?.transport || message.transport,
          };
        }));
      } else {
        const response = await api.sendText(contact, text, selectedSendChannel);
        setMessages((current) => current.map((message) => (
          message.id === optimisticId
            ? {
              ...message,
              pending: false,
              status: response.status || 'sent',
              channel: response.transport || message.channel,
              transport: response.transport || message.transport,
              routingReason: response.routingReason || response.fallbackReason || message.routingReason,
            }
            : message
        )));
      }
      onRefreshChats();
      void loadConversation(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Intenta otra vez.';
      setMessages((current) => current.map((message) => (
        message.id === optimisticId || message.id.startsWith(`${optimisticId}-attachment-`)
          ? { ...message, pending: false, failed: true, status: 'error', errorReason: errorMessage }
          : message
      )));
      setDraft(text);
      setDraftAttachments(attachmentsToSend);
      Alert.alert('No se envió', errorMessage);
    } finally {
      setSending(false);
    }
  };

  const openMessageActions = (message: ChatMessage) => {
    if (message.direction === 'system') return;
    setSelectedMessage(message);
    openSheet('messageActions');
  };

  const reactToMessage = async (message: ChatMessage, emoji: string) => {
    closeSheet();
    setMessages((current) => current.map((item) => (
      item.id === message.id
        ? {
          ...item,
          reactions: [
            ...(item.reactions || []).filter((reaction) => reaction.id !== `local-reaction-${message.id}`),
            { id: `local-reaction-${message.id}`, emoji, direction: 'outbound' },
          ],
        }
        : item
    )));

    try {
      await api.sendReaction(contact, message, emoji);
      void loadConversation(true);
    } catch (err) {
      Alert.alert('Reacción', err instanceof Error ? err.message : 'No se pudo mandar la reacción.');
    }
  };

  const copyMessage = async (message: ChatMessage) => {
    await Clipboard.setStringAsync(getMessagePreviewText(message));
    closeSheet();
    Alert.alert('Copiado', 'El mensaje quedó copiado.');
  };

  const toggleStarMessage = (message: ChatMessage) => {
    setStarredMessageIds((current) => (
      current.includes(message.id)
        ? current.filter((id) => id !== message.id)
        : [...current, message.id]
    ));
    closeSheet();
  };

  const forwardMessage = (message: ChatMessage) => {
    const text = getMessagePreviewText(message);
    setDraft((current) => current ? `${current}\n${text}` : text);
    closeSheet();
  };

  const retryMessage = (message: ChatMessage) => {
    if (!message.failed) return;
    setDraft(message.text || '');
    if (message.attachment?.dataUrl || message.attachment?.url) {
      setDraftAttachments([{
        id: `retry-${message.id}`,
        uri: message.attachment.url || message.attachment.dataUrl || '',
        dataUrl: message.attachment.dataUrl || message.attachment.url || '',
        kind: normalizeDraftAttachmentKind(message.attachment.type),
        name: message.attachment.name || getAttachmentLabel(message.attachment.type),
        mimeType: message.attachment.mimeType || '',
        durationMs: message.attachment.durationMs,
        size: message.attachment.size,
      }]);
    }
    closeSheet();
  };

  const cancelScheduledMessage = async (message: ChatMessage) => {
    const scheduledId = message.scheduledMessageId || message.providerMessageId || message.id.replace(/^scheduled-/, '');
    if (!scheduledId) return;
    closeSheet();
    try {
      await api.cancelScheduledMessage(scheduledId, contact.id);
      setMessages((current) => current.filter((item) => item.id !== message.id));
      setScheduledMessages((current) => current.filter((item) => item.id !== message.id));
      Alert.alert('Mensaje cancelado', 'El mensaje programado ya no se enviará.');
    } catch (err) {
      Alert.alert('Programado', err instanceof Error ? err.message : 'No se pudo cancelar el mensaje.');
    }
  };

  const openChatMore = () => {
    setAgentLoading(true);
    openSheet('chatMore');
    api.getAgentStates(contact.id)
      .then((states) => setAgentStates(Array.isArray(states) ? states : []))
      .catch(() => setAgentStates([]))
      .finally(() => setAgentLoading(false));
  };

  const openTagSheet = () => {
    setTagQuery('');
    setChatTagsLoading(true);
    openSheet('tag');
    api.getContactTags()
      .then((tags) => setChatTags(Array.isArray(tags) ? tags : []))
      .catch((err) => {
        setChatTags([]);
        Alert.alert('Etiquetas', err instanceof Error ? err.message : 'No se cargaron las etiquetas.');
      })
      .finally(() => setChatTagsLoading(false));
  };

  const openTemplatesSheet = () => {
    setTemplatesLoading(true);
    openSheet('templates');
    Promise.allSettled([
      api.getWhatsAppTemplates(),
      api.getMessageTemplateBundle(),
    ]).then(([whatsappResult, localResult]) => {
      const nextTemplates = normalizeNativeTemplates(
        whatsappResult.status === 'fulfilled' ? whatsappResult.value.items || [] : [],
        localResult.status === 'fulfilled' ? localResult.value.templates || [] : [],
      );
      setTemplates(nextTemplates);
    }).catch(() => setTemplates([]))
      .finally(() => setTemplatesLoading(false));
  };

  const sendTemplateToContact = async (template: WhatsAppTemplate) => {
    const localText = getTemplateBody(template);
    if (!contact.phone) {
      Alert.alert('Plantillas', 'Este contacto necesita teléfono para recibir una plantilla por WhatsApp.');
      return;
    }

    if (!template.id && localText) {
      setDraft((current) => current ? `${current}\n${localText}` : localText);
      closeSheet();
      return;
    }

    const templateKey = template.id || template.name || localText;
    setTemplateBusyId(templateKey || 'template');
    try {
      const response = await api.sendWhatsAppTemplate(contact, template);
      const sentAt = new Date().toISOString();
      setMessages((current) => [...current, {
        id: `template-${Date.now()}`,
        contactId: contact.id,
        date: sentAt,
        direction: 'outbound',
        text: localText || template.name || 'Plantilla enviada',
        channel: response.channel || response.transport || 'whatsapp_api',
        transport: response.transport || 'native',
        status: response.status || 'sent',
      }]);
      updateContactPreview(localText || template.name || 'Plantilla enviada', sentAt, 'whatsapp_api');
      closeSheet();
      void loadConversation(true);
    } catch (err) {
      Alert.alert('Plantillas', err instanceof Error ? err.message : 'No se pudo enviar la plantilla.');
    } finally {
      setTemplateBusyId(null);
    }
  };

  const openClabeSheet = () => {
    setClabesLoading(true);
    setClabeFormOpen(false);
    openSheet('clabe');
    api.getBankClabes()
      .then((accounts) => setBankClabes(accounts))
      .catch((err) => {
        setBankClabes([]);
        Alert.alert('CLABE', err instanceof Error ? err.message : 'No se cargaron las CLABEs.');
      })
      .finally(() => setClabesLoading(false));
  };

  const saveClabe = async () => {
    const clabe = normalizeClabe(clabeDraft.clabe);
    if (clabe.length !== 18) {
      Alert.alert('CLABE incompleta', 'La CLABE interbancaria debe tener 18 números.');
      return;
    }
    if (bankClabes.some((account) => account.clabe === clabe)) {
      Alert.alert('CLABE', 'Esa CLABE ya está guardada.');
      return;
    }
    const nextAccount: BankClabeAccount = {
      id: `clabe-${Date.now()}`,
      alias: clabeDraft.alias.trim() || `CLABE ${clabe.slice(-4)}`,
      clabe,
      bank: clabeDraft.bank.trim(),
      accountHolder: clabeDraft.accountHolder.trim(),
    };
    const nextAccounts = [nextAccount, ...bankClabes];
    setClabeBusyId(nextAccount.id);
    try {
      await api.saveBankClabes(nextAccounts);
      setBankClabes(nextAccounts);
      setClabeDraft({ alias: '', clabe: '', bank: '', accountHolder: '' });
      setClabeFormOpen(false);
    } catch (err) {
      Alert.alert('CLABE', err instanceof Error ? err.message : 'No se pudo guardar la CLABE.');
    } finally {
      setClabeBusyId(null);
    }
  };

  const sendClabe = async (account: BankClabeAccount) => {
    setClabeBusyId(account.id);
    try {
      const text = buildClabeMessage(account);
      await api.sendText(contact, text, selectedSendChannel);
      const sentAt = new Date().toISOString();
      setMessages((current) => [...current, {
        id: `clabe-${Date.now()}`,
        contactId: contact.id,
        date: sentAt,
        direction: 'outbound',
        text,
        channel: getBackendChannelForComposer(selectedSendChannel),
        transport: 'native',
        status: 'sent',
      }]);
      updateContactPreview('CLABE', sentAt, getBackendChannelForComposer(selectedSendChannel));
      closeSheet();
      void loadConversation(true);
    } catch (err) {
      Alert.alert('CLABE', err instanceof Error ? err.message : 'No se pudo enviar la CLABE.');
    } finally {
      setClabeBusyId(null);
    }
  };

  const openPaymentSheet = () => {
    setPaymentDraft({ amount: '', concept: 'Pago', method: 'cash' });
    openSheet('payment');
    void api.getPaymentLinkDeliveryOptions(contact.id).catch(() => undefined);
  };

  const createPaymentForContact = async () => {
    const amount = Number(paymentDraft.amount.replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert('Registrar pago', 'Escribe un monto mayor a 0.');
      return;
    }
    setPaymentBusy(true);
    try {
      await api.createTransaction({
        amount,
        currency: accountCurrency,
        status: 'paid',
        paymentMethod: paymentDraft.method || 'cash',
        paymentMode: 'single',
        title: paymentDraft.concept.trim() || 'Pago',
        description: paymentDraft.concept.trim() || 'Pago',
        contactId: contact.id,
        contactName: getContactName(contact),
        email: contact.email,
        phone: contact.phone,
        metadata: { source: 'native_mobile_chat' },
      });
      closeSheet();
      Alert.alert('Pago registrado', `Se registró ${formatContactMoney(amount, accountCurrency)} para ${getContactName(contact)}.`);
      onRefreshChats();
    } catch (err) {
      Alert.alert('Registrar pago', err instanceof Error ? err.message : 'No se pudo registrar el pago.');
    } finally {
      setPaymentBusy(false);
    }
  };

  const openAppointmentSheet = () => {
    setAppointmentDraft(createDefaultAppointmentDraft(timezone));
    openSheet('appointment');
  };

  const createAppointmentForContact = async () => {
    const title = appointmentDraft.title.trim() || `Cita con ${getContactName(contact)}`;
    const startTime = localDateTimePartsToUtcIso(appointmentDraft.date, appointmentDraft.time, timezone);
    if (!startTime) {
      Alert.alert('Agendar cita', 'Usa fecha YYYY-MM-DD y hora HH:mm.');
      return;
    }
    const durationMinutes = Math.max(15, Number(appointmentDraft.durationMinutes || 60) || 60);
    const endTime = new Date(new Date(startTime).getTime() + durationMinutes * 60000).toISOString();
    setAppointmentBusy(true);
    try {
      await api.createAppointment({
        title,
        contactId: contact.id,
        contactName: getContactName(contact),
        startTime,
        endTime,
        notes: appointmentDraft.notes.trim(),
        appointmentStatus: 'confirmed',
      });
      closeSheet();
      Alert.alert('Cita agendada', `${title} quedó en la agenda.`);
      onContactPatch(contact.id, { hasAppointments: true, nextAppointmentDate: startTime });
      onRefreshChats();
    } catch (err) {
      Alert.alert('Agendar cita', err instanceof Error ? err.message : 'No se pudo crear la cita.');
    } finally {
      setAppointmentBusy(false);
    }
  };

  const applyTagToContact = async (target: ChatContact, tag: ContactTag) => {
    if (tagBusy) return;
    if ((target.tags || []).includes(tag.id)) {
      Alert.alert('Etiqueta', `${getContactName(target)} ya tiene ${tag.name}.`);
      return;
    }

    setTagBusy(true);
    try {
      await api.addContactTag(target.id, tag.id);
      const nextTags = Array.from(new Set([...(target.tags || []), tag.id]));
      onContactPatch(target.id, { tags: nextTags });
      closeSheet();
      Alert.alert('Etiqueta agregada', `${tag.name} quedó en ${getContactName(target)}.`);
    } catch (err) {
      Alert.alert('Etiqueta', err instanceof Error ? err.message : 'No se pudo agregar la etiqueta.');
    } finally {
      setTagBusy(false);
    }
  };

  const createAndApplyTag = async (target: ChatContact) => {
    const name = tagQuery.trim();
    if (!name || tagBusy) return;
    setTagBusy(true);
    try {
      const tag = await api.createContactTag(name);
      setChatTags((current) => [tag, ...current.filter((item) => item.id !== tag.id)]);
      await api.addContactTag(target.id, tag.id);
      const nextTags = Array.from(new Set([...(target.tags || []), tag.id]));
      onContactPatch(target.id, { tags: nextTags });
      closeSheet();
      Alert.alert('Etiqueta creada', `${tag.name} quedó en ${getContactName(target)}.`);
    } catch (err) {
      Alert.alert('Etiqueta', err instanceof Error ? err.message : 'No se pudo crear la etiqueta.');
    } finally {
      setTagBusy(false);
    }
  };

  const scheduleMessageForContact = async (target: ChatContact) => {
    const text = scheduleText.trim();
    if (!text || scheduleBusy) return;
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    setScheduleBusy(true);
    try {
      await api.scheduleText(target, text, scheduledAt, selectedSendChannel);
      closeSheet();
      setScheduleText('');
      Alert.alert('Mensaje programado', `Se programó para enviarse en 1 hora a ${getContactName(target)}.`);
      void loadConversation(true);
    } catch (err) {
      Alert.alert('Programar mensaje', err instanceof Error ? err.message : 'No se pudo programar el mensaje.');
    } finally {
      setScheduleBusy(false);
    }
  };

  const runAgentAction = async (target: ChatContact, action: AgentAction) => {
    if (agentBusyAction) return;
    setAgentBusyAction(action);
    try {
      const state = await api.updateAgentState(target.id, action);
      setAgentStates([state]);
      closeSheet();
      Alert.alert('Agente conversacional', getAgentActionSuccess(action, getContactName(target)));
    } catch (err) {
      Alert.alert('Agente conversacional', err instanceof Error ? err.message : 'No se pudo actualizar el agente.');
    } finally {
      setAgentBusyAction(null);
    }
  };

  const openContactInfo = async () => {
    setContactInfoOpen(true);
    setContactInfo((current) => current?.id === contact.id ? current : contact);
    setContactInfoError('');
    setContactInfoLoading(true);
    try {
      const details = await api.getContact(contact.id);
      setContactInfo({ ...contact, ...details });
      onContactPatch(contact.id, details);
    } catch (err) {
      setContactInfoError(err instanceof Error ? err.message : 'No se pudo cargar todo el detalle. Te muestro lo que ya está guardado.');
    } finally {
      setContactInfoLoading(false);
    }
  };

  const saveContactInfoPatch = async (patch: Partial<ChatContact>) => {
    if (contactInfoSaving) return;
    const target = contactInfo || contact;
    setContactInfoSaving(true);
    try {
      const updated = await api.updateContact(target.id, patch);
      const next = { ...target, ...updated };
      setContactInfo(next);
      onContactPatch(target.id, updated);
    } catch (err) {
      Alert.alert('Contacto', err instanceof Error ? err.message : 'No se pudo guardar el contacto.');
    } finally {
      setContactInfoSaving(false);
    }
  };

  const navigateToContactTool = (target: ChatContact, section: PhoneSection) => {
    closeSheet();
    onNavigate?.(section);
  };

  const markChatAsRead = (target: ChatContact) => {
    onContactPatch(target.id, { unreadCount: 0 });
    closeSheet();
    void api.markChatRead(target.id).catch((err) => {
      Alert.alert('Chat', err instanceof Error ? err.message : 'No se pudo marcar como leído.');
    });
  };

  const toggleArchiveFromSheet = (target: ChatContact) => {
    onArchiveToggle(target);
    closeSheet();
    Alert.alert(archived ? 'Chat restaurado' : 'Chat archivado', getContactName(target));
  };

  const toggleMuteFromSheet = (target: ChatContact) => {
    onToggleMute(target);
    closeSheet();
  };

  if (contactInfoOpen) {
    return (
      <NativeContactDetailScreen
        contact={contactInfo || contact}
        accountCurrency={accountCurrency}
        journeyMessages={messages}
        loading={contactInfoLoading}
        saving={contactInfoSaving}
        error={contactInfoError}
        timezone={timezone}
        onAppointment={() => {
          setContactInfoOpen(false);
          setTimeout(openAppointmentSheet, 0);
        }}
        onBack={() => setContactInfoOpen(false)}
        onPayment={() => {
          setContactInfoOpen(false);
          setTimeout(openPaymentSheet, 0);
        }}
        onSave={saveContactInfoPatch}
      />
    );
  }

  return (
    <AppFrame>
      <View style={styles.conversationHeader}>
        <Pressable onPress={onBack} style={styles.backButton}>
          <ChevronLeft size={30} color={COLORS.text} strokeWidth={2.5} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Ver información del contacto" onPress={openContactInfo} style={({ pressed }) => [styles.conversationContactButton, pressed && styles.pressed]}>
          <View style={[styles.conversationAvatar, { borderColor: channelColor }]}>
            <View style={styles.conversationAvatarCircle}>
              {getContactAvatar(contact) ? (
                <Image source={{ uri: getContactAvatar(contact) }} style={styles.conversationAvatarImage} />
              ) : (
                <Text style={styles.avatarText}>{getContactName(contact).slice(0, 1).toUpperCase()}</Text>
              )}
            </View>
            {channelKind !== 'unknown' ? (
              <View style={[styles.conversationAvatarBadge, { backgroundColor: channelColor }]}>
                <ChannelBadgeIcon kind={channelKind} size={13} />
              </View>
            ) : null}
          </View>
          <View style={styles.conversationTitleWrap}>
            <Text numberOfLines={1} style={styles.conversationTitle}>{getContactName(contact)}</Text>
            <Text numberOfLines={1} style={styles.conversationSubtitle}>{getContactDetail(contact)}</Text>
          </View>
        </Pressable>
        <View style={styles.conversationCallActions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Agendar cita" onPress={openAppointmentSheet} style={({ pressed }) => [styles.conversationCallButton, pressed && styles.pressed]}>
            <CalendarDays size={23} color={COLORS.text} strokeWidth={2.35} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Cobrar" onPress={openPaymentSheet} style={({ pressed }) => [styles.conversationCallButton, pressed && styles.pressed]}>
            <CircleDollarSign size={23} color={COLORS.text} strokeWidth={2.35} />
          </Pressable>
        </View>
      </View>

      {searchOpen ? (
        <View style={styles.conversationSearchBar}>
          <Search size={18} color={COLORS.muted} strokeWidth={2.4} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Buscar en este chat"
            placeholderTextColor={COLORS.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.conversationSearchInput}
          />
          {searchQuery ? <Text style={styles.conversationSearchCount}>{filteredMessages.length}</Text> : null}
          <Pressable accessibilityRole="button" onPress={() => {
            setSearchQuery('');
            setSearchOpen(false);
          }} style={styles.clearSearchButton}>
            <X size={17} color={COLORS.muted} strokeWidth={2.45} />
          </Pressable>
        </View>
      ) : null}

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0} style={[styles.conversationBody, keyboardVisible && styles.conversationBodyKeyboardActive]}>
        {loading ? (
          <View style={styles.centerState}>
            <ActivityIndicator color={COLORS.accent} />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={conversationItems}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.messageList}
            keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl tintColor={COLORS.accent} refreshing={refreshing} onRefresh={() => void loadConversation(true)} />}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            ListEmptyComponent={(
              <View style={styles.emptyConversation}>
                <MessageCircle size={30} color={COLORS.accent} strokeWidth={2.4} />
                <Text style={styles.emptyConversationTitle}>{searchQuery ? 'Sin resultados' : 'Aún no hay mensajes'}</Text>
                <Text style={styles.emptyConversationCopy}>{searchQuery ? 'Cambia la búsqueda para ver otros mensajes.' : 'Escribe el primer mensaje o usa + para tomar acciones.'}</Text>
              </View>
            )}
            renderItem={({ item }) => (
              item.type === 'day'
                ? (
                  <View style={styles.messageDaySeparator}>
                    <Text style={styles.messageDayLabel}>{item.label}</Text>
                  </View>
                )
                : (
                  <NativeMessageBubble
                    contact={contact}
                    message={item.message}
                    replyTarget={item.message.replyToMessageId ? messages.find((message) => message.id === item.message.replyToMessageId) : null}
                    searchActive={Boolean(searchQuery)}
                    starred={starredMessageIds.includes(item.message.id)}
                    timezone={timezone}
                    onLongPress={() => openMessageActions(item.message)}
                  />
                )
            )}
          />
        )}

        {replyingToMessage ? (
          <View style={styles.replyPreviewBar}>
            <View style={styles.replyPreviewMarker} />
            <View style={styles.replyPreviewCopy}>
              <Text numberOfLines={1} style={styles.replyPreviewTitle}>Respondiendo a {replyingToMessage.direction === 'outbound' ? 'ti' : getContactName(contact)}</Text>
              <Text numberOfLines={1} style={styles.replyPreviewText}>{getMessagePreviewText(replyingToMessage)}</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={() => setReplyingToMessage(null)} style={styles.replyPreviewClose}>
              <X size={16} color={COLORS.muted} strokeWidth={2.45} />
            </Pressable>
          </View>
        ) : null}

        {draftAttachments.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.draftAttachmentStrip}>
            {draftAttachments.map((attachment) => (
              <View key={attachment.id} style={styles.draftAttachment}>
                <NativeDraftAttachmentPreview attachment={attachment} />
                <Pressable accessibilityRole="button" onPress={() => removeDraftAttachment(attachment.id)} style={styles.draftAttachmentRemove}>
                  <X size={14} color={COLORS.white} strokeWidth={2.6} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}

        {audioRecorderState.isRecording ? (
          <View style={styles.voiceRecordingBar}>
            <View style={styles.voiceRecordingIcon}>
              <Mic size={16} color={COLORS.white} strokeWidth={2.55} />
            </View>
            <Text style={styles.voiceRecordingText}>Grabando nota de voz · {formatDurationMs(audioRecorderState.durationMillis)}</Text>
            <Pressable accessibilityRole="button" onPress={() => void finishVoiceRecording()} style={styles.voiceRecordingDone}>
              <Check size={17} color={COLORS.white} strokeWidth={2.7} />
            </Pressable>
          </View>
        ) : null}

        <View style={[styles.composer, keyboardVisible && styles.composerKeyboardActive, hasComposerContent && styles.composerHasContent]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Canal de envío: ${selectedChannelOption?.label || 'WhatsApp'}`}
            onPress={() => openSheet('channel')}
            style={({ pressed }) => [
              styles.composerChannelButton,
              { borderColor: selectedChannelColor },
              pressed && styles.pressed,
            ]}
          >
            <ChannelBadgeIcon kind={selectedChannelKind} size={17} />
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => openSheet('attachments')} style={styles.composerPlus}>
            <Plus size={22} color={COLORS.accent} strokeWidth={2.55} />
          </Pressable>
          <View style={[styles.messageInputWrap, draft.trim() && styles.messageInputWrapWithSchedule]}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              editable={selectedChannelCanSend}
              placeholder={composerPlaceholder}
              placeholderTextColor={COLORS.muted}
              keyboardAppearance="dark"
              textAlignVertical="center"
              style={[styles.composerInput, !selectedChannelCanSend && styles.composerInputDisabled]}
            />
            {draft.trim() && !draftAttachments.length ? (
              <Pressable accessibilityRole="button" onPress={() => {
                setScheduleText(draft);
                openSheet('schedule');
              }} style={styles.composerScheduleButton}>
                <Clock size={17} color={COLORS.accent} strokeWidth={2.45} />
              </Pressable>
            ) : null}
          </View>
          <View style={[styles.composerTrailingActions, hasComposerContent && styles.composerTrailingActionsCompact]}>
            {!hasComposerContent ? (
              <Pressable accessibilityRole="button" onPress={() => void pickMedia('camera')} style={styles.composerIconButton}>
                <Camera size={20} color={COLORS.accent} strokeWidth={2.55} />
              </Pressable>
            ) : null}
            <Pressable
              disabled={sending || !selectedChannelCanSend}
              onPress={() => {
                if (hasComposerContent) {
                  void send();
                  return;
                }
                if (audioRecorderState.isRecording) {
                  void finishVoiceRecording();
                  return;
                }
                void startVoiceRecording();
              }}
              style={[styles.composerSendButton, (sending || !selectedChannelCanSend) && styles.disabledButton, audioRecorderState.isRecording && styles.composerRecordingButton]}
            >
              {sending ? <ActivityIndicator color={COLORS.white} /> : hasComposerContent ? <Send size={17} color={COLORS.white} strokeWidth={2.65} /> : <Mic size={19} color={COLORS.white} strokeWidth={2.5} />}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      <NativeConversationAttachmentSheet
        closing={activeSheet !== 'attachments' && closingSheet === 'attachments'}
        contact={contact}
        open={activeSheet === 'attachments' || closingSheet === 'attachments'}
        onAppointment={openAppointmentSheet}
        onCamera={() => void pickMedia('camera')}
        onClose={closeSheet}
        onClabe={openClabeSheet}
        onDocument={() => void pickDocument()}
        onLibrary={() => void pickMedia('library')}
        onMore={openChatMore}
        onPayment={openPaymentSheet}
        onSchedule={() => {
          setScheduleText(draft);
          openSheet('schedule');
        }}
        onSearch={() => {
          closeSheet();
          setSearchOpen(true);
        }}
        onTag={openTagSheet}
        onTemplates={openTemplatesSheet}
      />

      <NativeComposerChannelSheet
        channels={composerChannelOptions}
        closing={activeSheet !== 'channel' && closingSheet === 'channel'}
        contact={contact}
        open={activeSheet === 'channel' || closingSheet === 'channel'}
        selected={selectedSendChannel}
        onClose={closeSheet}
        onSelect={(channel) => {
          const option = composerChannelOptions.find((item) => item.value === channel);
          if (option?.disabledReason) {
            Alert.alert('Canal no disponible', option.disabledReason);
            return;
          }
          setSelectedSendChannel(channel);
          closeSheet();
        }}
      />

      <NativeMessageActionSheet
        closing={activeSheet !== 'messageActions' && closingSheet === 'messageActions'}
        message={selectedMessage}
        open={activeSheet === 'messageActions' || closingSheet === 'messageActions'}
        starred={selectedMessage ? starredMessageIds.includes(selectedMessage.id) : false}
        timezone={timezone}
        onClose={closeSheet}
        onCancelScheduled={cancelScheduledMessage}
        onCopy={(message) => void copyMessage(message)}
        onForward={forwardMessage}
        onInfo={(message) => {
          Alert.alert('Mensaje', [
            `Canal: ${getMessageChannelLabel(message.channel || message.transport)}`,
            `Estado: ${message.status || 'sin estado'}`,
            `Hora: ${formatMessageTime(message.date, timezone)}`,
            message.errorReason ? `Error: ${message.errorReason}` : '',
          ].filter(Boolean).join('\n'));
        }}
        onReact={reactToMessage}
        onReply={(message) => {
          setReplyingToMessage(message);
          closeSheet();
        }}
        onRetry={retryMessage}
        onStar={toggleStarMessage}
      />

      <ChatMoreSheet
        archived={archived}
        agentBusyAction={agentBusyAction}
        agentLoading={agentLoading}
        agentState={selectPrimaryAgentState(agentStates)}
        closing={activeSheet !== 'chatMore' && closingSheet === 'chatMore'}
        contact={contact}
        muted={muted}
        open={activeSheet === 'chatMore' || closingSheet === 'chatMore'}
        unread={getUnreadCount(contact)}
        onAgentAction={runAgentAction}
        onAppointment={() => openAppointmentSheet()}
        onArchiveToggle={toggleArchiveFromSheet}
        onClose={closeSheet}
        onMarkRead={markChatAsRead}
        onPayment={() => openPaymentSheet()}
        onSchedule={() => {
          setScheduleText('');
          openSheet('schedule');
        }}
        onSelect={() => {
          closeSheet();
          Alert.alert('Seleccionar', 'La selección múltiple se maneja desde la lista de chats.');
        }}
        onTag={openTagSheet}
        onToggleMute={toggleMuteFromSheet}
      />

      <ContactTagSheet
        busy={tagBusy}
        closing={activeSheet !== 'tag' && closingSheet === 'tag'}
        contact={contact}
        loading={chatTagsLoading}
        open={activeSheet === 'tag' || closingSheet === 'tag'}
        query={tagQuery}
        tags={chatTags}
        onApply={applyTagToContact}
        onChangeQuery={setTagQuery}
        onClose={closeSheet}
        onCreate={createAndApplyTag}
      />

      <ScheduleMessageSheet
        busy={scheduleBusy}
        closing={activeSheet !== 'schedule' && closingSheet === 'schedule'}
        contact={contact}
        open={activeSheet === 'schedule' || closingSheet === 'schedule'}
        text={scheduleText}
        onChangeText={setScheduleText}
        onClose={closeSheet}
        onSubmit={scheduleMessageForContact}
      />

      <NativeTemplatesSheet
        busyId={templateBusyId}
        closing={activeSheet !== 'templates' && closingSheet === 'templates'}
        contact={contact}
        loading={templatesLoading}
        open={activeSheet === 'templates' || closingSheet === 'templates'}
        templates={templates}
        onClose={closeSheet}
        onSend={sendTemplateToContact}
      />

      <NativeClabeSheet
        accounts={bankClabes}
        busyId={clabeBusyId}
        closing={activeSheet !== 'clabe' && closingSheet === 'clabe'}
        contact={contact}
        draft={clabeDraft}
        formOpen={clabeFormOpen}
        loading={clabesLoading}
        open={activeSheet === 'clabe' || closingSheet === 'clabe'}
        onChangeDraft={setClabeDraft}
        onClose={closeSheet}
        onSave={saveClabe}
        onSend={sendClabe}
        onToggleForm={() => setClabeFormOpen((current) => !current)}
      />

      <PaymentEntrySheet
        accountCurrency={accountCurrency}
        busy={paymentBusy}
        closing={activeSheet !== 'payment' && closingSheet === 'payment'}
        contact={contact}
        draft={paymentDraft}
        open={activeSheet === 'payment' || closingSheet === 'payment'}
        onChangeDraft={setPaymentDraft}
        onClose={closeSheet}
        onSubmit={createPaymentForContact}
      />

      <AppointmentEntrySheet
        busy={appointmentBusy}
        closing={activeSheet !== 'appointment' && closingSheet === 'appointment'}
        contact={contact}
        draft={appointmentDraft}
        open={activeSheet === 'appointment' || closingSheet === 'appointment'}
        timezone={timezone}
        onChangeDraft={setAppointmentDraft}
        onClose={closeSheet}
        onSubmit={createAppointmentForContact}
      />
    </AppFrame>
  );
}

function NativeComposerChannelSheet({
  channels,
  closing,
  contact,
  open,
  selected,
  onClose,
  onSelect,
}: {
  channels: ComposerChannelOption[];
  closing?: boolean;
  contact: ChatContact;
  open: boolean;
  selected: NativeMessageChannel;
  onClose: () => void;
  onSelect: (channel: NativeMessageChannel) => void;
}) {
  return (
    <BottomActionSheet
      closing={closing}
      open={open}
      title="Canal de envío"
      subtitle={getContactName(contact)}
      onClose={onClose}
    >
      <View style={styles.channelSheetBody}>
        {channels.map((channel) => {
          const active = selected === channel.value;
          const disabled = Boolean(channel.disabledReason);
          return (
            <Pressable
              key={channel.value}
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => onSelect(channel.value)}
              style={({ pressed }) => [
                styles.channelOptionRow,
                active && styles.channelOptionRowActive,
                disabled && styles.disabledButton,
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.channelOptionIcon, { backgroundColor: CHANNEL_BADGE_COLORS[channel.kind] || COLORS.panelSoft }]}>
                <ChannelBadgeIcon kind={channel.kind} size={18} />
              </View>
              <View style={styles.channelOptionCopy}>
                <Text style={styles.channelOptionTitle}>{channel.label}</Text>
                <Text numberOfLines={2} style={styles.channelOptionSubtitle}>{channel.disabledReason || channel.description}</Text>
              </View>
              {active ? <Check size={18} color={COLORS.accent} strokeWidth={2.6} /> : null}
            </Pressable>
          );
        })}
      </View>
    </BottomActionSheet>
  );
}

function NativeConversationAttachmentSheet({
  closing,
  contact,
  open,
  onAppointment,
  onCamera,
  onClabe,
  onClose,
  onDocument,
  onLibrary,
  onMore,
  onPayment,
  onSchedule,
  onSearch,
  onTag,
  onTemplates,
}: {
  closing?: boolean;
  contact: ChatContact;
  open: boolean;
  onAppointment: () => void;
  onCamera: () => void;
  onClabe: () => void;
  onClose: () => void;
  onDocument: () => void;
  onLibrary: () => void;
  onMore: () => void;
  onPayment: () => void;
  onSchedule: () => void;
  onSearch: () => void;
  onTag: () => void;
  onTemplates: () => void;
}) {
  return (
    <BottomActionSheet
      closing={closing}
      open={open}
      title="Acciones"
      subtitle={getContactName(contact)}
      onClose={onClose}
    >
      <ScrollView contentContainerStyle={styles.sheetActionList} showsVerticalScrollIndicator={false}>
        <SheetActionRow Icon={Camera} title="Cámara" subtitle="Toma foto o graba video para enviarlo por WhatsApp." onPress={onCamera} />
        <SheetActionRow Icon={ImageIcon} title="Fotos y videos" subtitle="Adjunta media desde tu galería." onPress={onLibrary} />
        <SheetActionRow Icon={FilePlus} title="Documento" subtitle="Adjunta PDF, Word, Excel o archivo compatible." onPress={onDocument} />
        <SheetActionRow Icon={Search} title="Buscar en este chat" subtitle="Encuentra mensajes dentro de la conversación." onPress={onSearch} />
        <View style={styles.sheetSectionDivider}>
          <Text style={styles.sheetSectionLabel}>Herramientas</Text>
        </View>
        <SheetActionRow Icon={MessageCircle} title="Plantillas" subtitle="Enviar una plantilla aprobada o insertar una respuesta guardada." onPress={onTemplates} />
        <SheetActionRow Icon={Banknote} title="Enviar CLABE" subtitle="Comparte una cuenta bancaria guardada." onPress={onClabe} />
        <SheetActionRow Icon={CalendarDays} title="Agendar cita" subtitle="Crear una cita para este contacto." onPress={onAppointment} />
        <SheetActionRow Icon={CircleDollarSign} title="Registrar pagos" subtitle="Elegir pago único, plan o suscripción." onPress={onPayment} />
        <SheetActionRow Icon={Clock} title="Programar mensaje" subtitle="Prepara un envío en una hora." onPress={onSchedule} />
        <SheetActionRow Icon={Tag} title="Agregar etiqueta" subtitle="Clasificar este chat con una etiqueta." onPress={onTag} />
        <SheetActionRow Icon={MoreHorizontal} title="Más acciones" subtitle="Silenciar, archivar o controlar agente." onPress={onMore} />
      </ScrollView>
    </BottomActionSheet>
  );
}

function NativeMessageActionSheet({
  closing,
  message,
  open,
  starred,
  timezone,
  onCancelScheduled,
  onClose,
  onCopy,
  onForward,
  onInfo,
  onReact,
  onReply,
  onRetry,
  onStar,
}: {
  closing?: boolean;
  message: ChatMessage | null;
  open: boolean;
  starred?: boolean;
  timezone: string;
  onCancelScheduled: (message: ChatMessage) => void;
  onClose: () => void;
  onCopy: (message: ChatMessage) => void;
  onForward: (message: ChatMessage) => void;
  onInfo: (message: ChatMessage) => void;
  onReact: (message: ChatMessage, emoji: string) => void;
  onReply: (message: ChatMessage) => void;
  onRetry: (message: ChatMessage) => void;
  onStar: (message: ChatMessage) => void;
}) {
  return (
    <BottomActionSheet
      closing={closing}
      open={open && Boolean(message)}
      title="Acciones del mensaje"
      subtitle={message ? formatMessageTime(message.date, timezone) : ''}
      onClose={onClose}
    >
      {message ? (
        <View style={styles.messageActionSheetBody}>
          <View style={styles.messageActionPreview}>
            <Text numberOfLines={2} style={styles.messageActionPreviewText}>{getMessagePreviewText(message)}</Text>
          </View>
          <View style={styles.reactionRow}>
            {MESSAGE_REACTION_EMOJIS.map((emoji) => (
              <Pressable key={emoji} accessibilityRole="button" onPress={() => onReact(message, emoji)} style={styles.reactionButton}>
                <Text style={styles.reactionEmoji}>{emoji}</Text>
              </Pressable>
            ))}
          </View>
          <SheetActionRow Icon={Reply} title="Responder" subtitle="Cita este mensaje en tu siguiente respuesta." onPress={() => onReply(message)} />
          <SheetActionRow Icon={Copy} title="Copiar" subtitle="Copia texto, caption o resumen del mensaje." onPress={() => onCopy(message)} />
          <SheetActionRow Icon={Star} title={starred ? 'Quitar destacado' : 'Destacar'} subtitle={starred ? 'Quita este mensaje de destacados locales.' : 'Marca este mensaje como importante en esta sesión.'} onPress={() => onStar(message)} />
          <SheetActionRow Icon={Forward} title="Reenviar" subtitle="Pasa el contenido al compositor para enviarlo." onPress={() => onForward(message)} />
          {message.failed ? (
            <SheetActionRow Icon={RefreshCw} title="Reintentar" subtitle="Devuelve el mensaje al compositor para mandarlo de nuevo." onPress={() => onRetry(message)} />
          ) : null}
          {isScheduledMessage(message) ? (
            <SheetActionRow Icon={X} title="Cancelar programado" subtitle="Cancela este mensaje antes de que se envíe." danger onPress={() => onCancelScheduled(message)} />
          ) : null}
          <SheetActionRow Icon={Smile} title="Reaccionar" subtitle="Usa los emojis rápidos de arriba." onPress={() => undefined} disabled />
          <SheetActionRow Icon={Info} title="Información" subtitle="Ver canal, estado y hora del mensaje." onPress={() => onInfo(message)} />
        </View>
      ) : null}
    </BottomActionSheet>
  );
}

function NativeMessageBubble({
  contact,
  message,
  replyTarget,
  searchActive,
  starred,
  timezone,
  onLongPress,
}: {
  contact: ChatContact;
  message: ChatMessage;
  replyTarget?: ChatMessage | null;
  searchActive?: boolean;
  starred?: boolean;
  timezone: string;
  onLongPress?: () => void;
}) {
  const outbound = message.direction === 'outbound';
  const system = message.direction === 'system';
  const attachment = message.attachment;
  const status = getMessageReceiptStatus(message);

  if (system) {
    return (
      <View style={styles.systemMessageRow}>
        <View style={styles.systemMessageBubble}>
          <Text style={styles.systemMessageText}>{message.text}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.messageRow, outbound ? styles.messageRowOutbound : styles.messageRowInbound]}>
      <Pressable
        delayLongPress={260}
        onLongPress={onLongPress}
        style={({ pressed }) => [
          styles.messageBubble,
          outbound ? styles.outboundBubble : styles.inboundBubble,
          attachment?.type === 'image' && styles.imageMessageBubble,
          message.failed && styles.failedBubble,
          searchActive && styles.messageSearchMatch,
          pressed && styles.pressed,
        ]}
      >
        {replyTarget ? (
          <View style={styles.quotedMessage}>
            <View style={styles.quotedMessageMarker} />
            <View style={styles.quotedMessageCopy}>
              <Text numberOfLines={1} style={styles.quotedMessageTitle}>{replyTarget.direction === 'outbound' ? 'Tú' : getContactName(contact)}</Text>
              <Text numberOfLines={1} style={styles.quotedMessageText}>{getMessagePreviewText(replyTarget)}</Text>
            </View>
          </View>
        ) : null}
        {attachment ? <NativeMessageAttachment attachment={attachment} /> : null}
        {message.location ? <NativeMessageLocation location={message.location} /> : null}
        {message.isComment ? (
          <View style={styles.commentContext}>
            <MessageCircle size={12} color={COLORS.accent} strokeWidth={2.5} />
            <Text style={styles.commentContextText}>
              {message.commentReplyMode === 'public' ? 'Respuesta pública al comentario' : message.commentReplyMode === 'private' ? 'Respuesta por privado' : 'Comentario'}
            </Text>
          </View>
        ) : null}
        {message.text ? <Text style={styles.messageText}>{message.text}</Text> : null}
        {starred ? (
          <View style={styles.messageStarredFlag}>
            <Star size={11} color={COLORS.meta} fill={COLORS.meta} strokeWidth={2.2} />
            <Text style={styles.messageStarredText}>Destacado</Text>
          </View>
        ) : null}
        {message.routingReason ? <Text numberOfLines={2} style={styles.messageRoutingNote}>{message.routingReason}</Text> : null}
        <View style={styles.messageMetaRow}>
          <Text style={styles.messageMeta}>
            {formatMessageTime(message.date, timezone)}
            {message.pending ? ' · enviando' : ''}
            {message.failed ? ' · error' : ''}
          </Text>
          {outbound ? <NativeMessageReceipt status={status} failed={Boolean(message.failed)} pending={Boolean(message.pending)} /> : null}
        </View>
        {message.reactions?.length ? (
          <View style={styles.messageReactions}>
            {message.reactions.slice(-3).map((reaction) => (
              <Text key={reaction.id} style={styles.messageReaction}>{reaction.emoji}</Text>
            ))}
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

function NativeMessageAttachment({ attachment }: { attachment: ChatAttachment }) {
  const imageUri = attachment.dataUrl || attachment.url;
  if (attachment.type === 'image' && imageUri) {
    return (
      <Pressable accessibilityRole="imagebutton" onPress={() => void Linking.openURL(imageUri).catch(() => undefined)}>
        <Image source={{ uri: imageUri }} style={styles.messageImage} />
      </Pressable>
    );
  }

  if (attachment.type === 'audio' && imageUri) {
    return <NativeAudioAttachment attachment={attachment} uri={imageUri} />;
  }

  const isVideo = attachment.type === 'video';
  const uri = imageUri;
  const Icon = isVideo ? Video : FileText;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!uri}
      onPress={() => uri ? Linking.openURL(uri).catch(() => undefined) : undefined}
      style={({ pressed }) => [styles.messageFileCard, pressed && styles.pressed]}
    >
      <View style={styles.messageFileIcon}>
        <Icon size={18} color={COLORS.accent} strokeWidth={2.5} />
      </View>
      <View style={styles.messageFileCopy}>
        <Text numberOfLines={1} style={styles.messageFileTitle}>{attachment.name || getAttachmentLabel(attachment.type)}</Text>
        <Text numberOfLines={1} style={styles.messageFileSubtitle}>{[
          attachment.mimeType || getAttachmentLabel(attachment.type),
          attachment.durationMs ? formatDurationMs(attachment.durationMs) : '',
        ].filter(Boolean).join(' · ')}</Text>
      </View>
      {isVideo ? <Play size={18} color={COLORS.text} strokeWidth={2.5} /> : null}
    </Pressable>
  );
}

function NativeAudioAttachment({ attachment, uri }: { attachment: ChatAttachment; uri: string }) {
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);
  const playing = Boolean(status.playing);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        if (playing) {
          player.pause();
          return;
        }
        if (status.currentTime && status.duration && status.currentTime >= status.duration - 0.2) {
          player.seekTo(0);
        }
        player.play();
      }}
      style={({ pressed }) => [styles.messageFileCard, pressed && styles.pressed]}
    >
      <View style={styles.messageFileIcon}>
        {playing ? <Pause size={18} color={COLORS.accent} strokeWidth={2.5} /> : <Mic size={18} color={COLORS.accent} strokeWidth={2.5} />}
      </View>
      <View style={styles.messageFileCopy}>
        <Text numberOfLines={1} style={styles.messageFileTitle}>{attachment.name || 'Nota de voz'}</Text>
        <Text numberOfLines={1} style={styles.messageFileSubtitle}>{formatDurationMs(attachment.durationMs || Number(status.duration || 0) * 1000)}</Text>
      </View>
      <Text style={styles.messageAudioState}>{playing ? 'Pausar' : 'Reproducir'}</Text>
    </Pressable>
  );
}

function NativeDraftAttachmentPreview({ attachment }: { attachment: ConversationDraftAttachment }) {
  if (attachment.kind === 'image') {
    return <Image source={{ uri: attachment.uri }} style={styles.draftAttachmentImage} />;
  }
  const Icon = attachment.kind === 'video' ? Video : attachment.kind === 'audio' ? Mic : FileText;
  return (
    <View style={styles.draftAttachmentFile}>
      <Icon size={21} color={COLORS.accent} strokeWidth={2.55} />
      <Text numberOfLines={2} style={styles.draftAttachmentFileText}>{attachment.kind === 'audio' ? formatDurationMs(attachment.durationMs) : attachment.name}</Text>
    </View>
  );
}

function NativeMessageLocation({ location }: { location: NonNullable<ChatMessage['location']> }) {
  return (
    <View style={styles.messageLocationCard}>
      <View style={styles.messageLocationIcon}>
        <MapPin size={20} color={COLORS.white} fill={COLORS.accent} strokeWidth={2.4} />
      </View>
      <View style={styles.messageLocationCopy}>
        <Text numberOfLines={1} style={styles.messageLocationTitle}>{location.name || 'Ubicación'}</Text>
        <Text numberOfLines={1} style={styles.messageLocationSubtitle}>{location.address || `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`}</Text>
      </View>
    </View>
  );
}

function NativeMessageReceipt({ status, failed, pending }: { status: 'sent' | 'delivered' | 'read' | 'pending' | 'failed'; failed?: boolean; pending?: boolean }) {
  if (failed) return <X size={13} color={COLORS.danger} strokeWidth={2.7} />;
  if (pending || status === 'pending') return <ActivityIndicator color={COLORS.meta} size="small" />;
  if (status === 'delivered' || status === 'read') {
    return <CheckCheck size={14} color={status === 'read' ? COLORS.accent : COLORS.meta} strokeWidth={2.45} />;
  }
  return <Check size={14} color={COLORS.meta} strokeWidth={2.45} />;
}

function getContactDetail(contact: ChatContact) {
  return contact.phone || contact.email || contact.source || 'Sin teléfono';
}

function getAttachmentLabel(type?: string) {
  if (type === 'image') return 'Foto';
  if (type === 'video') return 'Video';
  if (type === 'audio') return 'Audio';
  if (type === 'document' || type === 'file') return 'Documento';
  return 'Adjunto';
}

function getMessagePreviewText(message: ChatMessage) {
  if (message.text) return message.text;
  if (message.attachment) return getAttachmentLabel(message.attachment.type);
  if (message.location) return 'Ubicación';
  return 'Mensaje';
}

function getMessageChannelLabel(value?: string) {
  const normalized = String(value || '').toLowerCase();
  if (normalized.includes('instagram')) return 'Instagram';
  if (normalized.includes('messenger') || normalized.includes('facebook')) return 'Messenger';
  if (normalized.includes('email')) return 'Correo';
  if (normalized.includes('sms')) return 'SMS';
  if (normalized.includes('qr')) return 'WhatsApp QR';
  if (normalized.includes('api') || normalized.includes('whatsapp')) return 'WhatsApp';
  return value || 'Ristak';
}

function getMessageReceiptStatus(message: ChatMessage): 'sent' | 'delivered' | 'read' | 'pending' | 'failed' {
  if (message.failed || String(message.status || '').toLowerCase() === 'error') return 'failed';
  if (message.pending || ['pending', 'queued', 'enviando', 'sending'].includes(String(message.status || '').toLowerCase())) return 'pending';
  if (message.readAt || String(message.status || '').toLowerCase() === 'read') return 'read';
  if (message.deliveredAt || String(message.status || '').toLowerCase() === 'delivered') return 'delivered';
  return 'sent';
}

function normalizeDraftAttachmentKind(type?: string): ConversationDraftAttachment['kind'] {
  const normalized = normalizeProbe(type);
  if (normalized.includes('video')) return 'video';
  if (normalized.includes('audio') || normalized.includes('voice')) return 'audio';
  if (normalized.includes('document') || normalized.includes('file') || normalized.includes('pdf')) return 'document';
  return 'image';
}

function getFilenameFromUri(uri: string, fallback: string) {
  try {
    const clean = decodeURIComponent(uri.split('?')[0] || uri);
    return clean.split('/').filter(Boolean).pop() || fallback;
  } catch {
    return fallback;
  }
}

function buildDataUrl(base64: string, mimeType: string) {
  if (base64.startsWith('data:')) return base64;
  return `data:${mimeType || 'application/octet-stream'};base64,${base64}`;
}

async function readFileAsDataUrl(uri: string, mimeType: string) {
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  return buildDataUrl(base64, mimeType);
}

function assertAttachmentSize(size: number | undefined, maxBytes: number, label: string) {
  if (!size || size <= maxBytes) return;
  const sizeMb = (size / 1024 / 1024).toFixed(1);
  const maxMb = Math.round(maxBytes / 1024 / 1024);
  throw new Error(`${label} pesa ${sizeMb} MB. El máximo permitido aquí es ${maxMb} MB.`);
}

async function preparePickedMediaAttachment(asset: ImagePicker.ImagePickerAsset, index: number): Promise<ConversationDraftAttachment> {
  const kind: ConversationDraftAttachment['kind'] = asset.type === 'video' ? 'video' : 'image';
  const mimeType = asset.mimeType || (kind === 'video' ? 'video/mp4' : 'image/jpeg');
  const size = asset.fileSize;
  assertAttachmentSize(size, kind === 'video' ? VIDEO_ATTACHMENT_MAX_BYTES : MEDIA_ATTACHMENT_MAX_BYTES, kind === 'video' ? 'El video' : 'La imagen');
  const name = asset.fileName || getFilenameFromUri(asset.uri, `${kind}-${Date.now()}-${index}.${kind === 'video' ? 'mp4' : 'jpg'}`);
  const dataUrl = asset.base64 ? buildDataUrl(asset.base64, mimeType) : await readFileAsDataUrl(asset.uri, mimeType);
  return {
    id: `${kind}-${Date.now()}-${index}`,
    uri: asset.uri,
    dataUrl,
    kind,
    name,
    mimeType,
    size,
    durationMs: typeof asset.duration === 'number' ? asset.duration : undefined,
  };
}

async function preparePickedDocumentAttachment(asset: DocumentPicker.DocumentPickerAsset, index: number): Promise<ConversationDraftAttachment> {
  const mimeType = asset.mimeType || 'application/octet-stream';
  assertAttachmentSize(asset.size, DOCUMENT_ATTACHMENT_MAX_BYTES, 'El documento');
  return {
    id: `document-${Date.now()}-${index}`,
    uri: asset.uri,
    dataUrl: await readFileAsDataUrl(asset.uri, mimeType),
    kind: 'document',
    name: asset.name || getFilenameFromUri(asset.uri, `documento-${index + 1}`),
    mimeType,
    size: asset.size,
  };
}

async function prepareVoiceAttachment(uri: string, durationMs?: number): Promise<ConversationDraftAttachment> {
  const info = await FileSystem.getInfoAsync(uri);
  const size = info.exists && 'size' in info ? info.size : undefined;
  assertAttachmentSize(size, MEDIA_ATTACHMENT_MAX_BYTES, 'El audio');
  const mimeType = Platform.OS === 'ios' ? 'audio/m4a' : 'audio/mp4';
  return {
    id: `audio-${Date.now()}`,
    uri,
    dataUrl: await readFileAsDataUrl(uri, mimeType),
    kind: 'audio',
    name: getFilenameFromUri(uri, 'nota-de-voz.m4a'),
    mimeType,
    size,
    durationMs,
  };
}

function sendDraftAttachment(
  api: RistakApiClient,
  contact: ChatContact,
  attachment: ConversationDraftAttachment,
  caption: string,
) {
  if (attachment.kind === 'video') return api.sendVideo(contact, attachment.dataUrl, caption);
  if (attachment.kind === 'audio') return api.sendAudio(contact, attachment.dataUrl, attachment.durationMs);
  if (attachment.kind === 'document') return api.sendDocument(contact, attachment.dataUrl, attachment.name, attachment.mimeType, caption);
  return api.sendImage(contact, attachment.dataUrl, caption);
}

function buildScheduledMessages(contactId: string, scheduled: ScheduledChatMessage[]): ChatMessage[] {
  if (!Array.isArray(scheduled)) return [];
  return scheduled
    .filter((item) => item && item.scheduledAt && !['cancelled', 'canceled', 'sent', 'failed'].includes(String(item.status || '').toLowerCase()))
    .map((item, index) => {
      const scheduledId = item.id || item.externalId || `${item.scheduledAt}-${index}`;
      return {
        id: `scheduled-${scheduledId}`,
        scheduledMessageId: item.id || item.externalId || scheduledId,
        providerMessageId: item.externalId,
        contactId,
        date: item.scheduledAt || new Date().toISOString(),
        scheduledAt: item.scheduledAt,
        direction: 'outbound',
        text: item.text || '(mensaje programado)',
        channel: item.channel || item.transport || 'whatsapp_api',
        transport: item.transport || 'scheduled',
        status: 'scheduled',
      };
    });
}

function isScheduledMessage(message: ChatMessage) {
  return Boolean(message.scheduledAt || message.scheduledMessageId || String(message.status || '').toLowerCase() === 'scheduled');
}

function normalizeNativeTemplates(whatsappTemplates: WhatsAppTemplate[], localTemplates: MessageTemplate[]) {
  const whatsapp = (whatsappTemplates || []).map((template) => ({
    ...template,
    source: 'whatsapp' as const,
  }));
  const local = (localTemplates || [])
    .filter((template) => !template.status || ['active', 'enabled', 'published'].includes(String(template.status).toLowerCase()))
    .map((template) => ({
      id: '',
      name: template.name,
      description: template.description,
      bodyText: template.bodyText || template.body || template.footerText || '',
      localText: template.bodyText || template.body || template.footerText || '',
      source: 'local' as const,
    }))
    .filter((template) => template.name || template.localText);
  return [...whatsapp, ...local].slice(0, 60);
}

function getTemplateBody(template: WhatsAppTemplate) {
  return template.localText || template.bodyText || template.body || template.text || template.description || '';
}

function normalizeClabe(value: string) {
  return value.replace(/\D+/g, '').slice(0, 18);
}

function formatClabe(value: string) {
  return normalizeClabe(value).replace(/(\d{3})(?=\d)/g, '$1 ').trim();
}

function buildClabeMessage(account: BankClabeAccount) {
  return [
    account.alias || 'Cuenta bancaria',
    account.accountHolder ? `Titular: ${account.accountHolder}` : '',
    account.bank ? `Banco: ${account.bank}` : '',
    `CLABE: ${formatClabe(account.clabe)}`,
  ].filter(Boolean).join('\n');
}

function formatDurationMs(durationMs?: number) {
  const totalSeconds = Math.max(0, Math.round((durationMs || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function getTimezoneOffsetMs(date: Date, timezone: string) {
  const parts = getBusinessDateTimeParts(date, timezone);
  if (!parts) return 0;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function localDateTimePartsToUtcIso(dateText: string, timeText: string, timezone: string) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText.trim());
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeText.trim());
  if (!dateMatch || !timeMatch) return '';
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return '';
  let utcMs = Date.UTC(year, month - 1, day, hour, minute);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    utcMs = Date.UTC(year, month - 1, day, hour, minute) - getTimezoneOffsetMs(new Date(utcMs), timezone);
  }
  return new Date(utcMs).toISOString();
}

function createDefaultAppointmentDraft(timezone: string) {
  const nextHour = new Date(Date.now() + 60 * 60 * 1000);
  const parts = getBusinessDateTimeParts(nextHour, timezone);
  if (!parts) {
    return { title: '', date: '', time: '09:00', durationMinutes: '60', notes: '' };
  }
  return {
    title: '',
    date: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    time: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
    durationMinutes: '60',
    notes: '',
  };
}

function PrimaryButton({ label, busy, onPress }: { label: string; busy?: boolean; onPress: () => void }) {
  return (
    <Pressable disabled={busy} onPress={onPress} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy && styles.disabledButton]}>
      {busy ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.primaryButtonLabel}>{label}</Text>}
    </Pressable>
  );
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
      <Text style={styles.secondaryButtonLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  phoneDockWrap: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 10,
    zIndex: 10,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.26,
    shadowRadius: 26,
    elevation: 12,
  },
  phoneDock: {
    minHeight: 62,
    borderRadius: 31,
    borderWidth: 1,
    borderColor: 'rgba(199,226,255,0.19)',
    backgroundColor: 'rgba(10, 31, 92, 0.91)',
    flexDirection: 'row',
    paddingHorizontal: PHONE_DOCK_HORIZONTAL_PADDING,
    paddingVertical: 6,
    overflow: 'visible',
  },
  phoneDockSwiping: {
    shadowOpacity: 0.34,
  },
  phoneDockIndicator: {
    position: 'absolute',
    top: 6,
    bottom: 6,
    left: PHONE_DOCK_HORIZONTAL_PADDING,
    borderRadius: 999,
    backgroundColor: 'rgba(0,168,248,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(0,168,248,0.42)',
    shadowColor: COLORS.accent,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 18,
    elevation: 2,
  },
  phoneDockItem: {
    flex: 1,
    minWidth: 0,
    minHeight: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  phoneDockItemActive: {
    transform: [{ translateY: -1 }],
  },
  phoneDockIconWrap: {
    minWidth: 34,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phoneDockIconWrapActive: {
    transform: [{ translateY: -1 }],
  },
  phoneDockIcon: {
    color: COLORS.muted,
    fontSize: 15,
    fontWeight: '900',
  },
  phoneDockIconActive: {
    color: COLORS.accent,
  },
  phoneDockBadge: {
    position: 'absolute',
    top: -7,
    right: -11,
    minWidth: 19,
    height: 19,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
    borderWidth: 2,
    borderColor: COLORS.panel,
  },
  phoneDockBadgeText: {
    color: COLORS.bg,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '900',
  },
  sectionScroll: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: PHONE_DOCK_RESERVED_SPACE,
    gap: 14,
  },
  settingsFrame: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 126,
    gap: 16,
  },
  settingsBackButton: {
    alignSelf: 'flex-start',
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingRight: 8,
  },
  settingsBackLabel: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '800',
  },
  settingsHeader: {
    gap: 2,
    paddingHorizontal: 2,
  },
  settingsKicker: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  settingsTitle: {
    color: COLORS.text,
    fontSize: 40,
    lineHeight: 45,
    fontWeight: '900',
  },
  settingsHeaderSubtitle: {
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700',
    marginTop: 4,
  },
  settingsContent: {
    gap: 12,
  },
  settingsListGroup: {
    overflow: 'hidden',
  },
  settingsListItem: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 2,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  settingsListIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsListIcon_green: {
    backgroundColor: COLORS.accentSoft,
  },
  settingsListIcon_black: {
    backgroundColor: COLORS.text,
  },
  settingsListIcon_blue: {
    backgroundColor: 'rgba(70,185,255,0.22)',
  },
  settingsListIcon_gold: {
    backgroundColor: 'rgba(245,158,11,0.22)',
  },
  settingsListIcon_red: {
    backgroundColor: 'rgba(248,113,113,0.2)',
  },
  settingsListText: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  settingsListTitle: {
    color: COLORS.text,
    fontSize: 19,
    lineHeight: 22,
    fontWeight: '900',
  },
  settingsListSubtitle: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '600',
  },
  settingsListMeta: {
    maxWidth: 96,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
  },
  settingsListMetaText: {
    flexShrink: 1,
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  settingsLogoutButton: {
    minHeight: 52,
    marginTop: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },
  settingsLogoutText: {
    color: COLORS.danger,
    fontSize: 15,
    fontWeight: '700',
  },
  settingsCard: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(10,31,92,0.58)',
    padding: 16,
    gap: 14,
  },
  settingsFieldTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '900',
  },
  settingsHint: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  settingsSegmented: {
    minHeight: 46,
    borderRadius: 23,
    backgroundColor: COLORS.panelSoft,
    flexDirection: 'row',
    padding: 5,
    gap: 5,
  },
  settingsSegmentButton: {
    flex: 1,
    minHeight: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsSegmentButtonActive: {
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  settingsSegmentText: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: '900',
  },
  settingsSegmentTextActive: {
    color: COLORS.text,
  },
  settingsActionCard: {
    minHeight: 74,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(10,31,92,0.58)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
  },
  settingsActionIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.text,
  },
  settingsActionCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  settingsActionTitle: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: '900',
  },
  settingsActionSubtitle: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '600',
  },
  settingsActionButton: {
    minHeight: 36,
    borderRadius: 18,
    backgroundColor: COLORS.text,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 11,
  },
  settingsActionButtonText: {
    color: COLORS.bg,
    fontSize: 12,
    fontWeight: '900',
  },
  settingsAlert: {
    minHeight: 52,
    borderRadius: 20,
    backgroundColor: 'rgba(255,93,108,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,93,108,0.22)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
  },
  settingsAlertText: {
    flex: 1,
    color: COLORS.danger,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
  },
  settingsInlineState: {
    minHeight: 72,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(10,31,92,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  settingsInlineText: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: '800',
  },
  settingsEmptyState: {
    minHeight: 76,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(10,31,92,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
  },
  settingsEmptyText: {
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '800',
    textAlign: 'center',
  },
  settingsToggleRow: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 4,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  settingsToggleRowEmbedded: {
    paddingHorizontal: 0,
  },
  settingsToggleRowDisabled: {
    opacity: 0.56,
  },
  settingsToggleCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  settingsToggleTitle: {
    color: COLORS.text,
    fontSize: 17,
    lineHeight: 20,
    fontWeight: '900',
  },
  settingsToggleSubtitle: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '600',
  },
  settingsToggleControl: {
    width: 28,
    height: 28,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: 'rgba(170,192,231,0.44)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsToggleControlChecked: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accent,
  },
  settingsItemList: {
    gap: 10,
  },
  phoneNumberRow: {
    minHeight: 92,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(10,31,92,0.58)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
  },
  phoneNumberRowActive: {
    borderColor: 'rgba(0,168,248,0.45)',
    backgroundColor: COLORS.accentSoft,
  },
  phoneNumberAvatar: {
    width: 52,
    height: 52,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.text,
  },
  phoneNumberAvatarText: {
    color: COLORS.bg,
    fontSize: 15,
    fontWeight: '900',
  },
  phoneNumberCopy: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  phoneNumberTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '900',
  },
  phoneNumberSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
  phoneNumberActions: {
    alignItems: 'flex-end',
    gap: 7,
  },
  phoneNumberPill: {
    minHeight: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  phoneNumberPillActive: {
    borderColor: 'rgba(0,168,248,0.45)',
    backgroundColor: COLORS.accent,
  },
  phoneNumberPillText: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '900',
  },
  phoneNumberPillTextActive: {
    color: COLORS.bg,
  },
  templateRow: {
    minHeight: 76,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(10,31,92,0.58)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
  },
  templateIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.text,
  },
  templateCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  templateTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
  },
  templatePreview: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  templateBlockedReason: {
    color: COLORS.danger,
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '800',
  },
  templateStatus: {
    minHeight: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 9,
    backgroundColor: COLORS.panelSoft,
  },
  templateStatusApproved: {
    backgroundColor: 'rgba(34,197,94,0.16)',
  },
  templateStatusBlocked: {
    backgroundColor: 'rgba(255,93,108,0.18)',
  },
  templateStatusPending: {
    backgroundColor: 'rgba(245,158,11,0.18)',
  },
  templateStatusText: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '900',
  },
  templateStatusTextApproved: {
    color: '#86efac',
  },
  templateStatusTextBlocked: {
    color: COLORS.danger,
  },
  templateStatusTextPending: {
    color: '#facc15',
  },
  businessDescriptionPanel: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(10,31,92,0.58)',
    padding: 16,
    gap: 12,
  },
  businessDescriptionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  businessDescriptionIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.text,
  },
  businessDescriptionCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  businessDescriptionTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '900',
  },
  businessDescriptionSubtitle: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '600',
  },
  businessDescriptionField: {
    position: 'relative',
  },
  businessDescriptionInput: {
    minHeight: 178,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    color: COLORS.text,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 62,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '600',
  },
  businessVoiceButton: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    minWidth: 98,
    minHeight: 42,
    borderRadius: 21,
    backgroundColor: COLORS.text,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
  },
  businessVoiceButtonRecording: {
    backgroundColor: COLORS.danger,
  },
  businessVoiceButtonText: {
    color: COLORS.bg,
    fontSize: 13,
    fontWeight: '900',
  },
  businessVoiceButtonTextRecording: {
    color: COLORS.white,
  },
  businessDescriptionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  businessDescriptionMessage: {
    flex: 1,
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '700',
  },
  settingsSmallPrimaryButton: {
    minHeight: 38,
    borderRadius: 19,
    backgroundColor: COLORS.text,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
  },
  settingsSmallPrimaryText: {
    color: COLORS.bg,
    fontSize: 13,
    fontWeight: '900',
  },
  customFieldsList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
  },
  customFieldGroup: {
    gap: 2,
    paddingTop: 12,
  },
  customFieldGroupTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '900',
    marginBottom: 2,
  },
  customFieldRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  customFieldCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  customFieldTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '800',
  },
  customFieldSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  settingsCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  settingsCardHeaderIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.text,
  },
  settingsCardHeaderCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  settingsCardTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '900',
  },
  settingsCardSubtitle: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '600',
  },
  settingsChoiceList: {
    gap: 10,
  },
  settingsChoiceButton: {
    minHeight: 74,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(6,18,58,0.44)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
  },
  settingsChoiceActive: {
    borderColor: 'rgba(0,168,248,0.45)',
    backgroundColor: COLORS.accentSoft,
  },
  settingsChoiceIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.text,
  },
  settingsChoiceCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  settingsChoiceTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '900',
  },
  settingsChoiceSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  settingsChoiceCheck: {
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsEnabledCard: {
    minHeight: 54,
    borderRadius: 20,
    backgroundColor: 'rgba(34,197,94,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.22)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
  },
  settingsPushCardNeedsAction: {
    backgroundColor: 'rgba(70,185,255,0.14)',
    borderColor: 'rgba(70,185,255,0.24)',
  },
  settingsPushCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  settingsEnabledText: {
    flex: 1,
    color: '#86efac',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
  },
  settingsPushMessage: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
  },
  settingsPushActionButton: {
    minHeight: 34,
    borderRadius: 17,
    backgroundColor: COLORS.text,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 10,
  },
  settingsPushActionText: {
    color: COLORS.bg,
    fontSize: 12,
    fontWeight: '900',
  },
  calendarPickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  calendarPickerCount: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '900',
  },
  calendarChipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  calendarChip: {
    alignSelf: 'flex-start',
    minHeight: 38,
    maxWidth: '100%',
    borderRadius: 19,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
  },
  calendarChipActive: {
    borderColor: 'rgba(0,168,248,0.45)',
    backgroundColor: COLORS.accentSoft,
  },
  calendarChipText: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: '800',
  },
  calendarChipTextActive: {
    color: COLORS.text,
  },
  calendarColorDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  sectionBlock: {
    gap: 4,
  },
  sectionTitle: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: '900',
    marginBottom: 6,
  },
  inlineState: {
    minHeight: 90,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  infoRow: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  infoRowText: {
    flex: 1,
    minWidth: 0,
  },
  infoRowTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '800',
  },
  infoRowSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 3,
  },
  infoRowValue: {
    color: COLORS.accent,
    fontSize: 14,
    fontWeight: '900',
  },
  actionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  actionTile: {
    width: '47.5%',
    minHeight: 78,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    justifyContent: 'center',
    padding: 14,
  },
  actionTileLabel: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
  },
  paymentsSelectStack: {
    paddingTop: 24,
    paddingHorizontal: 16,
    paddingBottom: 126,
    gap: 2,
  },
  paymentsSelectTitle: {
    color: COLORS.text,
    fontSize: 38,
    lineHeight: 43,
    fontWeight: '900',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  paymentChoiceCard: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  paymentChoiceIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paymentChoiceCopy: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  paymentChoiceTitle: {
    color: COLORS.text,
    fontSize: 19,
    lineHeight: 22,
    fontWeight: '800',
  },
  paymentChoiceSubtitle: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  recentPaymentsSection: {
    marginTop: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    gap: 9,
  },
  recentPaymentsToggle: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  recentPaymentsToggleCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  recentPaymentsToggleTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '900',
  },
  recentPaymentsToggleSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  recentPaymentsChevronOpen: {
    transform: [{ rotate: '180deg' }],
  },
  recentPaymentsPanel: {
    gap: 8,
  },
  recentPeriodPicker: {
    flexDirection: 'row',
    gap: 6,
  },
  recentPeriodButton: {
    flex: 1,
    minHeight: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panel,
  },
  recentPeriodButtonActive: {
    backgroundColor: COLORS.text,
  },
  recentPeriodText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '900',
  },
  recentPeriodTextActive: {
    color: COLORS.bg,
  },
  recentPaymentsState: {
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 10,
  },
  recentPaymentsRefresh: {
    alignSelf: 'center',
    minHeight: 28,
    borderRadius: 14,
    backgroundColor: COLORS.panel,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  recentPaymentsRefreshText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  recentPaymentsList: {
    gap: 0,
  },
  recentPaymentItem: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
  },
  recentPaymentItemSelected: {
    backgroundColor: COLORS.accentSoft,
  },
  recentPaymentMain: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  recentPaymentAmount: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: '900',
  },
  recentPaymentContact: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  recentPaymentMeta: {
    alignItems: 'flex-end',
    maxWidth: 138,
    gap: 4,
  },
  recentPaymentDate: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '800',
  },
  recentPaymentMethod: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '700',
  },
  productsTopBar: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
  },
  productsHost: {
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 132,
    gap: 14,
  },
  paymentsBackButton: {
    minHeight: 40,
    borderRadius: 20,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: COLORS.panel,
  },
  paymentsBackText: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '800',
  },
  productsToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  productsToolbarCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  productsToolbarTitle: {
    color: COLORS.text,
    fontSize: 26,
    lineHeight: 30,
    fontWeight: '900',
  },
  productsToolbarSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  productsToolbarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  productIconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panel,
  },
  productPrimaryButton: {
    minHeight: 44,
    borderRadius: 22,
    paddingHorizontal: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: COLORS.accent,
  },
  productPrimaryButtonText: {
    color: COLORS.white,
    fontSize: 13,
    fontWeight: '900',
  },
  productSecondaryButton: {
    minHeight: 44,
    borderRadius: 22,
    paddingHorizontal: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
  },
  productSecondaryButtonText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '900',
  },
  productForm: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    padding: 14,
    gap: 12,
  },
  productFormHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  productFormHeaderCopy: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  productFormTitle: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: '900',
  },
  productFormSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '600',
  },
  productFormActions: {
    flexDirection: 'row',
    gap: 10,
  },
  productFormPrimaryButton: {
    flex: 1,
  },
  productsState: {
    minHeight: 170,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 18,
  },
  productsEmpty: {
    minHeight: 210,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 18,
  },
  productsEmptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panel,
  },
  productsList: {
    gap: 10,
  },
  productItem: {
    minHeight: 78,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  productItemMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  productItemIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(37,211,102,0.14)',
  },
  productItemCopy: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  productItemTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '900',
  },
  productItemDescription: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  productItemPrice: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  productItemActions: {
    flexDirection: 'row',
    gap: 8,
  },
  productItemActionButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panelSoft,
  },
  productDeleteButton: {
    backgroundColor: COLORS.dangerSoft,
  },
  paymentFormHost: {
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 132,
    gap: 14,
  },
  paymentFormHeader: {
    gap: 5,
    paddingHorizontal: 2,
  },
  paymentFormTitle: {
    color: COLORS.text,
    fontSize: 32,
    lineHeight: 36,
    fontWeight: '900',
  },
  paymentFormSubtitle: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  paymentFormBlock: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    padding: 14,
    gap: 12,
  },
  paymentFormBlockTitle: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: '900',
  },
  paymentField: {
    gap: 6,
  },
  paymentFieldLabel: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '900',
  },
  paymentFieldInput: {
    minHeight: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    color: COLORS.text,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15,
    fontWeight: '700',
  },
  paymentFieldInputMultiline: {
    minHeight: 84,
    textAlignVertical: 'top',
  },
  paymentOptionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  paymentOptionPill: {
    minHeight: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panelSoft,
  },
  paymentOptionPillActive: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accentSoft,
  },
  paymentOptionText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '900',
  },
  paymentOptionTextActive: {
    color: COLORS.text,
  },
  selectedContactCard: {
    minHeight: 62,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
  },
  selectedContactIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accentSoft,
  },
  selectedContactCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  selectedContactName: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
  },
  selectedContactDetail: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  contactSearchResults: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
  },
  paymentInlineLoading: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  paymentSubmitButton: {
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  paymentSubmitText: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: '900',
  },
  paymentsBottomSpacer: {
    height: 26,
  },
  segmentWrap: {
    minHeight: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 5,
    gap: 4,
  },
  segmentActive: {
    flex: 1,
    color: COLORS.text,
    backgroundColor: COLORS.panelSoft,
    borderRadius: 18,
    overflow: 'hidden',
    textAlign: 'center',
    paddingVertical: 9,
    fontSize: 12,
    fontWeight: '900',
  },
  segmentLabel: {
    flex: 1,
    color: COLORS.muted,
    textAlign: 'center',
    paddingVertical: 9,
    fontSize: 12,
    fontWeight: '800',
  },
  analyticsScroll: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 122,
    gap: 12,
  },
  analyticsHeader: {
    gap: 8,
    paddingTop: 2,
  },
  analyticsEyebrow: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  analyticsTitleRow: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  analyticsTitle: {
    flex: 1,
    minWidth: 0,
    color: COLORS.text,
    fontSize: 42,
    lineHeight: 48,
    fontWeight: '900',
  },
  analyticsPeriodToggle: {
    minHeight: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: 5,
    paddingHorizontal: 12,
    marginTop: 5,
    maxWidth: 138,
  },
  analyticsPeriodToggleOpen: {
    borderColor: 'rgba(0,168,248,0.36)',
    backgroundColor: COLORS.panelSoft,
  },
  analyticsPeriodToggleText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '900',
    maxWidth: 102,
  },
  analyticsCustomRangeInline: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '800',
    marginTop: -3,
  },
  analyticsPeriodMenu: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    padding: 7,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'stretch',
    rowGap: 7,
  },
  analyticsPeriodOption: {
    width: '48.5%',
    minHeight: 38,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    backgroundColor: 'transparent',
  },
  analyticsPeriodOptionWide: {
    width: '100%',
  },
  analyticsPeriodOptionActive: {
    backgroundColor: COLORS.text,
  },
  analyticsPeriodOptionText: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },
  analyticsPeriodOptionTextActive: {
    color: COLORS.bg,
    fontWeight: '900',
  },
  analyticsCustomSheetBody: {
    padding: 14,
    gap: 12,
  },
  analyticsCustomHint: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  analyticsCustomDateRow: {
    flexDirection: 'row',
    gap: 10,
  },
  analyticsCustomDateField: {
    flex: 1,
    minWidth: 0,
    gap: 6,
  },
  analyticsCustomDateLabel: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  analyticsCustomDateInput: {
    minHeight: 46,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    color: COLORS.text,
    paddingHorizontal: 12,
    paddingVertical: 0,
    fontSize: 15,
    fontWeight: '800',
  },
  analyticsCustomActions: {
    gap: 8,
  },
  analyticsInlineError: {
    gap: 10,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    padding: 12,
  },
  analyticsMetricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 8,
  },
  analyticsMetricCard: {
    width: '48.8%',
    minHeight: 124,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    padding: 12,
    gap: 6,
  },
  analyticsMetricIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  analyticsTonegreen: {
    backgroundColor: COLORS.accent,
  },
  analyticsToneblack: {
    backgroundColor: COLORS.text,
  },
  analyticsToneblue: {
    backgroundColor: 'rgba(70,185,255,0.24)',
  },
  analyticsTonegold: {
    backgroundColor: 'rgba(255,209,102,0.22)',
  },
  analyticsTonered: {
    backgroundColor: 'rgba(255,93,108,0.18)',
  },
  analyticsMetricTitle: {
    color: COLORS.muted,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800',
  },
  analyticsMetricValue: {
    color: COLORS.text,
    fontSize: 19,
    lineHeight: 23,
    fontWeight: '900',
  },
  analyticsMetricDelta: {
    fontSize: 11,
    fontWeight: '800',
  },
  analyticsDeltaPositive: {
    color: COLORS.accent,
  },
  analyticsDeltaNegative: {
    color: COLORS.danger,
  },
  analyticsPanel: {
    gap: 12,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    padding: 14,
  },
  analyticsPanelHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  analyticsPanelTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  analyticsSectionLabel: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  analyticsPanelTitle: {
    color: COLORS.text,
    fontSize: 22,
    lineHeight: 26,
    fontWeight: '900',
    marginTop: 4,
  },
  analyticsOptionScroll: {
    marginHorizontal: -14,
  },
  analyticsOptionScroller: {
    gap: 7,
    paddingHorizontal: 14,
    paddingRight: 18,
  },
  analyticsChip: {
    minHeight: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 13,
  },
  analyticsChipActive: {
    borderColor: 'rgba(0,168,248,0.34)',
    backgroundColor: COLORS.accentSoft,
  },
  analyticsChipText: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: '800',
  },
  analyticsChipTextActive: {
    color: COLORS.text,
  },
  analyticsSegmentedControl: {
    minHeight: 39,
    borderRadius: 20,
    backgroundColor: COLORS.panelSoft,
    flexDirection: 'row',
    padding: 4,
    gap: 4,
  },
  analyticsSegmentButton: {
    flex: 1,
    minWidth: 0,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  analyticsSegmentButtonActive: {
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  analyticsSegmentText: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '800',
  },
  analyticsSegmentTextActive: {
    color: COLORS.text,
    fontWeight: '900',
  },
  analyticsLegendRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  analyticsLegendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  analyticsLegendDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  analyticsLegendText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  analyticsChartCanvas: {
    minHeight: 190,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: COLORS.panelSoft,
    justifyContent: 'flex-end',
  },
  analyticsChartTopScale: {
    position: 'absolute',
    top: 10,
    left: 12,
    zIndex: 1,
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '800',
  },
  analyticsLoadingState: {
    minHeight: 128,
    borderRadius: 18,
    backgroundColor: COLORS.panelSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  analyticsEmptyState: {
    minHeight: 128,
    borderRadius: 18,
    backgroundColor: COLORS.panelSoft,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  analyticsEmptyText: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },
  analyticsConversionPill: {
    minHeight: 32,
    borderRadius: 16,
    backgroundColor: COLORS.accent,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  analyticsConversionPillText: {
    color: COLORS.bg,
    fontSize: 13,
    fontWeight: '900',
  },
  analyticsFunnelList: {
    gap: 10,
  },
  analyticsFunnelItem: {
    flexDirection: 'row',
    gap: 9,
    minWidth: 0,
  },
  analyticsFunnelIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panelSoft,
  },
  calendarPage: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  calendarHeader: {
    paddingTop: 16,
    paddingHorizontal: 15,
    paddingBottom: 0,
    gap: 8,
    backgroundColor: COLORS.bg,
  },
  calendarToolbar: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 20,
  },
  calendarPeriodChip: {
    minHeight: 42,
    width: 96,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: 'rgba(183,207,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.055)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 10,
  },
  calendarPeriodText: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '900',
  },
  calendarHeaderCapsule: {
    minHeight: 42,
    width: 174,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: 'rgba(183,207,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.055)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 5,
  },
  calendarCapsuleIconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  calendarCapsuleTodayButton: {
    minWidth: 62,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  calendarTitleRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 0,
  },
  calendarTitleButton: {
    flex: 1,
    minWidth: 0,
  },
  calendarTitle: {
    color: COLORS.text,
    fontSize: 39,
    lineHeight: 43,
    fontWeight: '900',
    textTransform: 'capitalize',
  },
  calendarSubtitle: {
    color: COLORS.accent,
    fontSize: 13,
    fontWeight: '900',
    marginTop: 1,
  },
  calendarPeriodControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingBottom: 2,
  },
  calendarNavButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panelSoft,
  },
  analyticsFunnelContent: {
    flex: 1,
    minWidth: 0,
    gap: 5,
  },
  analyticsFunnelTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  analyticsFunnelTitle: {
    flex: 1,
    minWidth: 0,
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
  },
  analyticsFunnelValue: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '900',
  },
  analyticsProgressTrack: {
    height: 8,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: COLORS.panelSoft,
  },
  analyticsProgressFill: {
    minWidth: 6,
    height: '100%',
    borderRadius: 999,
    backgroundColor: COLORS.accent,
  },
  analyticsMiniCaption: {
    color: COLORS.muted,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
  },
  analyticsSourceList: {
    gap: 10,
  },
  analyticsSourceItem: {
    gap: 6,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  analyticsSourceTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  analyticsSourceTitle: {
    flex: 1,
    minWidth: 0,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  calendarTodayButton: {
    minHeight: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    backgroundColor: COLORS.panelSoft,
  },
  calendarTodayButtonText: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '900',
  },
  calendarSelector: {
    minHeight: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 13,
  },
  calendarSelectorDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  calendarSelectorText: {
    flex: 1,
    minWidth: 0,
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '900',
  },
  calendarCenterState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  calendarScrollBody: {
    paddingBottom: 138,
  },
  calendarSurface: {
    paddingHorizontal: 16,
    paddingTop: 0,
    paddingBottom: 0,
    backgroundColor: COLORS.bg,
  },
  calendarWeekdayRow: {
    flexDirection: 'row',
    height: CALENDAR_WEEKDAY_ROW_HEIGHT,
    alignItems: 'center',
    paddingHorizontal: 0,
    backgroundColor: 'transparent',
  },
  calendarWeekdayText: {
    flex: 1,
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '900',
    textAlign: 'center',
  },
  calendarMonthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingTop: CALENDAR_MONTH_GRID_TOP_PADDING,
    paddingBottom: 0,
    backgroundColor: 'transparent',
  },
  calendarDayCell: {
    width: '14.2857%',
    height: CALENDAR_MONTH_DAY_CELL_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  calendarDayCellWeekend: {},
  calendarDayCellMuted: {
    opacity: 0.64,
  },
  calendarDayNumberWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calendarDayNumberToday: {
    borderWidth: 0,
    borderColor: 'transparent',
  },
  calendarDayNumberSelected: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  calendarDayNumber: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '800',
  },
  calendarDayNumberMuted: {
    color: COLORS.muted,
  },
  calendarDayNumberWeekend: {
    color: COLORS.muted,
  },
  calendarDayNumberTodayText: {
    color: COLORS.accent,
  },
  calendarDayNumberSelectedText: {
    color: COLORS.white,
  },
  calendarDayMarkers: {
    minHeight: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  calendarDayMarker: {
    width: 4,
    height: 4,
    borderRadius: 3,
    backgroundColor: COLORS.accent,
  },
  calendarAgendaHeader: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 0,
    paddingBottom: 4,
    borderTopWidth: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  calendarAgendaHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  calendarAgendaDate: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  calendarAgendaTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '900',
    marginTop: 1,
  },
  calendarAgendaSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '800',
    marginTop: 2,
  },
  calendarRefreshingPill: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '900',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: COLORS.panel,
    overflow: 'hidden',
  },
  calendarEventCard: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginHorizontal: 20,
    marginTop: 7,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(183,207,255,0.18)',
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  calendarEventAccent: {
    width: 4,
    alignSelf: 'stretch',
    borderRadius: 999,
    marginVertical: 2,
  },
  calendarEventCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  calendarEventTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '900',
  },
  calendarEventMeta: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  calendarEventTimeStack: {
    minWidth: 62,
    alignItems: 'flex-end',
    gap: 1,
  },
  calendarEventTimeStart: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '900',
  },
  calendarEventTimeEnd: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: '700',
  },
  calendarEmpty: {
    minHeight: 210,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 8,
  },
  calendarEmptyIcon: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panelSoft,
  },
  calendarEmptyTitle: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '900',
    textAlign: 'center',
  },
  calendarEmptyText: {
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  calendarErrorText: {
    color: COLORS.danger,
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
  },
  calendarYearGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  calendarYearMonth: {
    width: '33.3333%',
    minHeight: 86,
    borderRadius: 18,
    padding: 11,
    justifyContent: 'space-between',
    backgroundColor: 'transparent',
  },
  calendarYearMonthSelected: {
    backgroundColor: COLORS.accentSoft,
  },
  calendarYearMonthTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '900',
    textTransform: 'capitalize',
  },
  calendarYearMonthToday: {
    color: COLORS.accent,
  },
  calendarYearMonthTitleSelected: {
    color: COLORS.text,
  },
  calendarYearMonthDots: {
    minHeight: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  calendarYearMonthDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: COLORS.accent,
  },
  calendarYearMonthDotWide: {
    width: 13,
    height: 5,
    borderRadius: 3,
    backgroundColor: COLORS.accent,
  },
  calendarYearMonthCount: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '900',
  },
  calendarSheetList: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 18,
  },
  calendarSheetRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    paddingHorizontal: 6,
    paddingVertical: 9,
  },
  calendarSheetRowSelected: {
    backgroundColor: COLORS.accentSoft,
  },
  calendarSheetDot: {
    width: 13,
    height: 13,
    borderRadius: 7,
  },
  calendarSheetCopy: {
    flex: 1,
    minWidth: 0,
  },
  calendarSheetTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
  },
  analyticsSourceValue: {
    flexShrink: 0,
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '900',
  },
  analyticsSourceTrack: {
    height: 8,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: COLORS.panelSoft,
  },
  analyticsSourceFill: {
    minWidth: 6,
    height: '100%',
    borderRadius: 999,
    backgroundColor: COLORS.accent,
  },
  analyticsPhoneSourceTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  analyticsPhoneSourceCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  calendarSheetSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
    fontWeight: '700',
  },
  eventDetailsBody: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 18,
  },
  eventDetailsHero: {
    minHeight: 78,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 13,
    marginBottom: 8,
  },
  eventDetailsAccent: {
    width: 5,
    alignSelf: 'stretch',
    borderRadius: 999,
  },
  eventDetailsCopy: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  eventDetailsDate: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '900',
    textTransform: 'capitalize',
  },
  eventDetailsTime: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: '800',
  },
  appointmentFormBody: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 26,
    gap: 14,
  },
  appointmentContactCard: {
    minHeight: 58,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 11,
  },
  appointmentContactIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: COLORS.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  appointmentContactCopy: {
    flex: 1,
    minWidth: 0,
  },
  appointmentContactName: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
  },
  appointmentContactMeta: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
    fontWeight: '700',
  },
  appointmentFieldGrid: {
    flexDirection: 'row',
    gap: 14,
  },
  appointmentField: {
    gap: 8,
  },
  appointmentFieldCompact: {
    flex: 1,
    minWidth: 0,
  },
  appointmentFieldLabel: {
    color: COLORS.muted,
    fontSize: 14,
    fontWeight: '700',
    textTransform: 'none',
  },
  appointmentRequiredStar: {
    color: COLORS.danger,
    fontWeight: '900',
  },
  appointmentInputWrap: {
    minHeight: 56,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  appointmentInputWrapMultiline: {
    minHeight: 112,
    alignItems: 'flex-start',
    paddingTop: 15,
  },
  appointmentInput: {
    flex: 1,
    minHeight: 52,
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700',
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  appointmentInputMultiline: {
    minHeight: 100,
    lineHeight: 25,
    paddingTop: 0,
  },
  appointmentSection: {
    gap: 8,
  },
  appointmentChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  appointmentChoiceChip: {
    minHeight: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(16,42,120,0.58)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  appointmentChoiceChipActive: {
    borderColor: 'rgba(0,168,248,0.46)',
    backgroundColor: COLORS.accentSoft,
  },
  appointmentChoiceText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  appointmentChoiceTextActive: {
    color: COLORS.text,
  },
  appointmentHint: {
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700',
  },
  appointmentSelectPlaceholder: {
    color: COLORS.muted,
  },
  appointmentSelectValue: {
    flex: 1,
    minWidth: 0,
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '800',
  },
  appointmentSelectWrap: {
    minHeight: 56,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
  },
  appointmentSelectWrapStatic: {
    opacity: 0.98,
  },
  centerScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
  },
  bootLogo: {
    width: 132,
    height: 132,
  },
  authLogo: {
    width: 82,
    height: 82,
    alignSelf: 'flex-start',
  },
  authWrap: {
    flex: 1,
  },
  authScroller: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 20,
  },
  authPanel: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    borderRadius: 24,
    padding: 22,
    gap: 14,
  },
  kicker: {
    color: COLORS.accent,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  title: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: '900',
  },
  bodyText: {
    color: COLORS.muted,
    fontSize: 15,
    lineHeight: 22,
  },
  caption: {
    color: COLORS.muted,
    fontSize: 12,
  },
  input: {
    minHeight: 50,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    color: COLORS.text,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  chatListHeader: {
    paddingTop: 8,
    paddingHorizontal: 14,
    paddingBottom: 8,
    backgroundColor: COLORS.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  chatTopActionRow: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  chatHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  agentRoundButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(6,18,58,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(39,199,216,0.26)',
  },
  headerIconButton: {
    minWidth: 38,
    height: 38,
    borderRadius: 19,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(6,18,58,0.72)',
  },
  newChatButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
  },
  chatTitleRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 8,
  },
  chatTitleMain: {
    flex: 1,
    minWidth: 0,
  },
  chatTitle: {
    color: COLORS.text,
    fontSize: 38,
    lineHeight: 43,
    fontWeight: '900',
  },
  searchBox: {
    minHeight: 38,
    borderRadius: 19,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.panelSoft,
    paddingHorizontal: 11,
  },
  searchInput: {
    flex: 1,
    minHeight: 38,
    color: COLORS.text,
    paddingHorizontal: 0,
    paddingVertical: 0,
    fontSize: 15,
  },
  clearSearchButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterChipScroll: {
    marginHorizontal: -14,
  },
  filterChipRow: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 2,
  },
  filterChip: {
    minHeight: 34,
    borderRadius: 17,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    maxWidth: 210,
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  filterChipActive: {
    backgroundColor: COLORS.accentSoft,
    borderColor: 'rgba(0,168,248,0.28)',
  },
  filterChipComments: {
    borderColor: '#38bdf8',
  },
  filterChipSeparator: {
    alignSelf: 'center',
    width: 1,
    height: 24,
    marginHorizontal: 2,
    borderRadius: 999,
    backgroundColor: COLORS.border,
  },
  filterChipMore: {
    minWidth: 38,
    paddingHorizontal: 0,
  },
  filterChipText: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: '800',
  },
  filterChipTextActive: {
    color: COLORS.text,
  },
  filterChipCount: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
  },
  filterChipCountText: {
    color: COLORS.white,
    fontSize: 11,
    fontWeight: '900',
  },
  sheetBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(1,8,28,0.42)',
  },
  sheetModalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetDimmer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(1,8,28,0.52)',
  },
  sheetScrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  filterSheet: {
    maxHeight: '82%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    overflow: 'hidden',
  },
  filterSheetHeader: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  filterSheetTitle: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '900',
  },
  filterSheetSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  sheetCloseButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panelSoft,
  },
  filterSheetBody: {
    padding: 14,
    paddingBottom: 30,
    gap: 14,
  },
  filterManagerSection: {
    gap: 7,
  },
  filterManagerSectionTitle: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    paddingHorizontal: 4,
  },
  filterManagerRow: {
    minHeight: 62,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(16,42,120,0.48)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  filterManagerRowActive: {
    borderColor: 'rgba(0,168,248,0.42)',
    backgroundColor: COLORS.accentSoft,
  },
  filterManagerCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  filterManagerTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '900',
  },
  filterManagerDescription: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  filterManagerToggle: {
    minWidth: 76,
    minHeight: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    backgroundColor: COLORS.panelSoft,
  },
  filterManagerToggleActive: {
    backgroundColor: COLORS.text,
  },
  filterManagerToggleText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '900',
  },
  filterManagerToggleTextActive: {
    color: COLORS.bg,
  },
  actionSheet: {
    maxHeight: '88%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    overflow: 'hidden',
    paddingBottom: 16,
  },
  actionSheetHandle: {
    alignSelf: 'center',
    width: 48,
    height: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(170,192,231,0.38)',
    marginTop: 8,
    marginBottom: 3,
  },
  actionSheetHeader: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  actionSheetHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  actionSheetTitle: {
    color: COLORS.text,
    fontSize: 19,
    fontWeight: '900',
  },
  actionSheetSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  sheetActionList: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
  },
  sheetSectionDivider: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
    paddingTop: 10,
  },
  sheetSectionLabel: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  sheetActionRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    paddingHorizontal: 6,
    paddingVertical: 10,
  },
  sheetActionIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accentSoft,
  },
  sheetActionIconDanger: {
    backgroundColor: COLORS.dangerSoft,
  },
  sheetActionCopy: {
    flex: 1,
    minWidth: 0,
  },
  sheetActionTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
  },
  sheetActionSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  contactPickerBody: {
    padding: 14,
    gap: 12,
  },
  cameraPreview: {
    width: '100%',
    height: 170,
    borderRadius: 20,
    backgroundColor: COLORS.bg,
  },
  sheetSearchBox: {
    minHeight: 42,
    borderRadius: 21,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.panelSoft,
    paddingHorizontal: 12,
  },
  sheetSearchInput: {
    flex: 1,
    minHeight: 42,
    color: COLORS.text,
    paddingHorizontal: 0,
    paddingVertical: 0,
    fontSize: 15,
  },
  sheetInlineState: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  contactPickerList: {
    paddingBottom: 8,
  },
  contactPickerRow: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  contactPickerAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 2,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  contactPickerAvatarImage: {
    width: 42,
    height: 42,
    borderRadius: 21,
  },
  contactPickerCopy: {
    flex: 1,
    minWidth: 0,
  },
  contactPickerName: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
  },
  contactPickerSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
  },
  contactPickerEmpty: {
    color: COLORS.muted,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 28,
  },
  scheduleSheetBody: {
    padding: 14,
    gap: 12,
  },
  scheduleTextInput: {
    minHeight: 118,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    color: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    lineHeight: 20,
  },
  primaryButton: {
    minHeight: 52,
    borderRadius: 18,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonLabel: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: '900',
  },
  secondaryButton: {
    minHeight: 44,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  secondaryButtonLabel: {
    color: COLORS.text,
    fontWeight: '800',
  },
  textButton: {
    alignSelf: 'center',
    padding: 10,
  },
  textButtonLabel: {
    color: COLORS.accent,
    fontWeight: '800',
  },
  errorText: {
    color: COLORS.danger,
    fontSize: 14,
  },
  disabledButton: {
    opacity: 0.58,
  },
  pressed: {
    opacity: 0.78,
  },
  header: {
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    color: COLORS.text,
    fontSize: 26,
    fontWeight: '900',
  },
  roundButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panel,
  },
  roundButtonLabel: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '900',
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  chatList: {
    paddingTop: 2,
    paddingBottom: PHONE_DOCK_RESERVED_SPACE,
  },
  emptyList: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    paddingBottom: PHONE_DOCK_RESERVED_SPACE,
  },
  emptyChats: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    maxWidth: 280,
  },
  emptyChatsIcon: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: COLORS.panelSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyChatsTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '900',
    textAlign: 'center',
  },
  emptyChatsCopy: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  chatSelectionPanel: {
    gap: 9,
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 10,
    padding: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(16,42,120,0.88)',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.1,
    shadowRadius: 30,
    elevation: 2,
  },
  chatSelectionPanelTop: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  chatSelectionCount: {
    flex: 1,
    minWidth: 0,
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
  },
  chatSelectionClearButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  chatSelectionSelectAll: {
    alignSelf: 'flex-start',
    minHeight: 36,
    maxWidth: '100%',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(255,255,255,0.06)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 11,
  },
  chatSelectionSelectAllText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '800',
  },
  chatSelectionMiniCheck: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(170,192,231,0.52)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  chatSelectionMiniCheckActive: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accent,
  },
  chatSelectionMoreButton: {
    minHeight: 40,
    borderRadius: 20,
    backgroundColor: COLORS.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  chatSelectionMoreButtonText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '900',
  },
  chatSelectionActionsMenu: {
    overflow: 'hidden',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(6,18,58,0.58)',
  },
  chatSelectionActionRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  chatSelectionActionIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accentSoft,
  },
  chatSelectionActionCopy: {
    flex: 1,
    minWidth: 0,
  },
  chatSelectionActionTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '900',
  },
  chatSelectionActionSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  archiveRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  archiveRowActive: {
    backgroundColor: COLORS.accentSoft,
  },
  archiveRowIcon: {
    width: 48,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  archiveRowTitle: {
    flex: 1,
    color: COLORS.muted,
    fontSize: 17,
    fontWeight: '800',
  },
  archiveRowTitleActive: {
    color: COLORS.text,
  },
  archiveRowCount: {
    color: COLORS.muted,
    fontSize: 15,
    fontWeight: '800',
  },
  aiChatRow: {
    position: 'relative',
    height: 74,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 13,
    paddingVertical: 8,
    backgroundColor: COLORS.bg,
  },
  aiChatDivider: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.border,
  },
  aiChatAvatarSlot: {
    width: 52,
    height: 58,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  aiChatAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(39,199,216,0.38)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(39,199,216,0.12)',
  },
  aiChatBody: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 3,
  },
  aiChatName: {
    color: COLORS.text,
    fontSize: 16,
    lineHeight: 19,
    fontWeight: '800',
  },
  aiChatSubtitle: {
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '500',
  },
  aiChatMeta: {
    alignSelf: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 8,
    minWidth: 38,
  },
  aiChatPinned: {
    color: COLORS.accent,
    fontSize: 11,
    fontWeight: '900',
  },
  aiConversationBody: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  aiWelcomeBubble: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    padding: 20,
    gap: 10,
    alignItems: 'flex-start',
  },
  aiWelcomeTitle: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '900',
  },
  aiWelcomeCopy: {
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  chatSwipeRow: {
    position: 'relative',
    minHeight: CHAT_ROW_MIN_HEIGHT,
    overflow: 'hidden',
    backgroundColor: COLORS.bg,
  },
  chatSwipeRowSelected: {
    backgroundColor: COLORS.accentSoft,
  },
  chatSwipeActions: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    minHeight: CHAT_ROW_MIN_HEIGHT,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    zIndex: 0,
  },
  chatSwipeClosePlate: {
    flex: 1,
    minWidth: 0,
  },
  chatSwipeAction: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    minHeight: CHAT_ROW_MIN_HEIGHT,
  },
  chatSwipeMore: {
    width: CHAT_SWIPE_MORE_WIDTH,
    backgroundColor: 'rgba(243,248,255,0.72)',
  },
  chatSwipeArchive: {
    width: CHAT_SWIPE_ARCHIVE_WIDTH,
    backgroundColor: COLORS.accent,
  },
  chatSwipeActionText: {
    color: COLORS.white,
    fontSize: 13,
    fontWeight: '900',
  },
  chatSwipeMoreText: {
    color: COLORS.bg,
  },
  chatSwipeContent: {
    position: 'relative',
    zIndex: 1,
    width: '100%',
    backgroundColor: COLORS.bg,
  },
  chatRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: CHAT_ROW_MIN_HEIGHT,
    paddingHorizontal: 14,
    borderRadius: 0,
  },
  chatRowUnread: {
    backgroundColor: 'rgba(39,199,216,0.07)',
  },
  chatRowSelecting: {
    gap: 10,
    paddingLeft: 10,
  },
  chatRowSelected: {
    backgroundColor: COLORS.accentSoft,
  },
  chatRowArchived: {
    opacity: 0.86,
  },
  chatSelectionCheck: {
    width: 25,
    height: 25,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: 'rgba(170,192,231,0.52)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  chatSelectionCheckActive: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accent,
  },
  avatar: {
    position: 'relative',
    width: CHAT_AVATAR_SIZE,
    height: CHAT_AVATAR_SIZE,
    borderRadius: CHAT_AVATAR_SIZE / 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.bg,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.16,
    shadowRadius: 12,
    elevation: 2,
  },
  avatarCircle: {
    width: CHAT_AVATAR_INNER_SIZE,
    height: CHAT_AVATAR_INNER_SIZE,
    borderRadius: CHAT_AVATAR_INNER_SIZE / 2,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: {
    width: CHAT_AVATAR_INNER_SIZE,
    height: CHAT_AVATAR_INNER_SIZE,
  },
  avatarText: {
    color: COLORS.text,
    fontWeight: '900',
    fontSize: 18,
  },
  avatarChannelBadge: {
    position: 'absolute',
    right: -4,
    bottom: -2,
    minWidth: CHAT_CHANNEL_BADGE_SIZE,
    height: CHAT_CHANNEL_BADGE_SIZE,
    borderRadius: CHAT_CHANNEL_BADGE_SIZE / 2,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.bg,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.28,
    shadowRadius: 5,
    elevation: 3,
  },
  chatRowBody: {
    flex: 1,
    alignSelf: 'stretch',
    justifyContent: 'center',
    minWidth: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  chatName: {
    flex: 1,
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '800',
  },
  chatNameUnread: {
    fontWeight: '900',
  },
  rowTime: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  rowTimeUnread: {
    color: COLORS.accent,
    fontWeight: '900',
  },
  rowFooter: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  lastMessage: {
    flex: 1,
    color: COLORS.muted,
    fontSize: 15,
  },
  lastMessageUnread: {
    color: COLORS.meta,
    fontWeight: '700',
  },
  unreadPill: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadText: {
    color: COLORS.bg,
    fontSize: 13,
    fontWeight: '900',
  },
  conversationHeader: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    gap: 8,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(16,42,120,0.68)',
  },
  backLabel: {
    color: COLORS.text,
    fontSize: 34,
    lineHeight: 34,
  },
  conversationContactButton: {
    flex: 1,
    minWidth: 0,
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  conversationAvatar: {
    position: 'relative',
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.bg,
  },
  conversationAvatarCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  conversationAvatarImage: {
    width: 42,
    height: 42,
  },
  conversationAvatarBadge: {
    position: 'absolute',
    right: -4,
    bottom: -2,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.bg,
  },
  conversationTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  conversationTitle: {
    color: COLORS.text,
    fontSize: 17,
    lineHeight: 21,
    fontWeight: '900',
  },
  conversationSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    marginTop: 1,
  },
  conversationHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  conversationHeaderIconButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(16,42,120,0.68)',
  },
  conversationHeaderIconButtonActive: {
    backgroundColor: COLORS.accentSoft,
  },
  conversationSearchBar: {
    minHeight: 48,
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.panelSoft,
    paddingHorizontal: 13,
  },
  conversationSearchInput: {
    flex: 1,
    minHeight: 48,
    paddingVertical: 0,
    paddingHorizontal: 0,
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '700',
  },
  conversationSearchCount: {
    minWidth: 28,
    textAlign: 'center',
    color: COLORS.accent,
    fontSize: 12,
    fontWeight: '900',
  },
  conversationBody: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  messageList: {
    flexGrow: 1,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
    gap: 8,
  },
  emptyConversation: {
    flex: 1,
    minHeight: 360,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 28,
  },
  emptyConversationTitle: {
    color: COLORS.text,
    fontSize: 19,
    fontWeight: '900',
    textAlign: 'center',
  },
  emptyConversationCopy: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  messageDaySeparator: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
  },
  messageDayLabel: {
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: 'rgba(16,42,120,0.72)',
    color: COLORS.meta,
    fontSize: 11,
    fontWeight: '900',
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  messageRow: {
    flexDirection: 'row',
    marginVertical: 1,
  },
  messageRowInbound: {
    justifyContent: 'flex-start',
  },
  messageRowOutbound: {
    justifyContent: 'flex-end',
  },
  messageBubble: {
    maxWidth: '84%',
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 11,
    gap: 5,
  },
  inboundBubble: {
    backgroundColor: 'rgba(16,42,120,0.88)',
    borderTopLeftRadius: 6,
  },
  outboundBubble: {
    backgroundColor: 'rgba(0,168,248,0.92)',
    borderTopRightRadius: 6,
  },
  imageMessageBubble: {
    paddingHorizontal: 6,
    paddingTop: 6,
  },
  failedBubble: {
    backgroundColor: COLORS.dangerSoft,
  },
  messageSearchMatch: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.26)',
  },
  messageText: {
    color: COLORS.text,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '500',
  },
  messageMeta: {
    color: COLORS.meta,
    fontSize: 11,
    fontWeight: '800',
    textAlign: 'right',
  },
  messageMetaRow: {
    alignSelf: 'flex-end',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 1,
  },
  messageImage: {
    width: 214,
    height: 228,
    borderRadius: 14,
    backgroundColor: COLORS.bg,
  },
  messageFileCard: {
    minWidth: 214,
    maxWidth: 248,
    minHeight: 54,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    backgroundColor: 'rgba(6,18,58,0.32)',
  },
  messageFileIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accentSoft,
  },
  messageFileCopy: {
    flex: 1,
    minWidth: 0,
  },
  messageFileTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '900',
  },
  messageFileSubtitle: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 2,
    fontWeight: '700',
  },
  messageLocationCard: {
    minWidth: 214,
    maxWidth: 248,
    minHeight: 58,
    borderRadius: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    backgroundColor: 'rgba(6,18,58,0.32)',
  },
  messageLocationIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
  },
  messageLocationCopy: {
    flex: 1,
    minWidth: 0,
  },
  messageLocationTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '900',
  },
  messageLocationSubtitle: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 2,
    fontWeight: '700',
  },
  quotedMessage: {
    minWidth: 190,
    maxWidth: 248,
    borderRadius: 12,
    flexDirection: 'row',
    overflow: 'hidden',
    backgroundColor: 'rgba(6,18,58,0.3)',
  },
  quotedMessageMarker: {
    width: 3,
    backgroundColor: COLORS.accent,
  },
  quotedMessageCopy: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  quotedMessageTitle: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '900',
  },
  quotedMessageText: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 1,
    fontWeight: '700',
  },
  commentContext: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: 'rgba(6,18,58,0.28)',
  },
  commentContextText: {
    color: COLORS.meta,
    fontSize: 11,
    fontWeight: '900',
  },
  messageRoutingNote: {
    color: COLORS.meta,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
  },
  messageReactions: {
    position: 'absolute',
    right: 6,
    bottom: -13,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  messageReaction: {
    fontSize: 13,
  },
  systemMessageRow: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  systemMessageBubble: {
    maxWidth: '84%',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: 'rgba(16,42,120,0.62)',
  },
  systemMessageText: {
    color: COLORS.meta,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
  replyPreviewBar: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.panel,
  },
  replyPreviewMarker: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: 999,
    backgroundColor: COLORS.accent,
  },
  replyPreviewCopy: {
    flex: 1,
    minWidth: 0,
  },
  replyPreviewTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '900',
  },
  replyPreviewText: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 1,
    fontWeight: '700',
  },
  replyPreviewClose: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panelSoft,
  },
  draftAttachmentStrip: {
    gap: 9,
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: COLORS.panel,
  },
  draftAttachment: {
    width: 74,
    height: 74,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: COLORS.bg,
  },
  draftAttachmentImage: {
    width: 74,
    height: 74,
  },
  draftAttachmentRemove: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  messageActionSheetBody: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
  },
  messageActionPreview: {
    borderRadius: 18,
    padding: 12,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  messageActionPreviewText: {
    color: COLORS.text,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '800',
  },
  reactionRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 8,
  },
  reactionButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panelSoft,
  },
  reactionEmoji: {
    fontSize: 24,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    paddingHorizontal: 7,
    paddingTop: 5,
    paddingBottom: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.panel,
  },
  composerHasContent: {
    backgroundColor: COLORS.panel,
  },
  composerChannelButton: {
    width: 32,
    height: 36,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerPlus: {
    width: 32,
    height: 36,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  messageInputWrap: {
    flex: 1,
    minHeight: 36,
    maxHeight: 112,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: COLORS.panelSoft,
    overflow: 'hidden',
  },
  messageInputWrapWithSchedule: {
    paddingRight: 2,
  },
  composerInput: {
    flex: 1,
    minHeight: 36,
    maxHeight: 106,
    color: COLORS.text,
    paddingHorizontal: 11,
    paddingTop: 8,
    paddingBottom: 8,
    fontSize: 15,
    lineHeight: 20,
  },
  composerScheduleButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 1,
  },
  composerTrailingActions: {
    minWidth: 74,
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 5,
  },
  composerTrailingActionsCompact: {
    minWidth: 36,
  },
  composerIconButton: {
    width: 34,
    height: 36,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  composerSendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
  },
  sendButton: {
    minHeight: 44,
    borderRadius: 18,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  sendLabel: {
    color: COLORS.white,
    fontWeight: '900',
  },
  appointmentChoiceSubtext: {
    color: COLORS.muted,
    fontSize: 10,
    fontWeight: '500',
    marginTop: 2,
    maxWidth: 124,
  },
  appointmentInputReadOnly: {
    color: COLORS.muted,
  },
  appointmentSegmentedTab: {
    flex: 1,
    minWidth: 0,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  appointmentSegmentedTabActive: {
    backgroundColor: 'rgba(255,255,255,0.09)',
  },
  appointmentSegmentedTabs: {
    minHeight: 56,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(255,255,255,0.035)',
    flexDirection: 'row',
    padding: 5,
    gap: 5,
  },
  appointmentAdvancedPanel: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(255,255,255,0.025)',
    padding: 12,
    gap: 14,
  },
  appointmentPickerGroup: {
    gap: 8,
  },
  appointmentPickerTitle: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '900',
  },
  appointmentPickerRow: {
    gap: 8,
    paddingRight: 16,
  },
  appointmentPickerWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  appointmentPickerChip: {
    minHeight: 34,
    minWidth: 48,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(16,42,120,0.58)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  appointmentPickerChipActive: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accentSoft,
  },
  appointmentPickerText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '900',
  },
  appointmentPickerTextActive: {
    color: COLORS.text,
  },
  appointmentInlineLoading: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  appointmentGuestSection: {
    gap: 10,
  },
  appointmentGuestHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  appointmentGuestCount: {
    minWidth: 25,
    height: 25,
    borderRadius: 13,
    backgroundColor: COLORS.accent,
    color: COLORS.text,
    overflow: 'hidden',
    textAlign: 'center',
    textAlignVertical: 'center',
    fontSize: 12,
    fontWeight: '900',
  },
  appointmentGuestResults: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
  },
  appointmentGuestManual: {
    flexDirection: 'row',
    gap: 10,
  },
  appointmentGuestAddButton: {
    minHeight: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: 'rgba(0,168,248,0.45)',
    backgroundColor: COLORS.accentSoft,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 14,
  },
  appointmentGuestAddText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '900',
  },
  appointmentGuestList: {
    gap: 8,
  },
  appointmentGuestItem: {
    minHeight: 52,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(255,255,255,0.025)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  appointmentGuestAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  appointmentGuestCopy: {
    flex: 1,
    minWidth: 0,
  },
  appointmentGuestName: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '900',
  },
  appointmentGuestContact: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  appointmentGuestRemove: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  calendarMiniDay: {
    width: '14.2857%',
    height: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calendarMiniDayDot: {
    position: 'absolute',
    bottom: 1,
    width: 2,
    height: 2,
    borderRadius: 1,
    backgroundColor: COLORS.accent,
  },
  calendarMiniDayMuted: {
    opacity: 0.34,
  },
  calendarMiniDaySelected: {
    borderRadius: 8,
    backgroundColor: COLORS.primary,
  },
  calendarMiniDayText: {
    color: COLORS.text,
    fontSize: 7,
    fontWeight: '800',
  },
  calendarMiniDayTextMuted: {
    color: COLORS.muted,
  },
  calendarMiniDayTextSelected: {
    color: COLORS.bg,
  },
  calendarMiniDayTextToday: {
    color: COLORS.accent,
  },
  calendarMiniMonthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 6,
  },
  calendarMonthSwipePage: {
    backgroundColor: COLORS.bg,
  },
  calendarMonthSwipeTrack: {
    flexDirection: 'row',
  },
  calendarMonthSwipeViewport: {
    overflow: 'hidden',
    backgroundColor: COLORS.bg,
  },
  calendarSurfaceMuted: {
    opacity: 0.62,
  },
  calendarTimelineBody: {
    flexDirection: 'row',
  },
  calendarTimelineColumns: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
  },
  calendarTimelineEvent: {
    position: 'absolute',
    left: 7,
    right: 8,
    minHeight: 36,
    borderRadius: 12,
    borderLeftWidth: 5,
    borderWidth: 1,
    borderColor: 'rgba(183,207,255,0.18)',
    backgroundColor: COLORS.panelSoft,
    paddingHorizontal: 8,
    paddingVertical: 6,
    overflow: 'hidden',
  },
  calendarTimelineEventLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  calendarTimelineEventTime: {
    color: COLORS.muted,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '700',
    marginTop: 2,
  },
  calendarTimelineEventTitle: {
    color: COLORS.text,
    fontSize: 12,
    lineHeight: 14,
    fontWeight: '800',
  },
  calendarTimelineGrid: {
    flex: 1,
    minWidth: 0,
    height: TIMELINE_GRID_HEIGHT,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: COLORS.border,
    position: 'relative',
  },
  calendarTimelineHourColumn: {
    width: 48,
    height: TIMELINE_GRID_HEIGHT,
  },
  calendarTimelineHourLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.border,
  },
  calendarTimelineHourText: {
    height: TIMELINE_HOUR_HEIGHT,
    color: COLORS.muted,
    fontSize: 10,
    fontWeight: '800',
    paddingTop: 1,
  },
  calendarTimelineNowLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: COLORS.danger,
  },
  calendarTimelineNowText: {
    position: 'absolute',
    right: 4,
    top: -15,
    color: COLORS.danger,
    fontSize: 10,
    fontWeight: '900',
  },
  calendarTimelinePanel: {
    paddingHorizontal: 12,
    paddingTop: 2,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  calendarTimelineResponderLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  calendarTimelineSelection: {
    position: 'absolute',
    left: 4,
    right: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(70,185,255,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(70,185,255,0.48)',
  },
  calendarTitleSwipePage: {
    minWidth: 0,
  },
  calendarTitleSwipeTrack: {
    flexDirection: 'row',
  },
  calendarTitleSwipeViewport: {
    overflow: 'hidden',
  },
  calendarViewPicker: {
    marginHorizontal: 18,
    marginTop: 12,
    marginBottom: 4,
    minHeight: 38,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(255,255,255,0.035)',
    flexDirection: 'row',
    padding: 4,
    gap: 4,
  },
  calendarViewPickerButton: {
    flex: 1,
    minWidth: 0,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calendarViewPickerButtonActive: {
    backgroundColor: COLORS.panelSoft,
  },
  calendarViewPickerText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '900',
  },
  calendarViewPickerTextActive: {
    color: COLORS.text,
  },
  calendarWeekDayButton: {
    flex: 1,
    minHeight: 50,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  calendarWeekDayButtonSelected: {
    backgroundColor: COLORS.accentSoft,
  },
  calendarWeekDayCount: {
    minWidth: 16,
    minHeight: 16,
    borderRadius: 8,
    overflow: 'hidden',
    textAlign: 'center',
    color: COLORS.bg,
    backgroundColor: COLORS.accent,
    fontSize: 10,
    fontWeight: '900',
  },
  calendarWeekDayLabel: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '900',
  },
  calendarWeekDayNumber: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '900',
  },
  calendarWeekDayNumberSelected: {
    color: COLORS.accent,
  },
  calendarWeekDayToday: {
    color: COLORS.accent,
  },
  calendarWeekTimelineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 58,
    marginBottom: 8,
  },
  calendarWeekTimelineSpacer: {
    width: 48,
  },
  calendarYearButton: {
    width: '33.3333%',
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  calendarYearButtonSelected: {
    backgroundColor: COLORS.accentSoft,
  },
  calendarYearButtonSelectedText: {
    color: COLORS.text,
  },
  calendarYearButtonText: {
    color: COLORS.text,
    fontSize: 25,
    fontWeight: '900',
  },
  calendarYearButtonTodayText: {
    color: COLORS.accent,
  },
  calendarYearsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 22,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  freeSlotChip: {
    width: '31%',
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.035)',
  },
  freeSlotChipActive: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accentSoft,
  },
  freeSlotCount: {
    color: COLORS.muted,
    fontSize: 10,
    fontWeight: '800',
    marginTop: 3,
  },
  freeSlotDate: {
    color: COLORS.muted,
    fontSize: 10,
    fontWeight: '600',
  },
  freeSlotDateActive: {
    color: COLORS.text,
  },
  freeSlotDateChip: {
    width: 132,
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(255,255,255,0.035)',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  freeSlotDateChipActive: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accentSoft,
  },
  freeSlotDateRow: {
    gap: 8,
    paddingLeft: 18,
    paddingRight: 34,
  },
  freeSlotPanel: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(255,255,255,0.025)',
    padding: 10,
  },
  freeSlotStack: {
    gap: 8,
  },
  freeSlotTime: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 3,
  },
  freeSlotTimeActive: {
    color: COLORS.accent,
  },
  freeSlotTimeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  appointmentSheetBody: {
    padding: 14,
    gap: 12,
  },
  channelOptionCopy: {
    flex: 1,
    minWidth: 0,
  },
  channelOptionIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  channelOptionRow: {
    minHeight: 58,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(6,18,58,0.48)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  channelOptionRowActive: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accentSoft,
  },
  channelOptionSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
    fontWeight: '700',
  },
  channelOptionTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '900',
  },
  channelSheetBody: {
    gap: 7,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 18,
  },
  clabeSheetBody: {
    padding: 14,
    gap: 12,
  },
  composerInputDisabled: {
    color: COLORS.muted,
  },
  composerKeyboardActive: {
    paddingBottom: 4,
    backgroundColor: COLORS.panel,
  },
  composerRecordingButton: {
    backgroundColor: COLORS.danger,
  },
  contactDetailAvatar: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
    overflow: 'hidden',
  },
  contactDetailAvatarImage: {
    width: 78,
    height: 78,
  },
  contactDetailAvatarText: {
    color: COLORS.white,
    fontSize: 30,
    fontWeight: '900',
  },
  contactDetailBody: {
    gap: 12,
    padding: 12,
    paddingBottom: 28,
  },
  contactDetailEditableRow: {
    minHeight: 48,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(6,18,58,0.42)',
  },
  contactDetailEmpty: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  contactDetailError: {
    color: COLORS.danger,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    fontWeight: '800',
  },
  contactDetailHeader: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.panel,
  },
  contactDetailHeaderSpacer: {
    width: 34,
    height: 34,
  },
  contactDetailHeaderTitle: {
    flex: 1,
    minWidth: 0,
  },
  contactDetailHero: {
    alignItems: 'center',
    gap: 8,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 14,
    backgroundColor: 'rgba(16,42,120,0.62)',
  },
  contactDetailHeroMeta: {
    color: COLORS.muted,
    fontSize: 13,
    fontWeight: '800',
  },
  contactDetailMetric: {
    flex: 1,
    minHeight: 92,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 11,
    backgroundColor: 'rgba(16,42,120,0.58)',
  },
  contactDetailMetricHint: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '700',
    marginTop: 3,
  },
  contactDetailMetricLabel: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  contactDetailMetricValue: {
    color: COLORS.text,
    fontSize: 21,
    fontWeight: '900',
    marginTop: 8,
  },
  contactDetailMetrics: {
    flexDirection: 'row',
    gap: 10,
  },
  contactDetailMiniButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accentSoft,
  },
  contactDetailNameEditor: {
    width: '100%',
    minHeight: 44,
    borderRadius: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingLeft: 12,
    backgroundColor: COLORS.panelSoft,
  },
  contactDetailNameInput: {
    flex: 1,
    minHeight: 44,
    color: COLORS.text,
    fontSize: 19,
    fontWeight: '900',
    textAlign: 'center',
  },
  contactDetailQuickAction: {
    flex: 1,
    minHeight: 48,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(16,42,120,0.62)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  contactDetailQuickActionText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '900',
  },
  contactDetailQuickActions: {
    flexDirection: 'row',
    gap: 10,
  },
  contactDetailRow: {
    minHeight: 48,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(6,18,58,0.32)',
  },
  contactDetailRowCopy: {
    flex: 1,
    minWidth: 0,
  },
  contactDetailRowIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accentSoft,
  },
  contactDetailRowInput: {
    flex: 1,
    minHeight: 44,
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '800',
  },
  contactDetailRowLabel: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '800',
  },
  contactDetailRowValue: {
    color: COLORS.text,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
    fontWeight: '800',
  },
  contactDetailSaveButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 3,
    backgroundColor: COLORS.accent,
  },
  contactDetailSection: {
    gap: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 10,
    backgroundColor: 'rgba(16,42,120,0.48)',
  },
  contactDetailSectionTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
    marginBottom: 2,
  },
  contactDetailSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 1,
    fontWeight: '700',
  },
  contactDetailTitle: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '900',
  },
  conversationBodyKeyboardActive: {
    backgroundColor: COLORS.panel,
  },
  conversationCallActions: {
    width: 84,
    minWidth: 84,
    height: 40,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    overflow: 'hidden',
    backgroundColor: 'rgba(16,42,120,0.72)',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  conversationCallButton: {
    width: 41,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
  },
  draftAttachmentFile: {
    width: 74,
    height: 74,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    padding: 7,
    backgroundColor: COLORS.panelSoft,
  },
  draftAttachmentFileText: {
    color: COLORS.text,
    fontSize: 9,
    lineHeight: 12,
    textAlign: 'center',
    fontWeight: '800',
  },
  messageAudioState: {
    color: COLORS.meta,
    fontSize: 11,
    fontWeight: '900',
  },
  messageStarredFlag: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
    backgroundColor: 'rgba(6,18,58,0.24)',
  },
  messageStarredText: {
    color: COLORS.meta,
    fontSize: 10,
    fontWeight: '900',
  },
  paymentSheetBody: {
    padding: 14,
    gap: 12,
  },
  sheetFormBlock: {
    gap: 10,
    padding: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bg,
  },
  sheetInlineInputs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sheetInput: {
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    color: COLORS.text,
    paddingHorizontal: 13,
    paddingVertical: 10,
    fontSize: 15,
    fontWeight: '700',
  },
  sheetInputFlex: {
    flex: 1,
    minWidth: 0,
  },
  sheetInputShort: {
    width: 104,
  },
  sheetPill: {
    flex: 1,
    minHeight: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  sheetPillActive: {
    borderColor: COLORS.accent,
    backgroundColor: COLORS.accentSoft,
  },
  sheetPillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sheetPillText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '900',
  },
  sheetPillTextActive: {
    color: COLORS.text,
  },
  sheetTextArea: {
    minHeight: 96,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    color: COLORS.text,
    paddingHorizontal: 13,
    paddingVertical: 11,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  templatesSheetBody: {
    minHeight: 160,
  },
  voiceRecordingBar: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.panel,
  },
  voiceRecordingDone: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
  },
  voiceRecordingIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.danger,
  },
  voiceRecordingText: {
    flex: 1,
    minWidth: 0,
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '900',
  },
});
