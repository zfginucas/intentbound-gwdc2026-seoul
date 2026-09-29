import type { Merchant, Quote, SessionState } from './types'

export interface PolicyDraft {
  budget: number
  perPaymentCap: number
  allowedMerchantIds: string[]
  expiresAt: string | null
}

export type DecisionCode = 'ELIGIBLE' | 'OVER_LIMIT' | 'MERCHANT_NOT_ALLOWED' | 'REVOKED' | 'EXPIRED' | 'QUOTE_MISMATCH' | 'MISSING_PAYEE'

export interface DecisionCheck {
  key: string
  label: string
  passed: boolean | null
  detail: string
}

export interface PreviewDecision {
  code: DecisionCode
  allowed: boolean
  calculatedTotal: number
  checks: DecisionCheck[]
}

export function quoteTotal(quote: Quote): number {
  return quote.items + quote.deliveryFee + quote.serviceFee + quote.tax - quote.discount
}

export function toSun(amountTrx: number): number {
  return Math.round(amountTrx * 1_000_000)
}

export function fromSun(amountSun: number): number {
  return amountSun / 1_000_000
}

export function previewDecision(quote: Quote, merchant: Merchant | undefined, policy: PolicyDraft, sessionState: SessionState, spent = 0): PreviewDecision {
  const total = quoteTotal(quote)
  const quoteMatches = Number.isFinite(total) && Math.abs(total - quote.total) < 0.000001
  const allowlisted = !!merchant && policy.allowedMerchantIds.includes(merchant.id)
  const withinCap = total <= policy.perPaymentCap && total <= policy.budget - spent
  const notExpired = !policy.expiresAt || new Date(policy.expiresAt).getTime() > Date.now()
  const notRevoked = sessionState !== 'revoked' && sessionState !== 'revoking'
  const authorizationState = sessionState === 'active' ? true : ['revoked', 'revoking', 'expired'].includes(sessionState) ? false : null
  const authorizationDetail = sessionState === 'active' ? 'Active on Shasta' : sessionState === 'revoked' || sessionState === 'revoking' ? 'Stopped by owner' : sessionState === 'pending' ? 'Awaiting chain confirmation' : 'No funded session yet'
  const hasPayee = !!merchant?.address
  const checks: DecisionCheck[] = [
    { key: 'quote', label: 'Fee calculation', passed: quoteMatches, detail: `${formatAmount(quote.items)} + ${formatAmount(quote.deliveryFee)} + ${formatAmount(quote.serviceFee)} + ${formatAmount(quote.tax)} - ${formatAmount(quote.discount)} = ${formatAmount(total)} ${quote.currency}` },
    { key: 'budget', label: 'Full price within cap', passed: withinCap, detail: `${formatAmount(total)} / ${formatAmount(Math.min(policy.perPaymentCap, policy.budget - spent))} ${quote.currency}` },
    { key: 'merchant', label: 'Payee allowlisted', passed: allowlisted, detail: merchant ? `${merchant.name} · ${merchant.address ?? 'address not configured'}` : 'Merchant missing from catalog' },
    { key: 'time', label: 'Before expiry', passed: policy.expiresAt ? notExpired : null, detail: policy.expiresAt ? new Date(policy.expiresAt).toLocaleString() : 'Set at approval' },
    { key: 'revoke', label: 'Authorization state', passed: authorizationState, detail: authorizationDetail },
  ]

  let code: DecisionCode = 'ELIGIBLE'
  if (!quoteMatches) code = 'QUOTE_MISMATCH'
  else if (!notRevoked) code = 'REVOKED'
  else if (!notExpired) code = 'EXPIRED'
  else if (!withinCap) code = 'OVER_LIMIT'
  else if (!allowlisted) code = 'MERCHANT_NOT_ALLOWED'
  else if (!hasPayee && sessionState === 'active') code = 'MISSING_PAYEE'

  return { code, allowed: code === 'ELIGIBLE', calculatedTotal: total, checks }
}

export function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
