import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
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
} from 'react-native';
import * as Haptics from 'expo-haptics';
import * as FileSystem from 'expo-file-system/legacy';
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
  CreditCard,
  ExternalLink,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Package,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Repeat2,
  Save,
  Search,
  Send,
  Settings,
  Tag,
  Trash2,
  User,
  Video,
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
import { RistakApiClient, getUserDisplayName, loginWithResolvedTenant } from './api';
import {
  configureNativeNotificationListeners,
  getNativePushPermissionStatus,
  subscribeToNativePushNotifications,
  type NativePushPermissionStatus,
} from './notifications';
import {
  buildMessagesFromJourney,
  addDateOnlyDays,
  addDateOnlyMonths,
  dateOnlyInTimezone,
  formatChatListDate,
  formatCurrency,
  formatPaymentDate,
  getBusinessDateRange,
  formatShortDate,
  getContactAvatar,
  getContactName,
  getPaymentMethodLabel,
  getPaymentStatusLabel,
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
  ConversationAgentState,
  DashboardMetrics,
  IntegrationsStatus,
  PaymentGatewayProvider,
  PaymentLinkResponse,
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

type Screen = 'boot' | 'login' | 'shell';
type ChatFilterId = string;
type ChatSheetMode = 'chatMore' | 'newChat' | 'cameraShare' | 'tag' | 'schedule' | null;
type AgentAction = 'activate' | 'pause' | 'take_over' | 'skip';
type CameraMediaKind = 'image' | 'video';
type ChannelBadgeKind = 'whatsapp' | 'instagram' | 'messenger' | 'facebook_comment' | 'instagram_comment' | 'email' | 'sms' | 'unknown';
type ChatFilterPreset = {
  id: ChatFilterId;
  label: string;
  description: string;
  section: string;
  locked?: boolean;
  separatorBefore?: boolean;
};
type PaymentView = 'select' | 'single' | 'partial' | 'subscription' | 'products';
type RecentPaymentsPeriod = 'today' | '7d' | '30d' | '90d';
type ProductFormMode = 'create' | 'edit' | null;
type SinglePaymentMode = 'highlevel_invoice' | 'payment_link' | 'manual';
type ManualPaymentMethod = 'cash' | 'bank_transfer' | 'card' | 'check' | 'other';
type HighLevelInvoiceSendMethod = 'email' | 'sms' | 'both';
type PaymentContactSheetTarget = 'single' | 'partial' | 'subscription' | null;
type PaymentPlanProvider = PaymentGatewayProvider | 'highlevel';
type PaymentLinkReady = {
  title: string;
  description: string;
  url: string;
  amount: number;
  currency: string;
};

type PaymentCapabilities = {
  loading: boolean;
  highLevelConnected: boolean;
  hasConnectedPaymentGateway: boolean;
  canUsePaymentPlans: boolean;
  canUseSubscriptions: boolean;
  linkProviders: PaymentGatewayProvider[];
  planProviders: PaymentPlanProvider[];
  subscriptionProviders: PaymentGatewayProvider[];
};

type ProductFormState = {
  name: string;
  description: string;
  priceName: string;
  amount: string;
};

type SinglePaymentDraft = {
  contact: ChatContact | null;
  title: string;
  description: string;
  amount: string;
  chargeType: 'direct' | 'product';
  productId: string;
  mode: SinglePaymentMode;
  provider: PaymentGatewayProvider | '';
  paymentDate: string;
  dueDate: string;
  manualMethod: ManualPaymentMethod;
  sendMethod: HighLevelInvoiceSendMethod;
  reference: string;
  notes: string;
};

type PartialPaymentDraft = {
  contact: ChatContact | null;
  title: string;
  totalAmount: string;
  firstPaymentAmount: string;
  firstPaymentMethod: 'card' | 'cash' | 'bank_transfer' | 'deposit';
  installmentCount: string;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'yearly';
  provider: PaymentPlanProvider | '';
};

type SubscriptionDraft = {
  contact: ChatContact | null;
  name: string;
  amount: string;
  intervalType: 'daily' | 'weekly' | 'monthly' | 'yearly';
  intervalCount: string;
  startDate: string;
  description: string;
  provider: PaymentGatewayProvider | '';
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
const CHAT_SWIPE_GESTURE_START_DISTANCE = 4;
const CHAT_SWIPE_INTENT_DISTANCE = 7;
const CHAT_SWIPE_OPEN_DURATION_MS = 520;
const CHAT_SWIPE_CLOSE_DURATION_MS = 480;
const CHAT_ROW_MIN_HEIGHT = 86;
const CHAT_AVATAR_SIZE = 58;
const CHAT_AVATAR_INNER_SIZE = 50;
const CAMERA_VIDEO_MAX_DURATION_SECONDS = 60;
const CAMERA_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const HIDDEN_SCROLL_INDICATOR_PROPS = {
  showsHorizontalScrollIndicator: false,
  showsVerticalScrollIndicator: false,
} as const;

function triggerChatSelectionHaptic() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
}

function getCameraAssetKind(asset?: ImagePicker.ImagePickerAsset | null): CameraMediaKind {
  return asset?.type === 'video' || asset?.type === 'pairedVideo' ? 'video' : 'image';
}

function getCameraAssetNoun(asset?: ImagePicker.ImagePickerAsset | null) {
  return getCameraAssetKind(asset) === 'video' ? 'video' : 'foto';
}

function getCameraAssetMimeType(asset: ImagePicker.ImagePickerAsset) {
  if (asset.mimeType) return asset.mimeType;
  const cleanPath = (asset.fileName || asset.uri || '').split('?')[0].toLowerCase();
  const extension = cleanPath.includes('.') ? cleanPath.split('.').pop() : '';

  if (getCameraAssetKind(asset) === 'video') {
    if (extension === 'mov') return 'video/quicktime';
    if (extension === 'webm') return 'video/webm';
    return 'video/mp4';
  }

  if (extension === 'png') return 'image/png';
  if (extension === 'heic') return 'image/heic';
  if (extension === 'heif') return 'image/heif';
  if (extension === 'webp') return 'image/webp';
  return 'image/jpeg';
}

function formatCameraAssetDuration(asset?: ImagePicker.ImagePickerAsset | null) {
  const durationMs = Number(asset?.duration || 0);
  if (!durationMs) return '';
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

async function buildCameraAssetDataUrl(asset: ImagePicker.ImagePickerAsset) {
  const mimeType = getCameraAssetMimeType(asset);
  const base64 = asset.base64 || await FileSystem.readAsStringAsync(asset.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return {
    dataUrl: `data:${mimeType};base64,${base64}`,
    mimeType,
  };
}

const CHAT_CHANNEL_BADGE_SIZE = 22;
const CHAT_SHEET_OPEN_DURATION_MS = 260;
const CHAT_SHEET_CLOSE_DURATION_MS = 280;
const CHAT_SHEET_HIDDEN_TRANSLATE_Y = 860;
const AI_AGENT_CHAT_ID = 'ristak-ai-agent-mobile-chat';
const AI_AGENT_CHAT_DISPLAY_NAME = 'Asistente Personal AI';
const AI_AGENT_CHAT_SUBTITLE = 'Te ayuda dentro de Ristak';
const AI_AGENT_CHAT_SEARCH_TEXT = 'asistente personal ai ristak ai agente inteligencia artificial ia';
const ACCOUNT_CURRENCY_CONFIG_KEY = 'account_currency';
const ACCOUNT_TIMEZONE_CONFIG_KEY = 'account_timezone';
const SUCCESS_PAYMENT_STATUSES = new Set(['paid', 'partial']);
const RECENT_PAYMENT_PERIODS: Array<{ id: RecentPaymentsPeriod; label: string; days: number }> = [
  { id: 'today', label: 'Hoy', days: 1 },
  { id: '7d', label: '7 días', days: 7 },
  { id: '30d', label: '30 días', days: 30 },
  { id: '90d', label: '90 días', days: 90 },
];
const PROVIDER_LABELS: Record<PaymentGatewayProvider, string> = {
  stripe: 'Stripe',
  conekta: 'Conekta',
  mercadopago: 'Mercado Pago',
  clip: 'CLIP',
  rebill: 'Rebill',
};
const PLAN_PROVIDER_LABELS: Record<PaymentPlanProvider, string> = {
  highlevel: 'Ristak / HighLevel',
  stripe: 'Stripe',
  conekta: 'Conekta',
  mercadopago: 'Mercado Pago',
  clip: 'CLIP',
  rebill: 'Rebill',
};
const MANUAL_PAYMENT_METHODS: Array<{ id: ManualPaymentMethod; label: string }> = [
  { id: 'cash', label: 'Efectivo' },
  { id: 'bank_transfer', label: 'Transferencia bancaria' },
  { id: 'card', label: 'Tarjeta' },
  { id: 'check', label: 'Cheque' },
  { id: 'other', label: 'Otro' },
];
const HIGHLEVEL_INVOICE_SEND_METHODS: Array<{ id: HighLevelInvoiceSendMethod; label: string }> = [
  { id: 'email', label: 'Email' },
  { id: 'sms', label: 'WhatsApp/SMS' },
  { id: 'both', label: 'Email + WhatsApp' },
];
const SUBSCRIPTION_INTERVALS: Array<{ id: SubscriptionDraft['intervalType']; label: string }> = [
  { id: 'daily', label: 'Diario' },
  { id: 'weekly', label: 'Semanal' },
  { id: 'monthly', label: 'Mensual' },
  { id: 'yearly', label: 'Anual' },
];
const PAYMENT_PLAN_FREQUENCIES: Array<{ id: PartialPaymentDraft['frequency']; label: string }> = [
  { id: 'weekly', label: 'Semanal' },
  { id: 'biweekly', label: 'Quincenal' },
  { id: 'monthly', label: 'Mensual' },
  { id: 'yearly', label: 'Anual' },
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
  const [notificationContactId, setNotificationContactId] = useState('');
  const [paymentContact, setPaymentContact] = useState<ChatContact | null>(null);
  const autoRegisteredPushKeyRef = useRef('');
  const clearNotificationContactId = useCallback(() => setNotificationContactId(''), []);
  const dock = <PhoneDock active={activeSection} onSelect={setActiveSection} />;

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
        onNavigate={setActiveSection}
        onOpenPayments={(contact) => {
          setPaymentContact(contact);
          setActiveSection('payments');
        }}
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
      {activeSection === 'payments' ? <PaymentsSection api={api} initialContact={paymentContact} onInitialContactConsumed={() => setPaymentContact(null)} /> : null}
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
        <ScrollView {...HIDDEN_SCROLL_INDICATOR_PROPS} contentContainerStyle={styles.authScroller} keyboardShouldPersistTaps="handled">
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
  onNavigate,
  onOpenPayments,
}: {
  api: RistakApiClient;
  footer?: React.ReactNode;
  notificationContactId?: string;
  onNotificationHandled?: () => void;
  onNavigate?: (section: PhoneSection) => void;
  onOpenPayments?: (contact: ChatContact) => void;
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
  const [cameraSending, setCameraSending] = useState(false);
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
  const showAssistantRow = !archivedViewOpen && activeFilter === 'all' && (
    !query.trim() || AI_AGENT_CHAT_SEARCH_TEXT.includes(query.trim().toLowerCase())
  );
  const showArchiveRow = !query.trim() && (archivedViewOpen || activeFilter === 'all');
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
    if (section === 'payments') {
      onOpenPayments?.(contact);
      return;
    }
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
      Alert.alert('Cámara', 'Necesito permiso de cámara para tomar fotos o grabar video desde la app.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images', 'videos'],
      allowsEditing: false,
      base64: true,
      quality: 0.86,
      videoMaxDuration: CAMERA_VIDEO_MAX_DURATION_SECONDS,
      videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
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

  const chooseCameraRecipient = async (contact: ChatContact) => {
    if (!cameraAsset || cameraSending) return;
    if (!contact.phone) {
      Alert.alert('Enviar multimedia', 'Este contacto no tiene teléfono principal para enviar por WhatsApp.');
      return;
    }

    const assetSize = Number(cameraAsset.fileSize || 0);
    const assetNoun = getCameraAssetNoun(cameraAsset);
    if (assetSize > CAMERA_MEDIA_MAX_BYTES) {
      Alert.alert(
        'Archivo muy grande',
        `Este ${assetNoun} supera el límite de WhatsApp para envío directo. Graba uno más corto o con menos resolución.`,
      );
      return;
    }

    setSheetContact(contact);
    setCameraSending(true);
    try {
      const kind = getCameraAssetKind(cameraAsset);
      const { dataUrl, mimeType } = await buildCameraAssetDataUrl(cameraAsset);
      await api.sendMedia(contact, {
        kind,
        dataUrl,
        mimeType,
        fileName: cameraAsset.fileName || undefined,
      });
      const preview = kind === 'video' ? 'Tú: video' : 'Tú: foto';
      const nowIso = new Date().toISOString();
      setChats((current) => {
        const nextContact: ChatContact = {
          ...contact,
          lastMessageDate: nowIso,
          lastMessageDirection: 'outbound',
          lastMessageText: preview,
          lastMessageType: kind,
          unreadCount: 0,
        };
        return [nextContact, ...current.filter((item) => item.id !== contact.id)];
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      closeSheet();
      void loadChats(true);
    } catch (err) {
      Alert.alert('No se envió', err instanceof Error ? err.message : `No se pudo enviar el ${assetNoun}.`);
    } finally {
      setCameraSending(false);
    }
  };

  const clearChatSelection = () => {
    setSelectedChatIds([]);
    setSelectionActionsOpen(false);
  };

  const startChatSelection = (contact: ChatContact) => {
    triggerChatSelectionHaptic();
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
  const contactPickerAsset = contactPickerSheet === 'cameraShare' ? cameraAsset : null;
  const contactPickerAssetNoun = getCameraAssetNoun(contactPickerAsset);
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
        <ChatFilterBar
          active={activeFilter}
          filters={visibleFilters}
          unreadTotal={unreadTotal}
          onChange={applyFilter}
        />
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
          {...HIDDEN_SCROLL_INDICATOR_PROPS}
          style={styles.chatListSurface}
          data={filteredChats}
          keyExtractor={(item) => item.id}
          extraData={`${openSwipeChatId || ''}|${selectedChatIds.join(',')}|${archivedChatIds.join(',')}|${businessTimezone}|${selectionActive ? 'selecting' : 'normal'}`}
          refreshControl={<RefreshControl tintColor={COLORS.accent} refreshing={refreshing} onRefresh={refresh} />}
          onScrollBeginDrag={() => {
            if (openSwipeChatId) setOpenSwipeChatId(null);
          }}
          contentContainerStyle={chatListHasRows ? styles.chatList : styles.emptyList}
          ListHeaderComponent={(
            <>
              {showAssistantRow ? <AssistantChatRow onPress={() => setAssistantOpen(true)} /> : null}
              {selectionActive ? (
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
              ) : showArchiveRow ? (
                <ArchiveRow
                  active={archivedViewOpen}
                  count={archivedChatCount}
                  onPress={() => setArchivedViewOpen((current) => !current)}
                />
              ) : null}
            </>
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
            <View style={styles.emptyChatsFill}>
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
        asset={contactPickerAsset}
        contacts={contactSheetOptions}
        closing={contactPickerClosing}
        loading={contactsLoading}
        open={Boolean(contactPickerSheet)}
        query={contactQuery}
        sending={contactPickerSheet === 'cameraShare' ? cameraSending : false}
        title={contactPickerSheet === 'cameraShare' ? `Enviar ${contactPickerAssetNoun}` : 'Nuevo chat'}
        onChangeQuery={setContactQuery}
        onClose={cameraSending ? () => undefined : closeSheet}
        onSelect={contactPickerSheet === 'cameraShare' ? chooseCameraRecipient : openContactFromSheet}
      />
      {footer}
    </AppFrame>
  );
}

function PaymentsSection({
  api,
  initialContact,
  onInitialContactConsumed,
}: {
  api: RistakApiClient;
  initialContact?: ChatContact | null;
  onInitialContactConsumed?: () => void;
}) {
  const [view, setView] = useState<PaymentView>('select');
  const [accountCurrency, setAccountCurrency] = useState('');
  const [businessTimezone, setBusinessTimezone] = useState(resolveBusinessTimezone());
  const [capabilities, setCapabilities] = useState<PaymentCapabilities>(() => getEmptyPaymentCapabilities(true));
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [recentPayments, setRecentPayments] = useState<TransactionItem[]>([]);
  const [recentPaymentsOpen, setRecentPaymentsOpen] = useState(false);
  const [recentPaymentsPeriod, setRecentPaymentsPeriod] = useState<RecentPaymentsPeriod>('30d');
  const [selectedRecentPaymentId, setSelectedRecentPaymentId] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [recentLoading, setRecentLoading] = useState(false);
  const [error, setError] = useState('');
  const [productFormMode, setProductFormMode] = useState<ProductFormMode>(null);
  const [editingProduct, setEditingProduct] = useState<ProductItem | null>(null);
  const [productForm, setProductForm] = useState<ProductFormState>(() => createEmptyProductForm());
  const [savingProduct, setSavingProduct] = useState(false);
  const [deletingProductId, setDeletingProductId] = useState('');
  const [contactSheetTarget, setContactSheetTarget] = useState<PaymentContactSheetTarget>(null);
  const [contactQuery, setContactQuery] = useState('');
  const [contactResults, setContactResults] = useState<ChatContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [linkReady, setLinkReady] = useState<PaymentLinkReady | null>(null);
  const [savingPayment, setSavingPayment] = useState(false);
  const [singleDraft, setSingleDraft] = useState<SinglePaymentDraft>(() => createSinglePaymentDraft(businessTimezone));
  const [partialDraft, setPartialDraft] = useState<PartialPaymentDraft>(() => createPartialPaymentDraft());
  const [subscriptionDraft, setSubscriptionDraft] = useState<SubscriptionDraft>(() => createSubscriptionDraft(businessTimezone));

  const selectedRecentPeriod = RECENT_PAYMENT_PERIODS.find((period) => period.id === recentPaymentsPeriod) || RECENT_PAYMENT_PERIODS[2];
  const selectedRecentPayment = recentPayments.find((payment) => getTransactionId(payment) === selectedRecentPaymentId) || null;
  const selectedProduct = products.find((product) => getProductId(product) === singleDraft.productId) || null;
  const selectedProductPrice = getPrimaryPrice(selectedProduct);
  const usableCurrency = accountCurrency || normalizeCurrencyCode(selectedProductPrice?.currency || selectedProduct?.currency || selectedRecentPayment?.currency) || 'MXN';

  const loadBase = useCallback(async ({ refresh = false }: { refresh?: boolean } = {}) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const [configResponse, integrations, productsResponse] = await Promise.all([
        api.getConfig([ACCOUNT_CURRENCY_CONFIG_KEY, ACCOUNT_TIMEZONE_CONFIG_KEY]),
        api.getIntegrationsStatus(),
        api.getProducts(),
      ]);
      const config = unwrapConfig(configResponse);
      const nextCurrency = normalizeCurrencyCode(String(config[ACCOUNT_CURRENCY_CONFIG_KEY] || ''));
      const nextTimezone = resolveBusinessTimezone(String(config[ACCOUNT_TIMEZONE_CONFIG_KEY] || ''));
      const nextCapabilities = getPaymentCapabilities(integrations);
      const nextProducts = Array.isArray(productsResponse.products) ? productsResponse.products : [];

      setAccountCurrency(nextCurrency);
      setBusinessTimezone(nextTimezone);
      setCapabilities(nextCapabilities);
      setProducts(nextProducts);
      setSingleDraft((current) => ({
        ...current,
        mode: getAvailableSinglePaymentMode(current.mode, nextCapabilities),
        provider: current.provider || nextCapabilities.linkProviders[0] || '',
        paymentDate: current.paymentDate || dateOnlyInTimezone(new Date(), nextTimezone),
        dueDate: current.dueDate || addDateOnlyDays(dateOnlyInTimezone(new Date(), nextTimezone), 7),
      }));
      setPartialDraft((current) => ({
        ...current,
        provider: current.provider || nextCapabilities.planProviders[0] || '',
      }));
      setSubscriptionDraft((current) => ({
        ...current,
        provider: current.provider || nextCapabilities.subscriptionProviders[0] || '',
        startDate: current.startDate || dateOnlyInTimezone(new Date(), nextTimezone),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los pagos.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api]);

  const loadRecentPayments = useCallback(async () => {
    const period = RECENT_PAYMENT_PERIODS.find((item) => item.id === recentPaymentsPeriod) || RECENT_PAYMENT_PERIODS[2];
    const range = getBusinessDateRange(period.days, businessTimezone);
    setRecentLoading(true);
    try {
      const response = await api.getTransactions(80, {
        startDate: range.startDate,
        endDate: range.endDate,
      });
      const list = Array.isArray(response)
        ? response
        : Array.isArray(response.transactions) ? response.transactions : [];
      const received = list
        .filter((payment) => Number(payment.amount ?? payment.total ?? 0) > 0 && SUCCESS_PAYMENT_STATUSES.has(String(payment.status || '').toLowerCase()))
        .sort((left, right) => getTransactionTime(right) - getTransactionTime(left));
      setRecentPayments(received);
      setSelectedRecentPaymentId((current) => (received.some((payment) => getTransactionId(payment) === current) ? current : ''));
    } catch (err) {
      Alert.alert('Últimos pagos', err instanceof Error ? err.message : 'No pude cargar pagos recibidos.');
    } finally {
      setRecentLoading(false);
    }
  }, [api, businessTimezone, recentPaymentsPeriod]);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  useEffect(() => {
    if (!recentPaymentsOpen) return;
    void loadRecentPayments();
  }, [loadRecentPayments, recentPaymentsOpen]);

  useEffect(() => {
    if (!initialContact) return;
    setSingleDraft((current) => ({ ...current, contact: initialContact }));
    setPartialDraft((current) => ({ ...current, contact: initialContact }));
    setSubscriptionDraft((current) => ({ ...current, contact: initialContact }));
    setView('single');
    onInitialContactConsumed?.();
  }, [initialContact, onInitialContactConsumed]);

  useEffect(() => {
    if (!contactSheetTarget) {
      setContactsLoading(false);
      return;
    }
    const query = contactQuery.trim();
    if (query.length < 2) {
      setContactResults([]);
      setContactsLoading(false);
      return;
    }
    let cancelled = false;
    setContactsLoading(true);
    const timer = setTimeout(() => {
      api.searchContacts(query)
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
  }, [api, contactQuery, contactSheetTarget]);

  const openContactSheet = (target: PaymentContactSheetTarget) => {
    setContactSheetTarget(target);
    setContactQuery('');
    setContactResults([]);
  };

  const closeContactSheet = () => {
    setContactSheetTarget(null);
    setContactQuery('');
    setContactResults([]);
    setContactsLoading(false);
  };

  const selectPaymentContact = (contact: ChatContact) => {
    if (contactSheetTarget === 'single') setSingleDraft((current) => ({ ...current, contact }));
    if (contactSheetTarget === 'partial') setPartialDraft((current) => ({ ...current, contact }));
    if (contactSheetTarget === 'subscription') setSubscriptionDraft((current) => ({ ...current, contact }));
    closeContactSheet();
  };

  const refreshProducts = async () => {
    const response = await api.getProducts();
    setProducts(Array.isArray(response.products) ? response.products : []);
  };

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

  const saveProduct = async () => {
    const name = productForm.name.trim();
    const amount = Number(productForm.amount);
    const currency = accountCurrency;
    if (!currency) {
      Alert.alert('Moneda de cuenta', 'No pude leer la moneda configurada de la cuenta. Actualiza la pantalla e intenta otra vez.');
      return;
    }
    if (!name) {
      Alert.alert('Falta el nombre', 'Escribe cómo se llama el producto.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert('Falta el precio', 'Escribe un precio válido para poder cobrarlo.');
      return;
    }

    const currentPrice = editingProduct ? getPrimaryPrice(editingProduct) : null;
    const payload = {
      name,
      description: productForm.description.trim(),
      currency,
      prices: [{
        id: getPriceId(currentPrice),
        localId: currentPrice?.localId,
        name: productForm.priceName.trim() || 'Precio base',
        amount,
        currency,
        type: 'one_time',
      }],
    };

    setSavingProduct(true);
    try {
      if (productFormMode === 'edit' && editingProduct) {
        await api.updateProduct(getProductId(editingProduct), payload);
        Alert.alert('Producto actualizado', `${name} ya quedó listo para cobrar.`);
      } else {
        await api.createProduct(payload);
        Alert.alert('Producto creado', `${name} ya aparece en tu catálogo.`);
      }
      closeProductForm();
      await refreshProducts();
    } catch (err) {
      Alert.alert('No se guardó el producto', err instanceof Error ? err.message : 'Intenta otra vez.');
    } finally {
      setSavingProduct(false);
    }
  };

  const confirmDeleteProduct = (product: ProductItem) => {
    const productId = getProductId(product);
    if (!productId) return;
    Alert.alert('Eliminar producto', `Se quitará "${product.name || 'Producto'}" de la lista para cobrar. Los pagos anteriores no se borran.`, [
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
            .catch((err) => Alert.alert('No se eliminó', err instanceof Error ? err.message : 'Intenta otra vez.'))
            .finally(() => setDeletingProductId(''));
        },
      },
    ]);
  };

  const submitSinglePayment = async () => {
    if (savingPayment) return;
    const amount = Number(singleDraft.chargeType === 'product' && selectedProductPrice ? getPriceAmount(selectedProductPrice) : singleDraft.amount);
    const contact = singleDraft.contact;
    const currency = accountCurrency || normalizeCurrencyCode(selectedProductPrice?.currency || selectedProduct?.currency);
    if (!currency) {
      Alert.alert('Moneda de cuenta', 'No pude leer la moneda configurada de la cuenta. Actualiza la pantalla e intenta otra vez.');
      return;
    }
    if (!contact) {
      Alert.alert('Selecciona un contacto', 'El cobro necesita un cliente guardado.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert('Ingresa un monto válido', 'El monto debe ser mayor a cero.');
      return;
    }

    const title = singleDraft.title.trim() || 'Pago';
    const description = singleDraft.description.trim() || title;
    const lineItems = [{
      name: selectedProduct?.name || title,
      description: selectedProduct?.description || description,
      amount,
      qty: 1,
      currency,
      ...(selectedProduct ? {
        productId: getProductId(selectedProduct),
        priceId: getPriceId(selectedProductPrice),
      } : {}),
    }];
    const createLocalManualPayment = () => api.createTransaction({
      date: singleDraft.paymentDate,
      contactId: contact.id,
      contactName: getContactName(contact),
      email: contact.email || '',
      phone: contact.phone || '',
      amount,
      currency,
      method: singleDraft.manualMethod,
      status: 'paid',
      reference: singleDraft.reference.trim(),
      title,
      description: [description, singleDraft.notes.trim()].filter(Boolean).join('\n'),
      dueDate: singleDraft.dueDate,
      metadata: { lineItems, source: 'native_mobile_payments' },
    });
    const invoicePayload = buildNativeInvoicePayload({
      contact,
      title,
      description,
      amount,
      currency,
      dueDate: singleDraft.dueDate,
      lineItems,
      source: 'native_mobile_payments',
    });

    setSavingPayment(true);
    try {
      if (singleDraft.mode === 'manual') {
        if (capabilities.highLevelConnected) {
          let invoiceId = '';
          try {
            const invoiceResponse = await api.createHighLevelInvoice(invoicePayload);
            invoiceId = getHighLevelInvoiceId(invoiceResponse);
            if (!invoiceId) throw new Error('No se pudo obtener el ID del invoice.');
            await api.recordHighLevelInvoicePayment(invoiceId, {
              amount,
              currency,
              paymentDate: singleDraft.paymentDate,
              paymentMethod: singleDraft.manualMethod,
              reference: singleDraft.reference.trim(),
              notes: singleDraft.notes.trim(),
            });
            void api.syncHighLevelInvoice(invoiceId).catch(() => undefined);
          } catch (err) {
            if (invoiceId) throw err;
            await createLocalManualPayment();
          }
        } else {
          await createLocalManualPayment();
        }
        Alert.alert('Pago registrado', 'El pago quedó guardado correctamente.');
        setView('select');
        if (recentPaymentsOpen) void loadRecentPayments();
        return;
      }

      if (singleDraft.mode === 'highlevel_invoice') {
        if (!capabilities.highLevelConnected) {
          Alert.alert('HighLevel no conectado', 'Conecta HighLevel o crea el cobro con una pasarela de Ristak.');
          return;
        }
        if ((singleDraft.sendMethod === 'email' || singleDraft.sendMethod === 'both') && !contact.email) {
          Alert.alert('Falta el email', 'Este invoice necesita email para enviarse por correo.');
          return;
        }
        if ((singleDraft.sendMethod === 'sms' || singleDraft.sendMethod === 'both') && !contact.phone) {
          Alert.alert('Falta el teléfono', 'Este invoice necesita teléfono para enviarse por WhatsApp/SMS.');
          return;
        }
        const invoiceResponse = await api.createHighLevelInvoice(invoicePayload);
        const invoiceId = getHighLevelInvoiceId(invoiceResponse);
        if (!invoiceId) throw new Error('No se pudo obtener el ID del invoice.');
        const sendResponse = await api.sendHighLevelInvoice(invoiceId, singleDraft.sendMethod);
        const url = sendResponse.paymentLink || getHighLevelInvoiceUrl(invoiceResponse);
        if (url) {
          setLinkReady({
            title: 'Invoice HighLevel enviado',
            description: sendResponse.message || 'El enlace quedó enviado por HighLevel y también está listo para abrirlo.',
            url,
            amount,
            currency,
          });
        } else {
          Alert.alert('Invoice enviado', sendResponse.message || 'HighLevel recibió el invoice correctamente.');
          setView('select');
        }
        if (recentPaymentsOpen) void loadRecentPayments();
        return;
      }

      const provider = singleDraft.provider || capabilities.linkProviders[0];
      if (!provider) {
        Alert.alert('Pasarela no conectada', 'Conecta una pasarela o registra el pago manualmente.');
        return;
      }
      if (provider === 'clip') {
        if (currency !== 'MXN') {
          Alert.alert('Moneda no soportada', 'CLIP sólo acepta MXN. Usa otra pasarela o registra el pago manual.');
          return;
        }
        if (!contact.email || !contact.phone) {
          Alert.alert('Faltan datos del cliente', 'CLIP necesita email y teléfono para crear el link de pago.');
          return;
        }
      }

      const response = await api.createPaymentLink(provider, {
        contactId: contact.id,
        contactName: getContactName(contact),
        email: contact.email || '',
        phone: contact.phone || '',
        amount,
        currency,
        applyTax: false,
        title,
        description,
        dueDate: singleDraft.dueDate,
        source: 'native_mobile_payments',
        lineItems,
      });
      const url = getPaymentResponseUrl(response);
      if (!url) {
        Alert.alert('Link creado', 'El cobro se creó, pero el backend no devolvió un enlace para abrir.');
        setView('select');
        return;
      }
      setLinkReady({
        title: `Enlace ${PROVIDER_LABELS[provider]} listo`,
        description: 'Compártelo con el cliente para que complete el pago en la página segura.',
        url,
        amount,
        currency,
      });
      if (recentPaymentsOpen) void loadRecentPayments();
    } catch (err) {
      Alert.alert('No se pudo crear el cobro', err instanceof Error ? err.message : 'Intenta otra vez.');
    } finally {
      setSavingPayment(false);
    }
  };

  const submitPartialPayment = async () => {
    if (savingPayment) return;
    const contact = partialDraft.contact;
    const totalAmount = Number(partialDraft.totalAmount);
    const firstPaymentAmount = Math.max(0, Number(partialDraft.firstPaymentAmount || 0));
    const installmentCount = Math.max(1, Number.parseInt(partialDraft.installmentCount, 10) || 1);
    const currency = accountCurrency;
    const provider = partialDraft.provider || capabilities.planProviders[0];
    if (!currency) {
      Alert.alert('Moneda de cuenta', 'No pude leer la moneda configurada de la cuenta. Actualiza la pantalla e intenta otra vez.');
      return;
    }
    if (!provider) {
      Alert.alert('Planes no disponibles', 'Tu cuenta no tiene HighLevel o una pasarela de planes conectada.');
      return;
    }
    if (!contact) {
      Alert.alert('Selecciona un contacto', 'El plan necesita un cliente guardado.');
      return;
    }
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      Alert.alert('Ingresa un total válido', 'El total del plan debe ser mayor a cero.');
      return;
    }
    if (firstPaymentAmount >= totalAmount) {
      Alert.alert('Primer pago inválido', 'El primer pago debe ser menor al total cuando hay parcialidades restantes.');
      return;
    }

    const title = partialDraft.title.trim() || 'Plan de parcialidades';
    const remainingTotal = Math.round((totalAmount - firstPaymentAmount) * 100) / 100;
    const baseRemaining = Math.floor((remainingTotal / installmentCount) * 100) / 100;
    let allocated = 0;
    const startDate = dateOnlyInTimezone(new Date(), businessTimezone);
    const remainingPayments = Array.from({ length: installmentCount }, (_, index) => {
      const isLast = index === installmentCount - 1;
      const amount = isLast ? Math.round((remainingTotal - allocated) * 100) / 100 : baseRemaining;
      allocated += amount;
      return {
        sequence: index + 1,
        type: 'amount',
        value: amount,
        amount,
        percentage: null,
        dueDate: getInstallmentDueDate(startDate, partialDraft.frequency, index + 1),
        frequency: partialDraft.frequency,
      };
    });

    setSavingPayment(true);
    try {
      const payload = {
        contact: {
          id: contact.id,
          name: getContactName(contact),
          email: contact.email || '',
          phone: contact.phone || '',
        },
        totalAmount,
        currency,
        description: title,
        title,
        invoicePayload: buildNativeInvoicePayload({
          contact,
          title,
          amount: totalAmount,
          currency,
          dueDate: addDateOnlyDays(startDate, 7),
        }),
        firstPayment: {
          enabled: firstPaymentAmount > 0,
          type: 'amount',
          value: firstPaymentAmount,
          amount: firstPaymentAmount,
          date: startDate,
          frequency: partialDraft.frequency,
          method: firstPaymentAmount > 0 ? partialDraft.firstPaymentMethod : 'none',
        },
        remainingAutomatic: provider !== 'highlevel',
        remainingFrequency: partialDraft.frequency,
        remainingPayments,
        channels: {
          email: Boolean(contact.email),
          whatsapp: Boolean(contact.phone),
          sms: false,
        },
        source: 'native_mobile_payments',
      };
      const response = await api.createPaymentPlan(provider, payload);
      const url = getPaymentResponseUrl(response);
      if (url) {
        setLinkReady({
          title: 'Enlace de parcialidades listo',
          description: 'Comparte el enlace para que el cliente autorice el primer pago o la tarjeta del plan.',
          url,
          amount: firstPaymentAmount || Number(response.cardSetupAmount || 0) || totalAmount,
          currency,
        });
      } else {
        Alert.alert('Plan creado', 'Las parcialidades quedaron registradas correctamente.');
        setView('select');
      }
      if (recentPaymentsOpen) void loadRecentPayments();
    } catch (err) {
      Alert.alert('No se pudo crear el plan', err instanceof Error ? err.message : 'Intenta otra vez.');
    } finally {
      setSavingPayment(false);
    }
  };

  const submitSubscription = async () => {
    if (savingPayment) return;
    const contact = subscriptionDraft.contact;
    const provider = subscriptionDraft.provider || capabilities.subscriptionProviders[0];
    const amount = Number(subscriptionDraft.amount);
    const currency = accountCurrency;
    if (!currency) {
      Alert.alert('Moneda de cuenta', 'No pude leer la moneda configurada de la cuenta. Actualiza la pantalla e intenta otra vez.');
      return;
    }
    if (!provider) {
      Alert.alert('Pasarela no conectada', 'Conecta Stripe, Conekta, Mercado Pago o Rebill para crear suscripciones.');
      return;
    }
    if (!subscriptionDraft.name.trim()) {
      Alert.alert('Falta el nombre', 'Escribe cómo se llama la suscripción.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert('Falta el monto', 'Escribe un monto válido para la suscripción.');
      return;
    }
    if (!contact) {
      Alert.alert('Selecciona un contacto', 'La suscripción necesita un cliente guardado.');
      return;
    }
    if ((provider === 'mercadopago' || provider === 'rebill') && !contact.email) {
      Alert.alert('Falta el email', `${PROVIDER_LABELS[provider]} necesita email para que el cliente autorice la suscripción.`);
      return;
    }
    if (provider === 'conekta' && subscriptionDraft.intervalType === 'daily') {
      Alert.alert('Frecuencia no soportada', 'Conekta no acepta suscripciones diarias.');
      return;
    }
    if (provider === 'rebill' && !['monthly', 'yearly'].includes(subscriptionDraft.intervalType)) {
      Alert.alert('Frecuencia no soportada', 'Rebill sólo acepta suscripciones mensuales o anuales.');
      return;
    }

    setSavingPayment(true);
    try {
      const requiresExternalAuthorization = provider === 'mercadopago' || provider === 'rebill';
      const startDate = subscriptionDraft.startDate || dateOnlyInTimezone(new Date(), businessTimezone);
      const subscription = await api.createSubscription({
        contactId: contact.id,
        contactName: getContactName(contact),
        contactEmail: contact.email || null,
        contactPhone: contact.phone || null,
        name: subscriptionDraft.name.trim(),
        description: subscriptionDraft.description.trim(),
        status: requiresExternalAuthorization ? 'incomplete' : 'active',
        amount,
        currency,
        intervalType: subscriptionDraft.intervalType,
        intervalCount: Math.max(1, Number.parseInt(subscriptionDraft.intervalCount, 10) || 1),
        startDate,
        nextRunAt: requiresExternalAuthorization ? null : startDate,
        paymentMethod: getNativeSubscriptionPaymentMethod(provider),
        paymentProvider: provider,
        source: 'native_mobile_payments',
      });
      const url = getSubscriptionActivationUrl(subscription, provider);
      if (url) {
        setLinkReady({
          title: 'Suscripción lista',
          description: 'Envíale el link al cliente para que active la suscripción.',
          url,
          amount,
          currency,
        });
      } else {
        Alert.alert('Suscripción creada', `${subscriptionDraft.name.trim()} quedó guardada.`);
        setView('select');
      }
    } catch (err) {
      Alert.alert('No se guardó la suscripción', err instanceof Error ? err.message : 'Intenta otra vez.');
    } finally {
      setSavingPayment(false);
    }
  };

  if (view === 'products') {
    return (
      <>
        <PaymentsProductsView
          currency={usableCurrency}
          deletingProductId={deletingProductId}
          editing={productFormMode}
          form={productForm}
          loading={loading}
          products={products}
          saving={savingProduct}
          onBack={() => setView('select')}
          onChangeForm={(patch) => setProductForm((current) => ({ ...current, ...patch }))}
          onCreate={openCreateProduct}
          onEdit={openEditProduct}
          onCancelForm={closeProductForm}
          onDelete={confirmDeleteProduct}
          onRefresh={() => void loadBase({ refresh: true })}
          onSave={() => void saveProduct()}
        />
        <SectionState loading={false} error={error} onRetry={() => void loadBase({ refresh: true })} />
      </>
    );
  }

  if (view === 'single') {
    return (
      <>
        <SinglePaymentForm
          capabilities={capabilities}
          currency={usableCurrency}
          draft={singleDraft}
          products={products}
          saving={savingPayment}
          onBack={() => setView('select')}
          onChange={(patch) => setSingleDraft((current) => ({ ...current, ...patch }))}
          onPickContact={() => openContactSheet('single')}
          onSubmit={() => void submitSinglePayment()}
        />
        <PaymentContactSheet
          contacts={contactResults}
          loading={contactsLoading}
          open={contactSheetTarget === 'single'}
          query={contactQuery}
          onChangeQuery={setContactQuery}
          onClose={closeContactSheet}
          onSelect={selectPaymentContact}
        />
        <PaymentLinkReadySheet link={linkReady} onClose={() => setLinkReady(null)} />
      </>
    );
  }

  if (view === 'partial') {
    return (
      <>
        <PartialPaymentForm
          capabilities={capabilities}
          currency={usableCurrency}
          draft={partialDraft}
          saving={savingPayment}
          onBack={() => setView('select')}
          onChange={(patch) => setPartialDraft((current) => ({ ...current, ...patch }))}
          onPickContact={() => openContactSheet('partial')}
          onSubmit={() => void submitPartialPayment()}
        />
        <PaymentContactSheet
          contacts={contactResults}
          loading={contactsLoading}
          open={contactSheetTarget === 'partial'}
          query={contactQuery}
          onChangeQuery={setContactQuery}
          onClose={closeContactSheet}
          onSelect={selectPaymentContact}
        />
        <PaymentLinkReadySheet link={linkReady} onClose={() => setLinkReady(null)} />
      </>
    );
  }

  if (view === 'subscription') {
    return (
      <>
        <SubscriptionPaymentForm
          capabilities={capabilities}
          currency={usableCurrency}
          draft={subscriptionDraft}
          saving={savingPayment}
          onBack={() => setView('select')}
          onChange={(patch) => setSubscriptionDraft((current) => ({ ...current, ...patch }))}
          onPickContact={() => openContactSheet('subscription')}
          onSubmit={() => void submitSubscription()}
        />
        <PaymentContactSheet
          contacts={contactResults}
          loading={contactsLoading}
          open={contactSheetTarget === 'subscription'}
          query={contactQuery}
          onChangeQuery={setContactQuery}
          onClose={closeContactSheet}
          onSelect={selectPaymentContact}
        />
        <PaymentLinkReadySheet link={linkReady} onClose={() => setLinkReady(null)} />
      </>
    );
  }

  return (
    <ScrollView
      {...HIDDEN_SCROLL_INDICATOR_PROPS}
      refreshControl={<RefreshControl tintColor={COLORS.accent} refreshing={refreshing} onRefresh={() => void loadBase({ refresh: true })} />}
      contentContainerStyle={styles.paymentsSelectScroll}
    >
      <Text style={styles.paymentsTitle}>Elige cómo quieres pagar</Text>
      <SectionState loading={loading} error={error} onRetry={() => void loadBase({ refresh: true })} />
      {!loading && !error ? (
        <>
          <PaymentChoiceCard
            Icon={CreditCard}
            title="Registrar pago único"
            subtitle="Cobro único: envía una liga de pago o registra un pago manual."
            onPress={() => setView('single')}
          />
          {capabilities.canUsePaymentPlans ? (
            <PaymentChoiceCard
              Icon={CalendarDays}
              title="Planes de pago"
              subtitle="Parcialidades automáticas con enganche y cobros recurrentes."
              onPress={() => setView('partial')}
            />
          ) : null}
          {capabilities.canUseSubscriptions ? (
            <PaymentChoiceCard
              Icon={Repeat2}
              title="Suscripción"
              subtitle="Cobros recurrentes con Stripe, Conekta, Mercado Pago o Rebill."
              onPress={() => setView('subscription')}
            />
          ) : null}
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
                <Text style={styles.recentPaymentsToggleTitle}>{recentPaymentsOpen ? 'Ocultar últimos pagos' : 'Mostrar últimos pagos'}</Text>
                <Text style={styles.recentPaymentsToggleMeta}>
                  {selectedRecentPayment
                    ? `${formatCurrency(Number(selectedRecentPayment.amount ?? selectedRecentPayment.total ?? 0), selectedRecentPayment.currency || usableCurrency)} seleccionado`
                    : `${selectedRecentPeriod.label} recientes`}
                </Text>
              </View>
              <ChevronDown size={22} color={COLORS.muted} strokeWidth={2.5} />
            </Pressable>
            {recentPaymentsOpen ? (
              <View style={styles.recentPaymentsPanel}>
                <SegmentedOptions
                  value={recentPaymentsPeriod}
                  options={RECENT_PAYMENT_PERIODS.map((period) => ({ value: period.id, label: period.label }))}
                  onChange={(value) => setRecentPaymentsPeriod(value as RecentPaymentsPeriod)}
                />
                {recentLoading && !recentPayments.length ? (
                  <View style={styles.inlineState}>
                    <ActivityIndicator color={COLORS.accent} />
                    <Text style={styles.caption}>Cargando...</Text>
                  </View>
                ) : recentPayments.length ? (
                  recentPayments.slice(0, 24).map((payment, index) => {
                    const paymentId = getTransactionId(payment) || `payment-${index}`;
                    const selected = paymentId === selectedRecentPaymentId;
                    const amount = Number(payment.amount ?? payment.total ?? 0);
                    return (
                      <Pressable
                        key={paymentId}
                        onPress={() => setSelectedRecentPaymentId(selected ? '' : paymentId)}
                        style={({ pressed }) => [styles.recentPaymentItem, selected && styles.recentPaymentItemSelected, pressed && styles.pressed]}
                      >
                        <View style={styles.recentPaymentMain}>
                          <Text style={styles.recentPaymentAmount}>{formatCurrency(amount, payment.currency || usableCurrency)}</Text>
                          <Text numberOfLines={1} style={styles.recentPaymentContact}>{getPaymentContactLabel(payment)}</Text>
                        </View>
                        <View style={styles.recentPaymentMeta}>
                          <Text style={styles.recentPaymentDate}>{formatPaymentDate(payment.date || payment.paymentDate || payment.createdAt, businessTimezone)}</Text>
                          <Text numberOfLines={1} style={styles.recentPaymentStatus}>
                            {getPaymentMethodLabel(payment.method || payment.paymentMethod)} · {getPaymentStatusLabel(payment.status)}
                          </Text>
                        </View>
                        {selected ? <Check size={18} color={COLORS.accent} strokeWidth={2.8} /> : null}
                      </Pressable>
                    );
                  })
                ) : (
                  <Text style={styles.recentPaymentsEmpty}>No hay pagos recibidos en este periodo.</Text>
                )}
              </View>
            ) : null}
          </View>
          <View style={styles.selectBottomSpacer} />
        </>
      ) : null}
    </ScrollView>
  );
}

function PaymentChoiceCard({
  Icon,
  title,
  subtitle,
  onPress,
}: {
  Icon: LucideIcon;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.paymentChoiceCard, pressed && styles.pressed]}>
      <View style={styles.paymentChoiceIcon}>
        <Icon size={24} color={COLORS.accent} strokeWidth={2.5} />
      </View>
      <View style={styles.paymentChoiceCopy}>
        <Text style={styles.paymentChoiceTitle}>{title}</Text>
        <Text style={styles.paymentChoiceSubtitle}>{subtitle}</Text>
      </View>
      <ChevronRight size={20} color={COLORS.muted} strokeWidth={2.4} />
    </Pressable>
  );
}

function PaymentFormShell({
  title,
  subtitle,
  Icon,
  summary,
  saving,
  submitLabel,
  children,
  onBack,
  onSubmit,
}: {
  title: string;
  subtitle: string;
  Icon: LucideIcon;
  summary?: { label: string; detail: string; amount: string };
  saving?: boolean;
  submitLabel: string;
  children: React.ReactNode;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <View style={styles.paymentFormRoot}>
      <View style={styles.paymentFormHeader}>
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.paymentBackButton}>
          <ChevronLeft size={20} color={COLORS.text} strokeWidth={2.5} />
        </Pressable>
        <View style={styles.paymentFormIcon}>
          <Icon size={21} color={COLORS.accent} strokeWidth={2.5} />
        </View>
        <View style={styles.paymentFormHeaderCopy}>
          <Text style={styles.paymentFormTitle}>{title}</Text>
          <Text style={styles.paymentFormSubtitle}>{subtitle}</Text>
        </View>
      </View>
      <ScrollView {...HIDDEN_SCROLL_INDICATOR_PROPS} contentContainerStyle={styles.paymentFormScroll} keyboardShouldPersistTaps="handled">
        {summary ? (
          <View style={styles.paymentSummaryBar}>
            <View style={styles.paymentSummaryCopy}>
              <Text style={styles.paymentSummaryLabel}>{summary.label}</Text>
              <Text style={styles.paymentSummaryDetail}>{summary.detail}</Text>
            </View>
            <Text style={styles.paymentSummaryAmount}>{summary.amount}</Text>
          </View>
        ) : null}
        {children}
      </ScrollView>
      <View style={styles.paymentFormFooter}>
        <PrimaryButton label={submitLabel} busy={saving} onPress={onSubmit} />
      </View>
    </View>
  );
}

function SinglePaymentForm({
  capabilities,
  currency,
  draft,
  products,
  saving,
  onBack,
  onChange,
  onPickContact,
  onSubmit,
}: {
  capabilities: PaymentCapabilities;
  currency: string;
  draft: SinglePaymentDraft;
  products: ProductItem[];
  saving: boolean;
  onBack: () => void;
  onChange: (patch: Partial<SinglePaymentDraft>) => void;
  onPickContact: () => void;
  onSubmit: () => void;
}) {
  const selectedProduct = products.find((product) => getProductId(product) === draft.productId) || null;
  const price = getPrimaryPrice(selectedProduct);
  const amount = draft.chargeType === 'product' && price ? getPriceAmount(price) : Number(draft.amount || 0);
  const paymentProviders = capabilities.linkProviders.map((provider) => ({ value: provider, label: PROVIDER_LABELS[provider] }));
  const paymentModeOptions = [
    ...(capabilities.highLevelConnected ? [{ value: 'highlevel_invoice', label: 'Invoice GHL' }] : []),
    ...(paymentProviders.length ? [{ value: 'payment_link', label: 'Liga de pago' }] : []),
    { value: 'manual', label: 'Manual' },
  ];
  const summaryDetail = draft.mode === 'manual'
    ? getPaymentMethodLabel(draft.manualMethod)
    : draft.mode === 'highlevel_invoice'
      ? `HighLevel · ${HIGHLEVEL_INVOICE_SEND_METHODS.find((method) => method.id === draft.sendMethod)?.label || 'Email'}`
      : draft.provider ? PROVIDER_LABELS[draft.provider] : 'Link de pago';

  return (
    <PaymentFormShell
      Icon={CreditCard}
      title="Registrar pago único"
      subtitle="Envía una liga de pago o registra un pago manual."
      summary={{ label: draft.mode === 'manual' ? 'Pago manual' : 'Link de pago', detail: summaryDetail, amount: formatCurrency(amount, currency) }}
      saving={saving}
      submitLabel={draft.mode === 'manual' ? 'Registrar pago' : 'Crear enlace de pago'}
      onBack={onBack}
      onSubmit={onSubmit}
    >
      <PaymentContactButton contact={draft.contact} onPress={onPickContact} />
      <SegmentedOptions
        value={draft.chargeType}
        options={[
          { value: 'direct', label: 'Monto directo' },
          { value: 'product', label: 'Guardado' },
        ]}
        onChange={(value) => onChange({ chargeType: value as SinglePaymentDraft['chargeType'] })}
      />
      {draft.chargeType === 'product' ? (
        <View style={styles.paymentFieldGroup}>
          <Text style={styles.paymentFieldLabel}>Precio guardado</Text>
          {products.length ? products.map((product) => {
            const productId = getProductId(product);
            const productPrice = getPrimaryPrice(product);
            return (
              <Pressable
                key={productId || product.name}
                onPress={() => onChange({
                  productId,
                  title: product.name || draft.title,
                  description: product.description || draft.description,
                  amount: String(getPriceAmount(productPrice) || draft.amount),
                })}
                style={({ pressed }) => [styles.paymentOptionRow, draft.productId === productId && styles.paymentOptionRowActive, pressed && styles.pressed]}
              >
                <Package size={18} color={COLORS.accent} strokeWidth={2.4} />
                <View style={styles.paymentOptionCopy}>
                  <Text style={styles.paymentOptionTitle}>{product.name || 'Producto'}</Text>
                  <Text style={styles.paymentOptionSubtitle}>
                    {productPrice ? `${productPrice.name || 'Precio base'} · ${formatCurrency(getPriceAmount(productPrice), productPrice.currency || currency)}` : 'Sin precio guardado'}
                  </Text>
                </View>
                {draft.productId === productId ? <Check size={18} color={COLORS.accent} strokeWidth={2.8} /> : null}
              </Pressable>
            );
          }) : (
            <Text style={styles.paymentEmptyCopy}>No hay precios guardados. Puedes cobrar por monto directo.</Text>
          )}
        </View>
      ) : (
        <PaymentTextField
          label={`Monto (${currency})`}
          value={draft.amount}
          keyboardType="decimal-pad"
          placeholder="0.00"
          onChangeText={(amountValue) => onChange({ amount: amountValue })}
        />
      )}
      <PaymentTextField label="Título" value={draft.title} placeholder="Pago" onChangeText={(titleValue) => onChange({ title: titleValue })} />
      <PaymentTextField label="Descripción" value={draft.description} placeholder="Concepto del cobro" onChangeText={(description) => onChange({ description })} multiline />
      <SegmentedOptions
        value={draft.mode}
        options={paymentModeOptions}
        onChange={(modeValue) => onChange({ mode: modeValue as SinglePaymentMode })}
      />
      {draft.mode === 'payment_link' ? (
        paymentProviders.length ? (
          <SegmentedOptions
            value={draft.provider || paymentProviders[0]?.value || ''}
            options={paymentProviders}
            onChange={(provider) => onChange({ provider: provider as PaymentGatewayProvider })}
          />
        ) : (
          <View style={styles.paymentNotice}>
            <Text style={styles.paymentNoticeTitle}>Sin pasarela conectada</Text>
            <Text style={styles.paymentNoticeCopy}>Registra este pago manualmente o conecta una pasarela en Ajustes.</Text>
          </View>
        )
      ) : draft.mode === 'highlevel_invoice' ? (
        <>
          <SegmentedOptions
            value={draft.sendMethod}
            options={HIGHLEVEL_INVOICE_SEND_METHODS.map((method) => ({ value: method.id, label: method.label }))}
            onChange={(sendMethod) => onChange({ sendMethod: sendMethod as HighLevelInvoiceSendMethod })}
          />
          <PaymentTextField label="Vence" value={draft.dueDate} placeholder="YYYY-MM-DD" onChangeText={(dueDate) => onChange({ dueDate })} />
        </>
      ) : (
        <>
          <SegmentedOptions
            value={draft.manualMethod}
            options={MANUAL_PAYMENT_METHODS.map((method) => ({ value: method.id, label: method.label }))}
            onChange={(method) => onChange({ manualMethod: method as ManualPaymentMethod })}
          />
          <PaymentTextField label="Fecha de pago" value={draft.paymentDate} placeholder="YYYY-MM-DD" onChangeText={(paymentDate) => onChange({ paymentDate })} />
          <PaymentTextField label="Referencia" value={draft.reference} placeholder="Opcional" onChangeText={(reference) => onChange({ reference })} />
          <PaymentTextField label="Notas" value={draft.notes} placeholder="Notas internas" onChangeText={(notes) => onChange({ notes })} multiline />
        </>
      )}
    </PaymentFormShell>
  );
}

function PartialPaymentForm({
  capabilities,
  currency,
  draft,
  saving,
  onBack,
  onChange,
  onPickContact,
  onSubmit,
}: {
  capabilities: PaymentCapabilities;
  currency: string;
  draft: PartialPaymentDraft;
  saving: boolean;
  onBack: () => void;
  onChange: (patch: Partial<PartialPaymentDraft>) => void;
  onPickContact: () => void;
  onSubmit: () => void;
}) {
  const total = Number(draft.totalAmount || 0);
  const first = Math.max(0, Number(draft.firstPaymentAmount || 0));
  const count = Math.max(1, Number.parseInt(draft.installmentCount, 10) || 1);
  const remaining = Math.max(0, total - first);
  const installment = count ? remaining / count : 0;
  const providers = capabilities.planProviders.map((provider) => ({ value: provider, label: PLAN_PROVIDER_LABELS[provider] }));

  return (
    <PaymentFormShell
      Icon={CalendarDays}
      title="Planes de pago"
      subtitle="Configura parcialidades desde el celular."
      summary={{ label: 'Plan', detail: `${count} parcialidad${count === 1 ? '' : 'es'} · ${PAYMENT_PLAN_FREQUENCIES.find((item) => item.id === draft.frequency)?.label || 'Mensual'}`, amount: formatCurrency(total, currency) }}
      saving={saving}
      submitLabel="Crear plan de pagos"
      onBack={onBack}
      onSubmit={onSubmit}
    >
      <PaymentContactButton contact={draft.contact} onPress={onPickContact} />
      {providers.length ? (
        <SegmentedOptions
          value={draft.provider || providers[0]?.value || ''}
          options={providers}
          onChange={(provider) => onChange({ provider: provider as PaymentPlanProvider })}
        />
      ) : (
        <View style={styles.paymentNotice}>
          <Text style={styles.paymentNoticeTitle}>Planes no disponibles</Text>
          <Text style={styles.paymentNoticeCopy}>Tu cuenta necesita HighLevel, Stripe, Conekta o Rebill conectado para crear parcialidades.</Text>
        </View>
      )}
      <PaymentTextField label={`Total (${currency})`} value={draft.totalAmount} keyboardType="decimal-pad" placeholder="0.00" onChangeText={(totalAmount) => onChange({ totalAmount })} />
      <PaymentTextField label={`Primer pago (${currency})`} value={draft.firstPaymentAmount} keyboardType="decimal-pad" placeholder="0.00" onChangeText={(firstPaymentAmount) => onChange({ firstPaymentAmount })} />
      <SegmentedOptions
        value={draft.firstPaymentMethod}
        options={[
          { value: 'card', label: 'Tarjeta / link' },
          { value: 'bank_transfer', label: 'Transferencia' },
          { value: 'cash', label: 'Efectivo' },
          { value: 'deposit', label: 'Depósito' },
        ]}
        onChange={(firstPaymentMethod) => onChange({ firstPaymentMethod: firstPaymentMethod as PartialPaymentDraft['firstPaymentMethod'] })}
      />
      <View style={styles.paymentFormGrid}>
        <View style={styles.paymentFormGridItem}>
          <PaymentTextField label="Pagos restantes" value={draft.installmentCount} keyboardType="number-pad" placeholder="2" onChangeText={(installmentCount) => onChange({ installmentCount })} />
        </View>
        <View style={styles.paymentFormGridItem}>
          <PaymentTextField label="Monto aprox." value={formatCurrency(installment, currency)} editable={false} onChangeText={() => undefined} />
        </View>
      </View>
      <SegmentedOptions
        value={draft.frequency}
        options={PAYMENT_PLAN_FREQUENCIES.map((item) => ({ value: item.id, label: item.label }))}
        onChange={(frequency) => onChange({ frequency: frequency as PartialPaymentDraft['frequency'] })}
      />
      <PaymentTextField label="Concepto" value={draft.title} placeholder="Plan de parcialidades" onChangeText={(title) => onChange({ title })} />
    </PaymentFormShell>
  );
}

function SubscriptionPaymentForm({
  capabilities,
  currency,
  draft,
  saving,
  onBack,
  onChange,
  onPickContact,
  onSubmit,
}: {
  capabilities: PaymentCapabilities;
  currency: string;
  draft: SubscriptionDraft;
  saving: boolean;
  onBack: () => void;
  onChange: (patch: Partial<SubscriptionDraft>) => void;
  onPickContact: () => void;
  onSubmit: () => void;
}) {
  const amount = Number(draft.amount || 0);
  const providers = capabilities.subscriptionProviders.map((provider) => ({ value: provider, label: PROVIDER_LABELS[provider] }));
  const interval = SUBSCRIPTION_INTERVALS.find((item) => item.id === draft.intervalType)?.label || 'Mensual';

  return (
    <PaymentFormShell
      Icon={Repeat2}
      title="Nueva suscripción"
      subtitle="Configura el cobro recurrente desde el celular."
      summary={{ label: 'Cobro recurrente', detail: `${interval} · ${draft.provider ? PROVIDER_LABELS[draft.provider] : 'Pasarela'}`, amount: formatCurrency(amount, currency) }}
      saving={saving}
      submitLabel="Crear enlace de pago"
      onBack={onBack}
      onSubmit={onSubmit}
    >
      <PaymentContactButton contact={draft.contact} onPress={onPickContact} />
      {providers.length ? (
        <SegmentedOptions
          value={draft.provider || providers[0]?.value || ''}
          options={providers}
          onChange={(provider) => onChange({ provider: provider as PaymentGatewayProvider })}
        />
      ) : (
        <View style={styles.paymentNotice}>
          <Text style={styles.paymentNoticeTitle}>Sin pasarela conectada</Text>
          <Text style={styles.paymentNoticeCopy}>Conecta Stripe, Conekta, Mercado Pago o Rebill para crear suscripciones.</Text>
        </View>
      )}
      <PaymentTextField label="Nombre" value={draft.name} placeholder="Ej. Membresía mensual" onChangeText={(name) => onChange({ name })} />
      <PaymentTextField label={`Monto (${currency})`} value={draft.amount} keyboardType="decimal-pad" placeholder="0.00" onChangeText={(amountValue) => onChange({ amount: amountValue })} />
      <SegmentedOptions
        value={draft.intervalType}
        options={SUBSCRIPTION_INTERVALS.map((item) => ({ value: item.id, label: item.label }))}
        onChange={(intervalType) => onChange({ intervalType: intervalType as SubscriptionDraft['intervalType'] })}
      />
      <View style={styles.paymentFormGrid}>
        <View style={styles.paymentFormGridItem}>
          <PaymentTextField label="Cada" value={draft.intervalCount} keyboardType="number-pad" placeholder="1" onChangeText={(intervalCount) => onChange({ intervalCount })} />
        </View>
        <View style={styles.paymentFormGridItem}>
          <PaymentTextField label="Inicio" value={draft.startDate} placeholder="YYYY-MM-DD" onChangeText={(startDate) => onChange({ startDate })} />
        </View>
      </View>
      <PaymentTextField label="Notas" value={draft.description} placeholder="Notas internas de esta suscripción." onChangeText={(description) => onChange({ description })} multiline />
    </PaymentFormShell>
  );
}

function PaymentsProductsView({
  currency,
  deletingProductId,
  editing,
  form,
  loading,
  products,
  saving,
  onBack,
  onCancelForm,
  onChangeForm,
  onCreate,
  onDelete,
  onEdit,
  onRefresh,
  onSave,
}: {
  currency: string;
  deletingProductId: string;
  editing: ProductFormMode;
  form: ProductFormState;
  loading: boolean;
  products: ProductItem[];
  saving: boolean;
  onBack: () => void;
  onCancelForm: () => void;
  onChangeForm: (patch: Partial<ProductFormState>) => void;
  onCreate: () => void;
  onDelete: (product: ProductItem) => void;
  onEdit: (product: ProductItem) => void;
  onRefresh: () => void;
  onSave: () => void;
}) {
  return (
    <View style={styles.paymentFormRoot}>
      <View style={styles.productsHeader}>
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.paymentBackButton}>
          <ChevronLeft size={20} color={COLORS.text} strokeWidth={2.5} />
        </Pressable>
        <View style={styles.productsHeaderCopy}>
          <Text style={styles.paymentFormTitle}>Precios Guardados</Text>
          <Text style={styles.paymentFormSubtitle}>{products.length === 1 ? '1 disponible' : `${products.length} disponibles`}</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onRefresh} style={styles.paymentIconButton}>
          <RefreshCw size={18} color={COLORS.text} strokeWidth={2.5} />
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onCreate} style={styles.productNewButton}>
          <Plus size={17} color={COLORS.white} strokeWidth={2.6} />
          <Text style={styles.productNewButtonText}>Nuevo</Text>
        </Pressable>
      </View>
      <ScrollView {...HIDDEN_SCROLL_INDICATOR_PROPS} contentContainerStyle={styles.paymentFormScroll} keyboardShouldPersistTaps="handled">
        {editing ? (
          <View style={styles.productForm}>
            <View style={styles.productFormHeader}>
              <View style={styles.productFormHeaderCopy}>
                <Text style={styles.productFormTitle}>{editing === 'edit' ? 'Editar producto' : 'Nuevo producto'}</Text>
                <Text style={styles.productFormSubtitle}>Estos datos aparecerán al cobrar desde Guardados.</Text>
              </View>
              <Pressable accessibilityRole="button" onPress={onCancelForm} style={styles.sheetCloseButton}>
                <X size={18} color={COLORS.text} strokeWidth={2.5} />
              </Pressable>
            </View>
            <PaymentTextField label="Nombre del producto" value={form.name} placeholder="Ej. Consulta inicial" onChangeText={(name) => onChangeForm({ name })} />
            <PaymentTextField label={`Precio (${currency})`} value={form.amount} keyboardType="decimal-pad" placeholder="0.00" onChangeText={(amount) => onChangeForm({ amount })} />
            <PaymentTextField label="Nombre del precio" value={form.priceName} placeholder="Precio base" onChangeText={(priceName) => onChangeForm({ priceName })} />
            <PaymentTextField label="Descripción" value={form.description} placeholder="Agrega una nota corta para reconocerlo." multiline onChangeText={(description) => onChangeForm({ description })} />
            <View style={styles.productFormActions}>
              <SecondaryButton label="Cancelar" onPress={onCancelForm} />
              <Pressable disabled={saving} onPress={onSave} style={({ pressed }) => [styles.productSaveButton, pressed && styles.pressed, saving && styles.disabledButton]}>
                {saving ? <ActivityIndicator color={COLORS.white} /> : <Save size={17} color={COLORS.white} strokeWidth={2.6} />}
                <Text style={styles.productSaveButtonText}>Guardar</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {loading && !products.length ? (
          <View style={styles.inlineState}>
            <ActivityIndicator color={COLORS.accent} />
            <Text style={styles.caption}>Cargando...</Text>
          </View>
        ) : products.length ? (
          <View style={styles.productsList}>
            {products.map((product, index) => {
              const productId = getProductId(product) || `product-${index}`;
              const price = getPrimaryPrice(product);
              const amount = getPriceAmount(price);
              const deleting = deletingProductId === productId;
              return (
                <View key={productId} style={styles.productItem}>
                  <View style={styles.productItemIcon}>
                    <Package size={20} color={COLORS.accent} strokeWidth={2.5} />
                  </View>
                  <View style={styles.productItemCopy}>
                    <Text numberOfLines={1} style={styles.productItemTitle}>{product.name || 'Producto sin nombre'}</Text>
                    <Text numberOfLines={1} style={styles.productItemSubtitle}>{product.description || 'Sin descripción'}</Text>
                    <Text style={styles.productItemMeta}>{price ? `${price.name || 'Precio'} · ${formatCurrency(amount, price.currency || product.currency || currency)}` : 'Sin precio guardado'}</Text>
                  </View>
                  <Pressable accessibilityRole="button" onPress={() => onEdit(product)} style={styles.paymentIconButton}>
                    <Pencil size={17} color={COLORS.text} strokeWidth={2.4} />
                  </Pressable>
                  <Pressable disabled={deleting} accessibilityRole="button" onPress={() => onDelete(product)} style={[styles.paymentIconButton, styles.productDeleteButton, deleting && styles.disabledButton]}>
                    {deleting ? <ActivityIndicator color={COLORS.danger} /> : <Trash2 size={17} color={COLORS.danger} strokeWidth={2.4} />}
                  </Pressable>
                </View>
              );
            })}
          </View>
        ) : (
          <View style={styles.productsEmpty}>
            <Package size={30} color={COLORS.accent} strokeWidth={2.4} />
            <Text style={styles.productsEmptyTitle}>Sin productos todavía</Text>
            <Text style={styles.productsEmptyCopy}>Crea tu primer producto para cobrarlo rápido desde el celular.</Text>
            <PrimaryButton label="Crear producto" onPress={onCreate} />
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function PaymentContactButton({ contact, onPress }: { contact: ChatContact | null; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.paymentContactButton, pressed && styles.pressed]}>
      <View style={styles.paymentContactIcon}>
        <User size={19} color={COLORS.accent} strokeWidth={2.5} />
      </View>
      <View style={styles.paymentContactCopy}>
        <Text style={styles.paymentContactLabel}>Cliente</Text>
        <Text numberOfLines={1} style={styles.paymentContactValue}>
          {contact ? getContactName(contact) : 'Buscar contacto'}
        </Text>
        {contact ? <Text numberOfLines={1} style={styles.paymentContactMeta}>{contact.email || contact.phone || 'Contacto guardado'}</Text> : null}
      </View>
      <ChevronRight size={18} color={COLORS.muted} strokeWidth={2.4} />
    </Pressable>
  );
}

function PaymentTextField({
  label,
  value,
  placeholder,
  keyboardType,
  multiline,
  editable = true,
  onChangeText,
}: {
  label: string;
  value: string;
  placeholder?: string;
  keyboardType?: 'default' | 'decimal-pad' | 'number-pad';
  multiline?: boolean;
  editable?: boolean;
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={styles.paymentFieldGroup}>
      <Text style={styles.paymentFieldLabel}>{label}</Text>
      <TextInput
        value={value}
        editable={editable}
        onChangeText={onChangeText}
        keyboardType={keyboardType || 'default'}
        placeholder={placeholder}
        placeholderTextColor={COLORS.muted}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        style={[styles.paymentInput, multiline && styles.paymentTextarea, !editable && styles.paymentInputDisabled]}
      />
    </View>
  );
}

function SegmentedOptions({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  onChange: (value: string) => void;
}) {
  if (!options.length) return null;
  return (
    <ScrollView horizontal {...HIDDEN_SCROLL_INDICATOR_PROPS} contentContainerStyle={styles.paymentSegmentRow}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            disabled={option.disabled}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [styles.paymentSegment, selected && styles.paymentSegmentActive, option.disabled && styles.disabledButton, pressed && styles.pressed]}
          >
            <Text style={[styles.paymentSegmentText, selected && styles.paymentSegmentTextActive]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function PaymentContactSheet({
  contacts,
  loading,
  open,
  query,
  onChangeQuery,
  onClose,
  onSelect,
}: {
  contacts: ChatContact[];
  loading: boolean;
  open: boolean;
  query: string;
  onChangeQuery: (value: string) => void;
  onClose: () => void;
  onSelect: (contact: ChatContact) => void;
}) {
  return (
    <BottomActionSheet open={open} title="Seleccionar cliente" subtitle="Busca por nombre, email o teléfono" onClose={onClose}>
      <View style={styles.contactPickerBody}>
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
          <ScrollView {...HIDDEN_SCROLL_INDICATOR_PROPS} contentContainerStyle={styles.contactPickerList} keyboardShouldPersistTaps="handled">
            {contacts.length ? contacts.slice(0, 40).map((contact) => (
              <ContactPickerRow key={contact.id} contact={contact} onPress={() => onSelect(contact)} />
            )) : (
              <Text style={styles.contactPickerEmpty}>{query.trim().length >= 2 ? 'No encontramos contactos guardados con esa búsqueda.' : 'Busca por nombre, email o teléfono.'}</Text>
            )}
          </ScrollView>
        )}
      </View>
    </BottomActionSheet>
  );
}

function PaymentLinkReadySheet({ link, onClose }: { link: PaymentLinkReady | null; onClose: () => void }) {
  return (
    <BottomActionSheet
      open={Boolean(link)}
      title={link?.title || 'Link listo'}
      subtitle={link ? formatCurrency(link.amount, link.currency) : ''}
      onClose={onClose}
    >
      {link ? (
        <View style={styles.paymentLinkReadyBody}>
          <View style={styles.paymentNotice}>
            <Text style={styles.paymentNoticeTitle}>Autorización pendiente</Text>
            <Text style={styles.paymentNoticeCopy}>{link.description}</Text>
          </View>
          <Text selectable numberOfLines={3} style={styles.paymentLinkText}>{link.url}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              Linking.openURL(link.url).catch(() => Alert.alert('No se pudo abrir', 'Copia o revisa el enlace manualmente.'));
            }}
            style={({ pressed }) => [styles.paymentOpenLinkButton, pressed && styles.pressed]}
          >
            <ExternalLink size={18} color={COLORS.white} strokeWidth={2.5} />
            <Text style={styles.paymentOpenLinkText}>Abrir</Text>
          </Pressable>
          <SecondaryButton label="Listo" onPress={onClose} />
        </View>
      ) : null}
    </BottomActionSheet>
  );
}

function unwrapConfig(response: unknown) {
  if (response && typeof response === 'object' && 'config' in response) {
    const config = (response as { config?: unknown }).config;
    return config && typeof config === 'object' ? config as Record<string, unknown> : {};
  }
  return response && typeof response === 'object' ? response as Record<string, unknown> : {};
}

function getEmptyPaymentCapabilities(loading = false): PaymentCapabilities {
  return {
    loading,
    highLevelConnected: false,
    hasConnectedPaymentGateway: false,
    canUsePaymentPlans: false,
    canUseSubscriptions: false,
    linkProviders: [],
    planProviders: [],
    subscriptionProviders: [],
  };
}

function getPaymentCapabilities(status: IntegrationsStatus | null): PaymentCapabilities {
  const connected = (provider: PaymentGatewayProvider | 'highlevel') => Boolean((status?.[provider] as { connected?: boolean } | undefined)?.connected);
  const linkProviders: PaymentGatewayProvider[] = [
    ...(connected('stripe') ? ['stripe' as const] : []),
    ...(connected('conekta') ? ['conekta' as const] : []),
    ...(connected('mercadopago') ? ['mercadopago' as const] : []),
    ...(connected('clip') ? ['clip' as const] : []),
    ...(connected('rebill') ? ['rebill' as const] : []),
  ];
  const gatewayPlanProviders: PaymentGatewayProvider[] = [
    ...(connected('stripe') ? ['stripe' as const] : []),
    ...(connected('conekta') ? ['conekta' as const] : []),
    ...(connected('rebill') ? ['rebill' as const] : []),
  ];
  const subscriptionProviders: PaymentGatewayProvider[] = [
    ...(connected('stripe') ? ['stripe' as const] : []),
    ...(connected('conekta') ? ['conekta' as const] : []),
    ...(connected('mercadopago') ? ['mercadopago' as const] : []),
    ...(connected('rebill') ? ['rebill' as const] : []),
  ];
  const highLevelConnected = connected('highlevel');
  return {
    loading: false,
    highLevelConnected,
    hasConnectedPaymentGateway: linkProviders.length > 0,
    canUsePaymentPlans: highLevelConnected || gatewayPlanProviders.length > 0,
    canUseSubscriptions: subscriptionProviders.length > 0,
    linkProviders,
    planProviders: [...(highLevelConnected ? ['highlevel' as const] : []), ...gatewayPlanProviders],
    subscriptionProviders,
  };
}

function getAvailableSinglePaymentMode(mode: SinglePaymentMode, capabilities: PaymentCapabilities): SinglePaymentMode {
  if (mode === 'highlevel_invoice' && capabilities.highLevelConnected) return mode;
  if (mode === 'payment_link' && capabilities.linkProviders.length > 0) return mode;
  if (mode === 'manual') return mode;
  if (capabilities.highLevelConnected) return 'highlevel_invoice';
  if (capabilities.linkProviders.length > 0) return 'payment_link';
  return 'manual';
}

function createEmptyProductForm(): ProductFormState {
  return {
    name: '',
    description: '',
    priceName: 'Precio base',
    amount: '',
  };
}

function createSinglePaymentDraft(timezone: string, contact: ChatContact | null = null): SinglePaymentDraft {
  const today = dateOnlyInTimezone(new Date(), timezone);
  return {
    contact,
    title: 'Pago',
    description: '',
    amount: '',
    chargeType: 'direct',
    productId: '',
    mode: 'payment_link',
    provider: '',
    paymentDate: today,
    dueDate: addDateOnlyDays(today, 7),
    manualMethod: 'cash',
    sendMethod: 'email',
    reference: '',
    notes: '',
  };
}

function createPartialPaymentDraft(contact: ChatContact | null = null): PartialPaymentDraft {
  return {
    contact,
    title: 'Plan de parcialidades',
    totalAmount: '',
    firstPaymentAmount: '',
    firstPaymentMethod: 'card',
    installmentCount: '2',
    frequency: 'monthly',
    provider: '',
  };
}

function createSubscriptionDraft(timezone: string, contact: ChatContact | null = null): SubscriptionDraft {
  return {
    contact,
    name: '',
    amount: '',
    intervalType: 'monthly',
    intervalCount: '1',
    startDate: dateOnlyInTimezone(new Date(), timezone),
    description: '',
    provider: '',
  };
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
  return transaction.id || transaction._id || '';
}

function getTransactionTime(transaction: TransactionItem) {
  const value = transaction.date || transaction.paymentDate || transaction.createdAt || '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function getPaymentContactLabel(transaction: TransactionItem) {
  return transaction.contactName || transaction.email || transaction.phone || 'Cliente sin nombre';
}

function getPaymentResponseUrl(response?: PaymentLinkResponse | null) {
  if (!response) return '';
  return String(
    response.paymentUrl ||
    response.cardSetupLink ||
    response.firstPaymentLink ||
    response.payment?.paymentUrl ||
    response.payment?.paymentUrl ||
    ''
  );
}

function getHighLevelInvoiceId(response: { invoice?: { id?: string; _id?: string } } | null) {
  return String(response?.invoice?.id || response?.invoice?._id || '').trim();
}

function getHighLevelInvoiceUrl(response: { invoice?: { paymentLink?: string } } | null) {
  return String(response?.invoice?.paymentLink || '').trim();
}

function getSubscriptionActivationUrl(subscription: { [key: string]: unknown } | null, provider: PaymentGatewayProvider) {
  if (!subscription) return '';
  if (provider === 'mercadopago') return String(subscription.mercadoPagoInitPoint || subscription.mercadoPagoSandboxInitPoint || subscription.subscriptionStartUrl || '');
  if (provider === 'rebill') return String(subscription.rebillPaymentLinkUrl || subscription.rebillCheckoutUrl || subscription.subscriptionStartUrl || '');
  if (provider === 'stripe') return String(subscription.stripeCheckoutUrl || subscription.subscriptionStartUrl || '');
  if (provider === 'conekta') return String(subscription.conektaCheckoutUrl || subscription.subscriptionStartUrl || '');
  return String(subscription.subscriptionStartUrl || '');
}

function getNativeSubscriptionPaymentMethod(provider: PaymentGatewayProvider) {
  if (provider === 'mercadopago') return 'mercadopago_subscription';
  if (provider === 'rebill') return 'rebill_subscription';
  if (provider === 'conekta') return 'conekta_subscription';
  if (provider === 'stripe') return 'stripe_saved_card';
  return `${provider}_subscription`;
}

function buildNativeInvoicePayload({
  contact,
  title,
  description,
  amount,
  currency,
  dueDate,
  lineItems,
  source = 'native_mobile_payments',
}: {
  contact: ChatContact;
  title: string;
  description?: string;
  amount: number;
  currency: string;
  dueDate: string;
  lineItems?: Array<Record<string, unknown>>;
  source?: string;
}) {
  const items = lineItems?.length ? lineItems : [{
    name: title,
    description: description || title,
    amount,
    qty: 1,
    currency,
  }];

  return {
    name: title,
    title,
    currency,
    contactDetails: {
      id: contact.id,
      name: getContactName(contact),
      email: contact.email || '',
      phoneNo: contact.phone || '',
    },
    items,
    dueDate,
    metadata: {
      source,
      lineItems: items,
    },
  };
}

function getInstallmentDueDate(startDate: string, frequency: PartialPaymentDraft['frequency'], index: number) {
  if (frequency === 'weekly') return addDateOnlyDays(startDate, 7 * index);
  if (frequency === 'biweekly') return addDateOnlyDays(startDate, 14 * index);
  if (frequency === 'yearly') return addDateOnlyMonths(startDate, 12 * index);
  return addDateOnlyMonths(startDate, index);
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
    <ScrollView {...HIDDEN_SCROLL_INDICATOR_PROPS} contentContainerStyle={styles.sectionScroll}>
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
    <ScrollView {...HIDDEN_SCROLL_INDICATOR_PROPS} contentContainerStyle={styles.sectionScroll}>
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
  const [pushPermission, setPushPermission] = useState<NativePushPermissionStatus>('unsupported');
  const [pushBusy, setPushBusy] = useState(false);

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
          'calendar_push_notification_calendar_ids',
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

  useEffect(() => {
    void getNativePushPermissionStatus().then(setPushPermission);
  }, []);

  const requestNativePush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      const calendarIds = Array.isArray(config.calendar_push_notification_calendar_ids)
        ? config.calendar_push_notification_calendar_ids.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      const result = await subscribeToNativePushNotifications(api, { calendarIds });
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
    ['Permiso del celular', formatPushPermission(pushPermission)],
  ];

  return (
    <ScrollView {...HIDDEN_SCROLL_INDICATOR_PROPS} contentContainerStyle={styles.sectionScroll}>
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
          <PrimaryButton
            label={pushBusy ? 'Activando alertas...' : 'Activar notificaciones'}
            busy={pushBusy}
            onPress={() => void requestNativePush()}
          />
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

function formatPushPermission(value: NativePushPermissionStatus) {
  if (value === 'granted') return 'Permitido';
  if (value === 'denied') return 'Bloqueado';
  if (value === 'prompt') return 'Pendiente';
  return 'No disponible';
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
      {...HIDDEN_SCROLL_INDICATOR_PROPS}
      ref={scrollRef}
      horizontal
      contentInsetAdjustmentBehavior="never"
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
          <ScrollView {...HIDDEN_SCROLL_INDICATOR_PROPS} contentContainerStyle={styles.filterSheetBody}>
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
        <ScrollView {...HIDDEN_SCROLL_INDICATOR_PROPS} contentContainerStyle={styles.sheetActionList}>
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
            <ScrollView {...HIDDEN_SCROLL_INDICATOR_PROPS} contentContainerStyle={styles.sheetActionList} keyboardShouldPersistTaps="handled">
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
  sending = false,
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
  sending?: boolean;
  title: string;
  onChangeQuery: (value: string) => void;
  onClose: () => void;
  onSelect: (contact: ChatContact) => void | Promise<void>;
}) {
  const assetKind = getCameraAssetKind(asset);
  const assetNoun = getCameraAssetNoun(asset);
  const videoDuration = formatCameraAssetDuration(asset);

  return (
    <BottomActionSheet
      closing={closing}
      open={open}
      title={title}
      subtitle={asset ? `Elige a quién enviar ${assetKind === 'video' ? 'el' : 'la'} ${assetNoun}` : 'Busca por nombre, número o correo'}
      onClose={onClose}
    >
      <View style={styles.contactPickerBody}>
        {asset && assetKind === 'image' ? (
          <Image source={{ uri: asset.uri }} style={styles.cameraPreview} />
        ) : null}
        {asset && assetKind === 'video' ? (
          <View style={styles.cameraVideoPreview}>
            <View style={styles.cameraVideoIcon}>
              <Video size={30} color={COLORS.accent} strokeWidth={2.5} />
            </View>
            <View style={styles.cameraVideoCopy}>
              <Text style={styles.cameraVideoTitle}>Video listo</Text>
              <Text style={styles.cameraVideoMeta}>{videoDuration ? `${videoDuration} · listo para enviar` : 'Listo para enviar'}</Text>
            </View>
          </View>
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
        {sending ? (
          <View style={styles.sheetInlineState}>
            <ActivityIndicator color={COLORS.accent} />
            <Text style={styles.caption}>Enviando {assetNoun}...</Text>
          </View>
        ) : loading ? (
          <View style={styles.sheetInlineState}>
            <ActivityIndicator color={COLORS.accent} />
            <Text style={styles.caption}>Buscando contactos...</Text>
          </View>
        ) : (
          <ScrollView {...HIDDEN_SCROLL_INDICATOR_PROPS} contentContainerStyle={styles.contactPickerList} keyboardShouldPersistTaps="handled">
            {contacts.length ? contacts.slice(0, 40).map((contact) => (
              <ContactPickerRow key={contact.id} contact={contact} disabled={sending} onPress={() => { void onSelect(contact); }} />
            )) : (
              <Text style={styles.contactPickerEmpty}>No hay contactos para mostrar.</Text>
            )}
          </ScrollView>
        )}
      </View>
    </BottomActionSheet>
  );
}

function ContactPickerRow({ contact, disabled = false, onPress }: { contact: ChatContact; disabled?: boolean; onPress: () => void }) {
  const avatar = getContactAvatar(contact);
  const channelKind = getContactChannelKind(contact);
  const channelColor = CHANNEL_BADGE_COLORS[channelKind];
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.contactPickerRow, pressed && styles.pressed, disabled && styles.disabledButton]}>
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
          <Image source={require('../assets/icon.png')} style={styles.aiChatLogoImage} />
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
        <Pressable accessibilityRole="button" onPress={onToggleVisible} style={styles.chatSelectionSelectAll}>
          <View style={[styles.chatSelectionMiniCheck, allVisibleSelected && styles.chatSelectionMiniCheckActive]}>
            {allVisibleSelected ? <Check size={11} color={COLORS.white} strokeWidth={3} /> : null}
          </View>
          <Text numberOfLines={1} style={styles.chatSelectionSelectAllText}>
            {allVisibleSelected ? 'Quitar' : 'Visibles'}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onToggleMenu}
          style={[styles.chatSelectionMoreButton, busy && styles.disabledButton]}
        >
          <MoreHorizontal size={17} color={COLORS.white} strokeWidth={2.8} />
          <Text style={styles.chatSelectionMoreButtonText}>Más</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onClear} style={styles.chatSelectionClearButton}>
          <X size={16} color={COLORS.text} strokeWidth={2.5} />
        </Pressable>
      </View>
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
  const swipeTargetRef = useRef(0);
  const draggingRef = useRef(false);
  const dragStartedOpenRef = useRef(false);
  const dragIntentRef = useRef<'opening' | 'closing' | null>(null);
  const suppressNextPressRef = useRef(false);
  const suppressPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (suppressPressTimerRef.current) {
      clearTimeout(suppressPressTimerRef.current);
      suppressPressTimerRef.current = null;
    }
  }, []);

  const animateSwipeTo = useCallback((toValue: number) => {
    swipeTargetRef.current = toValue;
    translateX.stopAnimation();
    Animated.timing(translateX, {
      toValue,
      useNativeDriver: true,
      duration: toValue < 0 ? CHAT_SWIPE_OPEN_DURATION_MS : CHAT_SWIPE_CLOSE_DURATION_MS,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
    }).start(({ finished }) => {
      if (finished) offsetRef.current = toValue;
    });
  }, [translateX]);

  useEffect(() => {
    if (draggingRef.current) return;
    const nextTarget = swipeOpen && !selectionActive ? -CHAT_SWIPE_ACTION_WIDTH : 0;
    if (swipeTargetRef.current === nextTarget) return;
    animateSwipeTo(nextTarget);
  }, [animateSwipeTo, selectionActive, swipeOpen]);

  const settleSwipe = useCallback((toValue: number) => {
    if (swipeTargetRef.current !== toValue) {
      animateSwipeTo(toValue);
    }
    if (toValue < 0) {
      onSwipeOpen();
      return;
    }
    onSwipeClose();
  }, [animateSwipeTo, onSwipeClose, onSwipeOpen]);

  const settleSwipeFromIntent = useCallback(() => {
    const intent = dragIntentRef.current;
    dragIntentRef.current = null;
    if (intent === 'opening') {
      settleSwipe(-CHAT_SWIPE_ACTION_WIDTH);
      return;
    }
    if (intent === 'closing') {
      settleSwipe(0);
      return;
    }
    settleSwipe(dragStartedOpenRef.current ? -CHAT_SWIPE_ACTION_WIDTH : 0);
  }, [settleSwipe]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) => {
      if (selectionActive) return false;
      return Math.abs(gestureState.dx) > CHAT_SWIPE_GESTURE_START_DISTANCE
        && Math.abs(gestureState.dx) > Math.abs(gestureState.dy) + 2;
    },
    onPanResponderGrant: () => {
      draggingRef.current = true;
      onSwipeStart();
      const expectedOffset = swipeOpen && !selectionActive ? -CHAT_SWIPE_ACTION_WIDTH : 0;
      offsetRef.current = expectedOffset;
      dragStartOffsetRef.current = expectedOffset;
      swipeTargetRef.current = expectedOffset;
      dragStartedOpenRef.current = expectedOffset <= -CHAT_SWIPE_ACTION_WIDTH + 1;
      dragIntentRef.current = null;
      translateX.stopAnimation((value) => {
        const currentOffset = Math.max(-CHAT_SWIPE_ACTION_WIDTH, Math.min(0, Number(value) || 0));
        offsetRef.current = currentOffset;
        dragStartOffsetRef.current = currentOffset;
        swipeTargetRef.current = currentOffset;
        dragStartedOpenRef.current = currentOffset <= -CHAT_SWIPE_ACTION_WIDTH + 1;
        dragIntentRef.current = null;
      });
    },
    onPanResponderMove: (_, gestureState) => {
      if (dragIntentRef.current) return;
      const startedOpen = dragStartedOpenRef.current;
      if (!startedOpen && gestureState.dx <= -CHAT_SWIPE_INTENT_DISTANCE) {
        dragIntentRef.current = 'opening';
        animateSwipeTo(-CHAT_SWIPE_ACTION_WIDTH);
        return;
      }
      if (startedOpen && gestureState.dx >= CHAT_SWIPE_INTENT_DISTANCE) {
        dragIntentRef.current = 'closing';
        animateSwipeTo(0);
        return;
      }
      const holdOffset = startedOpen ? -CHAT_SWIPE_ACTION_WIDTH : 0;
      offsetRef.current = holdOffset;
      swipeTargetRef.current = holdOffset;
      translateX.setValue(holdOffset);
    },
    onPanResponderRelease: () => {
      draggingRef.current = false;
      settleSwipeFromIntent();
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderTerminate: () => {
      draggingRef.current = false;
      settleSwipeFromIntent();
    },
  }), [animateSwipeTo, onSwipeStart, selectionActive, settleSwipeFromIntent, swipeOpen, translateX]);

  const handlePress = () => {
    if (suppressNextPressRef.current) {
      suppressNextPressRef.current = false;
      if (suppressPressTimerRef.current) {
        clearTimeout(suppressPressTimerRef.current);
        suppressPressTimerRef.current = null;
      }
      return;
    }
    if (swipeOpen && !selectionActive) {
      onSwipeClose();
      return;
    }
    onPress();
  };

  const handleLongPress = () => {
    suppressNextPressRef.current = true;
    if (suppressPressTimerRef.current) clearTimeout(suppressPressTimerRef.current);
    suppressPressTimerRef.current = setTimeout(() => {
      suppressNextPressRef.current = false;
      suppressPressTimerRef.current = null;
    }, 650);
    onLongPress?.();
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
            pressed && !draggingRef.current && styles.pressed,
          ]}
          onPress={handlePress}
          onLongPress={selectionActive ? undefined : handleLongPress}
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
            {...HIDDEN_SCROLL_INDICATOR_PROPS}
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
  paymentsSelectScroll: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 118,
    gap: 10,
  },
  paymentsTitle: {
    color: COLORS.text,
    fontSize: 31,
    lineHeight: 36,
    fontWeight: '900',
    marginBottom: 6,
  },
  paymentChoiceCard: {
    minHeight: 82,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    paddingVertical: 12,
  },
  paymentChoiceIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accentSoft,
  },
  paymentChoiceCopy: {
    flex: 1,
    minWidth: 0,
  },
  paymentChoiceTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '900',
  },
  paymentChoiceSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
  },
  recentPaymentsSection: {
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  recentPaymentsToggle: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  recentPaymentsToggleCopy: {
    flex: 1,
    minWidth: 0,
  },
  recentPaymentsToggleTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
  },
  recentPaymentsToggleMeta: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
  },
  recentPaymentsPanel: {
    gap: 8,
    paddingBottom: 12,
  },
  recentPaymentItem: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 18,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(16,42,120,0.36)',
  },
  recentPaymentItemSelected: {
    backgroundColor: COLORS.accentSoft,
    borderWidth: 1,
    borderColor: 'rgba(0,168,248,0.34)',
  },
  recentPaymentMain: {
    flex: 1,
    minWidth: 0,
  },
  recentPaymentAmount: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
  },
  recentPaymentContact: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
  },
  recentPaymentMeta: {
    minWidth: 96,
    alignItems: 'flex-end',
  },
  recentPaymentDate: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '800',
  },
  recentPaymentStatus: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 2,
    maxWidth: 126,
  },
  recentPaymentsEmpty: {
    color: COLORS.muted,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 20,
  },
  selectBottomSpacer: {
    height: 18,
  },
  paymentFormRoot: {
    flex: 1,
    minHeight: 0,
  },
  paymentFormHeader: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  paymentBackButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  paymentFormIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accentSoft,
  },
  paymentFormHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  paymentFormTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '900',
  },
  paymentFormSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
  },
  paymentFormScroll: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 112,
    gap: 12,
  },
  paymentSummaryBar: {
    minHeight: 66,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  paymentSummaryCopy: {
    flex: 1,
    minWidth: 0,
  },
  paymentSummaryLabel: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '900',
  },
  paymentSummaryDetail: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 3,
  },
  paymentSummaryAmount: {
    color: COLORS.accent,
    fontSize: 16,
    fontWeight: '900',
  },
  paymentFormFooter: {
    position: 'absolute',
    right: 0,
    bottom: 72,
    left: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    backgroundColor: 'rgba(6,18,58,0.96)',
  },
  paymentFieldGroup: {
    gap: 6,
  },
  paymentFieldLabel: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '900',
    paddingHorizontal: 2,
  },
  paymentInput: {
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelSoft,
    color: COLORS.text,
    paddingHorizontal: 13,
    paddingVertical: 9,
    fontSize: 15,
  },
  paymentTextarea: {
    minHeight: 92,
    lineHeight: 20,
  },
  paymentInputDisabled: {
    color: COLORS.muted,
    opacity: 0.86,
  },
  paymentSegmentRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 1,
  },
  paymentSegment: {
    minHeight: 38,
    borderRadius: 19,
    paddingHorizontal: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  paymentSegmentActive: {
    backgroundColor: COLORS.accentSoft,
    borderColor: 'rgba(0,168,248,0.36)',
  },
  paymentSegmentText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '900',
  },
  paymentSegmentTextActive: {
    color: COLORS.text,
  },
  paymentContactButton: {
    minHeight: 70,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  paymentContactIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accentSoft,
  },
  paymentContactCopy: {
    flex: 1,
    minWidth: 0,
  },
  paymentContactLabel: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  paymentContactValue: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
    marginTop: 2,
  },
  paymentContactMeta: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
  },
  paymentNotice: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(16,42,120,0.46)',
    padding: 13,
    gap: 4,
  },
  paymentNoticeTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '900',
  },
  paymentNoticeCopy: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 17,
  },
  paymentFormGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  paymentFormGridItem: {
    flex: 1,
    minWidth: 0,
  },
  paymentOptionRow: {
    minHeight: 62,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(16,42,120,0.36)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  paymentOptionRowActive: {
    backgroundColor: COLORS.accentSoft,
    borderColor: 'rgba(0,168,248,0.34)',
  },
  paymentOptionCopy: {
    flex: 1,
    minWidth: 0,
  },
  paymentOptionTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '900',
  },
  paymentOptionSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
  },
  paymentEmptyCopy: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 18,
    padding: 8,
  },
  paymentLinkReadyBody: {
    padding: 14,
    gap: 12,
  },
  paymentLinkText: {
    color: COLORS.meta,
    fontSize: 12,
    lineHeight: 17,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bg,
    padding: 12,
  },
  paymentOpenLinkButton: {
    minHeight: 48,
    borderRadius: 17,
    backgroundColor: COLORS.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  paymentOpenLinkText: {
    color: COLORS.white,
    fontSize: 15,
    fontWeight: '900',
  },
  productsHeader: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  productsHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  paymentIconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
  },
  productNewButton: {
    minHeight: 38,
    borderRadius: 19,
    backgroundColor: COLORS.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 11,
  },
  productNewButtonText: {
    color: COLORS.white,
    fontSize: 12,
    fontWeight: '900',
  },
  productForm: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    padding: 13,
    gap: 12,
  },
  productFormHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  productFormHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  productFormTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '900',
  },
  productFormSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
  },
  productFormActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
  },
  productSaveButton: {
    minHeight: 44,
    borderRadius: 16,
    backgroundColor: COLORS.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 16,
  },
  productSaveButtonText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '900',
  },
  productsList: {
    gap: 8,
  },
  productItem: {
    minHeight: 74,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    paddingVertical: 8,
  },
  productItemIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accentSoft,
  },
  productItemCopy: {
    flex: 1,
    minWidth: 0,
  },
  productItemTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '900',
  },
  productItemSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 2,
  },
  productItemMeta: {
    color: COLORS.accent,
    fontSize: 12,
    fontWeight: '800',
    marginTop: 3,
  },
  productDeleteButton: {
    backgroundColor: 'rgba(255,93,108,0.1)',
  },
  productsEmpty: {
    minHeight: 260,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 22,
  },
  productsEmptyTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '900',
    textAlign: 'center',
  },
  productsEmptyCopy: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
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
  cameraVideoPreview: {
    minHeight: 108,
    borderRadius: 20,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
  },
  cameraVideoIcon: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: COLORS.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraVideoCopy: {
    flex: 1,
    minWidth: 0,
  },
  cameraVideoTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '900',
  },
  cameraVideoMeta: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 4,
    fontWeight: '700',
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
  chatListSurface: {
    flex: 1,
    alignSelf: 'stretch',
    backgroundColor: COLORS.bg,
    marginBottom: -72,
  },
  chatList: {
    paddingTop: 2,
    paddingBottom: 118,
  },
  emptyList: {
    flexGrow: 1,
    backgroundColor: COLORS.bg,
    paddingBottom: 118,
  },
  emptyChatsFill: {
    flexGrow: 1,
    minHeight: 460,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingBottom: 92,
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
    gap: 6,
    minHeight: 46,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    backgroundColor: 'rgba(16,42,120,0.62)',
  },
  chatSelectionPanelTop: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  chatSelectionCount: {
    flex: 1,
    minWidth: 0,
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '900',
  },
  chatSelectionClearButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  chatSelectionSelectAll: {
    minHeight: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(255,255,255,0.06)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 9,
  },
  chatSelectionSelectAllText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '800',
  },
  chatSelectionMiniCheck: {
    width: 17,
    height: 17,
    borderRadius: 9,
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
    minHeight: 32,
    minWidth: 72,
    borderRadius: 16,
    backgroundColor: COLORS.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 10,
  },
  chatSelectionMoreButtonText: {
    color: COLORS.white,
    fontSize: 12,
    fontWeight: '900',
  },
  chatSelectionActionsMenu: {
    marginTop: 4,
    marginBottom: 4,
    overflow: 'hidden',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: 'rgba(6,18,58,0.58)',
  },
  chatSelectionActionRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  chatSelectionActionIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
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
    fontSize: 13,
    fontWeight: '900',
  },
  chatSelectionActionSubtitle: {
    color: COLORS.muted,
    fontSize: 11,
    lineHeight: 14,
    marginTop: 2,
  },
  archiveRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 28,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  archiveRowActive: {
    backgroundColor: COLORS.accentSoft,
  },
  archiveRowIcon: {
    width: 64,
    height: 34,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  archiveRowTitle: {
    flex: 1,
    color: COLORS.muted,
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'left',
  },
  archiveRowTitleActive: {
    color: COLORS.text,
  },
  archiveRowCount: {
    width: 64,
    color: COLORS.muted,
    fontSize: 15,
    fontWeight: '800',
    textAlign: 'right',
  },
  aiChatRow: {
    position: 'relative',
    minHeight: CHAT_ROW_MIN_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
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
    width: CHAT_AVATAR_SIZE,
    height: CHAT_AVATAR_SIZE,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  aiChatAvatar: {
    width: CHAT_AVATAR_SIZE,
    height: CHAT_AVATAR_SIZE,
    borderRadius: CHAT_AVATAR_SIZE / 2,
    borderWidth: 2,
    borderColor: 'rgba(39,199,216,0.38)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(39,199,216,0.12)',
    overflow: 'hidden',
  },
  aiChatLogoImage: {
    width: CHAT_AVATAR_SIZE - 8,
    height: CHAT_AVATAR_SIZE - 8,
    borderRadius: (CHAT_AVATAR_SIZE - 8) / 2,
  },
  aiChatBody: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 4,
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
    alignSelf: 'center',
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
    height: 42,
    paddingTop: 1,
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
