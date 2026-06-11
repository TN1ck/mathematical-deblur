// Generates README artwork: a before/after composite and an app screenshot.
import { chromium } from 'playwright'
import fs from 'node:fs'

const OUT = '../docs'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })
await page.goto('http://localhost:5179')

// A photo-like demo card, gaussian-blurred with sigma 4
const blurredPng = await page.evaluate(() => {
  const w = 560, h = 400
  const sharp = document.createElement('canvas')
  sharp.width = w; sharp.height = h
  const ctx = sharp.getContext('2d')
  const grad = ctx.createLinearGradient(0, 0, w, h)
  grad.addColorStop(0, '#f6f0e8')
  grad.addColorStop(1, '#dfe7f0')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#1d2433'
  ctx.font = 'bold 52px Georgia'
  ctx.fillText('Boarding pass', 36, 80)
  ctx.font = '26px Georgia'
  ctx.fillText('Gate B42 · Seat 17A · 09:35', 36, 130)
  ctx.font = '20px Courier'
  ctx.fillText('PNR: X4QT7Z   FLIGHT TN-1024', 36, 175)
  ctx.strokeStyle = '#1d2433'
  ctx.lineWidth = 3
  for (let i = 0; i < 36; i++) {
    const bw = (i * 7919) % 3 + 1
    ctx.fillRect(36 + i * 9, 210, bw, 70)
  }
  ctx.font = 'italic 22px Georgia'
  ctx.fillStyle = '#7a4a12'
  ctx.fillText('have a pleasant flight', 36, 330)
  ctx.fillStyle = '#b33'
  ctx.beginPath()
  ctx.arc(470, 320, 44, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 26px Arial'
  ctx.fillText('TN', 452, 330)

  const blurred = document.createElement('canvas')
  blurred.width = w; blurred.height = h
  const bctx = blurred.getContext('2d')
  bctx.filter = 'blur(4px)'
  bctx.drawImage(sharp, 0, 0)
  return blurred.toDataURL('image/png')
})
fs.writeFileSync('/tmp/readme-blurred.png', Buffer.from(blurredPng.split(',')[1], 'base64'))

await page.setInputFiles('input[type=file]', '/tmp/readme-blurred.png')
await page.waitForSelector('canvas.image-canvas')
await page.waitForFunction(() => !document.querySelector('.processing-badge'), null, { timeout: 30000 })

// Gaussian defect, radius 4
await page.selectOption('select >> nth=0', '2')
await page.evaluate(() => {
  const input = document.querySelector('input[type=range]')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, '40')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
})
await page.waitForTimeout(400)
await page.waitForFunction(() => !document.querySelector('.processing-badge'), null, { timeout: 30000 })

// App screenshot
await page.screenshot({ path: `${OUT}/app.png` })

// Before/after composite from the live canvases
const composite = await page.evaluate((blurredDataUrl) => {
  return new Promise((resolve) => {
    const result = document.querySelector('canvas.image-canvas')
    const w = result.width, h = result.height
    const img = new Image()
    img.onload = () => {
      const pad = 16, label = 44
      const c = document.createElement('canvas')
      c.width = w * 2 + pad * 3
      c.height = h + label + pad
      const ctx = c.getContext('2d')
      ctx.fillStyle = '#15171c'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.drawImage(img, pad, label)
      ctx.drawImage(result, w + pad * 2, label)
      ctx.fillStyle = '#8b91a0'
      ctx.font = '600 22px system-ui'
      ctx.fillText('blurred input', pad, 30)
      ctx.fillStyle = '#4f8ef7'
      ctx.fillText('restored (Wiener deconvolution)', w + pad * 2, 30)
      resolve(c.toDataURL('image/png'))
    }
    img.src = blurredDataUrl
  })
}, blurredPng)
fs.writeFileSync(`${OUT}/before-after.png`, Buffer.from(composite.split(',')[1], 'base64'))
console.log('done')
await browser.close()
