// SPDX-License-Identifier: GPL-3.0-or-later
//
// smartdeblur-core: blind deconvolution (Wiener / Tikhonov / Total
// Variation prior) compiled to WebAssembly.
//
// This is a Rust port of the image-restoration core of SmartDeblur 1.27,
// Copyright (C) Vladimir Yuzhikov (yuvladimir@gmail.com),
// https://github.com/y-vladimir/smartdeblur — licensed under GPL v3.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

mod deconvolution;
mod fft2d;
mod kernel;
mod params;

use params::{Blur, Mode, PreviewMethod};
use wasm_bindgen::prelude::*;

fn blur_from_args(
    blur_type: u32,
    radius: f64,
    edge_feather: f64,
    correction_strength: f64,
    angle: f64,
) -> Blur {
    match blur_type {
        1 => Blur::Motion { radius, angle },
        2 => Blur::Gaussian { radius },
        _ => Blur::Focus {
            radius,
            edge_feather,
            correction_strength,
        },
    }
}

/// Stateful deconvolver bound to one input image. Reuse it across
/// parameter changes: FFT plans and buffers are allocated once.
#[wasm_bindgen]
pub struct WasmDeconvolver {
    inner: deconvolution::Deconvolver,
}

#[wasm_bindgen]
impl WasmDeconvolver {
    /// `rgba` must be width*height*4 bytes (e.g. from canvas ImageData).
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, rgba: Vec<u8>) -> WasmDeconvolver {
        WasmDeconvolver {
            inner: deconvolution::Deconvolver::new(width as usize, height as usize, rgba),
        }
    }

    /// Run deconvolution. Returns RGBA bytes of the restored image.
    ///
    /// blur_type: 0 = out-of-focus, 1 = motion, 2 = gaussian
    /// mode: 0 = gray preview, 1 = color preview, 2 = high quality (TV)
    /// preview_method: 0 = Wiener, 1 = Tikhonov
    /// on_progress: optional JS callback receiving 0..=100
    #[allow(clippy::too_many_arguments)]
    pub fn deconvolve(
        &mut self,
        blur_type: u32,
        radius: f64,
        smooth: f64,
        edge_feather: f64,
        correction_strength: f64,
        angle: f64,
        mode: u32,
        preview_method: u32,
        tv_iterations: u32,
        on_progress: Option<js_sys::Function>,
    ) -> Vec<u8> {
        let blur = blur_from_args(blur_type, radius, edge_feather, correction_strength, angle);
        let mode = match mode {
            1 => Mode::PreviewColor,
            2 => Mode::HighQuality,
            _ => Mode::PreviewGray,
        };
        let method = if preview_method == 1 {
            PreviewMethod::Tikhonov
        } else {
            PreviewMethod::Wiener
        };
        self.inner.tv_iterations = tv_iterations.max(1) as usize;

        let mut report = |p: u32| {
            if let Some(cb) = &on_progress {
                let _ = cb.call1(&JsValue::NULL, &JsValue::from(p));
            }
        };
        self.inner
            .deconvolve(&blur, mode, method, smooth, &mut report)
            .to_vec()
    }
}

/// Render the PSF kernel as a small grayscale image for UI preview.
/// Returns [size, pixel0, pixel1, ...] — a size*size block of 0..255
/// values prefixed with the side length.
#[wasm_bindgen]
pub fn kernel_preview(
    blur_type: u32,
    radius: f64,
    edge_feather: f64,
    correction_strength: f64,
    angle: f64,
) -> Vec<u8> {
    let blur = blur_from_args(blur_type, radius, edge_feather, correction_strength, angle);
    let image = kernel::build_kernel_image(&blur);
    let mut out = Vec::with_capacity(image.pixels.len() + 2);
    out.push((image.size & 0xff) as u8);
    out.push((image.size >> 8) as u8);
    out.extend_from_slice(&image.pixels);
    out
}
