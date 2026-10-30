/* Clash AI — types du client Google Play Billing (billing-client.js)
 * Fichier de documentation : le projet n'utilise pas de bundler TypeScript,
 * mais ces types permettent l'autocomplétion dans un éditeur compatible. */

export type PlanId = 'month' | 'pack';

/** Achat tel que renvoyé par le module natif (voir BillingManager.achat()). */
export interface GooglePurchase {
  productId: string;
  orderId: string;
  purchaseToken: string;
  acknowledged: boolean;
  autoRenewing: boolean;
  /** 1 = PURCHASED, 2 = PENDING, sinon état inconnu */
  state: number;
  quantity: number;
  purchaseTime: number;
  products: string[];
}

export interface Product {
  productId: string;
  title: string;
  /** 'subs' ou 'inapp' */
  type: string;
  /** Prix localisé par Play, ex. « 17,500 DT » */
  price: string;
  hasOfferToken: boolean;
}

export interface ApplyResult {
  granted: boolean;
  plan?: PlanId;
  reason?: string;
  pending?: boolean;
  productId?: string;
  orderId?: string;
  token?: string;
}

export interface BillingInitOptions {
  /** Lecture du quota local (chaîne JSON de index.html) */
  loadStock(): string;
  /** Écriture du quota local */
  saveStock(json: string): void;
  /** Durée d'un cycle d'abonnement, en jours (30 par défaut) */
  days?: number;
  /** Crédits accordés par un pack (10 par défaut) */
  packCredits?: number;
  notice(kind: 'ok' | 'warn' | 'err' | 'info', html: string): void;
  onChange?(): void;
  onGranted?(plan: PlanId, purchase: GooglePurchase): void;
}

export interface ClashBillingApi {
  readonly version: string;
  readonly ids: Record<PlanId, string>;
  init(options: BillingInitOptions): ClashBillingApi;
  state(): { available: boolean; connected: boolean; busy: boolean; products: Product[]; found: Partial<Record<PlanId, { price: string; title: string; offerToken: boolean }>>; lastError: string | null; ids: Record<PlanId, string> };
  available(): boolean;
  load(): Promise<{ ok: boolean; products: Product[]; error?: string }>;
  buy(planId: PlanId): Promise<{ ok: boolean; plan?: PlanId; finished?: boolean; error?: string; pending?: boolean }>;
  restore(silent?: boolean): Promise<{ ok: boolean; count?: number; scanned?: number; error?: string }>;
  apply(purchase: GooglePurchase, now?: number): ApplyResult;
  grantPremiumUntil(stock: string, until: number, now?: number, planId?: string): string;
  grantCredits(stock: string, n: number, now?: number): string;
  alreadyGranted(orderId: string): boolean;
  markGranted(orderId: string, plan: PlanId, at?: number): void;
  humanError(error: { code?: string; message?: string }): string;
}

declare global {
  interface Window { ClashBilling: ClashBillingApi }
}
