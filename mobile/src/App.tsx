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
  BarChart3,
  Bell,
  BellOff,
  Bot,
  CalendarDays,
  Camera,
  Check,
  CheckCheck,
  ChevronLeft,
  CircleDollarSign,
  Clock,
  FileText,
  Image as ImageIcon,
  Info,
  Mail,
  MapPin,
  MessageCircle,
  Mic,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Reply,
  Send,
  Smile,
  Plus,
  Search,
  Settings,
  Tag,
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
  formatChatListDate,
  formatConversationDayLabel,
  formatCurrency,
  formatMessageTime,
  formatShortDate,
  getConversationDayKey,
  getContactAvatar,
  getContactName,
  getTodayRange,
  resolveBusinessTimezone,
} from './format';
import type {
  CalendarEventItem,
  CalendarItem,
  ChatContact,
  ChatMessage,
  ChatAttachment,
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
type ConversationSheetMode = 'attachments' | 'messageActions' | 'chatMore' | 'tag' | 'schedule' | null;
type AgentAction = 'activate' | 'pause' | 'take_over' | 'skip';
type ChannelBadgeKind = 'whatsapp' | 'instagram' | 'messenger' | 'facebook_comment' | 'instagram_comment' | 'email' | 'sms' | 'unknown';
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
