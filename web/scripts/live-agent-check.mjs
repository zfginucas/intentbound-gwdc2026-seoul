import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const url = process.env.WEB_URL || 'http://localhost:5173'
const recommendOnly = process.argv.includes('--recommend-only')
const planOnly = process.argv.includes('--plan-only')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))

try {
  await page.goto(url)
  await page.getByRole('heading', { name: 'Dinner run' }).waitFor()
  assert.equal(await page.locator('.fallback-toggle input').isChecked(), false)

  let planSource = 'Skipped; existing plan call is in the server ledger.'
  if (!recommendOnly) {
    await page.locator('.send-button').click()
    await page.locator('.chat-turn.agent').first().waitFor({ timeout: 120_000 })
    planSource = await page.locator('.chat-turn.agent .turn-label').first().innerText()
    assert.match(planSource, /Kiln · qwen3-32b/i)
    await page.screenshot({ path: '/tmp/intentbound-live-kiln-plan.png' })
  }

  let recommendationSource = 'Skipped; existing recommendation call is in the server ledger.'
  if (!planOnly) {
    await page.locator('.compare-button').click()
    await page.locator('.chat-turn.agent').nth(recommendOnly ? 0 : 1).waitFor({ timeout: 120_000 })
    recommendationSource = await page.locator('.chat-turn.agent .turn-label').nth(recommendOnly ? 0 : 1).innerText()
    assert.match(recommendationSource, /Kiln · qwen3-32b/i)
    await page.locator('.chat-turn.agent').last().scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/intentbound-live-kiln-recommend.png' })
  }

  await page.locator('.primary-nav').getByRole('button', { name: 'Model Usage' }).click()
  await page.locator('.usage-record').first().waitFor({ timeout: 30_000 })
  const recordCount = await page.locator('.usage-record').count()
  assert.ok(recordCount >= 2, `Expected two real Kiln records, found ${recordCount}`)
  const summary = await page.locator('.usage-summary').innerText()
  assert.match(summary, /REAL CALLS\s+\d+/)
  await page.screenshot({ path: '/tmp/intentbound-live-kiln-usage.png' })

  assert.deepEqual(pageErrors, [])
  console.log(JSON.stringify({ planSource, recommendationSource, recordCount, summary, screenshots: ['/tmp/intentbound-live-kiln-plan.png', '/tmp/intentbound-live-kiln-recommend.png', '/tmp/intentbound-live-kiln-usage.png'] }, null, 2))
} catch (error) {
  await page.screenshot({ path: '/tmp/intentbound-live-kiln-error.png' })
  const message = await page.locator('.feedback-banner').allInnerTexts()
  console.error('Live UI feedback:', message)
  throw error
} finally {
  await browser.close()
}
