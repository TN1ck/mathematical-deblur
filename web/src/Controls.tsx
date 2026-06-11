// SPDX-License-Identifier: GPL-3.0-or-later

import { BlurType, PreviewMethod, type DeblurParams } from './types'

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  display?: string
  onChange: (value: number) => void
  onCommit: () => void
}

function Slider({ label, value, min, max, step = 1, display, onChange, onCommit }: SliderProps) {
  return (
    <label className="slider">
      <span className="slider-label">
        {label}
        <span className="slider-value">{display ?? value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
    </label>
  )
}

interface ControlsProps {
  params: DeblurParams
  disabled: boolean
  /** Live update while dragging (fast gray preview). */
  onChange: (params: DeblurParams) => void
  /** Drag finished (full color preview). */
  onCommit: () => void
}

export function Controls({ params, disabled, onChange, onCommit }: ControlsProps) {
  const set = (patch: Partial<DeblurParams>) => onChange({ ...params, ...patch })

  return (
    <fieldset className="controls" disabled={disabled}>
      <label className="field">
        <span>Defect type</span>
        <select
          value={params.blurType}
          onChange={(e) => {
            set({ blurType: Number(e.target.value) as DeblurParams['blurType'] })
            onCommit()
          }}
        >
          <option value={BlurType.Focus}>Out of focus</option>
          <option value={BlurType.Motion}>Motion blur</option>
          <option value={BlurType.Gaussian}>Gaussian blur</option>
        </select>
      </label>

      {params.blurType === BlurType.Motion ? (
        <>
          <Slider
            label="Length"
            value={params.radius * 10}
            min={1}
            max={500}
            display={params.radius.toFixed(1)}
            onChange={(v) => set({ radius: v / 10 })}
            onCommit={onCommit}
          />
          <Slider
            label="Angle"
            value={params.angle}
            min={-90}
            max={90}
            display={`${params.angle}°`}
            onChange={(v) => set({ angle: v })}
            onCommit={onCommit}
          />
        </>
      ) : (
        <Slider
          label="Radius"
          value={params.radius * 10}
          min={1}
          max={500}
          display={params.radius.toFixed(1)}
          onChange={(v) => set({ radius: v / 10 })}
          onCommit={onCommit}
        />
      )}

      <Slider
        label="Smooth"
        value={params.smooth}
        min={1}
        max={99}
        display={`${params.smooth}%`}
        onChange={(v) => set({ smooth: v })}
        onCommit={onCommit}
      />

      {params.blurType === BlurType.Focus && (
        <>
          <Slider
            label="Edge feather"
            value={params.edgeFeather}
            min={1}
            max={99}
            display={`${params.edgeFeather}%`}
            onChange={(v) => set({ edgeFeather: v })}
            onCommit={onCommit}
          />
          <Slider
            label="Correction strength"
            value={params.correctionStrength}
            min={-99}
            max={99}
            display={`${params.correctionStrength}%`}
            onChange={(v) => set({ correctionStrength: v })}
            onCommit={onCommit}
          />
        </>
      )}

      <label className="field">
        <span>Preview method</span>
        <select
          value={params.previewMethod}
          onChange={(e) => {
            set({ previewMethod: Number(e.target.value) as DeblurParams['previewMethod'] })
            onCommit()
          }}
        >
          <option value={PreviewMethod.Wiener}>Wiener</option>
          <option value={PreviewMethod.Tikhonov}>Tikhonov</option>
        </select>
      </label>

      <label className="field">
        <span>TV iterations</span>
        <input
          type="number"
          min={10}
          max={5000}
          step={10}
          value={params.tvIterations}
          onChange={(e) => set({ tvIterations: Number(e.target.value) })}
        />
      </label>
    </fieldset>
  )
}
