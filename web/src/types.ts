// SPDX-License-Identifier: GPL-3.0-or-later

export const BlurType = {
  Focus: 0,
  Motion: 1,
  Gaussian: 2,
} as const
export type BlurType = (typeof BlurType)[keyof typeof BlurType]

export const Mode = {
  PreviewGray: 0,
  PreviewColor: 1,
  HighQuality: 2,
} as const
export type Mode = (typeof Mode)[keyof typeof Mode]

export const PreviewMethod = {
  Wiener: 0,
  Tikhonov: 1,
} as const
export type PreviewMethod = (typeof PreviewMethod)[keyof typeof PreviewMethod]

export interface DeblurParams {
  blurType: BlurType
  /** Defect radius in pixels. For motion blur: half the motion length. */
  radius: number
  /** Smoothness / assumed PSNR, 1..99 */
  smooth: number
  /** Focus blur only: edge feather, 1..99 */
  edgeFeather: number
  /** Focus blur only: correction strength, -99..99 */
  correctionStrength: number
  /** Motion blur only: angle in degrees, -90..90 */
  angle: number
  previewMethod: PreviewMethod
  tvIterations: number
}

export const defaultParams: DeblurParams = {
  blurType: BlurType.Focus,
  radius: 5,
  smooth: 30,
  edgeFeather: 10,
  correctionStrength: 0,
  angle: 0,
  previewMethod: PreviewMethod.Wiener,
  tvIterations: 500,
}

export type WorkerRequest =
  | { type: 'setImage'; width: number; height: number; buffer: ArrayBuffer }
  | { type: 'deconvolve'; id: number; params: DeblurParams; mode: Mode }
  | { type: 'kernelPreview'; id: number; params: DeblurParams }

export type WorkerResponse =
  | { type: 'imageSet' }
  | { type: 'result'; id: number; width: number; height: number; buffer: ArrayBuffer }
  | { type: 'kernel'; id: number; size: number; buffer: ArrayBuffer }
  | { type: 'progress'; id: number; percent: number }
