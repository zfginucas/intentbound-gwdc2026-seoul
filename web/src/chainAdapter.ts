import { apiRequest } from './api'
import type { AttemptView, AuditView, SessionState, SessionView, UsageRecord } from './types'

export interface CreateSessionInput {
  budgetSun: number
  perPaymentCapSun: number
  allowedMerchantIds: string[]
  expiresAt: string
}

export interface ChainAdapter {
  createSession(input: CreateSessionInput): Promise<SessionView>
  getSession(id: string): Promise<SessionView>
  attempt(id: string, quoteId: string): Promise<{ attempt: AttemptView; session: SessionView | null }>
  revoke(id: string): Promise<SessionView>
  audit(id: string): Promise<AuditView>
  usage(): Promise<UsageRecord[]>
}

type RecordValue = Record<string, unknown>

const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const string = (value: unknown) => typeof value === 'string' ? value : null
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0
const arrayOfStrings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function normalizeState(value: unknown, record: RecordValue): SessionState {
  if (record.revoked === true) return 'revoked'
  const state = String(value ?? '').toLowerCase()
  if (['active', 'pending', 'revoking', 'revoked', 'expired', 'error'].includes(state)) return state as SessionState
  return 'pending'
}

export function normalizeAttempt(value: unknown): AttemptView {
  const outer = object(value)
  const record = object(outer.attempt ?? outer.decision ?? value)
  const txHash = string(record.paymentTxHash ?? record.txHash ?? record.transactionHash)
  const rawStatus = String(record.status ?? '').toLowerCase()
  const code = string(record.decisionCode ?? record.reasonCode ?? record.code) ?? 'PENDING'
  let status: AttemptView['status'] = 'pending'
  if (rawStatus === 'error') status = 'error'
  else if (['paid', 'allowed', 'executed', 'confirmed', 'success'].includes(rawStatus) || code === 'PAYMENT_EXECUTED') status = 'allowed'
  else if (['rejected', 'blocked', 'denied'].includes(rawStatus) || (code !== 'PENDING' && code !== 'ELIGIBLE' && code !== 'PAYMENT_EXECUTED' && code !== 'NONE')) status = 'rejected'
  return {
    id: string(record.id ?? record.decisionId ?? record.attemptId) ?? '',
    quoteId: string(record.quoteId) ?? '',
    code,
    status,
    reason: string(record.reason ?? record.message),
    txHash,
    timestamp: string(record.timestamp ?? record.createdAt),
    merchantAddress: string(record.merchantAddress ?? record.recipient),
    onChain: !!txHash && status !== 'pending' && (record.onChain === true || !!txHash),
  }
}

export function normalizeSession(value: unknown): SessionView {
  const outer = object(value)
  const record = object(outer.session ?? value)
  const id = string(record.id ?? record.sessionId)
  if (!id) throw new Error('The server did not return a session ID. No on-chain session is being shown.')
  return {
    id,
    state: normalizeState(record.state ?? record.status, record),
    budgetSun: number(record.budgetSun ?? record.budget),
    perPaymentCapSun: number(record.perPaymentCapSun ?? record.perPaymentCap),
    spentSun: number(record.spentSun ?? record.spent),
    allowedMerchantIds: arrayOfStrings(record.allowedMerchantIds),
    expiresAt: string(record.expiresAt),
    approvalTxHash: string(record.approvalTxHash ?? record.createTxHash),
    revokeTxHash: string(record.revokeTxHash),
    owner: string(record.owner),
    network: string(record.network),
    token: string(record.token ?? record.asset),
    attempts: Array.isArray(record.attempts) ? record.attempts.map(normalizeAttempt) : [],
  }
}

export function normalizeAudit(value: unknown): AuditView {
  const outer = object(value)
  const record = object(outer.audit ?? value)
  const rawVerdict = String(record.verdict ?? record.status ?? '').toLowerCase()
  const verdict: AuditView['verdict'] = ['pass', 'fail', 'incomplete'].includes(rawVerdict) ? rawVerdict as AuditView['verdict'] : 'unknown'
  const checks = Array.isArray(record.checks) ? record.checks.map((entry) => {
    const check = object(entry)
    return {
      label: string(check.label ?? check.name) ?? 'Unnamed check',
      passed: typeof check.passed === 'boolean' ? check.passed : null,
      detail: string(check.detail) ?? undefined,
    }
  }) : []
  const rawSource = String(record.source ?? '').toLowerCase()
  const source: AuditView['source'] = ['chain', 'local', 'mixed'].includes(rawSource) ? rawSource as AuditView['source'] : 'unknown'
  return {
    sessionId: string(record.sessionId) ?? '',
    verdict,
    summary: string(record.summary ?? record.message) ?? 'The auditor returned no summary.',
    checks,
    source,
    raw: value,
  }
}

export function normalizeUsage(value: unknown): UsageRecord[] {
  const outer = object(value)
  const rows = Array.isArray(value) ? value : Array.isArray(outer.records) ? outer.records : Array.isArray(outer.usage) ? outer.usage : []
  return rows.map((entry, index) => {
    const record = object(entry)
    const inference = object(record.inference ?? record)
    const usage = object(inference.usage)
    return {
      id: string(record.id ?? inference.generationId) ?? `record-${index}`,
      purpose: string(record.purpose ?? record.phase) ?? 'Agent call',
      inference: {
        source: inference.source === 'demo_fallback' ? 'demo_fallback' : 'kiln',
        model: string(inference.model),
        generationId: string(inference.generationId),
        usage: inference.usage ? {
          inputTokens: number(usage.inputTokens),
          outputTokens: number(usage.outputTokens),
          totalTokens: number(usage.totalTokens),
        } : null,
        latencyMs: typeof inference.latencyMs === 'number' ? inference.latencyMs : null,
      },
      createdAt: string(record.createdAt ?? record.timestamp),
    }
  })
}

export const httpChainAdapter: ChainAdapter = {
  async createSession(input) {
    return normalizeSession(await apiRequest<unknown>('/api/sessions', { method: 'POST', body: JSON.stringify(input) }))
  },
  async getSession(id) {
    return normalizeSession(await apiRequest<unknown>(`/api/sessions/${encodeURIComponent(id)}`))
  },
  async attempt(id, quoteId) {
    const raw = await apiRequest<unknown>(`/api/sessions/${encodeURIComponent(id)}/attempts`, { method: 'POST', body: JSON.stringify({ quoteId }) })
    const outer = object(raw)
    return { attempt: normalizeAttempt(raw), session: outer.session ? normalizeSession(outer.session) : null }
  },
  async revoke(id) {
    return normalizeSession(await apiRequest<unknown>(`/api/sessions/${encodeURIComponent(id)}/revoke`, { method: 'POST' }))
  },
  async audit(id) {
    return normalizeAudit(await apiRequest<unknown>(`/api/sessions/${encodeURIComponent(id)}/audit`))
  },
  async usage() {
    return normalizeUsage(await apiRequest<unknown>('/api/usage'))
  },
}

export function explorerTxUrl(txHash: string, network: string | null): string | null {
  return network?.toLowerCase() === 'shasta' ? `https://shasta.tronscan.org/#/transaction/${encodeURIComponent(txHash)}` : null
}
