// SPDX-License-Identifier: GPL-3.0-or-later

// Same cap as the original SmartDeblur (MAX_IMAGE_PIXELS)
const MAX_PIXELS = 3_000_000

/** Decode an image file into RGBA ImageData, downscaling to ≤3 MP. */
export async function loadImageFile(file: File): Promise<ImageData> {
  const bitmap = await createImageBitmap(file)
  let { width, height } = bitmap
  const pixels = width * height
  if (pixels > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / pixels)
    width = Math.max(1, Math.round(width * scale))
    height = Math.max(1, Math.round(height * scale))
  }
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return ctx.getImageData(0, 0, width, height)
}
