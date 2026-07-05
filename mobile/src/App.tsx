import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  KeyboardAvoidingView,
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
} from 'react-native';
import type { ImageStyle } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import * as ImagePicker from 'expo-image-picker';
import {
  Archive,
  Activity,
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
  CreditCard,
  DollarSign,
  FileText,
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
  Sun,
  Tag,
  Target,
  Trash2,
  TrendingDown,
  TrendingUp,
  User,
  Users,
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
  CalendarEventItem,
  CalendarItem,
  ChatContact,
  ChatMessage,
  ChatAttachment,
  ConfigValue,
  ContactCustomFieldDefinition,
  ContactTag,
  CustomLabels,
  ConversationAgentState,
  AIAgentConfigStatus,
  DashboardFunnelRow,
  DashboardFunnelScope,
  DashboardMetrics,
  OriginDistributionData,
  PhoneSection,
  PhoneThemePreference,
  ProductItem,
  ProductPrice,
  RistakUser,
  SourceDatum,
  TransactionItem,
  WhatsAppApiTemplate,
  WhatsAppApiPhoneNumber,
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

type SessionState = {
  baseUrl: string;
  token: string;
  user: RistakUser | null;
};

type Screen = 'boot' | 'login' | 'shell';
type ChatFilterId = string;
type ChatSheetMode = 'chatMore' | 'newChat' | 'cameraShare' | 'tag' | 'schedule' | null;
type ConversationSheetMode = 'attachments' | 'messageActions' | 'chatMore' | 'tag' | 'schedule' | null;
type CalendarViewMode = 'day' | 'week' | 'month' | 'year';
type CalendarSheetMode = 'calendar' | 'contactPicker' | 'event' | 'appointmentForm' | null;
type AppointmentFormMode = 'create' | 'edit';
type AgentAction = 'activate' | 'pause' | 'take_over' | 'skip';
type ChannelBadgeKind = 'whatsapp' | 'instagram' | 'messenger' | 'facebook_comment' | 'instagram_comment' | 'email' | 'sms' | 'unknown';
type PaymentView = 'select' | 'single' | 'partial' | 'subscription' | 'products';
type RecentPaymentsPeriod = 'today' | '7d' | '30d' | '90d';
type ProductFormMode = 'create' | 'edit' | null;
type SettingsPanel = 'templates' | 'agent' | 'chats' | 'custom-fields' | 'appearance' | 'notifications' | null;
type ConversationDraftAttachment = {
  id: string;
  uri: string;
  dataUrl: string;
  kind: 'image';
  name: string;
  mimeType: string;
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
const CALENDAR_SELECTED_ID_STORAGE_KEY = 'ristak.native.calendar.selectedCalendarId.v1';
const CALENDAR_WEEKDAYS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
const APPOINTMENT_STATUS_OPTIONS = [
  { value: 'pending', label: 'Pendiente' },
  { value: 'confirmed', label: 'Confirmada' },
  { value: 'cancelled', label: 'Cancelada' },
  { value: 'showed', label: 'Asistió' },
  { value: 'noshow', label: 'No asistió' },
  { value: 'rescheduled', label: 'Reprogramada' },
];
const APPOINTMENT_DURATION_OPTIONS = [30, 45, 60, 90, 120];
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
        <View style={styles.logoMark}>
          <Text style={styles.logoText}>R</Text>
        </View>
        <Text style={styles.title}>Ristak</Text>
        <ActivityIndicator color={COLORS.accent} />
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
            <View style={styles.logoMark}>
              <Text style={styles.logoText}>R</Text>
            </View>
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
    api.getConfig(['account_timezone'])
      .then((response) => {
        if (cancelled) return;
        const values = response && typeof response === 'object' && 'config' in response
          ? response.config
          : response;
        const timezone = values && typeof values === 'object' && 'account_timezone' in values
          ? values.account_timezone
          : '';
        setBusinessTimezone(resolveBusinessTimezone(typeof timezone === 'string' ? timezone : ''));
      })
      .catch(() => {
        if (!cancelled) setBusinessTimezone(resolveBusinessTimezone());
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

function calendarIsActive(calendar: CalendarItem) {
  if (calendar.isActive === false || calendar.active === false) return false;
  return true;
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
  const year = formatBusinessYear(dateOnly);
  if (!label) return '';
  const capitalized = `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
  return year ? `${capitalized} de ${year}` : capitalized;
}

function CalendarSection({ api, footer }: { api: RistakApiClient; footer?: React.ReactNode }) {
  const initialToday = useMemo(() => todayDateOnlyInBusinessTimezone(), []);
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
  const sheetCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeCalendars = useMemo(() => calendars.filter(calendarIsActive), [calendars]);
  const selectedCalendar = useMemo(() => {
    return calendars.find((calendar) => getCalendarKey(calendar) === selectedCalendarId) || activeCalendars[0] || calendars[0] || null;
  }, [activeCalendars, calendars, selectedCalendarId]);
  const selectedCalendarKey = getCalendarKey(selectedCalendar);
  const todayDateOnly = useMemo(() => todayDateOnlyInBusinessTimezone(businessTimezone), [businessTimezone]);
  const monthCells = useMemo(
    () => buildBusinessMonthCells(currentMonthDateOnly, todayDateOnly),
    [currentMonthDateOnly, todayDateOnly],
  );
  const monthRange = useMemo(() => getBusinessMonthRange(currentMonthDateOnly), [currentMonthDateOnly]);
  const eventRange = useMemo(() => {
    if (calendarView === 'year') {
      const yearDate = dateOnlyToCalendarDate(currentMonthDateOnly) || new Date();
      const year = yearDate.getFullYear();
      return {
        startDate: `${year}-01-01`,
        endDate: `${year}-12-31`,
      };
    }

    if (calendarView === 'week') {
      const selectedDate = dateOnlyToCalendarDate(selectedDateOnly) || new Date();
      const start = new Date(selectedDate);
      start.setDate(selectedDate.getDate() - selectedDate.getDay());
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      return {
        startDate: dateOnlyFromCalendarDate(start),
        endDate: dateOnlyFromCalendarDate(end),
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
  }, [calendarView, currentMonthDateOnly, monthRange.gridEnd, monthRange.gridStart, selectedDateOnly]);
  const eventRangeTimestamps = useMemo(
    () => getBusinessRangeTimestamps(eventRange.startDate, eventRange.endDate, businessTimezone),
    [businessTimezone, eventRange.endDate, eventRange.startDate],
  );

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
    if (calendarView === 'year') setCalendarView('month');
  }, [calendarView]);

  const movePeriod = useCallback((direction: -1 | 1) => {
    if (calendarView === 'month' || calendarView === 'year') {
      const next = calendarView === 'year'
        ? addBusinessDateOnlyMonths(currentMonthDateOnly, direction * 12)
        : addBusinessDateOnlyMonths(currentMonthDateOnly, direction);
      setCurrentMonthDateOnly(next);
      setSelectedDateOnly((current) => {
        const currentDate = dateOnlyToCalendarDate(current);
        const nextDate = dateOnlyToCalendarDate(next);
        if (!currentDate || !nextDate) return next;
        const target = new Date(nextDate.getFullYear(), nextDate.getMonth(), Math.min(currentDate.getDate(), 28), 12, 0, 0, 0);
        return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
      });
      return;
    }

    const days = calendarView === 'week' ? 7 : 1;
    const next = addBusinessDateOnlyDays(selectedDateOnly, direction * days);
    setSelectedDateOnly(next);
    setCurrentMonthDateOnly(next);
  }, [calendarView, currentMonthDateOnly, selectedDateOnly]);

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
      const response = await api.getCalendarEvents(eventRangeTimestamps.startTime, eventRangeTimestamps.endTime, selectedCalendarKey);
      setEvents(unwrapCalendarEvents(response));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las citas.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api, eventRangeTimestamps.endTime, eventRangeTimestamps.startTime, selectedCalendarKey]);

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

  const goToday = useCallback(() => {
    const today = todayDateOnlyInBusinessTimezone(businessTimezone);
    setSelectedDateOnly(today);
    setCurrentMonthDateOnly(today);
    setCalendarView('month');
  }, [businessTimezone]);

  const openCreateSheet = useCallback(() => {
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
    setAppointmentMode('create');
    setAppointmentDraft({
      title,
      appointmentStatus: 'confirmed',
      dateOnly: selectedDateOnly,
      startTime: getDefaultAppointmentStartTime(selectedDateOnly, businessTimezone),
      durationMinutes: 60,
      address: '',
      notes: '',
      contactId: contact.id,
      contact,
      calendarId: selectedCalendarKey,
    });
    openSheet('appointmentForm');
  }, [businessTimezone, openSheet, selectedCalendarKey, selectedDateOnly]);

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

    setAppointmentMode('edit');
    setAppointmentDraft({
      eventId,
      title: getEventTitle(event),
      appointmentStatus: String(event.appointmentStatus || event.appointment_status || event.status || 'confirmed'),
      dateOnly: startFields.dateOnly || selectedDateOnly,
      startTime: startFields.time || getDefaultAppointmentStartTime(selectedDateOnly, businessTimezone),
      durationMinutes,
      address: String(event.address || event.location || ''),
      notes: String(event.notes || event.description || ''),
      contactId: getEventContactId(event),
      contact: null,
      calendarId: getEventCalendarId(event) || selectedCalendarKey,
    });
    openSheet('appointmentForm');
  }, [businessTimezone, openSheet, selectedCalendarKey, selectedDateOnly]);

  const saveAppointmentDraft = useCallback(async (draft: AppointmentDraft) => {
    if (appointmentBusy) return;
    const calendarId = draft.calendarId || selectedCalendarKey;
    if (!calendarId) {
      Alert.alert('Selecciona calendario', 'Elige un calendario activo antes de guardar.');
      return;
    }
    if (!draft.title.trim()) {
      Alert.alert('Falta título', 'Escribe el nombre de la cita.');
      return;
    }
    if (appointmentMode === 'create' && !draft.contactId) {
      Alert.alert('Contacto requerido', 'Selecciona un contacto para crear la cita.');
      return;
    }

    const endFields = addMinutesToBusinessDateTime(draft.dateOnly, draft.startTime, draft.durationMinutes);
    const startIso = localBusinessDateTimeToUTCISOString(draft.dateOnly, draft.startTime, businessTimezone);
    const endIso = localBusinessDateTimeToUTCISOString(endFields.dateOnly, endFields.time, businessTimezone);
    if (!startIso || !endIso) {
      Alert.alert('Horario inválido', 'Usa fecha YYYY-MM-DD y hora HH:mm.');
      return;
    }

    const payload: Record<string, unknown> = {
      title: draft.title.trim(),
      appointmentStatus: draft.appointmentStatus,
      startTime: startIso,
      endTime: endIso,
      notes: draft.notes.trim(),
      address: draft.address.trim(),
      timeZone: businessTimezone,
    };
    if (appointmentMode === 'create') {
      payload.calendarId = calendarId;
      payload.contactId = draft.contactId;
    }

    setAppointmentBusy(true);
    try {
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
  }, [api, appointmentBusy, appointmentMode, businessTimezone, closeSheet, loadEvents, selectedCalendarKey]);

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
  const displayMonthTitle = calendarView === 'year' ? formatBusinessYear(currentMonthDateOnly) : formatBusinessMonthTitle(currentMonthDateOnly);
  const displayMonthSubtitle = calendarView === 'month'
    ? formatBusinessYear(currentMonthDateOnly)
    : formatBusinessDayHeader(selectedDateOnly);

  return (
    <AppFrame>
      <View style={styles.calendarPage}>
        <View style={styles.calendarHeader}>
          <View style={styles.calendarToolbar}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setCalendarView(calendarView === 'year' ? 'month' : 'year')}
              style={({ pressed }) => [styles.calendarPeriodChip, pressed && styles.pressed]}
            >
              <ChevronLeft size={20} color={COLORS.text} strokeWidth={2.8} />
              <Text numberOfLines={1} style={styles.calendarPeriodText}>
                {formatBusinessYear(currentMonthDateOnly)}
              </Text>
            </Pressable>
            <View style={styles.calendarHeaderCapsule}>
              <Pressable
                accessibilityRole="button"
                onPress={goToday}
                style={({ pressed }) => [styles.calendarCapsuleTodayButton, pressed && styles.pressed]}
              >
                <Text style={styles.calendarTodayButtonText}>Hoy</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => openSheet('calendar')}
                style={({ pressed }) => [styles.calendarCapsuleIconButton, pressed && styles.pressed]}
              >
                <CalendarDays size={25} color={COLORS.text} strokeWidth={2.35} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={openCreateSheet}
                style={({ pressed }) => [styles.calendarCapsuleIconButton, pressed && styles.pressed]}
              >
                <Plus size={30} color={COLORS.text} strokeWidth={2.25} />
              </Pressable>
            </View>
          </View>
          <View style={styles.calendarTitleRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setCalendarView(calendarView === 'year' ? 'month' : 'year')}
              style={styles.calendarTitleButton}
            >
              <Text numberOfLines={1} style={styles.calendarTitle}>{displayMonthTitle}</Text>
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
            data={calendarView === 'year' ? nextUpcomingEvents : agendaEvents}
            keyExtractor={(item, index) => getEventKey(item, index)}
            refreshControl={<RefreshControl tintColor={COLORS.accent} refreshing={refreshing} onRefresh={refresh} />}
            contentContainerStyle={styles.calendarScrollBody}
            ListHeaderComponent={(
              <>
                {calendarView === 'year' ? (
                  <CalendarYearOverview
                    currentMonthDateOnly={currentMonthDateOnly}
                    eventsByDate={eventsByDate}
                    selectedDateOnly={selectedDateOnly}
                    todayDateOnly={todayDateOnly}
                    onSelect={(dateOnly) => {
                      setCalendarView('month');
                      selectDate(dateOnly);
                    }}
                  />
                ) : (
                  <CalendarMonthGrid
                    cells={monthCells}
                    eventsByDate={eventsByDate}
                    selectedDateOnly={selectedDateOnly}
                    onSelectDate={selectDate}
                  />
                )}
                <View style={styles.calendarAgendaHeader}>
                  <View style={styles.calendarAgendaHeaderCopy}>
                    <Text style={styles.calendarAgendaDate}>
                      {calendarView === 'year' ? 'Próximas citas' : formatCalendarAgendaDate(selectedDateOnly)}
                    </Text>
                    <Text style={styles.calendarAgendaTitle}>
                      {calendarView === 'year'
                        ? `${nextUpcomingEvents.length} en este rango`
                        : agendaEvents.length ? `${agendaEvents.length} cita${agendaEvents.length === 1 ? '' : 's'}` : 'Sin citas'}
                    </Text>
                  </View>
                  {loading || refreshing ? <ActivityIndicator color={COLORS.text} /> : null}
                </View>
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
              ) : (
                <CalendarEmptyState
                  title={calendarView === 'year' ? 'No hay citas próximas' : 'No hay citas en este día'}
                  subtitle={calendarView === 'year'
                    ? 'Cambia de calendario o crea una cita nueva.'
                    : 'Toca otro día del mes o agenda una cita para este contacto.'}
                />
              )
            )}
          />
        )}

        <CalendarPickerSheet
          calendars={calendars}
          closing={calendarSheetClosing}
          open={calendarSheetOpen}
          selectedCalendarId={selectedCalendarKey}
          onClose={closeSheet}
          onSelect={chooseCalendar}
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

function CalendarMonthGrid({
  cells,
  eventsByDate,
  selectedDateOnly,
  onSelectDate,
}: {
  cells: ReturnType<typeof buildBusinessMonthCells>;
  eventsByDate: Record<string, CalendarEventItem[]>;
  selectedDateOnly: string;
  onSelectDate: (dateOnly: string) => void;
}) {
  return (
    <View style={styles.calendarSurface}>
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
  onSelect,
}: {
  currentMonthDateOnly: string;
  eventsByDate: Record<string, CalendarEventItem[]>;
  selectedDateOnly: string;
  todayDateOnly: string;
  onSelect: (dateOnly: string) => void;
}) {
  const yearDate = dateOnlyToCalendarDate(currentMonthDateOnly) || new Date();
  const year = yearDate.getFullYear();

  return (
    <View style={styles.calendarYearGrid}>
      {Array.from({ length: 12 }).map((_, monthIndex) => {
        const dateOnly = `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`;
        const range = getBusinessMonthRange(dateOnly);
        const monthEvents = Object.entries(eventsByDate)
          .filter(([key]) => key >= range.monthStart && key <= range.monthEnd)
          .reduce((total, [, list]) => total + list.length, 0);
        const selected = selectedDateOnly >= range.monthStart && selectedDateOnly <= range.monthEnd;
        const today = todayDateOnly >= range.monthStart && todayDateOnly <= range.monthEnd;

        return (
          <Pressable
            key={dateOnly}
            accessibilityRole="button"
            onPress={() => onSelect(dateOnly)}
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
            <View style={styles.calendarYearMonthDots}>
              {monthEvents ? <View style={styles.calendarYearMonthDot} /> : null}
              {monthEvents > 1 ? <View style={styles.calendarYearMonthDotWide} /> : null}
            </View>
            <Text style={styles.calendarYearMonthCount}>{monthEvents || ''}</Text>
          </Pressable>
        );
      })}
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

function CalendarEmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.calendarEmpty}>
      <View style={styles.calendarEmptyIcon}>
        <MessageCircle size={29} color={COLORS.accent} strokeWidth={2.3} />
      </View>
      <Text style={styles.calendarEmptyTitle}>{title}</Text>
      <Text style={styles.calendarEmptyText}>{subtitle}</Text>
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
  calendars,
  closing,
  open,
  selectedCalendarId,
  onClose,
  onSelect,
}: {
  calendars: CalendarItem[];
  closing: boolean;
  open: boolean;
  selectedCalendarId: string;
  onClose: () => void;
  onSelect: (calendar: CalendarItem) => void;
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
              <ContactPickerRow key={contact.id} contact={contact} onPress={() => onSelect(contact)} />
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
  const updateDraft = useCallback((updates: Partial<AppointmentDraft>) => {
    if (!draft) return;
    onChange({ ...draft, ...updates });
  }, [draft, onChange]);

  const endFields = draft
    ? addMinutesToBusinessDateTime(draft.dateOnly, draft.startTime, draft.durationMinutes)
    : { dateOnly: '', time: '' };

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
            {mode === 'create' && draft.contact ? (
              <View style={styles.appointmentContactCard}>
                <View style={styles.appointmentContactIcon}>
                  <User size={20} color={COLORS.accent} strokeWidth={2.6} />
                </View>
                <View style={styles.appointmentContactCopy}>
                  <Text numberOfLines={1} style={styles.appointmentContactName}>{getContactName(draft.contact)}</Text>
                  <Text numberOfLines={1} style={styles.appointmentContactMeta}>
                    {draft.contact.phone || draft.contact.email || 'Contacto seleccionado'}
                  </Text>
                </View>
              </View>
            ) : null}

            <AppointmentTextField
              label="Título"
              value={draft.title}
              placeholder="Nombre de la cita"
              onChangeText={(value) => updateDraft({ title: value })}
            />

            <View style={styles.appointmentFieldGrid}>
              <AppointmentTextField
                compact
                label="Fecha"
                value={draft.dateOnly}
                placeholder="YYYY-MM-DD"
                onChangeText={(value) => updateDraft({ dateOnly: value })}
              />
              <AppointmentTextField
                compact
                label="Hora"
                value={draft.startTime}
                placeholder="HH:mm"
                onChangeText={(value) => updateDraft({ startTime: value })}
              />
            </View>

            <View style={styles.appointmentSection}>
              <Text style={styles.appointmentFieldLabel}>Duración</Text>
              <View style={styles.appointmentChipRow}>
                {APPOINTMENT_DURATION_OPTIONS.map((minutes) => {
                  const selected = draft.durationMinutes === minutes;
                  return (
                    <Pressable
                      key={minutes}
                      accessibilityRole="button"
                      onPress={() => updateDraft({ durationMinutes: minutes })}
                      style={({ pressed }) => [
                        styles.appointmentChoiceChip,
                        selected && styles.appointmentChoiceChipActive,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={[styles.appointmentChoiceText, selected && styles.appointmentChoiceTextActive]}>
                        {minutes}m
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.appointmentHint}>
                Termina {endFields.dateOnly !== draft.dateOnly ? `${endFields.dateOnly} ` : ''}{endFields.time} · {timezone}
              </Text>
            </View>

            <View style={styles.appointmentSection}>
              <Text style={styles.appointmentFieldLabel}>Estado</Text>
              <View style={styles.appointmentChipRow}>
                {APPOINTMENT_STATUS_OPTIONS.map((option) => {
                  const selected = draft.appointmentStatus === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      accessibilityRole="button"
                      onPress={() => updateDraft({ appointmentStatus: option.value })}
                      style={({ pressed }) => [
                        styles.appointmentChoiceChip,
                        selected && styles.appointmentChoiceChipActive,
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
            </View>

            <AppointmentTextField
              label="Dirección"
              value={draft.address}
              placeholder="Ubicación o enlace"
              icon={MapPin}
              onChangeText={(value) => updateDraft({ address: value })}
            />
            <AppointmentTextField
              multiline
              label="Notas"
              value={draft.notes}
              placeholder="Notas internas de la cita"
              icon={FileText}
              onChangeText={(value) => updateDraft({ notes: value })}
            />

            <PrimaryButton
              label={mode === 'edit' ? 'Guardar cambios' : 'Agendar cita'}
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
  icon: Icon,
  label,
  multiline,
  placeholder,
  value,
  onChangeText,
}: {
  compact?: boolean;
  icon?: LucideIcon;
  label: string;
  multiline?: boolean;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={[styles.appointmentField, compact && styles.appointmentFieldCompact]}>
      <Text style={styles.appointmentFieldLabel}>{label}</Text>
      <View style={[styles.appointmentInputWrap, multiline && styles.appointmentInputWrapMultiline]}>
        {Icon ? <Icon size={17} color={COLORS.muted} strokeWidth={2.4} /> : null}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={COLORS.muted}
          multiline={multiline}
          textAlignVertical={multiline ? 'top' : 'center'}
          autoCapitalize="sentences"
          autoCorrect={false}
          style={[styles.appointmentInput, multiline && styles.appointmentInputMultiline]}
        />
      </View>
    </View>
  );
}

function getDateOnlyUtcTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return time;
}

function isValidDateOnly(value: string) {
  return getDateOnlyUtcTime(value) !== null;
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

function getThemeMeta(preference: PhoneThemePreference) {
  if (preference === 'light') return 'Claro';
  if (preference === 'dark') return 'Noche';
  if (preference === 'auto') return 'Horario: Noche';
  return 'Sistema: Noche';
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
  const [pushPermission, setPushPermission] = useState<NativePushPermissionStatus>('unsupported');
  const [pushBusy, setPushBusy] = useState(false);

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

  useEffect(() => {
    void getNativePushPermissionStatus().then(setPushPermission);
  }, []);

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
  }, [loadAIAgentStatus, loadCalendars]);

  useEffect(() => {
    if (activePanel === 'templates') void loadTemplates();
    if (activePanel === 'custom-fields') void loadCustomFields();
    if (activePanel === 'agent') void loadAIAgentStatus();
  }, [activePanel, loadAIAgentStatus, loadCustomFields, loadTemplates]);

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

  const requestNativePush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      const result = await subscribeToNativePushNotifications(api, { calendarIds: pushCalendarIds });
      const permission = await getNativePushPermissionStatus();
      setPushPermission(permission);
      if (result.status === 'subscribed') {
        Alert.alert('Alertas activadas', 'Este celular ya puede recibir notificaciones de Ristak.');
        return;
      }
      Alert.alert(result.status === 'not_configured' ? 'Falta preparar alertas' : 'No se activaron', result.reason);
    } catch (err) {
      Alert.alert('No se activaron las alertas', err instanceof Error ? err.message : 'Intenta otra vez.');
    } finally {
      setPushBusy(false);
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
  const chatPushEnabled = getUserBoolean('chat_push_notifications_enabled', true);
  const calendarPushEnabled = getUserBoolean('calendar_push_notifications_enabled', false);
  const appointmentConfirmationPushEnabled = getUserBoolean('appointment_confirmation_push_notifications_enabled', true);
  const paymentPushEnabled = getUserBoolean('payment_push_notifications_enabled', true);
  const notificationSoundEnabled = getUserBoolean('push_notification_sound_enabled', true);
  const notificationVibrationEnabled = getUserBoolean('push_notification_vibration_enabled', true);
  const pushCalendarIds = getUserStringArray('calendar_push_notification_calendar_ids');
  const selectedCalendarCount = pushCalendarIds.length || calendars.length;
  const blockedTemplates = templates.filter((template) => TEMPLATE_BLOCKED_STATUSES.has(getTemplateStatus(template))).length;
  const notificationCount = [
    chatPushEnabled,
    calendarPushEnabled,
    appointmentConfirmationPushEnabled,
    paymentPushEnabled,
  ].filter(Boolean).length;

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

  const handleSaveBusinessContext = async () => {
    const draft = businessContextDraft.trim();
    if (!draft || businessContextSaving || !aiReady) {
      Alert.alert(
        'Asistente Personal AI',
        aiReady ? 'Escribe la descripción del negocio primero.' : 'Conecta OpenAI para pulir y guardar la descripción.',
      );
      return;
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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo guardar la descripción.';
      setBusinessContextMessage(message);
      Alert.alert('No se guardó la descripción', message);
    } finally {
      setBusinessContextSaving(false);
    }
  };

  const togglePushCalendar = (calendarId: string) => {
    const next = pushCalendarIds.includes(calendarId)
      ? pushCalendarIds.filter((id) => id !== calendarId)
      : [...pushCalendarIds, calendarId];
    void saveUserPreference('calendar_push_notification_calendar_ids', next);
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
      { id: 'templates', title: 'Plantillas', description: 'Crear y revisar estados de Meta.', meta: templates.length ? `${templates.length} guardadas` : 'Revisar', Icon: FileText, tone: 'black' },
      { id: 'agent', title: AI_AGENT_CHAT_DISPLAY_NAME, description: 'Chat fijo y sugerencias.', meta: aiReady ? (aiAgentChatEnabled ? 'Activo' : 'Apagado') : 'Sin OpenAI', Icon: Bot, tone: 'blue' },
      { id: 'chats', title: 'Lista de chat', description: 'Orden, archivados y vista previa.', meta: conversationSortMode === 'recent' ? 'Recientes' : 'No leídas', Icon: MessageCircle, tone: 'green' },
      { id: 'custom-fields', title: 'Campos personalizados', description: 'Datos visibles en cada contacto.', meta: customFields.length ? `${customFields.length}` : 'Todos', Icon: ListChecks, tone: 'gold' },
      { id: 'appearance', title: 'Apariencia', description: 'Claro, noche, sistema u horario.', meta: getThemeMeta(themePreference), Icon: Sun, tone: 'blue' },
      { id: 'notifications', title: 'Notificaciones', description: 'Mensajes, citas, sonido y vibración.', meta: notificationCount ? `${notificationCount} activas` : 'Configurar', Icon: Bell, tone: 'red' },
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
              editable={!businessContextSaving && !aiAgentLoading}
              multiline
              placeholder="Ejemplo: Somos una clínica dental en Ciudad Juárez, atendemos familias..."
              placeholderTextColor={COLORS.muted}
              textAlignVertical="top"
              style={styles.businessDescriptionInput}
            />
            <Pressable
              accessibilityRole="button"
              disabled={!aiReady}
              onPress={() => {
                Alert.alert('Dictar', 'El dictado nativo queda pendiente de conectar al módulo de audio; por ahora escribe la descripción aquí.');
              }}
              style={({ pressed }) => [styles.businessVoiceButton, !aiReady && styles.disabledButton, pressed && styles.pressed]}
            >
              <Mic size={17} color={COLORS.white} strokeWidth={2.4} />
              <Text style={styles.businessVoiceButtonText}>Dictar</Text>
            </Pressable>
          </View>
          <View style={styles.businessDescriptionActions}>
            <Text numberOfLines={2} style={styles.businessDescriptionMessage}>
              {aiAgentLoading ? '' : businessContextMessage || (aiReady ? 'El dictado se guarda automático al terminar.' : 'OpenAI debe estar conectado para dictar y pulir.')}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={!aiReady || businessContextSaving || !descriptionChanged || !businessContextDraft.trim()}
              onPress={() => void handleSaveBusinessContext()}
              style={({ pressed }) => [styles.settingsSmallPrimaryButton, (!aiReady || businessContextSaving || !descriptionChanged || !businessContextDraft.trim()) && styles.disabledButton, pressed && styles.pressed]}
            >
              {businessContextSaving ? <ActivityIndicator color={COLORS.white} /> : <Save size={16} color={COLORS.white} strokeWidth={2.4} />}
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
            {customFields.map((definition, index) => (
              <View key={definition.definitionId || definition.fieldKey || definition.key || `field-${index}`} style={styles.customFieldRow}>
                <View style={styles.customFieldCopy}>
                  <Text numberOfLines={1} style={styles.customFieldTitle}>{definition.label || definition.name || `Campo ${index + 1}`}</Text>
                  <Text numberOfLines={1} style={styles.customFieldSubtitle}>{definition.folderName || 'Campos personalizados'} · {definition.dataType || 'text'}</Text>
                </View>
                <Check size={17} color={COLORS.accent} strokeWidth={2.8} />
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
      <Text style={styles.settingsHint}>Ahorita el chat se ve en modo {getThemeMeta(themePreference).toLowerCase()}.</Text>
    </View>
  );

  const renderNotifications = () => (
    <>
      <SettingsActionCard
        Icon={BellRing}
        title="Alertas de este celular"
        subtitle={`Permiso actual: ${formatPushPermission(pushPermission)}.`}
        actionLabel={pushPermission === 'granted' ? 'Reactivar' : 'Activar'}
        actionIcon={Bell}
        busy={pushBusy}
        onPress={() => void requestNativePush()}
      />
      <View style={styles.settingsEnabledCard}>
        <Check size={18} color="#0f6b3e" strokeWidth={2.6} />
        <Text style={styles.settingsEnabledText}>Este celular usa las preferencias guardadas de notificaciones.</Text>
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

function ContactPickerRow({ contact, onPress }: { contact: ChatContact; onPress: () => void }) {
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
      <Send size={18} color={COLORS.accent} strokeWidth={2.5} />
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

function NativeConversationScreen({
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
  const [draftAttachments, setDraftAttachments] = useState<ConversationDraftAttachment[]>([]);
  const [replyingToMessage, setReplyingToMessage] = useState<ChatMessage | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<ChatMessage | null>(null);
  const [activeSheet, setActiveSheet] = useState<ConversationSheetMode>(null);
  const [closingSheet, setClosingSheet] = useState<ConversationSheetMode>(null);
  const [chatTags, setChatTags] = useState<ContactTag[]>([]);
  const [chatTagsLoading, setChatTagsLoading] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const [tagBusy, setTagBusy] = useState(false);
  const [scheduleText, setScheduleText] = useState('');
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [agentStates, setAgentStates] = useState<ConversationAgentState[]>([]);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentBusyAction, setAgentBusyAction] = useState<AgentAction | null>(null);
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

  const loadConversation = useCallback(async (silent = false) => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const journey = await api.getConversation(contact.id, 100);
      if (requestId !== loadRequestRef.current) return;
      setMessages(buildMessagesFromJourney(contact.id, journey));
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
  const hasComposerContent = Boolean(draft.trim() || draftAttachments.length > 0);

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

  const appendImageAttachments = (assets: ImagePicker.ImagePickerAsset[]) => {
    const prepared = assets.reduce<ConversationDraftAttachment[]>((items, asset, index) => {
      if (!asset.base64) return items;
      const mimeType = asset.mimeType || 'image/jpeg';
      items.push({
        id: `draft-image-${Date.now()}-${index}`,
        uri: asset.uri,
        dataUrl: `data:${mimeType};base64,${asset.base64}`,
        kind: 'image',
        name: asset.fileName || `foto-${items.length + 1}.jpg`,
        mimeType,
      });
      return items;
    }, []);

    if (!prepared.length) {
      Alert.alert('Foto', 'No pude preparar la imagen para enviarla.');
      return;
    }

    setDraftAttachments((current) => [...current, ...prepared].slice(0, CONVERSATION_ATTACHMENT_LIMIT));
    closeSheet();
  };

  const pickImage = async (source: 'camera' | 'library') => {
    const remaining = CONVERSATION_ATTACHMENT_LIMIT - draftAttachments.length;
    if (remaining <= 0) {
      Alert.alert('Adjuntos', `Puedes preparar hasta ${CONVERSATION_ATTACHMENT_LIMIT} fotos por mensaje.`);
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
        mediaTypes: ['images'],
        quality: 0.86,
        base64: true,
      })
      : await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.86,
        base64: true,
        allowsMultipleSelection: remaining > 1,
        selectionLimit: remaining,
      });
    if (result.canceled || !result.assets?.length) return;
    appendImageAttachments(result.assets.slice(0, remaining));
  };

  const send = async () => {
    const text = draft.trim();
    const attachmentsToSend = draftAttachments;
    if ((!text && attachmentsToSend.length === 0) || sending) return;
    if (!contact.phone) {
      Alert.alert('Falta teléfono', 'Este contacto no tiene teléfono principal para enviar WhatsApp.');
      return;
    }

    const optimisticId = `local-${Date.now()}`;
    const sentAt = new Date().toISOString();
    const optimisticMessages: ChatMessage[] = attachmentsToSend.length
      ? attachmentsToSend.map((attachment, index) => ({
        id: `${optimisticId}-attachment-${index}`,
        contactId: contact.id,
        date: sentAt,
        direction: 'outbound',
        text: index === 0 ? text : '',
        channel: 'native',
        transport: 'native',
        status: 'enviando',
        pending: true,
        replyToMessageId: replyingToMessage?.id,
        attachment: {
          type: 'image',
          dataUrl: attachment.dataUrl,
          url: attachment.uri,
          name: attachment.name,
          mimeType: attachment.mimeType,
        },
      }))
      : [{
        id: optimisticId,
        contactId: contact.id,
        date: sentAt,
        direction: 'outbound',
        text,
        channel: 'native',
        transport: 'native',
        status: 'enviando',
        pending: true,
        replyToMessageId: replyingToMessage?.id,
      }];

    setDraft('');
    setDraftAttachments([]);
    setReplyingToMessage(null);
    setMessages((current) => [...current, ...optimisticMessages]);
    updateContactPreview(attachmentsToSend.length ? (text || 'Foto') : text, sentAt, 'native');
    setSending(true);
    try {
      if (attachmentsToSend.length > 0) {
        const responses = await Promise.all(attachmentsToSend.map((attachment, index) => (
          api.sendImage(contact, attachment.dataUrl, index === 0 ? text : '')
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
        const response = await api.sendText(contact, text);
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
      await api.scheduleText(target, text, scheduledAt);
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

  const navigateToContactTool = (target: ChatContact, section: PhoneSection) => {
    closeSheet();
    onNavigate?.(section);
    Alert.alert(
      section === 'calendar' ? 'Agendar cita' : 'Registrar pagos',
      `${section === 'calendar' ? 'Abriendo Citas' : 'Abriendo Pagos'} para continuar con ${getContactName(target)}.`,
    );
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

  return (
    <AppFrame>
      <View style={styles.conversationHeader}>
        <Pressable onPress={onBack} style={styles.backButton}>
          <ChevronLeft size={30} color={COLORS.text} strokeWidth={2.5} />
        </Pressable>
        <Pressable onPress={openChatMore} style={({ pressed }) => [styles.conversationContactButton, pressed && styles.pressed]}>
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
        <View style={styles.conversationHeaderActions}>
          <Pressable accessibilityRole="button" onPress={openChatMore} style={styles.conversationHeaderIconButton}>
            <Bot size={18} color={COLORS.accent} strokeWidth={2.45} />
          </Pressable>
          <Pressable accessibilityRole="button" onPress={openTagSheet} style={styles.conversationHeaderIconButton}>
            <Tag size={18} color={COLORS.accent} strokeWidth={2.45} />
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => setSearchOpen((current) => !current)} style={[styles.conversationHeaderIconButton, searchOpen && styles.conversationHeaderIconButtonActive]}>
            <Search size={18} color={COLORS.accent} strokeWidth={2.45} />
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

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={8} style={styles.conversationBody}>
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
                <Image source={{ uri: attachment.uri }} style={styles.draftAttachmentImage} />
                <Pressable accessibilityRole="button" onPress={() => removeDraftAttachment(attachment.id)} style={styles.draftAttachmentRemove}>
                  <X size={14} color={COLORS.white} strokeWidth={2.6} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}

        <View style={[styles.composer, hasComposerContent && styles.composerHasContent]}>
          <Pressable accessibilityRole="button" onPress={openChatMore} style={[styles.composerChannelButton, { backgroundColor: channelColor }]}>
            <ChannelBadgeIcon kind={channelKind} size={15} />
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => openSheet('attachments')} style={styles.composerPlus}>
            <Plus size={22} color={COLORS.accent} strokeWidth={2.55} />
          </Pressable>
          <View style={[styles.messageInputWrap, draft.trim() && styles.messageInputWrapWithSchedule]}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              placeholder=""
              placeholderTextColor={COLORS.muted}
              textAlignVertical="center"
              style={styles.composerInput}
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
              <Pressable accessibilityRole="button" onPress={() => void pickImage('camera')} style={styles.composerIconButton}>
                <Camera size={20} color={COLORS.accent} strokeWidth={2.55} />
              </Pressable>
            ) : null}
            <Pressable disabled={sending || !hasComposerContent} onPress={send} style={[styles.composerSendButton, (!hasComposerContent || sending) && styles.disabledButton]}>
              {sending ? <ActivityIndicator color={COLORS.white} /> : hasComposerContent ? <Send size={17} color={COLORS.white} strokeWidth={2.65} /> : <Mic size={19} color={COLORS.muted} strokeWidth={2.5} />}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      <NativeConversationAttachmentSheet
        closing={activeSheet !== 'attachments' && closingSheet === 'attachments'}
        contact={contact}
        open={activeSheet === 'attachments' || closingSheet === 'attachments'}
        onAppointment={() => navigateToContactTool(contact, 'calendar')}
        onCamera={() => void pickImage('camera')}
        onClose={closeSheet}
        onLibrary={() => void pickImage('library')}
        onMore={openChatMore}
        onPayment={() => navigateToContactTool(contact, 'payments')}
        onSchedule={() => {
          setScheduleText(draft);
          openSheet('schedule');
        }}
        onTag={openTagSheet}
      />

      <NativeMessageActionSheet
        closing={activeSheet !== 'messageActions' && closingSheet === 'messageActions'}
        message={selectedMessage}
        open={activeSheet === 'messageActions' || closingSheet === 'messageActions'}
        timezone={timezone}
        onClose={closeSheet}
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
        onAppointment={(target) => navigateToContactTool(target, 'calendar')}
        onArchiveToggle={toggleArchiveFromSheet}
        onClose={closeSheet}
        onMarkRead={markChatAsRead}
        onPayment={(target) => navigateToContactTool(target, 'payments')}
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
    </AppFrame>
  );
}

function NativeConversationAttachmentSheet({
  closing,
  contact,
  open,
  onAppointment,
  onCamera,
  onClose,
  onLibrary,
  onMore,
  onPayment,
  onSchedule,
  onTag,
}: {
  closing?: boolean;
  contact: ChatContact;
  open: boolean;
  onAppointment: () => void;
  onCamera: () => void;
  onClose: () => void;
  onLibrary: () => void;
  onMore: () => void;
  onPayment: () => void;
  onSchedule: () => void;
  onTag: () => void;
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
        <SheetActionRow Icon={Camera} title="Tomar foto" subtitle="Abre la cámara y deja la foto lista para enviar." onPress={onCamera} />
        <SheetActionRow Icon={ImageIcon} title="Elegir foto" subtitle="Adjunta una imagen desde tu galería." onPress={onLibrary} />
        <View style={styles.sheetSectionDivider}>
          <Text style={styles.sheetSectionLabel}>Herramientas</Text>
        </View>
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
  timezone,
  onClose,
  onInfo,
  onReact,
  onReply,
}: {
  closing?: boolean;
  message: ChatMessage | null;
  open: boolean;
  timezone: string;
  onClose: () => void;
  onInfo: (message: ChatMessage) => void;
  onReact: (message: ChatMessage, emoji: string) => void;
  onReply: (message: ChatMessage) => void;
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
  timezone,
  onLongPress,
}: {
  contact: ChatContact;
  message: ChatMessage;
  replyTarget?: ChatMessage | null;
  searchActive?: boolean;
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
    return <Image source={{ uri: imageUri }} style={styles.messageImage} />;
  }

  const Icon = attachment.type === 'audio' ? Mic : attachment.type === 'video' ? Play : FileText;
  return (
    <View style={styles.messageFileCard}>
      <View style={styles.messageFileIcon}>
        <Icon size={18} color={COLORS.accent} strokeWidth={2.5} />
      </View>
      <View style={styles.messageFileCopy}>
        <Text numberOfLines={1} style={styles.messageFileTitle}>{attachment.name || getAttachmentLabel(attachment.type)}</Text>
        <Text numberOfLines={1} style={styles.messageFileSubtitle}>{attachment.mimeType || getAttachmentLabel(attachment.type)}</Text>
      </View>
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
  businessVoiceButtonText: {
    color: COLORS.bg,
    fontSize: 13,
    fontWeight: '900',
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
  settingsEnabledText: {
    flex: 1,
    color: '#86efac',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
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
    paddingTop: 20,
    paddingHorizontal: 15,
    paddingBottom: 0,
    gap: 14,
    backgroundColor: COLORS.bg,
  },
  calendarToolbar: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  calendarPeriodChip: {
    minHeight: 50,
    minWidth: 118,
    borderRadius: 25,
    borderWidth: 1,
    borderColor: 'rgba(183,207,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.055)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  calendarPeriodText: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '900',
  },
  calendarHeaderCapsule: {
    minHeight: 52,
    flex: 1,
    maxWidth: 214,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: 'rgba(183,207,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.055)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 7,
  },
  calendarCapsuleIconButton: {
    width: 45,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  calendarCapsuleTodayButton: {
    minWidth: 72,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  calendarTitleRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  calendarTitleButton: {
    flex: 1,
    minWidth: 0,
  },
  calendarTitle: {
    color: COLORS.text,
    fontSize: 43,
    lineHeight: 49,
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
    fontSize: 19,
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
    paddingHorizontal: 18,
    paddingTop: 0,
    paddingBottom: 12,
    backgroundColor: COLORS.bg,
  },
  calendarWeekdayRow: {
    flexDirection: 'row',
    minHeight: 27,
    alignItems: 'center',
  },
  calendarWeekdayText: {
    flex: 1,
    color: COLORS.muted,
    fontSize: 16,
    fontWeight: '900',
    textAlign: 'center',
  },
  calendarMonthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calendarDayCell: {
    width: '14.2857%',
    minHeight: 48,
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
    fontSize: 23,
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
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  calendarAgendaHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  calendarAgendaDate: {
    color: COLORS.muted,
    fontSize: 16,
    fontWeight: '900',
  },
  calendarAgendaTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '900',
    marginTop: 3,
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
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    marginHorizontal: 20,
    marginTop: 11,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(183,207,255,0.18)',
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  calendarEventAccent: {
    width: 5,
    alignSelf: 'stretch',
    borderRadius: 999,
    marginVertical: 2,
  },
  calendarEventCopy: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  calendarEventTitle: {
    color: COLORS.text,
    fontSize: 21,
    fontWeight: '900',
  },
  calendarEventMeta: {
    color: COLORS.muted,
    fontSize: 15,
    fontWeight: '800',
  },
  calendarEventTimeStack: {
    minWidth: 78,
    alignItems: 'flex-end',
    gap: 3,
  },
  calendarEventTimeStart: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '900',
  },
  calendarEventTimeEnd: {
    color: COLORS.muted,
    fontSize: 16,
    fontWeight: '800',
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
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 24,
    gap: 14,
  },
  appointmentContactCard: {
    minHeight: 62,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
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
    gap: 10,
  },
  appointmentField: {
    gap: 7,
  },
  appointmentFieldCompact: {
    flex: 1,
    minWidth: 0,
  },
  appointmentFieldLabel: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  appointmentInputWrap: {
    minHeight: 46,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  appointmentInputWrapMultiline: {
    minHeight: 92,
    alignItems: 'flex-start',
    paddingTop: 12,
  },
  appointmentInput: {
    flex: 1,
    minHeight: 44,
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '800',
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  appointmentInputMultiline: {
    minHeight: 76,
    lineHeight: 20,
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
    minHeight: 36,
    borderRadius: 18,
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
    fontWeight: '900',
  },
  appointmentChoiceTextActive: {
    color: COLORS.text,
  },
  appointmentHint: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
  },
  centerScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
  },
  logoMark: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: {
    color: COLORS.white,
    fontSize: 30,
    fontWeight: '900',
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
    maxHeight: '84%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    overflow: 'hidden',
    paddingBottom: 20,
  },
  actionSheetHandle: {
    alignSelf: 'center',
    width: 48,
    height: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(170,192,231,0.38)',
    marginTop: 9,
    marginBottom: 4,
  },
  actionSheetHeader: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  actionSheetHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  actionSheetTitle: {
    color: COLORS.text,
    fontSize: 20,
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
});
