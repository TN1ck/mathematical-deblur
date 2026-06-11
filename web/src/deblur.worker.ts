// SPDX-License-Identifier: GPL-3.0-or-later
//
// Web worker hosting the WASM deconvolution engine, so that long
// FFT/TV runs never block the UI thread.

/// <reference lib="webworker" />
import init, { WasmDeconvolver, kernel_preview } from 'smartdeblur-core'
import type { WorkerRequest, WorkerResponse } from './types'

const ready = init()

let deconvolver: WasmDeconvolver | null = null
let imageWidth = 0
let imageHeight = 0

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer)
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  await ready
  const msg = e.data

  switch (msg.type) {
    case 'setImage': {
      deconvolver?.free()
      imageWidth = msg.width
      imageHeight = msg.height
      deconvolver = new WasmDeconvolver(msg.width, msg.height, new Uint8Array(msg.buffer))
      post({ type: 'imageSet' })
      break
    }

    case 'deconvolve': {
      if (!deconvolver) return
      const p = msg.params
      const out = deconvolver.deconvolve(
        p.blurType,
        p.radius,
        p.smooth,
        p.edgeFeather,
        p.correctionStrength,
        p.angle,
        msg.mode,
        p.previewMethod,
        p.tvIterations,
        (percent: number) => post({ type: 'progress', id: msg.id, percent }),
      )
      const buffer = out.buffer as ArrayBuffer
      post(
        { type: 'result', id: msg.id, width: imageWidth, height: imageHeight, buffer },
        [buffer],
      )
      break
    }

    case 'kernelPreview': {
      const p = msg.params
      const data = kernel_preview(
        p.blurType,
        p.radius,
        p.edgeFeather,
        p.correctionStrength,
        p.angle,
      )
      const size = data[0] | (data[1] << 8)
      const pixels = data.slice(2)
      const buffer = pixels.buffer as ArrayBuffer
      post({ type: 'kernel', id: msg.id, size, buffer }, [buffer])
      break
    }
  }
}
