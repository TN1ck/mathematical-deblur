// SPDX-License-Identifier: GPL-3.0-or-later
//
// PSF (kernel) construction, ported from ImageUtils.cpp and
// DeconvolutionTool::buildKernel of SmartDeblur (C) Vladimir Yuzhikov.
// The original renders kernels into small QImages with an antialiased
// QPainter; here the same shapes are rasterized with subpixel coverage
// sampling, producing 0..255 grayscale values.

use crate::params::Blur;

const SUBSAMPLES: usize = 8; // 8x8 coverage samples per pixel

/// A small square grayscale kernel image, values 0..=255.
pub struct KernelImage {
    pub size: usize,
    pub pixels: Vec<u8>,
}

pub fn build_kernel_image(blur: &Blur) -> KernelImage {
    match *blur {
        Blur::Focus {
            radius,
            edge_feather,
            correction_strength,
        } => build_focus(radius, edge_feather, correction_strength),
        Blur::Motion { radius, angle } => build_motion(radius, angle),
        Blur::Gaussian { radius } => build_gaussian(radius),
    }
}

/// Out-of-focus blur: antialiased filled disc, with an optional Gaussian
/// edge ring ("feather"/"correction strength") added on top.
fn build_focus(radius: f64, edge_feather: f64, correction_strength: f64) -> KernelImage {
    // Double radius plus 2*3 pixels so the kernel fits inside the image
    let mut size = (2.0 * radius + 6.0) as i64;
    size += size % 2;
    let size = size as usize;
    let mut pixels = vec![0u8; size * size];

    // Antialiased filled circle centered at (0.5 + size/2, 0.5 + size/2)
    let c = 0.5 + size as f64 / 2.0;
    for y in 0..size {
        for x in 0..size {
            pixels[y * size + x] = (255.0 * disc_coverage(x, y, c, c, radius)) as u8;
        }
    }

    // Edge correction: add a ring of radius `radius`, Gaussian-blurred along
    // the radial direction, weighted against the plain disc.
    let center = (size / 2) as f64;
    for y in 0..size {
        for x in 0..size {
            let dist = ((x as f64 - center).powi(2) + (y as f64 - center).powi(2)).sqrt();
            if dist <= radius {
                let mu = radius;
                let sigma = radius * edge_feather / 100.0;
                let mut gauss_value = (-((dist - mu) / sigma).powi(2) / 2.0).exp();
                gauss_value *= 255.0 * correction_strength / 100.0;

                let mut cur_value = pixels[y * size + x] as i64;
                if correction_strength >= 0.0 {
                    cur_value = (cur_value as f64 * (100.0 - correction_strength) / 100.0) as i64;
                }
                cur_value = (cur_value as f64 + gauss_value) as i64;
                pixels[y * size + x] = cur_value.clamp(0, 255) as u8;
            }
        }
    }

    KernelImage { size, pixels }
}

/// Motion blur: antialiased line of length 2*radius at the given angle,
/// stroked with width 1.01 (matches the original's QPen workaround).
fn build_motion(radius: f64, angle: f64) -> KernelImage {
    let motion_length = radius * 2.0;
    let mut size = (motion_length + 6.0) as i64;
    size += size % 2;
    let size = size as usize;
    let mut pixels = vec![0u8; size * size];

    let center = 0.5 + (size / 2) as f64;
    let angle_rad = std::f64::consts::PI * angle / 180.0;
    let (dx, dy) = (
        motion_length * angle_rad.cos() / 2.0,
        motion_length * angle_rad.sin() / 2.0,
    );
    let (x1, y1, x2, y2) = (center - dx, center - dy, center + dx, center + dy);
    let half_width = 1.01 / 2.0;

    for y in 0..size {
        for x in 0..size {
            pixels[y * size + x] =
                (255.0 * stroke_coverage(x, y, x1, y1, x2, y2, half_width)) as u8;
        }
    }

    KernelImage { size, pixels }
}

/// Gaussian blur: analytic 2D Gaussian evaluated per pixel.
fn build_gaussian(radius: f64) -> KernelImage {
    let mut size = (3.5 * radius + 6.0) as i64;
    size += size % 2;
    let size = size as usize;
    let mut pixels = vec![0u8; size * size];

    let half = (size / 2) as f64;
    for y in 0..size {
        for x in 0..size {
            let value = 255.0
                * (-((x as f64 - half).powi(2) + (y as f64 - half).powi(2))
                    / (2.0 * radius * radius))
                    .exp();
            pixels[y * size + x] = (value as i64).clamp(0, 255) as u8;
        }
    }

    KernelImage { size, pixels }
}

/// Fraction of pixel (x, y) covered by the disc at (cx, cy) with `radius`.
fn disc_coverage(x: usize, y: usize, cx: f64, cy: f64, radius: f64) -> f64 {
    let r2 = radius * radius;
    let mut hits = 0usize;
    for sy in 0..SUBSAMPLES {
        for sx in 0..SUBSAMPLES {
            let px = x as f64 + (sx as f64 + 0.5) / SUBSAMPLES as f64;
            let py = y as f64 + (sy as f64 + 0.5) / SUBSAMPLES as f64;
            if (px - cx).powi(2) + (py - cy).powi(2) <= r2 {
                hits += 1;
            }
        }
    }
    hits as f64 / (SUBSAMPLES * SUBSAMPLES) as f64
}

/// Fraction of pixel (x, y) covered by a stroked segment of half-width `hw`.
fn stroke_coverage(x: usize, y: usize, x1: f64, y1: f64, x2: f64, y2: f64, hw: f64) -> f64 {
    let mut hits = 0usize;
    for sy in 0..SUBSAMPLES {
        for sx in 0..SUBSAMPLES {
            let px = x as f64 + (sx as f64 + 0.5) / SUBSAMPLES as f64;
            let py = y as f64 + (sy as f64 + 0.5) / SUBSAMPLES as f64;
            if dist_to_segment(px, py, x1, y1, x2, y2) <= hw {
                hits += 1;
            }
        }
    }
    hits as f64 / (SUBSAMPLES * SUBSAMPLES) as f64
}

fn dist_to_segment(px: f64, py: f64, x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
    let (vx, vy) = (x2 - x1, y2 - y1);
    let len2 = vx * vx + vy * vy;
    let t = if len2 > 0.0 {
        (((px - x1) * vx + (py - y1) * vy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (qx, qy) = (x1 + t * vx, y1 + t * vy);
    ((px - qx).powi(2) + (py - qy).powi(2)).sqrt()
}

/// Embed the small kernel image into a width*height matrix, normalize it,
/// and FFT-shift it (translate by width/2, height/2) — exact port of
/// DeconvolutionTool::buildKernel.
pub fn build_kernel_matrix(out_kernel: &mut [f64], width: usize, height: usize, blur: &Blur) {
    let kernel_image = build_kernel_image(blur);
    let size = kernel_image.size as i64;
    let (w, h) = (width as i64, height as i64);

    let mut temp = vec![0.0f64; width * height];
    let mut sum_elements = 0.0f64;
    for y in 0..h {
        for x in 0..w {
            let mut value = 0.0;
            // Inside the (small) kernel area take pixel values, otherwise keep 0
            if (x - w / 2).abs() < (size - 2) / 2 && (y - h / 2).abs() < (size - 2) / 2 {
                let x_local = x - (w - size) / 2;
                let y_local = y - (h - size) / 2;
                if x_local >= 0 && x_local < size && y_local >= 0 && y_local < size {
                    value = kernel_image.pixels[(y_local * size + x_local) as usize] as f64;
                }
            }
            temp[(y * w + x) as usize] = value;
            sum_elements += value.abs();
        }
    }

    // Zero-protection
    if sum_elements == 0.0 {
        sum_elements = 1.0;
    }

    // Normalize
    let k = 1.0 / sum_elements;
    for v in temp.iter_mut() {
        *v *= k;
    }

    // Translate kernel by width/2 left and height/2 up, since the FFT is
    // not centered
    for y in 0..height {
        for x in 0..width {
            let x_translated = (x + width / 2) % width;
            let y_translated = (y + height / 2) % height;
            out_kernel[y * width + x] = temp[y_translated * width + x_translated];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focus_kernel_is_symmetric_disc() {
        let img = build_kernel_image(&Blur::Focus {
            radius: 5.0,
            edge_feather: 10.0,
            correction_strength: 0.0,
        });
        assert_eq!(img.size, 16);
        // center pixel fully covered
        assert_eq!(img.pixels[8 * 16 + 8], 255);
        // corner empty
        assert_eq!(img.pixels[0], 0);
    }

    #[test]
    fn kernel_matrix_is_normalized() {
        let (w, h) = (64, 48);
        let mut m = vec![0.0; w * h];
        build_kernel_matrix(&mut m, w, h, &Blur::Gaussian { radius: 3.0 });
        let sum: f64 = m.iter().sum();
        assert!((sum - 1.0).abs() < 1e-9, "sum = {}", sum);
        // FFT-shifted: the peak must sit at the origin
        let max_idx = m
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap()
            .0;
        assert_eq!(max_idx, 0);
    }
}
