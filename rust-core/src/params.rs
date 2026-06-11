// SPDX-License-Identifier: GPL-3.0-or-later
//
// Blur defect models, ported from src/Models of SmartDeblur
// (C) Vladimir Yuzhikov.

/// Blur defect model. `radius` semantics follow the original UI:
/// for motion blur it is half the motion length.
#[derive(Clone, Copy, Debug)]
pub enum Blur {
    Focus {
        radius: f64,
        edge_feather: f64,
        correction_strength: f64,
    },
    Motion {
        radius: f64,
        angle: f64,
    },
    Gaussian {
        radius: f64,
    },
}

impl Blur {
    pub fn radius(&self) -> f64 {
        match *self {
            Blur::Focus { radius, .. } => radius,
            Blur::Motion { radius, .. } => radius,
            Blur::Gaussian { radius } => radius,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    PreviewGray,
    PreviewColor,
    HighQuality,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewMethod {
    Wiener,
    Tikhonov,
}
