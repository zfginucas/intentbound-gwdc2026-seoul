export interface InferenceMeta {
  source: 'kiln' | 'demo_fallback'
  model: string | null
  generationId: string | null
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  } | null
  latencyMs: number | null
}

export interface StatusResponse {
  kiln: {
    configured: boolean
    connected: boolean | null
    model: string
  }
  chain: {
    network: string
    connected: boolean | null
    configured?: boolean
    asset?: string
    contractAddress?: string
  }
  merchantMode: 'fixture' | string
}

export interface CatalogItem {
  id: string
  name: string
  description: string
  price: number
  tags: string[]
  imageUrl?: string
}

export interface Merchant {
  id: string
  name: string
  address: string | null
  allowed: boolean
  description: string
  etaMinutes: number
  items: CatalogItem[]
}

export interface Quote {
  id: string
  merchantId: string
  itemId: string
  items: number
  deliveryFee: number
  serviceFee: number
  tax: number
  discount: number
  total: number
  currency: string
  fixture: boolean
}

export interface CatalogResponse {
  mode: 'simulated' | string
  currency: string
  merchants: Merchant[]
  quotes: Quote[]
}

export interface Preferences {
  warm: boolean
  avoidIngredients: string[]
  notes: string[]
}

export interface PlanResponse {
  draftPolicy: {
    budget: number | null
    perPaymentCap: number | null
    expiresAt: string | null
    allowedMerchantIds: string[]
    preferences: Preferences
  }
  missingFields: string[]
  requiresConfirmation: true
  assistantMessage: string
  inference: InferenceMeta
}

export interface RecommendResponse {
  rankedItemIds: string[]
  itemId: string
  merchantId: string
  reason: string
  inference: InferenceMeta
}

export type SessionState = 'none' | 'pending' | 'active' | 'revoking' | 'revoked' | 'expired' | 'error'

export interface SessionView {
  id: string
  state: SessionState
  budgetSun: number
  perPaymentCapSun: number
  spentSun: number
  allowedMerchantIds: string[]
  expiresAt: string | null
  approvalTxHash: string | null
  revokeTxHash: string | null
  owner: string | null
  network: string | null
  token: string | null
  attempts: AttemptView[]
}

export interface AttemptView {
  id: string
  quoteId: string
  code: string
  status: 'allowed' | 'rejected' | 'pending' | 'error'
  reason: string | null
  txHash: string | null
  timestamp: string | null
  merchantAddress: string | null
  onChain: boolean
}

export interface AuditView {
  sessionId: string
  verdict: 'pass' | 'fail' | 'incomplete' | 'unknown'
  summary: string
  checks: { label: string; passed: boolean | null; detail?: string }[]
  source: 'chain' | 'local' | 'mixed' | 'unknown'
  raw: unknown
}

export interface UsageRecord {
  id: string
  purpose: string
  inference: InferenceMeta
  createdAt: string | null
}
