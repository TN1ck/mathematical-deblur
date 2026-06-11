// SPDX-License-Identifier: GPL-3.0-or-later
//
// React bridge to the deconvolution worker. Preview requests are
// coalesced: while the worker is busy only the latest request is kept,
// so slider drags never queue up stale work.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeblurParams, Mode, WorkerRequest, WorkerResponse } from './types'

interface KernelImage {
  size: number
  pixels: Uint8ClampedArray
}

function createWorker() {
  return new Worker(new URL('./deblur.worker.ts', import.meta.url), { type: 'module' })
}

export function useDeblurEngine() {
  const [result, setResult] = useState<ImageData | null>(null)
  const [kernel, setKernel] = useState<KernelImage | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const workerRef = useRef<Worker | null>(null)
  const kernelWorkerRef = useRef<Worker | null>(null)
  const imageRef = useRef<ImageData | null>(null)
  const busyRef = useRef(false)
  const hqRunningRef = useRef(false)
  const pendingRef = useRef<{ params: DeblurParams; mode: Mode } | null>(null)
  const kernelBusyRef = useRef(false)
  const kernelPendingRef = useRef<DeblurParams | null>(null)
  const idRef = useRef(0)

  const handleMessage = useCallback((e: MessageEvent<WorkerResponse>) => {
    const msg = e.data
    switch (msg.type) {
      case 'result': {
        setResult(
          new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height),
        )
        busyRef.current = false
        hqRunningRef.current = false
        setProgress(null)
        const pending = pendingRef.current
        if (pending) {
          pendingRef.current = null
          sendDeconvolve(pending.params, pending.mode)
        } else {
          setBusy(false)
        }
        break
      }
      case 'progress':
        if (hqRunningRef.current) setProgress(msg.percent)
        break
      case 'imageSet':
        break
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleKernelMessage = useCallback((e: MessageEvent<WorkerResponse>) => {
    const msg = e.data
    if (msg.type !== 'kernel') return
    setKernel({ size: msg.size, pixels: new Uint8ClampedArray(msg.buffer) })
    kernelBusyRef.current = false
    const pending = kernelPendingRef.current
    if (pending) {
      kernelPendingRef.current = null
      sendKernelPreview(pending)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sendDeconvolve = useCallback(
    (params: DeblurParams, mode: Mode) => {
      const worker = workerRef.current
      if (!worker || !imageRef.current) return
      busyRef.current = true
      setBusy(true)
      hqRunningRef.current = mode === 2
      if (mode === 2) setProgress(0)
      const msg: WorkerRequest = { type: 'deconvolve', id: ++idRef.current, params, mode }
      worker.postMessage(msg)
    },
    [],
  )

  const sendKernelPreview = useCallback((params: DeblurParams) => {
    const worker = kernelWorkerRef.current
    if (!worker) return
    kernelBusyRef.current = true
    const msg: WorkerRequest = { type: 'kernelPreview', id: ++idRef.current, params }
    worker.postMessage(msg)
  }, [])

  useEffect(() => {
    const worker = createWorker()
    const kernelWorker = createWorker()
    worker.onmessage = handleMessage
    kernelWorker.onmessage = handleKernelMessage
    workerRef.current = worker
    kernelWorkerRef.current = kernelWorker
    // Fresh workers have no work in flight; clear any state left over
    // from a previous mount (StrictMode re-runs this effect)
    busyRef.current = false
    hqRunningRef.current = false
    kernelBusyRef.current = false
    const pendingDeconvolve = pendingRef.current
    const pendingKernel = kernelPendingRef.current
    pendingRef.current = null
    kernelPendingRef.current = null
    if (imageRef.current) {
      const image = imageRef.current
      const copy = new Uint8Array(image.data).buffer
      worker.postMessage(
        { type: 'setImage', width: image.width, height: image.height, buffer: copy },
        [copy],
      )
      if (pendingDeconvolve) sendDeconvolve(pendingDeconvolve.params, pendingDeconvolve.mode)
    }
    if (pendingKernel) sendKernelPreview(pendingKernel)
    return () => {
      worker.terminate()
      kernelWorker.terminate()
    }
  }, [handleMessage, handleKernelMessage, sendDeconvolve, sendKernelPreview])

  /** Load a new source image into the engine. */
  const setImage = useCallback((image: ImageData) => {
    imageRef.current = image
    setResult(null)
    pendingRef.current = null
    busyRef.current = false
    setBusy(false)
    const copy = new Uint8Array(image.data).buffer
    const msg: WorkerRequest = {
      type: 'setImage',
      width: image.width,
      height: image.height,
      buffer: copy,
    }
    workerRef.current?.postMessage(msg, [copy])
  }, [])

  /** Request a deconvolution; coalesced while the worker is busy. */
  const requestDeconvolve = useCallback(
    (params: DeblurParams, mode: Mode) => {
      if (!imageRef.current) return
      if (busyRef.current) {
        // A high-quality run in flight is never silently replaced by a preview
        if (hqRunningRef.current && mode !== 2) return
        pendingRef.current = { params, mode }
      } else {
        sendDeconvolve(params, mode)
      }
    },
    [sendDeconvolve],
  )

  const requestKernelPreview = useCallback(
    (params: DeblurParams) => {
      if (kernelBusyRef.current) {
        kernelPendingRef.current = params
      } else {
        sendKernelPreview(params)
      }
    },
    [sendKernelPreview],
  )

  /** Abort whatever the processing worker is doing (e.g. a long TV run). */
  const cancel = useCallback(() => {
    const worker = workerRef.current
    if (worker) {
      worker.terminate()
    }
    const fresh = createWorker()
    fresh.onmessage = handleMessage
    workerRef.current = fresh
    busyRef.current = false
    hqRunningRef.current = false
    pendingRef.current = null
    setBusy(false)
    setProgress(null)
    if (imageRef.current) {
      const image = imageRef.current
      const copy = new Uint8Array(image.data).buffer
      const msg: WorkerRequest = {
        type: 'setImage',
        width: image.width,
        height: image.height,
        buffer: copy,
      }
      fresh.postMessage(msg, [copy])
    }
  }, [handleMessage])

  return {
    result,
    kernel,
    progress,
    busy,
    setImage,
    requestDeconvolve,
    requestKernelPreview,
    cancel,
  }
}
