// SPDX-License-Identifier: GPL-3.0-or-later
//
// Deconvolution engine: Wiener, Tikhonov, and Total Variation prior,
// all operating in the frequency domain. Ported from
// DeconvolutionTool.cpp of SmartDeblur (C) Vladimir Yuzhikov.

use crate::fft2d::Fft2d;
use crate::kernel::build_kernel_matrix;
use crate::params::{Blur, Mode, PreviewMethod};
use rustfft::num_complex::Complex;

#[derive(Clone, Copy)]
enum Channel {
    Red,
    Green,
    Blue,
    Gray,
}

pub struct Deconvolver {
    width: usize,
    height: usize,
    fft: Fft2d,
    input_rgba: Vec<u8>,
    output_rgba: Vec<u8>,
    input_matrix: Vec<f64>,
    output_matrix: Vec<f64>,
    kernel_matrix: Vec<f64>,
    laplacian_matrix: Vec<f64>,
    out_laplacian_matrix: Vec<f64>,
    input_fft: Vec<Complex<f64>>,
    kernel_fft: Vec<Complex<f64>>,
    kernel_temp_fft: Vec<Complex<f64>>,
    laplacian_fft: Vec<Complex<f64>>,
    pub tv_iterations: usize,
}

impl Deconvolver {
    /// `rgba` is the input image, 4 bytes per pixel, row-major.
    pub fn new(width: usize, height: usize, rgba: Vec<u8>) -> Self {
        assert_eq!(rgba.len(), width * height * 4);
        let fft = Fft2d::new(width, height);
        let n = width * height;
        let nc = fft.complex_len();
        Deconvolver {
            width,
            height,
            fft,
            output_rgba: vec![255; n * 4],
            input_rgba: rgba,
            input_matrix: vec![0.0; n],
            output_matrix: vec![0.0; n],
            kernel_matrix: vec![0.0; n],
            laplacian_matrix: vec![0.0; n],
            out_laplacian_matrix: vec![0.0; n],
            input_fft: vec![Complex::default(); nc],
            kernel_fft: vec![Complex::default(); nc],
            kernel_temp_fft: vec![Complex::default(); nc],
            laplacian_fft: vec![Complex::default(); nc],
            tv_iterations: 500,
        }
    }

    /// Run deconvolution and return the result as RGBA bytes.
    /// `progress` receives 0..=100 as the work advances.
    pub fn deconvolve(
        &mut self,
        blur: &Blur,
        mode: Mode,
        preview_method: PreviewMethod,
        smooth: f64,
        progress: &mut dyn FnMut(u32),
    ) -> &[u8] {
        // Build kernel and its FFT once; it is shared by all channels
        build_kernel_matrix(&mut self.kernel_matrix, self.width, self.height, blur);
        self.fft.forward(&self.kernel_matrix, &mut self.kernel_fft);

        if mode == Mode::PreviewGray {
            self.deconvolve_channel(blur, mode, preview_method, smooth, Channel::Gray, &mut |p| {
                progress(p)
            });
        } else {
            let channels = [Channel::Red, Channel::Green, Channel::Blue];
            for (i, channel) in channels.into_iter().enumerate() {
                let base = (i as u32) * 100 / 3;
                self.deconvolve_channel(blur, mode, preview_method, smooth, channel, &mut |p| {
                    progress(base + p / 3)
                });
            }
        }
        progress(100);
        &self.output_rgba
    }

    fn deconvolve_channel(
        &mut self,
        blur: &Blur,
        mode: Mode,
        preview_method: PreviewMethod,
        smooth: f64,
        channel: Channel,
        progress: &mut dyn FnMut(u32),
    ) {
        let blur_radius = blur.radius();
        let (width, height) = (self.width, self.height);

        // Read the given channel into the working matrix
        self.fill_matrix_from_image(channel);
        self.fft.forward(&self.input_matrix, &mut self.input_fft);

        // Borders processing to prevent the ringing effect: convolve the
        // image with the kernel and substitute a band of `blur_radius`
        // pixels around the borders with the blurred version.
        multiply_real_ffts(&mut self.input_fft, &self.kernel_fft);
        self.fft.inverse(&mut self.input_fft, &mut self.output_matrix);
        let n = (width * height) as f64;
        for y in 0..height {
            for x in 0..width {
                let index = y * width + x;
                if (x as f64) < blur_radius
                    || (y as f64) < blur_radius
                    || (x as f64) > width as f64 - blur_radius
                    || (y as f64) > height as f64 - blur_radius
                {
                    self.input_matrix[index] = self.output_matrix[index] / n;
                }
            }
        }

        if mode != Mode::HighQuality {
            // Deconvolution in the frequency domain
            self.fft.forward(&self.input_matrix, &mut self.input_fft);
            match preview_method {
                PreviewMethod::Wiener => self.wiener(smooth),
                PreviewMethod::Tikhonov => self.tikhonov(smooth),
            }
            // Back to the spatial domain
            self.fft.inverse(&mut self.input_fft, &mut self.output_matrix);
        } else {
            self.total_variation(smooth, progress);
        }

        self.fill_image_from_matrix(channel);
    }

    /// Wiener filter: F = conj-free simplified form Re(H) / (|H|^2 + K),
    /// where K is derived from the "smooth" (PSNR) slider.
    fn wiener(&mut self, smooth: f64) {
        let k = 1.07f64.powf(smooth) / 10000.0;
        for (v, kf) in self.input_fft.iter_mut().zip(self.kernel_fft.iter()) {
            let energy = kf.re * kf.re + kf.im * kf.im;
            let wiener_value = kf.re / (energy + k);
            v.re *= wiener_value;
            v.im *= wiener_value;
        }
    }

    /// Tikhonov regularization: like Wiener, but the penalty is weighted by
    /// the spectrum of the discrete Laplacian, smoothing only where the
    /// image is smooth.
    fn tikhonov(&mut self, smooth: f64) {
        let (width, height) = (self.width, self.height);

        // Discrete Laplacian with wrap-around at the origin
        self.laplacian_matrix.fill(0.0);
        self.laplacian_matrix[0] = 4.0;
        self.laplacian_matrix[1] = -1.0;
        self.laplacian_matrix[width] = -1.0;
        self.laplacian_matrix[width - 1] = -1.0;
        self.laplacian_matrix[(height - 1) * width] = -1.0;
        self.fft
            .forward(&self.laplacian_matrix, &mut self.laplacian_fft);

        let k = 1.07f64.powf(smooth) / 1000.0;
        for ((v, kf), lf) in self
            .input_fft
            .iter_mut()
            .zip(self.kernel_fft.iter())
            .zip(self.laplacian_fft.iter())
        {
            let energy = kf.re * kf.re + kf.im * kf.im;
            let energy_laplacian = lf.re * lf.re + lf.im * lf.im;
            let tikhonov_value = kf.re / (energy + k * energy_laplacian);
            v.re *= tikhonov_value;
            v.im *= tikhonov_value;
        }
    }

    /// Total Variation prior, minimized by gradient descent:
    ///   f_{n+1} = f_n - tau * (h*(h*f - y) + lambda * div(grad f / |grad f|))
    /// The two convolutions are precomputed: h*h once, y*h once.
    fn total_variation(&mut self, smooth: f64, progress: &mut dyn FnMut(u32)) {
        let (width, height) = (self.width, self.height);
        let mut gradient_x = vec![0.0f64; width * height];
        let mut gradient_y = vec![0.0f64; width * height];
        let mut f_tv = vec![0.0f64; width * height];

        let k = 1.0 / (width * height) as f64;
        let k2 = (width * height) as f64;

        self.kernel_temp_fft.copy_from_slice(&self.kernel_fft);

        let epsilon = 0.004;
        let lambda = 1.07f64.powf(smooth) / 100000.0;
        let tau = 1.9 / (1.0 + lambda * 8.0 / epsilon);

        // Pre-multiply: h*(h*f-y) = h*h*f - y*h, so h*h and y*h are
        // precalculated.
        // 1. y*h convolution via FFT
        for index in 0..width * height {
            f_tv[index] = self.input_matrix[index] / 255.0;
            self.laplacian_matrix[index] = f_tv[index];
        }
        self.fft
            .forward(&self.laplacian_matrix, &mut self.laplacian_fft);
        multiply_real_ffts(&mut self.laplacian_fft, &self.kernel_temp_fft);
        self.fft
            .inverse(&mut self.laplacian_fft, &mut self.out_laplacian_matrix);
        for index in 0..width * height {
            self.input_matrix[index] = self.out_laplacian_matrix[index] * k;
        }

        // 2. h*h
        square_real_fft(&mut self.kernel_temp_fft);

        // Iterative gradient descent
        let total_iterations = self.tv_iterations;
        let mut niter = total_iterations;
        while niter > 0 {
            if niter % 10 == 0 {
                progress((100 * (total_iterations - niter) / total_iterations) as u32);
            }

            // f_tv * (h*h) convolution via FFT
            self.laplacian_matrix.copy_from_slice(&f_tv);
            self.fft
                .forward(&self.laplacian_matrix, &mut self.laplacian_fft);
            multiply_real_ffts(&mut self.laplacian_fft, &self.kernel_temp_fft);
            self.fft
                .inverse(&mut self.laplacian_fft, &mut self.out_laplacian_matrix);

            let epsilon_pow2 = epsilon * epsilon;
            for y in 0..height {
                for x in 0..width {
                    let index = y * width + x;
                    // Build gradient (forward differences)
                    let cur_value = f_tv[index];
                    let mut gy = if y < height - 1 {
                        f_tv[index + width] - cur_value
                    } else {
                        0.0
                    };
                    let mut gx = if x < width - 1 {
                        f_tv[index + 1] - cur_value
                    } else {
                        0.0
                    };

                    // Normalize: d = grad f / sqrt(eps^2 + |grad f|^2)
                    let k_value = 1.0 / (epsilon_pow2 + gy * gy + gx * gx).sqrt();
                    gy *= k_value;
                    gx *= k_value;
                    gradient_y[index] = gy;
                    gradient_x[index] = gx;

                    // Divergence (backward differences)
                    let mut divergence_value = 0.0;
                    if y > 0 && x > 0 {
                        let fx = gy - gradient_y[index - width];
                        let fy = gx - gradient_x[index - 1];
                        divergence_value = -(fx + fy);
                    }

                    // Gradient descent step
                    f_tv[index] -= tau
                        * (self.out_laplacian_matrix[index] * k - self.input_matrix[index]
                            + lambda * divergence_value);
                    if niter == 1 {
                        let f_tv_value = (255.0 * f_tv[index]).clamp(0.0, 255.0);
                        self.output_matrix[index] = k2 * f_tv_value;
                    }
                }
            }

            niter -= 1;
        }
    }

    fn fill_matrix_from_image(&mut self, channel: Channel) {
        for (i, px) in self.input_rgba.chunks_exact(4).enumerate() {
            let (r, g, b) = (px[0] as i32, px[1] as i32, px[2] as i32);
            let value = match channel {
                Channel::Red => r,
                Channel::Green => g,
                Channel::Blue => b,
                // qGray: (r*11 + g*16 + b*5) / 32
                Channel::Gray => (r * 11 + g * 16 + b * 5) / 32,
            };
            self.input_matrix[i] = value as f64;
        }
    }

    fn fill_image_from_matrix(&mut self, channel: Channel) {
        let k = 1.0 / (self.width * self.height) as f64;
        for (i, px) in self.output_rgba.chunks_exact_mut(4).enumerate() {
            let value = (k * self.output_matrix[i]).clamp(0.0, 255.0) as u8;
            match channel {
                Channel::Red => {
                    px[0] = value;
                    px[1] = 0;
                    px[2] = 0;
                }
                Channel::Green => px[1] = value,
                Channel::Blue => px[2] = value,
                Channel::Gray => {
                    px[0] = value;
                    px[1] = value;
                    px[2] = value;
                }
            }
            px[3] = 255;
        }
    }
}

/// Multiply a spectrum elementwise by the *real part* of the kernel
/// spectrum. The shifted, symmetric kernel has (nearly) real spectrum,
/// which the original exploits — exact port of multiplayRealFFTs.
fn multiply_real_ffts(out_fft: &mut [Complex<f64>], kernel_fft: &[Complex<f64>]) {
    for (v, kf) in out_fft.iter_mut().zip(kernel_fft.iter()) {
        v.re *= kf.re;
        v.im *= kf.re;
    }
}

/// multiplayRealFFTs(a, a): re' = re*re, im' = im*re.
fn square_real_fft(fft: &mut [Complex<f64>]) {
    for v in fft.iter_mut() {
        let value = v.re;
        v.re *= value;
        v.im *= value;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Blur a synthetic image with a Gaussian PSF, deconvolve with Wiener,
    /// and check that the result is closer to the original than the
    /// blurred input was.
    #[test]
    fn wiener_recovers_blurred_image() {
        let (w, h) = (64, 64);

        // Synthetic image: white square on gray background
        let mut original = vec![64.0f64; w * h];
        for y in 20..44 {
            for x in 20..44 {
                original[y * w + x] = 220.0;
            }
        }

        // Blur it through the same kernel machinery
        let blur = Blur::Gaussian { radius: 2.0 };
        let mut kernel = vec![0.0; w * h];
        build_kernel_matrix(&mut kernel, w, h, &blur);
        let mut fft = Fft2d::new(w, h);
        let mut kernel_fft = vec![Complex::default(); fft.complex_len()];
        let mut img_fft = vec![Complex::default(); fft.complex_len()];
        fft.forward(&kernel, &mut kernel_fft);
        fft.forward(&original, &mut img_fft);
        for (v, kf) in img_fft.iter_mut().zip(kernel_fft.iter()) {
            let t = *v;
            v.re = t.re * kf.re - t.im * kf.im;
            v.im = t.re * kf.im + t.im * kf.re;
        }
        let mut blurred = vec![0.0; w * h];
        fft.inverse(&mut img_fft, &mut blurred);
        let n = (w * h) as f64;
        for v in blurred.iter_mut() {
            *v = (*v / n).clamp(0.0, 255.0);
        }

        // Pack blurred image into RGBA and deconvolve (gray preview, Wiener)
        let mut rgba = vec![255u8; w * h * 4];
        for i in 0..w * h {
            let v = blurred[i] as u8;
            rgba[i * 4] = v;
            rgba[i * 4 + 1] = v;
            rgba[i * 4 + 2] = v;
        }
        let mut d = Deconvolver::new(w, h, rgba);
        let out = d
            .deconvolve(&blur, Mode::PreviewGray, PreviewMethod::Wiener, 30.0, &mut |_| {})
            .to_vec();

        let mse = |img: &dyn Fn(usize) -> f64| -> f64 {
            // Compare in the interior to ignore border effects
            let mut acc = 0.0;
            let mut count = 0.0;
            for y in 8..h - 8 {
                for x in 8..w - 8 {
                    let i = y * w + x;
                    acc += (img(i) - original[i]).powi(2);
                    count += 1.0;
                }
            }
            acc / count
        };
        let mse_blurred = mse(&|i| blurred[i]);
        let mse_restored = mse(&|i| out[i * 4] as f64);
        assert!(
            mse_restored < mse_blurred * 0.5,
            "restored mse {} vs blurred mse {}",
            mse_restored,
            mse_blurred
        );
    }
}
