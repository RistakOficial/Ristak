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
import * as SystemUI from 'expo-system-ui';
import * as ImagePicker from 'expo-image-picker';
import {
  Archive,
  Activity,
  BarChart3,
  Bell,
  BellOff,
  Bot,
  CalendarDays,
  Camera,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronDown,
  CircleDollarSign,
  Clock,
  CreditCard,
  DollarSign,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Play,
  Send,
  Plus,
  Search,
  Settings,
  Tag,
  Target,
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
import { RistakApiClient, getUserDisplayName } from './api';
import {
  buildMessagesFromJourney,
  cleanBaseUrl,
  formatChatListDate,
  formatCompactCurrency,
  formatCompactNumber,
  formatCurrency,
  formatNumber,
  formatRoas,
  formatShortDate,
  getContactAvatar,
  getContactName,
  getTodayRange,
  normalizeCurrencyCode,
  resolveBusinessTimezone,
} from './format';
import type {
  CalendarEventItem,
  CalendarItem,
  ChatContact,
  ChatMessage,
  ContactTag,
  CustomLabels,
  ConversationAgentState,
  DashboardFunnelRow,
  DashboardFunnelScope,
  DashboardMetrics,
  OriginDistributionData,
  PhoneSection,
  ProductItem,
  RistakUser,
  SourceDatum,
  TransactionItem,
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

type Screen = 'boot' | 'server' | 'login' | 'shell';
type ChatFilterId = string;
type ChatSheetMode = 'chatMore' | 'newChat' | 'cameraShare' | 'tag' | 'schedule' | null;
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
const AI_AGENT_CHAT_ID = 'ristak-ai-agent-mobile-chat';
const AI_AGENT_CHAT_DISPLAY_NAME = 'Asistente Personal AI';
const AI_AGENT_CHAT_SUBTITLE = 'Te ayuda dentro de Ristak';
const AI_AGENT_CHAT_SEARCH_TEXT = 'asistente personal ai ristak ai agente inteligencia artificial ia';
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

  if (activeSection === 'analytics') {
    return (
      <AppFrame>
        <AnalyticsSection api={api} />
        {dock}
      </AppFrame>
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
      {activeSection === 'calendar' ? <CalendarSection api={api} /> : null}
      {activeSection === 'payments' ? <PaymentsSection api={api} /> : null}
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

function CalendarSection({ api }: { api: RistakApiClient }) {
  const [calendars, setCalendars] = useState<CalendarItem[]>([]);
  const [events, setEvents] = useState<CalendarEventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const range = getTodayRange(30);
    setLoading(true);
    setError('');
    try {
      const [calendarsResponse, eventsResponse] = await Promise.all([
        api.getCalendars(),
        api.getCalendarEvents(range.startDate, range.endDate),
      ]);
      setCalendars(Array.isArray(calendarsResponse)
        ? calendarsResponse
        : Array.isArray(calendarsResponse.calendars) ? calendarsResponse.calendars : []);
      setEvents(Array.isArray(eventsResponse)
        ? eventsResponse
        : Array.isArray(eventsResponse.events) ? eventsResponse.events : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las citas.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ScrollView contentContainerStyle={styles.sectionScroll}>
      <SectionState loading={loading} error={error} onRetry={load} />
      {!loading && !error ? (
        <>
          <SectionBlock title="Proximas citas">
            {events.slice(0, 10).map((event, index) => (
              <InfoRow
                key={event.id || event._id || `event-${index}`}
                title={event.title || event.contactName || 'Cita'}
                subtitle={`${formatShortDate(event.start || event.startTime)} - ${event.status || 'programada'}`}
                value=""
              />
            ))}
            {!events.length ? <Text style={styles.caption}>No hay citas en el rango.</Text> : null}
          </SectionBlock>
          <SectionBlock title="Calendarios">
            {calendars.map((calendar, index) => (
              <InfoRow
                key={calendar.id || calendar._id || `calendar-${index}`}
                title={calendar.name || calendar.title || 'Calendario'}
                subtitle={calendar.id || calendar._id || ''}
                value=""
              />
            ))}
            {!calendars.length ? <Text style={styles.caption}>No hay calendarios conectados.</Text> : null}
          </SectionBlock>
        </>
      ) : null}
    </ScrollView>
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
          <Image source={{ uri: asset.uri }} style={styles.cameraPreview} />
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
        {avatar ? <Image source={{ uri: avatar }} style={styles.contactPickerAvatarImage} /> : <Text style={styles.avatarText}>{getContactName(contact).slice(0, 1).toUpperCase()}</Text>}
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
              {avatar ? <Image source={{ uri: avatar }} style={styles.avatarImage} /> : <Text style={styles.avatarText}>{getContactName(contact).slice(0, 1).toUpperCase()}</Text>}
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
