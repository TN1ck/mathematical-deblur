// Verification driver: generates a synthetically blurred image, uploads it,
// drives the controls, and measures sharpness of the result.
import { chromium } from 'playwright'
import fs from 'node:fs'

const URL = 'http://localhost:5179'
const OUT = '/tmp/deblur-verify'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('console', (m) => console.log('[console]', m.type(), m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

// --- 1. Generate sharp + blurred (gaussian sigma=4) test images in-browser
await page.goto(URL)
const images = await page.evaluate(() => {
  const w = 480, h = 360
  const draw = (ctx) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#000000'
    ctx.font = 'bold 42px Arial'
    ctx.fillText('SHARP TEXT 123', 40, 90)
    ctx.font = '22px Arial'
    ctx.fillText('the quick brown fox jumps', 40, 140)
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? '#d22' : '#22d'
      ctx.fillRect(40 + i * 45, 180, 30, 30)
    }
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 2
    for (let i = 0; i < 10; i++) {
      ctx.beginPath()
      ctx.moveTo(40 + i * 8, 240)
      ctx.lineTo(40 + i * 8, 320)
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(360, 280, 40, 0, Math.PI * 2)
    ctx.fill()
  }
  const sharp = document.createElement('canvas')
  sharp.width = w; sharp.height = h
  draw(sharp.getContext('2d'))

  const blurred = document.createElement('canvas')
  blurred.width = w; blurred.height = h
  const bctx = blurred.getContext('2d')
  bctx.filter = 'blur(4px)'
  bctx.drawImage(sharp, 0, 0)
  return { sharp: sharp.toDataURL('image/png'), blurred: blurred.toDataURL('image/png') }
})
const b64 = (d) => Buffer.from(d.split(',')[1], 'base64')
fs.writeFileSync(`${OUT}/sharp.png`, b64(images.sharp))
fs.writeFileSync(`${OUT}/blurred.png`, b64(images.blurred))

// Sharpness metric: variance of the discrete Laplacian over the interior
const sharpnessOfCanvas = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('canvas.image-canvas')
    if (!canvas) return null
    const ctx = canvas.getContext('2d')
    const { width: w, height: h } = canvas
    const d = ctx.getImageData(0, 0, w, h).data
    const gray = (i) => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]
    let sum = 0, sum2 = 0, n = 0
    const m = 16 // skip border band (ringing area)
    for (let y = m; y < h - m; y++) {
      for (let x = m; x < w - m; x++) {
        const i = y * w + x
        const lap = 4 * gray(i) - gray(i - 1) - gray(i + 1) - gray(i - w) - gray(i + w)
        sum += lap; sum2 += lap * lap; n++
      }
    }
    const mean = sum / n
    return sum2 / n - mean * mean
  })

// --- 2. Upload the blurred image
await page.setInputFiles('input[type=file]', `${OUT}/blurred.png`)
await page.waitForSelector('canvas.image-canvas', { timeout: 15000 })
// wait for first (auto) deconvolution to finish
await page.waitForFunction(() => !document.querySelector('.processing-badge'), null, { timeout: 30000 })
await page.screenshot({ path: `${OUT}/1-after-upload-focus-defaults.png` })
const sharpnessFocusDefault = await sharpnessOfCanvas()

// Baseline sharpness of blurred input = what canvas shows while holding compare
await page.locator('.compare-button').dispatchEvent('pointerdown')
await page.waitForTimeout(200)
const sharpnessBlurredInput = await sharpnessOfCanvas()
await page.screenshot({ path: `${OUT}/2-original-held.png` })
await page.locator('.compare-button').dispatchEvent('pointerup')

// --- 3. Switch to Gaussian defect, radius 4
await page.selectOption('select >> nth=0', '2')
await page.waitForFunction(() => !document.querySelector('.processing-badge'), null, { timeout: 30000 })

// set radius slider (first range input) to 40 => radius 4.0 via native setter
await page.evaluate(() => {
  const input = document.querySelector('input[type=range]')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, '40')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
})
await page.waitForTimeout(500)
await page.waitForFunction(() => !document.querySelector('.processing-badge'), null, { timeout: 30000 })
await page.screenshot({ path: `${OUT}/3-gaussian-r4-wiener.png` })
const sharpnessWiener = await sharpnessOfCanvas()

// kernel preview should be visible
const kernelShot = await page.locator('.kernel-canvas').screenshot({ path: `${OUT}/kernel.png` })

// --- 4. Probe: TV high quality with fewer iterations (faster)
await page.locator('input[type=number]').fill('120')
await page.locator('.hq-button').click()
await page.waitForSelector('progress', { timeout: 10000 })
await page.screenshot({ path: `${OUT}/4-tv-progress.png` })
await page.waitForFunction(() => !document.querySelector('progress'), null, { timeout: 120000 })
await page.screenshot({ path: `${OUT}/5-tv-result.png` })
const sharpnessTV = await sharpnessOfCanvas()

// --- 5. Probe: cancel a TV run mid-flight
await page.locator('input[type=number]').fill('2000')
await page.locator('.hq-button').click()
await page.waitForSelector('progress', { timeout: 10000 })
await page.waitForTimeout(700)
await page.getByText('Cancel').click()
const progressGone = await page
  .waitForFunction(() => !document.querySelector('progress'), null, { timeout: 5000 })
  .then(() => true)
  .catch(() => false)

// after cancel, engine should still respond: nudge smooth slider
await page.evaluate(() => {
  const inputs = document.querySelectorAll('input[type=range]')
  const input = inputs[1]
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, '40')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
})
const aliveAfterCancel = await page
  .waitForFunction(() => !document.querySelector('.processing-badge'), null, { timeout: 30000 })
  .then(() => true)
  .catch(() => false)
await page.screenshot({ path: `${OUT}/6-after-cancel-recovers.png` })

// --- 6. Probe: save button enabled, weird TV iteration input
const saveEnabled = await page.locator('button', { hasText: 'Save result' }).isEnabled()

console.log(JSON.stringify({
  sharpnessBlurredInput,
  sharpnessFocusDefault,
  sharpnessWiener,
  sharpnessTV,
  progressGoneAfterCancel: progressGone,
  aliveAfterCancel,
  saveEnabled,
  kernelShotBytes: kernelShot.length,
}, null, 2))

await browser.close()
