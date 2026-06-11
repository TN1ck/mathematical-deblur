// SPDX-License-Identifier: GPL-3.0-or-later
//
// 2D real-to-complex FFT with the same layout and (un)normalization
// conventions as FFTW's fftw_plan_dft_r2c_2d / fftw_plan_dft_c2r_2d,
// which the original SmartDeblur (C) Vladimir Yuzhikov relies on:
//   - real input is height x width, row-major
//   - complex half-spectrum is height x (width/2 + 1), row-major
//   - forward followed by inverse scales the data by width * height

use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;

pub struct Fft2d {
    width: usize,
    height: usize,
    half_width: usize,
    row_r2c: Arc<dyn RealToComplex<f64>>,
    row_c2r: Arc<dyn ComplexToReal<f64>>,
    col_forward: Arc<dyn Fft<f64>>,
    col_inverse: Arc<dyn Fft<f64>>,
    row_real: Vec<f64>,
    row_complex: Vec<Complex<f64>>,
    col_buf: Vec<Complex<f64>>,
    scratch_fwd: Vec<Complex<f64>>,
    scratch_inv: Vec<Complex<f64>>,
    scratch_col: Vec<Complex<f64>>,
}

impl Fft2d {
    pub fn new(width: usize, height: usize) -> Self {
        let mut real_planner = RealFftPlanner::<f64>::new();
        let mut planner = FftPlanner::<f64>::new();
        let row_r2c = real_planner.plan_fft_forward(width);
        let row_c2r = real_planner.plan_fft_inverse(width);
        let col_forward = planner.plan_fft_forward(height);
        let col_inverse = planner.plan_fft_inverse(height);
        let scratch_fwd = vec![Complex::default(); row_r2c.get_scratch_len()];
        let scratch_inv = vec![Complex::default(); row_c2r.get_scratch_len()];
        let scratch_col_len = col_forward
            .get_inplace_scratch_len()
            .max(col_inverse.get_inplace_scratch_len());
        Fft2d {
            width,
            height,
            half_width: width / 2 + 1,
            row_r2c,
            row_c2r,
            col_forward,
            col_inverse,
            row_real: vec![0.0; width],
            row_complex: vec![Complex::default(); width / 2 + 1],
            col_buf: vec![Complex::default(); height],
            scratch_fwd,
            scratch_inv,
            scratch_col: vec![Complex::default(); scratch_col_len],
        }
    }

    pub fn complex_len(&self) -> usize {
        self.half_width * self.height
    }

    /// Forward transform: real `input` (height*width) -> half-spectrum
    /// `output` (height*(width/2+1)). Unnormalized, like FFTW.
    pub fn forward(&mut self, input: &[f64], output: &mut [Complex<f64>]) {
        let hw = self.half_width;
        for y in 0..self.height {
            self.row_real
                .copy_from_slice(&input[y * self.width..(y + 1) * self.width]);
            self.row_r2c
                .process_with_scratch(
                    &mut self.row_real,
                    &mut output[y * hw..(y + 1) * hw],
                    &mut self.scratch_fwd,
                )
                .expect("row r2c failed");
        }
        for x in 0..hw {
            for y in 0..self.height {
                self.col_buf[y] = output[y * hw + x];
            }
            self.col_forward
                .process_with_scratch(&mut self.col_buf, &mut self.scratch_col);
            for y in 0..self.height {
                output[y * hw + x] = self.col_buf[y];
            }
        }
    }

    /// Inverse transform: half-spectrum `input` (height*(width/2+1)) ->
    /// real `output` (height*width). Unnormalized: carries a factor of
    /// width*height, like FFTW's c2r. `input` is used as scratch.
    pub fn inverse(&mut self, input: &mut [Complex<f64>], output: &mut [f64]) {
        let hw = self.half_width;
        for x in 0..hw {
            for y in 0..self.height {
                self.col_buf[y] = input[y * hw + x];
            }
            self.col_inverse
                .process_with_scratch(&mut self.col_buf, &mut self.scratch_col);
            for y in 0..self.height {
                input[y * hw + x] = self.col_buf[y];
            }
        }
        for y in 0..self.height {
            self.row_complex.copy_from_slice(&input[y * hw..(y + 1) * hw]);
            // realfft requires the imaginary parts of the DC and Nyquist bins
            // to be exactly zero; filtering leaves only numerical noise there.
            self.row_complex[0].im = 0.0;
            if self.width % 2 == 0 {
                self.row_complex[hw - 1].im = 0.0;
            }
            self.row_c2r
                .process_with_scratch(
                    &mut self.row_complex,
                    &mut output[y * self.width..(y + 1) * self.width],
                    &mut self.scratch_inv,
                )
                .expect("row c2r failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_scales_by_n() {
        let (w, h) = (16, 12);
        let mut fft = Fft2d::new(w, h);
        let input: Vec<f64> = (0..w * h).map(|i| ((i * 7919) % 256) as f64).collect();
        let mut spectrum = vec![Complex::default(); fft.complex_len()];
        let mut output = vec![0.0; w * h];
        fft.forward(&input, &mut spectrum);
        fft.inverse(&mut spectrum, &mut output);
        let n = (w * h) as f64;
        for (a, b) in input.iter().zip(output.iter()) {
            assert!((a - b / n).abs() < 1e-9, "{} vs {}", a, b / n);
        }
    }

    #[test]
    fn delta_has_flat_spectrum() {
        let (w, h) = (8, 8);
        let mut fft = Fft2d::new(w, h);
        let mut input = vec![0.0; w * h];
        input[0] = 1.0;
        let mut spectrum = vec![Complex::default(); fft.complex_len()];
        fft.forward(&input, &mut spectrum);
        for c in &spectrum {
            assert!((c.re - 1.0).abs() < 1e-12 && c.im.abs() < 1e-12);
        }
    }
}
