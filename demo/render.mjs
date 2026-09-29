import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium } = requireFromWeb('playwright')

const captureDir = resolve(process.argv[2] || '')
const outputOption = process.argv.indexOf('--output')
const voiceOption = process.argv.indexOf('--voiceover')
const outputPath = outputOption > 0 ? resolve(process.argv[outputOption + 1]) : null
const voiceoverPath = voiceOption > 0 ? resolve(process.argv[voiceOption + 1]) : null
if (!process.argv[2] || (outputOption > 0 && !process.argv[outputOption + 1]) || (voiceOption > 0 && !process.argv[voiceOption + 1])) {
  throw new Error('Usage: node demo/render.mjs CAPTURE_DIR [--output FILE.mp4] [--voiceover FILE.wav]')
}

const plans = {
  preview: [
    { shot: '00-workbench', seconds: 9, caption: 'Your agent can choose dinner. Who approved the payment?' },
    { shot: '01-agent', seconds: 14, caption: 'Live Kiln turns Mina\'s dinner brief into a menu choice.' },
    { shot: '02-review', seconds: 15, caption: 'Mina reviews the 18 test TRX cap and the exact payees.' },
    { shot: '11-usage', seconds: 14, caption: 'Preview only. Real Kiln usage; no Shasta payment shown.' },
  ],
  live: [
    { shot: '00-workbench', seconds: 12, caption: 'The agent can choose dinner, not its spending limits.' },
    { shot: '01-agent', seconds: 18, caption: 'Kiln qwen3-32b parses the brief and compares menu IDs.' },
    { shot: '02-review', seconds: 15, caption: 'Mina reviews: 18 test TRX, two payees, ten minutes.' },
    { shot: '03-approved', seconds: 10, caption: 'The demo owner funds a bounded Shasta session.' },
    { shot: '04-case-a', seconds: 23, caption: 'A: 15 + 2 + 2 = 19. No payment leaves the vault.' },
    { shot: '05-case-b', seconds: 22, caption: 'B: cheaper lookalike, but the payee is not approved.' },
    { shot: '07-receipt', seconds: 24, caption: 'C: 16 test TRX. Confirmed Shasta payment and receipt.' },
    { shot: '09-case-d', seconds: 13, caption: 'Stop is confirmed. D is refused despite spare budget.' },
    { shot: '10-audit', seconds: 18, caption: 'No wallet needed: the public audit replays every event.' },
    { shot: '11-usage', seconds: 10, caption: 'Real model usage. Deterministic checks need no extra call.' },
  ],
}

async function command(binary, args, cwd = captureDir) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolveResult({ stdout, stderr }) : reject(new Error(`${binary} exited ${code}: ${stderr.slice(-3000)}`)))
  })
}

function requireEvidence(manifest) {
  assert.equal(manifest.state, 'complete', 'Incomplete capture cannot be rendered')
  assert.equal(manifest.kiln?.plan?.source, 'kiln')
  assert.equal(manifest.kiln?.recommend?.source, 'kiln')
  assert.equal(manifest.kiln?.plan?.model, 'qwen3-32b')
  assert.equal(manifest.kiln?.recommend?.model, 'qwen3-32b')
  if (manifest.mode !== 'live') return
  assert.equal(manifest.status?.chain?.configured, true, 'Shasta was not configured in this capture')
  assert.match(manifest.chain?.approvalTxHash || '', /^(?:0x)?[a-fA-F0-9]{64}$/)
  assert.match(manifest.chain?.revokeTxHash || '', /^(?:0x)?[a-fA-F0-9]{64}$/)
  assert.equal(manifest.chain?.auditVerdict, 'pass', 'Public audit has not passed')
  for (const [caseId, status, code, event] of [
    ['A', 'rejected', 'OVER_LIMIT', 'AttemptRejected'],
    ['B', 'rejected', 'MERCHANT_NOT_ALLOWED', 'AttemptRejected'],
    ['C', 'allowed', 'PAYMENT_EXECUTED', 'PaymentExecuted'],
    ['D', 'rejected', 'REVOKED', 'AttemptRejected'],
  ]) {
    const attempt = manifest.chain?.attempts?.[caseId]
    assert.equal(attempt?.status, status, `Case ${caseId} is not confirmed`)
    assert.equal(attempt?.code, code, `Case ${caseId} has the wrong decision`)
    assert.equal(attempt?.event, event, `Case ${caseId} is missing its Shasta event`)
    assert.match(attempt?.txHash || '', /^(?:0x)?[a-fA-F0-9]{64}$/)
  }
}

const manifest = JSON.parse(await readFile(join(captureDir, 'capture.json'), 'utf8'))
assert.ok(manifest.mode === 'preview' || manifest.mode === 'live', 'Unknown capture mode')
requireEvidence(manifest)
if (manifest.kiln?.usageFiles?.currentRun) {
  const perRun = JSON.parse(await readFile(join(captureDir, manifest.kiln.usageFiles.currentRun), 'utf8'))
  assert.equal(perRun.records?.length, 2, 'Per-run Kiln export must contain exactly two calls')
  assert.equal(perRun.totals?.totalTokens, manifest.kiln.plan.usage.totalTokens + manifest.kiln.recommend.usage.totalTokens)
}
if (manifest.mode === 'live') {
  const evidence = JSON.parse(await readFile(join(captureDir, manifest.chain.evidenceFile), 'utf8'))
  const audit = JSON.parse(await readFile(join(captureDir, manifest.chain.auditFile), 'utf8'))
  assert.equal(evidence.evidence?.id, manifest.chain.sessionId, 'Evidence export belongs to a different session')
  assert.equal(evidence.evidence?.attempts?.length, 4, 'Evidence export is missing an attempt')
  assert.equal(audit.audit?.sessionId, manifest.chain.sessionId, 'Audit export belongs to a different session')
  assert.equal(audit.audit?.verdict, 'pass', 'Audit export did not pass')
}

const plan = plans[manifest.mode]
const duration = plan.reduce((sum, scene) => sum + scene.seconds, 0)
const target = outputPath || join(captureDir, manifest.mode === 'live' ? 'intentbound-verified-shasta.mp4' : 'intentbound-preview-no-payment.mp4')
await mkdir(dirname(target), { recursive: true })
await mkdir(join(captureDir, 'frames'), { recursive: true })

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  await page.setContent(`<!doctype html><html><head><style>
    * { box-sizing: border-box; }
    html, body { width: 1920px; height: 1080px; margin: 0; overflow: hidden; background: #101c20; color: #fff; font-family: Arial, Helvetica, sans-serif; }
    #screen { display: block; width: 1920px; height: 960px; object-fit: fill; }
    #footer { width: 1920px; height: 120px; display: grid; grid-template-columns: 274px 1fr 285px; gap: 30px; align-items: center; padding: 0 48px; border-top: 5px solid #21a28c; background: #112127; }
    #mode { font-size: 23px; font-weight: 800; line-height: 1.14; color: #55d4bd; }
    #caption { font-size: 37px; font-weight: 700; line-height: 1.14; color: #f8fbfb; }
    #disclosure { font-size: 19px; line-height: 1.3; text-align: right; color: #bed0d0; }
    body.preview #footer { border-color: #e6a449; }
    body.preview #mode { color: #f5bd69; }
  </style></head><body class="${manifest.mode}"><img id="screen" alt="Recorded IntentBound product screen"><div id="footer"><div id="mode"></div><div id="caption"></div><div id="disclosure"></div></div></body></html>`)

  for (let index = 0; index < plan.length; index++) {
    const scene = plan[index]
    const caption = scene.shot === '11-usage'
      ? manifest.mode === 'live'
        ? `This run: ${manifest.kiln.plan.usage.totalTokens} + ${manifest.kiln.recommend.usage.totalTokens} tokens. Page totals are cumulative.`
        : `This run: ${manifest.kiln.plan.usage.totalTokens} + ${manifest.kiln.recommend.usage.totalTokens} tokens. Page totals include rehearsals.`
      : scene.caption
    const shot = manifest.shots.find((entry) => entry.id === scene.shot)
    assert.ok(shot, `Missing captured UI shot ${scene.shot}`)
    const source = await readFile(join(captureDir, shot.file))
    await page.evaluate(({ data, caption, mode, index, total }) => {
      document.querySelector('#screen').src = `data:image/png;base64,${data}`
      document.querySelector('#mode').textContent = mode === 'live' ? 'INTENTBOUND\nSHASTA TESTNET' : 'DRAFT PREVIEW\nNO PAYMENT'
      document.querySelector('#caption').textContent = caption
      document.querySelector('#disclosure').textContent = mode === 'live'
        ? `SIMULATED MERCHANTS\nREAL CHAIN EVIDENCE\n${index + 1} / ${total}`
        : `SIMULATED MERCHANTS\nREAL KILN CALLS\n${index + 1} / ${total}`
      for (const element of document.querySelectorAll('#mode, #disclosure')) element.style.whiteSpace = 'pre-line'
    }, { data: source.toString('base64'), caption, mode: manifest.mode, index, total: plan.length })
    await page.waitForFunction(() => {
      const image = document.querySelector('#screen')
      return image.complete && image.naturalWidth === 1920 && image.naturalHeight === 960
    })
    await page.screenshot({ path: join(captureDir, 'frames', `${String(index).padStart(2, '0')}.png`) })
  }
} finally {
  await browser.close()
}

const concat = plan.map((scene, index) => `file 'frames/${String(index).padStart(2, '0')}.png'\nduration ${scene.seconds}`).join('\n')
  + `\nfile 'frames/${String(plan.length - 1).padStart(2, '0')}.png'\n`
await writeFile(join(captureDir, 'concat.txt'), concat)

const audioInput = voiceoverPath ? ['-i', voiceoverPath] : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']
await command('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', 'concat.txt',
  ...audioInput,
  '-map', '0:v:0', '-map', '1:a:0',
  '-vf', 'fps=30,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
  '-c:a', 'aac', '-b:a', '160k',
  '-t', String(duration), '-movflags', '+faststart', target,
])

const probe = await command('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', target])
const media = JSON.parse(probe.stdout)
const actualDuration = Number(media.format?.duration)
const video = media.streams.find((stream) => stream.codec_type === 'video')
assert.ok(Math.abs(actualDuration - duration) <= 0.1, `Expected ${duration}s, got ${actualDuration}s`)
assert.equal(video?.width, 1920)
assert.equal(video?.height, 1080)
await writeFile(join(captureDir, 'render.json'), JSON.stringify({
  mode: manifest.mode,
  output: target,
  targetDurationSeconds: duration,
  actualDurationSeconds: actualDuration,
  width: video.width,
  height: video.height,
  audio: voiceoverPath ? 'supplied voiceover' : 'silence',
  disclosure: manifest.disclosure,
}, null, 2) + '\n')
console.log(`Rendered ${manifest.mode} animatic: ${target} (${actualDuration.toFixed(2)}s, 1920x1080)`)
