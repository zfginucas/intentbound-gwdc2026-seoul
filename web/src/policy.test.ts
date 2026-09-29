import { describe, expect, it } from 'vitest'
import { fallbackCatalog } from './fixtures'
import { previewDecision, quoteTotal, toSun } from './policy'

const draft = {
  budget: 18,
  perPaymentCap: 18,
  allowedMerchantIds: ['seoul-bowl', 'han-table'],
  expiresAt: null,
}

const merchantFor = (id: string) => fallbackCatalog.merchants.find((merchant) => merchant.id === id)
const quoteFor = (id: string) => fallbackCatalog.quotes.find((quote) => quote.id === id)!

describe('financial preview', () => {
  it('recalculates every fixture quote from its fee components', () => {
    for (const quote of fallbackCatalog.quotes) expect(quoteTotal(quote)).toBe(quote.total)
  })

  it('blocks the 19 TRX all-in quote', () => {
    expect(previewDecision(quoteFor('A'), merchantFor('seoul-bowl'), draft, 'active').code).toBe('OVER_LIMIT')
  })

  it('blocks a cheaper but unapproved merchant', () => {
    expect(previewDecision(quoteFor('B'), merchantFor('han-table-express'), draft, 'active').code).toBe('MERCHANT_NOT_ALLOWED')
  })

  it('allows the 16 TRX quote before spending but stops the add-on after revoke', () => {
    const draftPreview = previewDecision(quoteFor('C'), merchantFor('han-table'), draft, 'none')
    expect(draftPreview.code).toBe('ELIGIBLE')
    expect(draftPreview.checks.find((check) => check.key === 'revoke')?.passed).toBeNull()
    expect(previewDecision(quoteFor('C'), merchantFor('han-table'), draft, 'active').code).toBe('ELIGIBLE')
    expect(previewDecision(quoteFor('D'), merchantFor('han-table'), draft, 'revoked', 16).code).toBe('REVOKED')
  })

  it('converts TRX to SUN without floating chain amounts', () => {
    expect(toSun(16)).toBe(16_000_000)
  })
})
