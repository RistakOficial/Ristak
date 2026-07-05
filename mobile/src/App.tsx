import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
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
  BarChart3,
  Bot,
  CalendarDays,
  Camera,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  CreditCard,
  DollarSign,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Repeat2,
  Save,
  Search,
  Send,
  Settings,
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
  formatCurrency,
  formatShortDate,
  getContactAvatar,
  getContactName,
  getTodayRange,
} from './format';
import type {
  CalendarEventItem,
  CalendarItem,
  ChatContact,
  ChatMessage,
  DashboardMetrics,
  PhoneSection,
  ProductItem,
  ProductPrice,
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
type ChatSheetMode = 'chatMore' | 'newChat' | 'cameraShare' | null;
type ChannelBadgeKind = 'whatsapp' | 'instagram' | 'messenger' | 'facebook_comment' | 'instagram_comment' | 'email' | 'sms' | 'unknown';
type PaymentView = 'select' | 'single' | 'partial' | 'subscription' | 'products';
type RecentPaymentsPeriod = 'today' | '7d' | '30d' | '90d';
type ProductFormMode = 'create' | 'edit' | null;
type ChatFilterPreset = {
  id: ChatFilterId;
  label: string;
  description: string;
  section: string;
  locked?: boolean;
  separatorBefore?: boolean;
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
const CHAT_SWIPE_ACTION_WIDTH = 184;
const CHAT_SWIPE_MORE_WIDTH = 84;
const CHAT_SWIPE_ARCHIVE_WIDTH = CHAT_SWIPE_ACTION_WIDTH - CHAT_SWIPE_MORE_WIDTH;
const CHAT_SWIPE_OPEN_THRESHOLD = 36;
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
}: {
  api: RistakApiClient;
  footer?: React.ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<ChatFilterId>('all');
  const [visibleFilterIds, setVisibleFilterIds] = useState<ChatFilterId[]>(DEFAULT_CHAT_FILTER_IDS);
  const [filterManagerOpen, setFilterManagerOpen] = useState(false);
  const [archivedChatIds, setArchivedChatIds] = useState<string[]>([]);
  const [archivedViewOpen, setArchivedViewOpen] = useState(false);
  const [chatPrefsHydrated, setChatPrefsHydrated] = useState(false);
  const [openSwipeChatId, setOpenSwipeChatId] = useState<string | null>(null);
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [selectionActionsOpen, setSelectionActionsOpen] = useState(false);
  const [bulkActionBusy, setBulkActionBusy] = useState(false);
  const [activeSheet, setActiveSheet] = useState<ChatSheetMode>(null);
  const [sheetContact, setSheetContact] = useState<ChatContact | null>(null);
  const [contactQuery, setContactQuery] = useState('');
  const [contactResults, setContactResults] = useState<ChatContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [cameraAsset, setCameraAsset] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [chats, setChats] = useState<ChatContact[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<ChatContact | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const searchInputRef = useRef<TextInput>(null);

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
    ]).then(([savedFilterIds, savedArchivedIds]) => {
      const availableIds = new Set(CHAT_FILTER_LIBRARY.map((preset) => preset.id));
      const next = savedFilterIds.filter((id, index, list) => availableIds.has(id) && list.indexOf(id) === index);
      setVisibleFilterIds(next.includes('all') ? next : ['all', ...next]);
      setArchivedChatIds(savedArchivedIds.filter((id, index, list) => typeof id === 'string' && id.trim() && list.indexOf(id) === index));
      setChatPrefsHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!chatPrefsHydrated) return;
    void writeJsonValue(CHAT_FILTERS_STORAGE_KEY, visibleFilterIds);
  }, [chatPrefsHydrated, visibleFilterIds]);

  useEffect(() => {
    if (!chatPrefsHydrated) return;
    void writeJsonValue(ARCHIVED_CHAT_IDS_STORAGE_KEY, archivedChatIds);
  }, [archivedChatIds, chatPrefsHydrated]);

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

  const closeSheet = () => {
    setActiveSheet(null);
    setSheetContact(null);
  };

  const openNewChatSheet = () => {
    setOpenSwipeChatId(null);
    setContactQuery('');
    setContactResults([]);
    setCameraAsset(null);
    setSheetContact(null);
    setActiveSheet('newChat');
  };

  const openCameraShareSheet = (asset: ImagePicker.ImagePickerAsset) => {
    setOpenSwipeChatId(null);
    setContactQuery('');
    setContactResults([]);
    setCameraAsset(asset);
    setSheetContact(null);
    setActiveSheet('cameraShare');
  };

  const openChatMoreActions = (contact: ChatContact) => {
    setOpenSwipeChatId(null);
    setSheetContact(contact);
    setActiveSheet('chatMore');
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
          extraData={`${openSwipeChatId || ''}|${selectedChatIds.join(',')}|${archivedChatIds.join(',')}|${selectionActive ? 'selecting' : 'normal'}`}
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
        open={activeSheet === 'chatMore'}
        archived={sheetContact ? archivedChatIds.includes(sheetContact.id) : false}
        unread={sheetContact ? getUnreadCount(sheetContact) : 0}
        onArchiveToggle={(contact) => {
          if (archivedChatIds.includes(contact.id)) restoreChat(contact);
          else archiveChat(contact);
          closeSheet();
        }}
        onClose={closeSheet}
        onMarkRead={(contact) => {
          markChatAsRead(contact);
          closeSheet();
        }}
        onSelect={(contact) => {
          closeSheet();
          startChatSelection(contact);
        }}
      />
      <ContactPickerSheet
        asset={activeSheet === 'cameraShare' ? cameraAsset : null}
        contacts={contactSheetOptions}
        loading={contactsLoading}
        open={activeSheet === 'newChat' || activeSheet === 'cameraShare'}
        query={contactQuery}
        title={activeSheet === 'cameraShare' ? 'Enviar foto' : 'Nuevo chat'}
        onChangeQuery={setContactQuery}
        onClose={closeSheet}
        onSelect={activeSheet === 'cameraShare' ? chooseCameraRecipient : openContactFromSheet}
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

function normalizeCurrencyCode(value: unknown, fallback = DEFAULT_ACCOUNT_CURRENCY) {
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
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
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
  open,
  title,
  subtitle,
  onClose,
}: {
  children: React.ReactNode;
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <Pressable style={styles.sheetScrim} onPress={onClose} />
        <View style={styles.actionSheet}>
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
        </View>
      </View>
    </Modal>
  );
}

function SheetActionRow({
  Icon,
  title,
  subtitle,
  danger,
  onPress,
}: {
  Icon: LucideIcon;
  title: string;
  subtitle: string;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.sheetActionRow, pressed && styles.pressed]}>
      <View style={[styles.sheetActionIcon, danger && styles.sheetActionIconDanger]}>
        <Icon size={20} color={danger ? COLORS.danger : COLORS.accent} strokeWidth={2.6} />
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
  contact,
  open,
  unread,
  onArchiveToggle,
  onClose,
  onMarkRead,
  onSelect,
}: {
  archived: boolean;
  contact: ChatContact | null;
  open: boolean;
  unread: number;
  onArchiveToggle: (contact: ChatContact) => void;
  onClose: () => void;
  onMarkRead: (contact: ChatContact) => void;
  onSelect: (contact: ChatContact) => void;
}) {
  return (
    <BottomActionSheet
      open={open && Boolean(contact)}
      title="Más acciones"
      subtitle={contact ? getContactName(contact) : ''}
      onClose={onClose}
    >
      {contact ? (
        <View style={styles.sheetActionList}>
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
        </View>
      ) : null}
    </BottomActionSheet>
  );
}

function ContactPickerSheet({
  asset,
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
      <View style={styles.aiChatAvatar}>
        <Bot size={27} color={COLORS.accent} strokeWidth={2.4} />
      </View>
      <View style={styles.aiChatBody}>
        <View style={styles.rowHeader}>
          <Text numberOfLines={1} style={styles.chatName}>{AI_AGENT_CHAT_DISPLAY_NAME}</Text>
          <Text style={styles.aiChatPinned}>Fijo</Text>
        </View>
        <Text numberOfLines={1} style={styles.lastMessage}>{AI_AGENT_CHAT_SUBTITLE}</Text>
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

function ChannelBadgeIcon({ kind, size = 13 }: { kind: ChannelBadgeKind; size?: number }) {
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
    Animated.spring(translateX, {
      toValue,
      useNativeDriver: true,
      friction: 8,
      tension: 76,
    }).start();
  }, [translateX]);

  useEffect(() => {
    animateSwipeTo(swipeOpen && !selectionActive ? -CHAT_SWIPE_ACTION_WIDTH : 0);
  }, [animateSwipeTo, selectionActive, swipeOpen]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => {
      if (selectionActive) return false;
      return Math.abs(gestureState.dx) > 8 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy) + 4;
    },
    onPanResponderGrant: () => {
      onSwipeStart();
      dragStartOffsetRef.current = offsetRef.current;
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
      const shouldOpen = Math.abs(offsetRef.current) >= CHAT_SWIPE_OPEN_THRESHOLD || gestureState.vx < -0.22;
      if (shouldOpen) {
        onSwipeOpen();
        animateSwipeTo(-CHAT_SWIPE_ACTION_WIDTH);
        return;
      }
      onSwipeClose();
      animateSwipeTo(0);
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderTerminate: () => {
      if (swipeOpen || Math.abs(offsetRef.current) >= CHAT_SWIPE_OPEN_THRESHOLD) {
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
        pointerEvents={swipeOpen && !selectionActive ? 'none' : 'auto'}
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
              <Text style={[styles.rowTime, unread > 0 && styles.rowTimeUnread]}>{formatShortDate(contact.lastMessageDate)}</Text>
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
  filterChipRow: {
    gap: 8,
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
    minHeight: 74,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 13,
    backgroundColor: COLORS.bg,
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
    alignSelf: 'stretch',
    justifyContent: 'center',
    minWidth: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
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
    minHeight: 74,
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
    minHeight: 74,
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
    minHeight: 74,
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
    gap: 9,
    minHeight: 74,
    paddingHorizontal: 13,
    borderRadius: 0,
  },
  chatRowUnread: {
    backgroundColor: 'rgba(39,199,216,0.07)',
  },
  chatRowSelecting: {
    gap: 8,
    paddingLeft: 9,
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
    width: 48,
    height: 48,
    borderRadius: 24,
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
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: {
    width: 42,
    height: 42,
  },
  avatarText: {
    color: COLORS.text,
    fontWeight: '900',
    fontSize: 16,
  },
  avatarChannelBadge: {
    position: 'absolute',
    right: -3,
    bottom: -2,
    minWidth: 19,
    height: 19,
    borderRadius: 10,
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
    fontSize: 11,
    fontWeight: '700',
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
    fontSize: 14,
  },
  lastMessageUnread: {
    color: COLORS.meta,
    fontWeight: '700',
  },
  unreadPill: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadText: {
    color: COLORS.bg,
    fontSize: 12,
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
