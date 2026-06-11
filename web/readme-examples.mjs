// Generates the README example gallery: motion-blur and out-of-focus
// before/after composites, produced by the real app.
import { chromium } from 'playwright'
import fs from 'node:fs'

const OUT = '../docs'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://localhost:5179')

// ---- scene painters + true convolution blurs, all in page context ----
const makeBlurred = (scene, blur) =>
  page.evaluate(
    ({ scene, blur }) => {
      const w = 560, h = 400
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const ctx = c.getContext('2d')

      if (scene === 'sign') {
        ctx.fillStyle = '#1d3b6e'
        ctx.fillRect(0, 0, w, h)
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 6
        ctx.strokeRect(14, 14, w - 28, h - 28)
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 64px Arial'
        ctx.fillText('MUSEUM', 48, 110)
        ctx.font = 'bold 44px Arial'
        ctx.fillText('400 m', 48, 180)
        ctx.font = 'bold 100px Arial'
        ctx.fillText('→', 360, 180)
        ctx.font = '32px Arial'
        ctx.fillText('Mon–Sun  10:00–18:00', 48, 280)
        ctx.fillStyle = '#ffd34d'
        ctx.font = 'bold 30px Arial'
        ctx.fillText('free admission today', 48, 340)
      } else {
        ctx.fillStyle = '#f7f3ea'
        ctx.fillRect(0, 0, w, h)
        ctx.fillStyle = '#2a2118'
        ctx.font = 'bold 46px Georgia'
        ctx.fillText('Café Lumière', 40, 80)
        ctx.strokeStyle = '#b9a98a'
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.moveTo(40, 100); ctx.lineTo(520, 100); ctx.stroke()
        ctx.font = '30px Georgia'
        ctx.fillText('WiFi:  Lumiere_Guest', 40, 160)
        ctx.fillText('Pass:  espresso2026', 40, 210)
        ctx.font = 'italic 24px Georgia'
        ctx.fillStyle = '#6b5b40'
        ctx.fillText('flat white ........... 4,20 €', 40, 280)
        ctx.fillText('croissant ............ 2,80 €', 40, 320)
        ctx.fillStyle = '#8a2f2f'
        ctx.font = 'bold 24px Georgia'
        ctx.fillText('ask for the cake of the day!', 40, 370)
      }

      // exact convolution blur over integer offsets
      const src = ctx.getImageData(0, 0, w, h)
      const offsets = []
      if (blur.type === 'motion') {
        // horizontal line, length 2*radius (matches the app's line PSF)
        const half = Math.round(blur.radius)
        for (let dx = -half; dx <= half; dx++) offsets.push([dx, 0])
      } else {
        const r = blur.radius
        for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
          for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++)
            if (dx * dx + dy * dy <= r * r) offsets.push([dx, dy])
      }
      const acc = new Float64Array(w * h * 4)
      const d = src.data
      for (const [dx, dy] of offsets) {
        for (let y = 0; y < h; y++) {
          const sy = Math.min(h - 1, Math.max(0, y + dy))
          for (let x = 0; x < w; x++) {
            const sx = Math.min(w - 1, Math.max(0, x + dx))
            const si = (sy * w + sx) * 4, di = (y * w + x) * 4
            acc[di] += d[si]; acc[di + 1] += d[si + 1]; acc[di + 2] += d[si + 2]; acc[di + 3] += 255
          }
        }
      }
      const out = ctx.createImageData(w, h)
      for (let i = 0; i < acc.length; i++) out.data[i] = acc[i] / offsets.length
      ctx.putImageData(out, 0, 0)
      return c.toDataURL('image/png')
    },
    { scene, blur },
  )

const setSlider = (index, value) =>
  page.evaluate(
    ({ index, value }) => {
      const input = document.querySelectorAll('input[type=range]')[index]
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, String(value))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    },
    { index, value },
  )

const settle = async () => {
  await page.waitForTimeout(400)
  await page.waitForFunction(() => !document.querySelector('.processing-badge'), null, {
    timeout: 60000,
  })
}

const compose = (blurredDataUrl, label, file) =>
  page
    .evaluate(
      ({ blurredDataUrl, label }) =>
        new Promise((resolve) => {
          const result = document.querySelector('canvas.image-canvas')
          const w = result.width, h = result.height
          const img = new Image()
          img.onload = () => {
            const pad = 16, top = 44
            const c = document.createElement('canvas')
            c.width = w * 2 + pad * 3
            c.height = h + top + pad
            const ctx = c.getContext('2d')
            ctx.fillStyle = '#15171c'
            ctx.fillRect(0, 0, c.width, c.height)
            ctx.drawImage(img, pad, top)
            ctx.drawImage(result, w + pad * 2, top)
            ctx.fillStyle = '#8b91a0'
            ctx.font = '600 22px system-ui'
            ctx.fillText('blurred input', pad, 30)
            ctx.fillStyle = '#4f8ef7'
            ctx.fillText(label, w + pad * 2, 30)
            resolve(c.toDataURL('image/png'))
          }
          img.src = blurredDataUrl
        }),
      { blurredDataUrl, label },
    )
    .then((dataUrl) => fs.writeFileSync(`${OUT}/${file}`, Buffer.from(dataUrl.split(',')[1], 'base64')))

// ---- 1. Motion blur: horizontal smear of 15 px on a street sign ----
let blurred = await makeBlurred('sign', { type: 'motion', radius: 7 })
fs.writeFileSync('/tmp/ex-motion.png', Buffer.from(blurred.split(',')[1], 'base64'))
await page.setInputFiles('input[type=file]', '/tmp/ex-motion.png')
await page.waitForSelector('canvas.image-canvas')
await settle()
await page.selectOption('select >> nth=0', '1') // motion
await settle()
await setSlider(0, 70) // length 7.0 (kernel line = 14 px)
await settle()
await setSlider(2, 55) // smooth
await settle()
await compose(blurred, 'restored (motion blur, Wiener)', 'example-motion.png')

// ---- 2. Out of focus: disc blur r=5 on a café card ----
blurred = await makeBlurred('card', { type: 'focus', radius: 5 })
fs.writeFileSync('/tmp/ex-focus.png', Buffer.from(blurred.split(',')[1], 'base64'))
await page.setInputFiles('input[type=file]', '/tmp/ex-focus.png')
await page.waitForSelector('canvas.image-canvas')
await settle()
await page.selectOption('select >> nth=0', '0') // out of focus
await settle()
await setSlider(0, 52) // radius 5.2
await settle()
await setSlider(1, 52) // smooth
await settle()
await compose(blurred, 'restored (out of focus, Wiener)', 'example-focus.png')

console.log('done')
await browser.close()
