import { chromium } from 'playwright'

const baseUrl = process.env.WEB_URL || 'http://localhost:5173'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

try {
  await page.goto(baseUrl)
  await page.getByRole('heading', { name: 'Dinner run' }).waitFor()

  await page.locator('.intro-action').click()
  await page.getByRole('dialog', { name: 'Review permission' }).waitFor()
  await page.screenshot({ path: '/tmp/intentbound-deck-review.png' })
  await page.getByRole('button', { name: 'Close review' }).click()

  await page.locator('.inspector').evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await page.screenshot({ path: '/tmp/intentbound-deck-blocked-preview.png' })

  await page.locator('.primary-nav').getByRole('button', { name: 'Activity' }).click()
  await page.getByRole('heading', { name: 'Decision history' }).waitFor()
  await page.screenshot({ path: '/tmp/intentbound-deck-activity-empty.png' })

  await page.locator('.primary-nav').getByRole('button', { name: 'Public Audit' }).click()
  await page.getByRole('heading', { name: 'Public audit' }).waitFor()
  await page.getByRole('button', { name: 'Preview fixture rules' }).click()
  await page.getByRole('heading', { name: 'Fixture replay only' }).waitFor()
  await page.screenshot({ path: '/tmp/intentbound-deck-audit-fixture-preview.png' })

  await page.locator('.primary-nav').getByRole('button', { name: 'Model Usage' }).click()
  await page.getByRole('heading', { name: 'Model usage' }).waitFor()
  await page.locator('.usage-summary').waitFor()
  await page.screenshot({ path: '/tmp/intentbound-deck-usage.png' })

  console.log([
    '/tmp/intentbound-deck-review.png',
    '/tmp/intentbound-deck-blocked-preview.png',
    '/tmp/intentbound-deck-activity-empty.png',
    '/tmp/intentbound-deck-audit-fixture-preview.png',
    '/tmp/intentbound-deck-usage.png',
  ].join('\n'))
} finally {
  await browser.close()
}
