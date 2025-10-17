import apiClient from './apiClient';

export interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  fingerprint?: string;
}

export interface GetPaymentMethodsResponse {
  success: boolean;
  hasPaymentMethods: boolean;
  customerId: string | null;
  paymentMethods: PaymentMethod[];
  message?: string;
}

export interface ChargePaymentMethodData {
  contactId: string;
  paymentMethodId: string;
  amount: number;
  currency?: string;
  description?: string;
  invoiceId?: string;
}

export interface ChargePaymentMethodResponse {
  success: boolean;
  paymentIntent?: {
    id: string;
    amount: number;
    currency: string;
    status: string;
    created: number;
  };
  error?: string;
  details?: string;
}

/**
 * Obtiene todos los payment methods de un contacto
 */
export async function getContactPaymentMethods(
  contactId: string
): Promise<GetPaymentMethodsResponse> {
  const response = await apiClient.get<GetPaymentMethodsResponse>(`/payment-methods/contact/${contactId}`);
  return response;
}

/**
 * Cobra a un payment method guardado
 */
export async function chargePaymentMethod(
  data: ChargePaymentMethodData
): Promise<ChargePaymentMethodResponse> {
  const response = await apiClient.post<ChargePaymentMethodResponse>('/payment-methods/charge', data);
  return response;
}

/**
 * Guarda configuraci�n de Stripe
 */
export interface StripeConfig {
  testSecretKey?: string;
  liveSecretKey?: string;
  mode: 'test' | 'live';
}

export async function saveStripeConfig(config: StripeConfig): Promise<{ success: boolean; message?: string }> {
  const response = await apiClient.post<{ success: boolean; message?: string }>('/highlevel/stripe-config', config);
  return response;
}

/**
 * Obtiene la configuraci�n actual de Stripe (sin mostrar claves)
 */
export interface StripeConfigResponse {
  success: boolean;
  configured: boolean;
  mode: 'test' | 'live' | null;
  hasTestKey: boolean;
  hasLiveKey: boolean;
}

export async function getStripeConfig(): Promise<StripeConfigResponse> {
  const response = await apiClient.get<StripeConfigResponse>('/highlevel/stripe-config');
  return response;
}
