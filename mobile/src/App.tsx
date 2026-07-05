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
} from 'react-native';
import type { ImageStyle } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import * as ImagePicker from 'expo-image-picker';
import {
  Archive,
  BarChart3,
  Bell,
  BellOff,
  Bot,
  CalendarDays,
  Camera,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock,
  FileText,
  Mail,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Play,
  Send,
  Plus,
  Search,
  Settings,
  Tag,
  Trash2,
  User,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
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
import { RistakApiClient, getUserDisplayName } from './api';
import {
  buildMessagesFromJourney,
  cleanBaseUrl,
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
  formatCurrency,
  formatShortDate,
  getBusinessDateOnly,
  getBusinessDateTimeParts,
  getBusinessMonthRange,
  getContactAvatar,
  getContactName,
  getTodayRange,
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
  ContactTag,
  ConversationAgentState,
  DashboardMetrics,
  PhoneSection,
  ProductItem,
  RistakUser,
  TransactionItem,
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

type Screen = 'boot' | 'server' | 'login' | 'shell';
type ChatFilterId = string;
type ChatSheetMode = 'chatMore' | 'newChat' | 'cameraShare' | 'tag' | 'schedule' | null;
type CalendarViewMode = 'day' | 'week' | 'month' | 'year';
type CalendarSheetMode = 'calendar' | 'contactPicker' | 'event' | 'appointmentForm' | null;
type AppointmentFormMode = 'create' | 'edit';
type AgentAction = 'activate' | 'pause' | 'take_over' | 'skip';
type ChannelBadgeKind = 'whatsapp' | 'instagram' | 'messenger' | 'facebook_comment' | 'instagram_comment' | 'email' | 'sms' | 'unknown';
type ChatFilterPreset = {
  id: ChatFilterId;
  label: string;
  description: string;
  section: string;
  locked?: boolean;
  separatorBefore?: boolean;
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
      setScreen('server');
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

  const handleServerReady = async (baseUrl: string) => {
    await writeApiBaseUrl(baseUrl);
    await clearAuthToken();
    setSession({ baseUrl, token: '', user: null });
    setScreen('login');
  };

  const handleLogin = async (email: string, password: string) => {
    const client = new RistakApiClient(session.baseUrl);
    const response = await client.login(email, password);
    if (!response.token || !response.user) {
      throw new Error(response.message || 'No se pudo iniciar sesion.');
    }
    await writeAuthToken(response.token);
    setSession({ baseUrl: session.baseUrl, token: response.token, user: response.user });
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
    setScreen('server');
  };

  if (screen === 'boot') {
    return <BootScreen />;
  }

  if (screen === 'server') {
    return <ServerScreen onReady={handleServerReady} />;
  }

  if (screen === 'login') {
    return (
      <LoginScreen
        baseUrl={session.baseUrl}
        onLogin={handleLogin}
        onChangeServer={resetServer}
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
  const dock = <PhoneDock active={activeSection} onSelect={setActiveSection} />;

  if (activeSection === 'chat') {
    return (
      <ChatScreen
        api={api}
        footer={dock}
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

  return (
    <AppFrame>
      <SectionHeader
        section={activeSection}
        user={user}
        baseUrl={baseUrl}
        onLogout={onLogout}
        onChangeServer={onChangeServer}
      />
      {activeSection === 'payments' ? <PaymentsSection api={api} /> : null}
      {activeSection === 'analytics' ? <AnalyticsSection api={api} /> : null}
      {activeSection === 'settings' ? <SettingsSection api={api} /> : null}
      {dock}
    </AppFrame>
  );
}

function PhoneDock({ active, onSelect }: { active: PhoneSection; onSelect: (section: PhoneSection) => void }) {
  const activeIndex = PHONE_NAV_ITEMS.findIndex((item) => item.key === active);

  return (
    <View style={styles.phoneDockWrap} pointerEvents="box-none">
      <View style={styles.phoneDock}>
        <View
          pointerEvents="none"
          style={[
            styles.phoneDockIndicator,
            { left: `${Math.max(0, activeIndex) * 20}%` },
          ]}
        />
        {PHONE_NAV_ITEMS.map((item) => {
          const selected = item.key === active;
          const DockIcon = item.Icon;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => onSelect(item.key)}
              style={({ pressed }) => [
                styles.phoneDockItem,
                pressed && styles.pressed,
              ]}
            >
              <DockIcon
                size={18}
                color={selected ? COLORS.accent : COLORS.muted}
                strokeWidth={selected ? 2.55 : 2.25}
              />
              <Text numberOfLines={1} style={[styles.phoneDockLabel, selected && styles.phoneDockLabelActive]}>
                {item.label}
              </Text>
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

function ServerScreen({ onReady }: { onReady: (baseUrl: string) => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const clean = cleanBaseUrl(url);
    if (!clean) {
      setError('Pega una URL valida, por ejemplo https://mi-negocio.onrender.com');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onReady(clean);
    } finally {
      setSaving(false);
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
            <Text style={styles.title}>Conecta tu Ristak</Text>
            <Text style={styles.bodyText}>
              Escribe la URL publica de la instalacion que quieres usar en este celular.
            </Text>
            <TextInput
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://tu-app.onrender.com"
              placeholderTextColor={COLORS.muted}
              style={styles.input}
            />
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <PrimaryButton label="Continuar" busy={saving} onPress={save} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </AppFrame>
  );
}

function LoginScreen({
  baseUrl,
  onLogin,
  onChangeServer,
}: {
  baseUrl: string;
  onLogin: (email: string, password: string) => Promise<void>;
  onChangeServer: () => Promise<void>;
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
            <Text style={styles.kicker}>Ristak Native</Text>
            <Text style={styles.title}>Iniciar sesion</Text>
            <Text style={styles.caption}>{baseUrl}</Text>
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
            <Pressable onPress={onChangeServer} style={styles.textButton}>
              <Text style={styles.textButtonLabel}>Cambiar instalacion</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </AppFrame>
  );
}

function ChatScreen({
  api,
  footer,
  onNavigate,
}: {
  api: RistakApiClient;
  footer?: React.ReactNode;
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
      <ConversationScreen
        api={api}
        contact={selected}
        onBack={() => {
          setSelected(null);
          void loadChats(true);
        }}
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
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [productsResponse, transactionsResponse] = await Promise.all([
        api.getProducts(),
        api.getTransactions(20),
      ]);
      setProducts(Array.isArray(productsResponse.products) ? productsResponse.products : []);
      setTransactions(Array.isArray(transactionsResponse)
        ? transactionsResponse
        : Array.isArray(transactionsResponse.transactions) ? transactionsResponse.transactions : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los pagos.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ScrollView contentContainerStyle={styles.sectionScroll}>
      <View style={styles.actionGrid}>
        {['Cobro unico', 'Pago parcial', 'Suscripcion', 'Productos'].map((label) => (
          <View key={label} style={styles.actionTile}>
            <Text style={styles.actionTileLabel}>{label}</Text>
          </View>
        ))}
      </View>
      <SectionState loading={loading} error={error} onRetry={load} />
      {!loading && !error ? (
        <>
          <SectionBlock title="Pagos recientes">
            {transactions.slice(0, 6).map((transaction, index) => {
              const amount = Number(transaction.amount ?? transaction.total ?? 0);
              return (
                <InfoRow
                  key={transaction.id || transaction._id || `transaction-${index}`}
                  title={transaction.concept || transaction.contactName || transaction.email || 'Pago'}
                  subtitle={`${transaction.status || 'Sin estado'} - ${formatShortDate(transaction.paymentDate || transaction.createdAt)}`}
                  value={formatCurrency(amount, transaction.currency || 'MXN')}
                />
              );
            })}
            {!transactions.length ? <Text style={styles.caption}>No hay pagos recientes.</Text> : null}
          </SectionBlock>
          <SectionBlock title="Productos">
            {products.slice(0, 8).map((product, index) => {
              const price = product.prices?.[0];
              const amount = Number(price?.amount ?? price?.price ?? 0);
              return (
                <InfoRow
                  key={product.id || product._id || product.localId || `product-${index}`}
                  title={product.name || 'Producto'}
                  subtitle={product.description || price?.name || 'Precio base'}
                  value={amount ? formatCurrency(amount, price?.currency || product.currency || 'MXN') : ''}
                />
              );
            })}
            {!products.length ? <Text style={styles.caption}>No hay productos para mostrar.</Text> : null}
          </SectionBlock>
        </>
      ) : null}
    </ScrollView>
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

function AnalyticsSection({ api }: { api: RistakApiClient }) {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const range = getTodayRange(30);
    setLoading(true);
    setError('');
    try {
      setMetrics(await api.getDashboardMetrics(range.startDate, range.endDate));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las analiticas.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = [
    { title: 'Ingresos netos', metric: metrics?.ingresosNetos, money: true },
    { title: 'Gasto publicidad', metric: metrics?.gastosPublicidad, money: true },
    { title: 'Ganancia neta', metric: metrics?.gananciaNeta, money: true },
    { title: 'ROAS', metric: metrics?.roas, money: false },
  ];

  return (
    <ScrollView contentContainerStyle={styles.sectionScroll}>
      <View style={styles.segmentWrap}>
        <Text style={styles.segmentActive}>30 dias</Text>
        <Text style={styles.segmentLabel}>Embudo</Text>
        <Text style={styles.segmentLabel}>Origen</Text>
      </View>
      <SectionState loading={loading} error={error} onRetry={load} />
      {!loading && !error ? (
        <SectionBlock title="Resumen">
          {rows.map((row) => {
            const value = Number(row.metric?.value || 0);
            const variation = Number(row.metric?.variation || 0);
            return (
              <InfoRow
                key={row.title}
                title={row.title}
                subtitle={`${variation >= 0 ? '+' : ''}${variation.toFixed(1)}% vs periodo anterior`}
                value={row.money ? formatCurrency(value) : value.toFixed(2)}
              />
            );
          })}
        </SectionBlock>
      ) : null}
    </ScrollView>
  );
}

function SettingsSection({ api }: { api: RistakApiClient }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [appConfig, userConfig] = await Promise.all([
        api.getConfig([
          'mobile_chat_ai_agent_enabled',
          'mobile_chat_show_archived',
          'mobile_chat_sort_mode',
          'mobile_chat_show_last_preview',
        ]),
        api.getUserConfig([
          'chat_push_notifications_enabled',
          'calendar_push_notifications_enabled',
          'payment_push_notifications_enabled',
          'push_notification_sound_enabled',
          'push_notification_vibration_enabled',
        ]),
      ]);
      const appConfigValues = appConfig && typeof appConfig === 'object' && 'config' in appConfig
        ? appConfig.config
        : appConfig;
      setConfig({
        ...(appConfigValues && typeof appConfigValues === 'object' ? appConfigValues : {}),
        ...(userConfig.config && typeof userConfig.config === 'object' ? userConfig.config : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los ajustes.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = [
    ['Agente IA en chat', config.mobile_chat_ai_agent_enabled],
    ['Mostrar archivados', config.mobile_chat_show_archived],
    ['Orden de conversaciones', config.mobile_chat_sort_mode || 'recent'],
    ['Preview del ultimo mensaje', config.mobile_chat_show_last_preview],
    ['Push de chat', config.chat_push_notifications_enabled],
    ['Push de citas', config.calendar_push_notifications_enabled],
    ['Push de pagos', config.payment_push_notifications_enabled],
    ['Sonido', config.push_notification_sound_enabled],
    ['Vibracion', config.push_notification_vibration_enabled],
  ];

  return (
    <ScrollView contentContainerStyle={styles.sectionScroll}>
      <SectionState loading={loading} error={error} onRetry={load} />
      {!loading && !error ? (
        <SectionBlock title="Preferencias moviles">
          {rows.map(([title, value]) => (
            <InfoRow
              key={String(title)}
              title={String(title)}
              subtitle="Misma preferencia que usa /movil"
              value={formatConfigValue(value)}
            />
          ))}
        </SectionBlock>
      ) : null}
    </ScrollView>
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const loadConversation = useCallback(async () => {
    setLoading(true);
    try {
      const journey = await api.getConversation(contact.id);
      setMessages(buildMessagesFromJourney(contact.id, journey));
      void api.markChatRead(contact.id).catch(() => undefined);
    } catch (err) {
      Alert.alert('Chat', err instanceof Error ? err.message : 'No se pudo cargar la conversacion.');
    } finally {
      setLoading(false);
    }
  }, [api, contact.id]);

  useEffect(() => {
    void loadConversation();
  }, [loadConversation]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    if (!contact.phone) {
      Alert.alert('Falta telefono', 'Este contacto no tiene telefono principal para enviar WhatsApp.');
      return;
    }

    const optimistic: ChatMessage = {
      id: `local-${Date.now()}`,
      contactId: contact.id,
      date: new Date().toISOString(),
      direction: 'outbound',
      text,
      channel: 'native',
      pending: true,
    };
    setDraft('');
    setMessages((current) => [...current, optimistic]);
    setSending(true);
    try {
      const response = await api.sendText(contact, text);
      setMessages((current) => current.map((message) => (
        message.id === optimistic.id
          ? { ...message, pending: false, status: response.status || 'sent', channel: response.transport || message.channel }
          : message
      )));
      void loadConversation();
    } catch (err) {
      setMessages((current) => current.map((message) => (
        message.id === optimistic.id ? { ...message, pending: false, failed: true } : message
      )));
      Alert.alert('No se envio', err instanceof Error ? err.message : 'Intenta otra vez.');
    } finally {
      setSending(false);
    }
  };

  return (
    <AppFrame>
      <View style={styles.conversationHeader}>
        <Pressable onPress={onBack} style={styles.backButton}>
          <Text style={styles.backLabel}>{'<'}</Text>
        </Pressable>
        <View style={styles.conversationTitleWrap}>
          <Text numberOfLines={1} style={styles.headerTitle}>{getContactName(contact)}</Text>
          <Text numberOfLines={1} style={styles.caption}>{contact.phone || 'Sin telefono'}</Text>
        </View>
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={12} style={styles.conversationBody}>
        {loading ? (
          <View style={styles.centerState}>
            <ActivityIndicator color={COLORS.accent} />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.messageList}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            renderItem={({ item }) => <MessageBubble message={item} />}
          />
        )}
        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            placeholder="Escribe un mensaje"
            placeholderTextColor={COLORS.muted}
            style={styles.composerInput}
          />
          <Pressable disabled={sending || !draft.trim()} onPress={send} style={[styles.sendButton, (!draft.trim() || sending) && styles.disabledButton]}>
            {sending ? <ActivityIndicator color={COLORS.white} /> : <Text style={styles.sendLabel}>Enviar</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </AppFrame>
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
    bottom: 8,
    zIndex: 10,
  },
  phoneDock: {
    minHeight: 64,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(10, 31, 92, 0.94)',
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 7,
    overflow: 'hidden',
  },
  phoneDockIndicator: {
    position: 'absolute',
    top: 7,
    bottom: 7,
    width: '20%',
    borderRadius: 999,
    backgroundColor: COLORS.accentSoft,
    borderWidth: 1,
    borderColor: 'rgba(0,168,248,0.34)',
  },
  phoneDockItem: {
    flex: 1,
    minWidth: 0,
    minHeight: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  phoneDockIcon: {
    color: COLORS.muted,
    fontSize: 15,
    fontWeight: '900',
  },
  phoneDockIconActive: {
    color: COLORS.accent,
  },
  phoneDockLabel: {
    color: COLORS.muted,
    fontSize: 10,
    fontWeight: '800',
  },
  phoneDockLabelActive: {
    color: COLORS.text,
  },
  sectionScroll: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 112,
    gap: 14,
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
    paddingBottom: 126,
  },
  emptyList: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    paddingBottom: 112,
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
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    gap: 10,
  },
  backButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panel,
  },
  backLabel: {
    color: COLORS.text,
    fontSize: 34,
    lineHeight: 34,
  },
  conversationTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  conversationBody: {
    flex: 1,
  },
  messageList: {
    padding: 14,
    gap: 8,
  },
  messageRow: {
    flexDirection: 'row',
  },
  messageRowInbound: {
    justifyContent: 'flex-start',
  },
  messageRowOutbound: {
    justifyContent: 'flex-end',
  },
  messageBubble: {
    maxWidth: '82%',
    borderRadius: 20,
    paddingVertical: 10,
    paddingHorizontal: 13,
  },
  inboundBubble: {
    backgroundColor: COLORS.panelSoft,
  },
  outboundBubble: {
    backgroundColor: COLORS.primary,
  },
  failedBubble: {
    backgroundColor: COLORS.dangerSoft,
  },
  messageText: {
    color: COLORS.text,
    fontSize: 16,
    lineHeight: 22,
  },
  messageMeta: {
    color: COLORS.meta,
    fontSize: 11,
    marginTop: 5,
    textAlign: 'right',
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.panel,
  },
  composerInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 126,
    borderRadius: 18,
    backgroundColor: COLORS.panelSoft,
    color: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
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
