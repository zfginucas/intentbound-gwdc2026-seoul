import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium } = requireFromWeb('playwright')
const demoDir = dirname(fileURLToPath(import.meta.url))
const mode = process.argv[2] || 'preview'
const webUrl = (process.env.INTENTBOUND_WEB_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '')
const apiUrl = (process.env.INTENTBOUND_API_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const outputDir = resolve(process.env.INTENTBOUND_CAPTURE_DIR || join(demoDir, 'output', `${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`))
const txPattern = /^(?:0x)?[a-fA-F0-9]{64}$/

if (!['preview', 'live'].includes(mode)) {
  throw new Error('Usage: node demo/capture.mjs preview|live')
}

const manifest = {
  schemaVersion: 1,
  mode,
  state: 'incomplete',
  capturedAt: new Date().toISOString(),
  webUrl,
  apiUrl,
  disclosure: 'Restaurant, menu, quote, and fulfillment data are simulated. Kiln and Shasta claims require recorded evidence.',
  status: null,
  kiln: {},
  chain: { sessionId: null, approvalTxHash: null, attempts: {}, revokeTxHash: null, auditVerdict: null },
  shots: [],
  pageErrors: [],
}

let browser
let context
let page

async function apiGet(path) {
  const response = await fetch(new URL(path, apiUrl), { signal: AbortSignal.timeout(15_000) })
  const body = await response.json().catch(() => null)
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(body)}`)
  return body
}

async function saveManifest() {
  await writeFile(join(outputDir, 'capture.json'), JSON.stringify(manifest, null, 2) + '\n')
}

async function shot(id, description) {
  await page.waitForTimeout(350)
  const file = `shots/${id}.png`
  await page.screenshot({ path: join(outputDir, file) })
  manifest.shots.push({ id, file, description, at: new Date().toISOString() })
  await page.waitForTimeout(800)
}

async function responseFromClick(path, action, timeout = 90_000, method = 'POST') {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => {
      const url = new URL(candidate.url())
      return url.pathname === path && candidate.request().method() === method
    }, { timeout }),
    action(),
  ])
  const body = await response.json().catch(() => null)
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(body)}`)
  return body
}

function assertRealInference(label, body) {
  const inference = body?.inference
  assert.equal(inference?.source, 'kiln', `${label} did not use live Kiln; scripted fallback cannot appear in this video`)
  assert.equal(inference?.model, 'qwen3-32b', `${label} did not report qwen3-32b`)
  assert.ok(inference?.usage?.inputTokens > 0, `${label} has no reported input tokens`)
  assert.ok(inference?.usage?.outputTokens > 0, `${label} has no reported output tokens`)
  return inference
}

function assertTx(hash, label) {
  assert.match(hash || '', txPattern, `${label} lacks a real-looking 64-hex transaction ID`)
}

async function assertFoodImages() {
  const images = await page.locator('.food-card img').evaluateAll((nodes) => nodes.map((node) => ({
    src: node.getAttribute('src'),
    loaded: node.complete && node.naturalWidth > 0,
  })))
  assert.equal(images.length, 3, 'Expected three product food images')
  assert.ok(images.every((image) => image.loaded), `A food image did not render: ${JSON.stringify(images)}`)
}

async function runKilnJourney() {
  const fallback = page.getByRole('checkbox', { name: /Scripted fallback/ })
  assert.equal(await fallback.isChecked(), false, 'Scripted fallback must be off')

  const plan = await responseFromClick('/api/agent/plan', () => page.getByRole('button', { name: 'Parse brief with agent' }).click())
  manifest.kiln.plan = assertRealInference('Intent parsing', plan)
  await page.locator('.chat-turn.agent').filter({ hasText: 'Kiln' }).last().waitFor()

  const recommendation = await responseFromClick('/api/agent/recommend', () => page.getByRole('button', { name: /Compare menu with agent/ }).click())
  manifest.kiln.recommend = assertRealInference('Menu comparison', recommendation)
  manifest.kiln.recommendedItemId = recommendation.itemId
  await page.locator('.recommendation-note').waitFor()
  await page.getByRole('button', { name: 'Refresh connections' }).click()
  await page.getByText('Live Kiln', { exact: false }).waitFor()
  await shot('01-agent', 'Live Kiln parsed the brief and compared known menu IDs')
}

async function reviewPermission() {
  await page.getByRole('button', { name: /Review permission/ }).first().click()
  await page.getByRole('dialog', { name: 'Review permission' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Approve with demo wallet' }).isDisabled(), true)
  const budget = Number(await page.getByRole('dialog').getByLabel(/Session budget/).inputValue())
  const cap = Number(await page.getByRole('dialog').getByLabel(/Per payment cap/).inputValue())
  assert.equal(budget, 18, 'Demo script requires an 18 test TRX session budget')
  assert.equal(cap, 18, 'Demo script requires an 18 test TRX per-payment cap')
  await shot('02-review', 'Human reviews all-in cap, allowed payees, duration, and demo wallet custody')
}

async function runCase(sessionId, id, expectedStatus, expectedCode, expectedEvent, spentSun) {
  const selector = id === 'D'
    ? page.locator('.story-step').filter({ hasText: 'Post-stop regression test' })
    : page.locator('.food-card').filter({ hasText: `CASE ${id}` })
  await selector.click()
  const runButton = page.locator('.inspector-footer .primary-command')
  assert.equal(await runButton.isEnabled(), true, `Case ${id} cannot be run from the UI`)
  const body = await responseFromClick(`/api/sessions/${sessionId}/attempts`, () => runButton.click(), 150_000)
  const attempt = body?.attempt
  assert.equal(attempt?.quoteId, id)
  assert.equal(attempt?.status, expectedStatus, `Case ${id} is not a confirmed ${expectedStatus} decision`)
  assert.equal(attempt?.code, expectedCode, `Case ${id} returned the wrong decision reason`)
  assert.equal(attempt?.onChain, true, `Case ${id} has no on-chain event`)
  assertTx(attempt?.txHash, `Case ${id}`)
  assert.equal(body.session?.spentSun, spentSun, `Case ${id} changed spend unexpectedly`)

  const evidence = await apiGet(`/api/sessions/${sessionId}/evidence`)
  const recorded = evidence?.evidence?.attempts?.find((entry) => entry.id === attempt.id)
  assert.equal(recorded?.chainEvent?.name, expectedEvent, `Case ${id} lacks the expected confirmed chain event`)
  assert.equal(recorded?.chainEvent?.amountSun, attempt.amountSun, `Case ${id} amount and chain event differ`)
  assert.equal(recorded?.chainEvent?.quoteHash?.toLowerCase(), attempt.quoteHash?.toLowerCase(), `Case ${id} quote hash and chain event differ`)
  assert.equal(recorded?.chainEvent?.merchantAddress, attempt.merchantAddress, `Case ${id} payee and chain event differ`)
  manifest.chain.attempts[id] = {
    id: attempt.id,
    code: attempt.code,
    status: attempt.status,
    amountSun: attempt.amountSun,
    txHash: attempt.txHash,
    event: recorded.chainEvent.name,
    spentSun: body.session.spentSun,
  }
  await page.locator('.inspector-footer .evidence-caption').filter({ hasText: attempt.code }).waitFor()
  await shot(`${id === 'D' ? '09' : id === 'A' ? '04' : id === 'B' ? '05' : '06'}-case-${id.toLowerCase()}`, `Case ${id}: ${attempt.code}, confirmed ${expectedEvent} event`)
}

async function runLiveJourney() {
  const session = await responseFromClick('/api/sessions', async () => {
    await page.getByRole('checkbox', { name: /I approve these exact/ }).check()
    await page.getByRole('button', { name: 'Approve with demo wallet' }).click()
  }, 180_000)
  const record = session?.session
  assert.equal(record?.state, 'active', 'Shasta session is not confirmed active')
  assert.equal(record?.budgetSun, 18_000_000)
  assert.equal(record?.spentSun, 0)
  assertTx(record?.approvalTxHash, 'Permission approval')
  manifest.chain.sessionId = record.id
  manifest.chain.approvalTxHash = record.approvalTxHash
  await page.getByText('ACTIVE', { exact: true }).first().waitFor()
  await shot('03-approved', 'Demo owner funded the time-limited Shasta permission')

  await runCase(record.id, 'A', 'rejected', 'OVER_LIMIT', 'AttemptRejected', 0)
  await runCase(record.id, 'B', 'rejected', 'MERCHANT_NOT_ALLOWED', 'AttemptRejected', 0)
  await runCase(record.id, 'C', 'allowed', 'PAYMENT_EXECUTED', 'PaymentExecuted', 16_000_000)

  await page.locator('.primary-nav').getByRole('button', { name: 'Activity' }).click()
  await page.getByRole('heading', { name: 'Decision history' }).waitFor()
  await page.getByText('CONFIRMED TRANSACTION HASH').waitFor()
  await shot('07-receipt', 'Real Shasta payment receipt tied to Case C')
  await page.locator('.primary-nav').getByRole('button', { name: /Dinner Run/ }).click()

  await page.getByRole('button', { name: 'Stop agent spending' }).click()
  const revoked = await responseFromClick(`/api/sessions/${record.id}/revoke`, () => page.getByRole('button', { name: 'Stop & revoke' }).click(), 180_000)
  assert.equal(revoked?.session?.state, 'revoked', 'Stop is not yet confirmed on Shasta')
  assertTx(revoked?.session?.revokeTxHash, 'Revocation')
  manifest.chain.revokeTxHash = revoked.session.revokeTxHash
  await page.getByText('STOPPED', { exact: true }).first().waitFor()
  await shot('08-stopped', 'Owner revocation confirmed on Shasta')
  await runCase(record.id, 'D', 'rejected', 'REVOKED', 'AttemptRejected', 16_000_000)

  await page.locator('.primary-nav').getByRole('button', { name: /Public Audit/ }).click()
  await page.getByRole('heading', { name: 'Public audit' }).waitFor()
  const audit = await responseFromClick(`/api/sessions/${record.id}/audit`, () => page.getByRole('button', { name: 'Verify' }).click(), 90_000, 'GET')
  assert.equal(audit?.audit?.verdict, 'pass', 'Independent audit did not pass')
  assert.ok(audit.audit.checks.every((check) => check.passed), 'Audit contains a failed or incomplete check')
  manifest.chain.auditVerdict = audit.audit.verdict
  await page.getByRole('heading', { name: 'Permission verified' }).waitFor()
  await writeFile(join(outputDir, 'shasta-audit.json'), JSON.stringify(audit, null, 2) + '\n')
  const finalEvidence = await apiGet(`/api/sessions/${record.id}/evidence`)
  assert.equal(finalEvidence?.evidence?.attempts?.length, 4, 'Final evidence is missing one of the four attempts')
  await writeFile(join(outputDir, 'shasta-session-evidence.json'), JSON.stringify(finalEvidence, null, 2) + '\n')
  manifest.chain.auditFile = 'shasta-audit.json'
  manifest.chain.evidenceFile = 'shasta-session-evidence.json'
  await shot('10-audit', 'Public audit replays the policy and all four testnet decisions')
}

async function captureUsage() {
  await page.locator('.primary-nav').getByRole('button', { name: /Model Usage/ }).click()
  await page.getByRole('heading', { name: 'Model usage' }).waitFor()
  const usage = await apiGet('/api/usage')
  const current = {}
  for (const [label, inference] of Object.entries({ plan: manifest.kiln.plan, recommend: manifest.kiln.recommend })) {
    const candidates = usage.records.filter((record) => record.purpose === label
      && record.inference?.source === 'kiln'
      && record.inference?.model === inference.model
      && record.inference?.usage?.totalTokens === inference.usage.totalTokens
      && (!inference.generationId || record.inference.generationId === inference.generationId)
      && Date.parse(record.createdAt) >= Date.parse(manifest.capturedAt))
    assert.equal(candidates.length, 1, `Could not identify exactly one Kiln ${label} record for this capture`)
    current[label] = candidates[0]
  }
  const totals = {
    inputTokens: current.plan.inference.usage.inputTokens + current.recommend.inference.usage.inputTokens,
    outputTokens: current.plan.inference.usage.outputTokens + current.recommend.inference.usage.outputTokens,
    totalTokens: current.plan.inference.usage.totalTokens + current.recommend.inference.usage.totalTokens,
  }
  await writeFile(join(outputDir, 'kiln-usage-server-snapshot.json'), JSON.stringify(usage, null, 2) + '\n')
  await writeFile(join(outputDir, 'kiln-usage-this-run.json'), JSON.stringify({
    model: 'qwen3-32b',
    capturedAt: manifest.capturedAt,
    disclosure: 'These two API ledger records belong to this capture. The full server snapshot also includes earlier calls.',
    records: [current.plan, current.recommend],
    totals,
  }, null, 2) + '\n')
  manifest.kiln.usageFiles = {
    currentRun: 'kiln-usage-this-run.json',
    serverSnapshot: 'kiln-usage-server-snapshot.json',
  }
  manifest.kiln.currentRunTotals = totals
  manifest.kiln.usageRecordCount = usage.records.filter((record) => record.inference?.source === 'kiln').length
  await shot('11-usage', 'Cumulative server usage summary; this run is isolated in kiln-usage-this-run.json')
  if (manifest.kiln.recommend.generationId) {
    await page.locator('.usage-record').filter({ hasText: manifest.kiln.recommend.generationId }).scrollIntoViewIfNeeded()
  }
  await shot('12-usage-current', 'The plan and recommendation ledger rows for this capture')
}

async function finalizeVideo() {
  const video = page.video()
  await context.close()
  context = null
  if (video) await rename(await video.path(), join(outputDir, 'raw-ui.webm'))
}

async function main() {
  try {
    await mkdir(join(outputDir, 'shots'), { recursive: true })
    manifest.status = await apiGet('/api/status')
  assert.equal(manifest.status?.merchantMode, 'fixture', 'The disclosure assumes simulated merchants')
  assert.equal(manifest.status?.kiln?.model, 'qwen3-32b')
  assert.equal(manifest.status?.kiln?.configured, true, 'Kiln must be configured for both recording modes')
  if (mode === 'live') {
    assert.equal(manifest.status?.chain?.network, 'shasta', 'Live capture must use Shasta')
    assert.equal(manifest.status?.chain?.configured, true, 'Shasta is not configured; record preview instead')
    assert.ok(manifest.status?.chain?.contractAddress, 'No deployed Shasta contract is configured')
  }
  await apiGet('/api/catalog')

  browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', headless: true })
  context = await browser.newContext({
    viewport: { width: 1920, height: 960 },
    deviceScaleFactor: 1,
    recordVideo: { dir: outputDir, size: { width: 1920, height: 960 } },
  })
  page = await context.newPage()
  page.on('pageerror', (error) => manifest.pageErrors.push(error.message))
  await page.goto(webUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Dinner run' }).waitFor()
  await assertFoodImages()
  await shot('00-workbench', 'Dinner Run product UI with simulated food catalog')
  await runKilnJourney()
  await reviewPermission()

  if (mode === 'live') {
    await runLiveJourney()
  } else {
    await page.getByRole('button', { name: 'Close review' }).click()
  }
  await captureUsage()
  assert.deepEqual(manifest.pageErrors, [], 'The page raised an uncaught error')
  manifest.state = 'complete'
  await saveManifest()
  await finalizeVideo()
    console.log(`Completed ${mode} capture: ${outputDir}`)
  } catch (error) {
    manifest.state = 'incomplete'
    manifest.failure = error instanceof Error ? error.message : String(error)
    await mkdir(outputDir, { recursive: true })
    await saveManifest()
    if (context) await context.close().catch(() => {})
    console.error(`Capture incomplete: ${manifest.failure}`)
    console.error(`Partial evidence is retained in ${outputDir}; do not render it as a verified run.`)
    process.exitCode = 1
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

await main()
