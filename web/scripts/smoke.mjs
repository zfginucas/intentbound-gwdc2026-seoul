import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const baseUrl = process.env.WEB_URL || 'http://localhost:5173'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const pageErrors = []

async function checkImages(page) {
  const result = await page.locator('.food-card img').evaluateAll((images) => images.map((image) => ({ loaded: image.complete && image.naturalWidth > 0, src: image.getAttribute('src') })))
  assert.equal(result.length, 3)
  assert.ok(result.every((image) => image.loaded), JSON.stringify(result))
}

async function checkOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  assert.ok(overflow <= 1, `Document overflows horizontally by ${overflow}px`)
}

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  desktop.on('pageerror', (error) => pageErrors.push(error.message))
  await desktop.goto(baseUrl)
  await desktop.getByRole('heading', { name: 'Dinner run' }).waitFor()
  await checkImages(desktop)
  await checkOverflow(desktop)
  assert.equal(await desktop.locator('.food-card').count(), 3)
  assert.match(await desktop.locator('.food-card').nth(0).innerText(), /Full price over budget/)
  assert.match(await desktop.locator('.food-card').nth(1).innerText(), /Payee not approved/)
  assert.match(await desktop.locator('.food-card').nth(2).innerText(), /Quote eligible/)
  await desktop.locator('.food-card').nth(2).click()
  assert.match(await desktop.locator('.inspector-head').innerText(), /Doenjang stew/i)
  await desktop.getByRole('button', { name: /Review permission/ }).first().click()
  await desktop.getByRole('dialog', { name: 'Review permission' }).waitFor()
  assert.equal(await desktop.getByRole('button', { name: 'Approve with demo wallet' }).isDisabled(), true)
  await desktop.getByRole('checkbox', { name: /I approve these exact/ }).check()
  assert.equal(await desktop.getByRole('button', { name: 'Approve with demo wallet' }).isEnabled(), true)
  await desktop.getByRole('button', { name: 'Close review' }).click()
  await desktop.locator('.primary-nav').getByRole('button', { name: 'Public Audit' }).click()
  await desktop.getByRole('heading', { name: 'Public audit' }).waitFor()
  await desktop.locator('.primary-nav').getByRole('button', { name: 'Model Usage' }).click()
  await desktop.getByRole('heading', { name: 'Model usage' }).waitFor()

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 })
  mobile.on('pageerror', (error) => pageErrors.push(error.message))
  let mockSession = null
  await mobile.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const input = route.request().postDataJSON()
    mockSession = {
      id: 'ui-smoke-session', state: 'active', budgetSun: input.budgetSun,
      perPaymentCapSun: input.perPaymentCapSun, spentSun: 0,
      allowedMerchantIds: input.allowedMerchantIds, expiresAt: input.expiresAt,
      approvalTxHash: null, revokeTxHash: null, owner: null,
      network: 'shasta', token: 'TRX', attempts: [],
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: mockSession }) })
  })
  await mobile.route('**/api/sessions/ui-smoke-session/revoke', async (route) => {
    assert.equal(route.request().method(), 'POST')
    mockSession = { ...mockSession, state: 'revoked', revokeTxHash: 'ui-smoke-revoke-only' }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: mockSession }) })
  })
  await mobile.route('**/api/sessions/ui-smoke-session/attempts', async (route) => {
    assert.equal(route.request().method(), 'POST')
    assert.equal(route.request().postDataJSON().quoteId, 'D')
    const attempt = { id: 'ui-smoke-D', quoteId: 'D', code: 'REVOKED', status: 'rejected', reason: 'Stopped by owner', txHash: null, timestamp: new Date().toISOString(), merchantAddress: null, onChain: false }
    mockSession = { ...mockSession, attempts: [attempt] }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ attempt, session: mockSession }) })
  })
  await mobile.goto(baseUrl)
  await mobile.getByRole('heading', { name: 'Dinner run' }).waitFor()
  await checkImages(mobile)
  await checkOverflow(mobile)
  for (const name of ['Dinner', 'Activity', 'Audit', 'Usage']) {
    const tab = mobile.getByRole('button', { name, exact: true }).first()
    assert.equal(await tab.isVisible(), true, `${name} tab is missing`)
    const box = await tab.boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= 391, `${name} tab is clipped`)
  }
  await mobile.getByRole('button', { name: 'Agent', exact: true }).click()
  await mobile.getByLabel('Message to personal agent').waitFor({ state: 'visible' })
  await mobile.getByRole('button', { name: 'Permission', exact: true }).click()
  await mobile.getByText('DRAFT PAYEES', { exact: true }).waitFor({ state: 'visible' })
  await mobile.getByRole('button', { name: 'Menu', exact: true }).click()
  await mobile.locator('.mobile-policy-dock').getByRole('button', { name: 'Review' }).click()
  await mobile.getByRole('checkbox', { name: /I approve these exact/ }).check()
  await mobile.getByRole('button', { name: 'Approve with demo wallet' }).click()
  await mobile.locator('.mobile-policy-dock').getByRole('button', { name: 'Stop' }).waitFor({ state: 'visible' })
  await mobile.locator('.story-step').last().click()
  assert.equal(await mobile.getByRole('button', { name: 'Stop first' }).isDisabled(), true)
  await mobile.locator('.mobile-policy-dock').getByRole('button', { name: 'Stop' }).click()
  await mobile.getByRole('button', { name: 'Stop & revoke' }).click()
  await mobile.getByRole('button', { name: 'Run revoke test' }).waitFor({ state: 'visible' })
  assert.equal(await mobile.getByRole('button', { name: 'Run revoke test' }).isEnabled(), true)
  await mobile.getByRole('button', { name: 'Run revoke test' }).click()
  await mobile.getByRole('button', { name: 'Test recorded' }).waitFor({ state: 'visible' })
  await mobile.locator('.story-step').nth(2).click()
  assert.equal(await mobile.getByRole('button', { name: 'Run attempt' }).isDisabled(), true)
  await checkOverflow(mobile)
  assert.deepEqual(pageErrors, [])
  console.log('UI smoke passed: desktop cards, review, audit/usage navigation, mobile panels, Stop dock, D revoke regression and blocked ordinary spend, images and overflow.')
} finally {
  await browser.close()
}
