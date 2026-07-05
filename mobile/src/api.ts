import type {
  CalendarEventItem,
  CalendarItem,
  ChatContact,
  ConfigValue,
  DashboardMetrics,
  JourneyEvent,
  LoginResponse,
  ProductItem,
  RistakUser,
  SendTextResponse,
  TransactionItem,
  VerifyResponse,
} from './types';

type RequestOptions = RequestInit & {
  params?: Record<string, string | number | boolean | undefined>;
};

type ApiError = Error & {
  status?: number;
  body?: unknown;
};

function withApiPrefix(path: string) {
  if (path.startsWith('/api')) return path;
  return `/api${path.startsWith('/') ? '' : '/'}${path}`;
}

export class RistakApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token = '',
  ) {}

  private buildUrl(path: string, params?: RequestOptions['params']) {
    const url = new URL(`${this.baseUrl}${withApiPrefix(path)}`);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value).trim()) {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers(options.headers);
    const hasBody = options.body !== undefined && options.body !== null;
    if (hasBody && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }

    const response = await fetch(this.buildUrl(path, options.params), {
      ...options,
      headers,
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message = payload && typeof payload === 'object'
        ? String((payload as { error?: unknown; message?: unknown }).error || (payload as { message?: unknown }).message || response.statusText)
        : response.statusText;
      const error = new Error(message || `HTTP ${response.status}`) as ApiError;
      error.status = response.status;
      error.body = payload;
      throw error;
    }

    if (payload && typeof payload === 'object' && 'success' in payload && 'data' in payload) {
      return (payload as { data: T }).data;
    }

    return payload as T;
  }

  login(email: string, password: string) {
    return this.request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  verify(token: string) {
    return new RistakApiClient(this.baseUrl).request<VerifyResponse>('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  }

  getChats(query = '', offset = 0, limit = 50) {
    return this.request<ChatContact[]>('/contacts/chats', {
      params: {
        q: query.trim() || undefined,
        limit,
        offset: offset > 0 ? offset : undefined,
      },
    });
  }

  getConversation(contactId: string, limit = 50) {
    return this.request<JourneyEvent[]>(`/contacts/${encodeURIComponent(contactId)}/journey`, {
      params: {
        includeBusinessMessages: true,
        refreshExternalStatuses: false,
        chatMessagesOnly: true,
        messageLimit: limit,
      },
    });
  }

  markChatRead(contactId: string) {
    return this.request(`/contacts/chats/${encodeURIComponent(contactId)}/read`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  sendText(contact: ChatContact, text: string) {
    return this.request<SendTextResponse>('/whatsapp-api/messages/text', {
      method: 'POST',
      body: JSON.stringify({
        to: contact.phone || '',
        from: contact.lastBusinessPhone || undefined,
        contactId: contact.id,
        text,
        externalId: `native-${Date.now()}`,
        phoneNumberId: contact.lastBusinessPhoneNumberId || undefined,
        messageOrigin: 'native_mobile_chat',
      }),
    });
  }

  getProducts(limit = 100) {
    return this.request<{ products?: ProductItem[]; total?: number }>('/products', {
      params: {
        limit,
        includePrices: true,
      },
    });
  }

  getTransactions(limit = 20) {
    return this.request<TransactionItem[] | { transactions?: TransactionItem[] }>('/transactions', {
      params: {
        limit,
        page: 1,
      },
    });
  }

  getDashboardMetrics(startDate: string, endDate: string) {
    return this.request<DashboardMetrics>('/dashboard/metrics', {
      params: {
        startDate,
        endDate,
      },
    });
  }

  getCalendars() {
    return this.request<CalendarItem[] | { calendars?: CalendarItem[] }>('/calendars');
  }

  getCalendarEvents(startDate: string, endDate: string) {
    return this.request<CalendarEventItem[] | { events?: CalendarEventItem[] }>('/calendars/events', {
      params: {
        startDate,
        endDate,
      },
    });
  }

  getConfig(keys: string[]) {
    return this.request<{ config?: Record<string, ConfigValue> } | Record<string, ConfigValue>>('/config', {
      params: {
        keys: keys.join(','),
      },
    });
  }

  getUserConfig(keys: string[]) {
    return this.request<{ config?: Record<string, ConfigValue> }>('/user-config', {
      params: {
        keys: keys.join(','),
      },
    });
  }
}

export function getUserDisplayName(user?: RistakUser | null) {
  return user?.name || user?.email || 'Ristak';
}
