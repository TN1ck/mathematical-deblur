// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from 'react'
import { Controls } from './Controls'
import { loadImageFile } from './loadImage'
import { BlurType, Mode, defaultParams, type DeblurParams } from './types'
import { useDeblurEngine } from './useDeblurEngine'

// The bundled example is blurred with a Gaussian of sigma 4 —
// these parameters restore it immediately.
const exampleParams: DeblurParams = {
  ...defaultParams,
  blurType: BlurType.Gaussian,
  radius: 4,
}

export default function App() {
  const [params, setParams] = useState<DeblurParams>(defaultParams)
  const [image, setImage] = useState<ImageData | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const engine = useDeblurEngine()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const kernelCanvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const paramsRef = useRef(params)
  paramsRef.current = params

  const openFile = useCallback(
    async (file: File) => {
      const data = await loadImageFile(file)
      setImage(data)
      engine.setImage(data)
      engine.requestDeconvolve(paramsRef.current, Mode.PreviewColor)
    },
    [engine],
  )

  const openExample = useCallback(async () => {
    const blob = await (await fetch('sample-blurred.png')).blob()
    const data = await loadImageFile(new File([blob], 'sample-blurred.png'))
    setParams(exampleParams)
    engine.requestKernelPreview(exampleParams)
    setImage(data)
    engine.setImage(data)
    engine.requestDeconvolve(exampleParams, Mode.PreviewColor)
  }, [engine])

  // Live (drag) update: fast grayscale preview, like the original
  const handleParamsChange = useCallback(
    (next: DeblurParams) => {
      setParams(next)
      engine.requestKernelPreview(next)
      engine.requestDeconvolve(next, Mode.PreviewGray)
    },
    [engine],
  )

  // Drag finished: full color preview
  const handleCommit = useCallback(() => {
    engine.requestDeconvolve(paramsRef.current, Mode.PreviewColor)
  }, [engine])

  const handleHighQuality = useCallback(() => {
    engine.requestDeconvolve(paramsRef.current, Mode.HighQuality)
  }, [engine])

  // Paint result (or original while comparing) to the main canvas
  useEffect(() => {
    const canvas = canvasRef.current
    const data = showOriginal ? image : (engine.result ?? image)
    if (!canvas || !data) return
    canvas.width = data.width
    canvas.height = data.height
    canvas.getContext('2d')!.putImageData(data, 0, 0)
  }, [engine.result, image, showOriginal])

  // Paint the PSF kernel preview
  useEffect(() => {
    const canvas = kernelCanvasRef.current
    const kernel = engine.kernel
    if (!canvas || !kernel) return
    canvas.width = kernel.size
    canvas.height = kernel.size
    const rgba = new Uint8ClampedArray(kernel.size * kernel.size * 4)
    for (let i = 0; i < kernel.pixels.length; i++) {
      rgba[i * 4] = kernel.pixels[i]
      rgba[i * 4 + 1] = kernel.pixels[i]
      rgba[i * 4 + 2] = kernel.pixels[i]
      rgba[i * 4 + 3] = 255
    }
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(rgba, kernel.size, kernel.size), 0, 0)
  }, [engine.kernel])

  // Initial kernel preview
  useEffect(() => {
    engine.requestKernelPreview(defaultParams)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDownload = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'deblurred.png'
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }, [])

  return (
    <div className="app">
      <header className="header">
        <h1>Mathematical Deblur</h1>
        <span className="subtitle">
          Restore defocused and blurred images — Wiener · Tikhonov · Total Variation
        </span>
      </header>

      <main className="main">
        <section
          className={`viewport ${dragOver ? 'drag-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const file = e.dataTransfer.files[0]
            if (file) void openFile(file)
          }}
        >
          {image ? (
            <canvas ref={canvasRef} className="image-canvas" />
          ) : (
            <div className="dropzone">
              <span className="dropzone-title">Drop a blurred image here</span>
              <small>JPEG / PNG, downscaled to 3 MP — it never leaves your device</small>
              <div className="dropzone-actions">
                <button onClick={() => fileInputRef.current?.click()}>Browse files</button>
                <button onClick={() => void openExample()}>Try an example</button>
              </div>
            </div>
          )}
          {engine.busy && engine.progress === null && (
            <div className="processing-badge">processing…</div>
          )}
        </section>

        <aside className="sidebar">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void openFile(file)
              e.target.value = ''
            }}
          />
          <div className="button-row">
            <button onClick={() => fileInputRef.current?.click()}>Open image…</button>
            <button onClick={handleDownload} disabled={!engine.result}>
              Save result
            </button>
          </div>

          <Controls
            params={params}
            disabled={!image}
            onChange={handleParamsChange}
            onCommit={handleCommit}
          />

          <div className="kernel-box">
            <span>Kernel (PSF) preview</span>
            <canvas ref={kernelCanvasRef} className="kernel-canvas" />
          </div>

          <div className="hq-box">
            {engine.progress !== null ? (
              <>
                <progress max={100} value={engine.progress} />
                <button onClick={engine.cancel}>Cancel</button>
              </>
            ) : (
              <button className="hq-button" disabled={!image} onClick={handleHighQuality}>
                High quality (Total Variation)
              </button>
            )}
          </div>

          <button
            className="compare-button"
            disabled={!image || !engine.result}
            onPointerDown={() => setShowOriginal(true)}
            onPointerUp={() => setShowOriginal(false)}
            onPointerLeave={() => setShowOriginal(false)}
          >
            Hold to compare with original
          </button>

          <details className="how">
            <summary>How does this work?</summary>
            <div className="how-body">
              <p>
                A blurred photo is the sharp scene <em>convolved</em> with a small
                pattern called the point spread function (PSF): a disc for missed
                focus, a line for camera shake. The information isn&apos;t gone —
                it&apos;s smeared in a predictable way, and convolution can largely
                be inverted.
              </p>
              <p>
                When you adjust the sliders, the app builds the PSF you describe
                (shown in the preview above) and inverts it in the frequency
                domain using Wiener or Tikhonov filtering. Plain inversion would
                amplify noise into garbage, so the <em>smooth</em> setting
                regularizes it. The high-quality mode goes further and minimizes a
                Total Variation prior — hundreds of gradient-descent iterations
                that favor clean edges and suppress ringing.
              </p>
              <p>
                <strong>Tip:</strong> slowly raise the radius. The image looks
                worse and worse — then snaps into focus when the radius matches
                the real blur. If you overshoot you&apos;ll see ghost ringing;
                back off until it disappears.
              </p>
              <p>
                Read the full theory in Vladimir Yuzhikov&apos;s articles:{' '}
                <a
                  href="https://yuzhikov.com/articles/BlurredImagesRestoration1.htm"
                  target="_blank"
                  rel="noreferrer"
                >
                  part 1 — theory
                </a>{' '}
                ·{' '}
                <a
                  href="https://yuzhikov.com/articles/BlurredImagesRestoration2.htm"
                  target="_blank"
                  rel="noreferrer"
                >
                  part 2 — practice
                </a>
              </p>
            </div>
          </details>

          <footer className="footer">
            By{' '}
            <a href="https://tn1ck.com" target="_blank" rel="noreferrer">
              Tom Nick
            </a>{' '}
            · based on{' '}
            <a href="https://github.com/y-vladimir/smartdeblur" target="_blank" rel="noreferrer">
              SmartDeblur
            </a>{' '}
            by Vladimir Yuzhikov · GPL-3.0
          </footer>
        </aside>
      </main>
    </div>
  )
}
