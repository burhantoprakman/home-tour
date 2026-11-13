"""HDR (HLG / PQ, BT.2020) phone video -> SDR sRGB frames, in numpy.

The installed ffmpeg has no zscale/libplacebo, so ffmpeg only decodes, applies the BT.2020
YUV->RGB matrix and scales to 16-bit RGB PNGs. Here: inverse transfer -> linear light,
BT.2020 -> BT.709 gamut, one global exposure for the whole clip (so colours stay consistent
across views, which training needs), Reinhard on luminance, sRGB OETF -> 8-bit.
"""

from __future__ import annotations

import numpy as np

HDR_TRANSFERS = {"arib-std-b67": "hlg", "smpte2084": "pq"}

# BT.2100 HLG constants
_HLG_A = 0.17883277
_HLG_B = 1.0 - 4.0 * _HLG_A
_HLG_C = 0.5 - _HLG_A * np.log(4.0 * _HLG_A)

# SMPTE ST 2084 (PQ) constants
_PQ_M1 = 2610.0 / 16384.0
_PQ_M2 = 2523.0 / 4096.0 * 128.0
_PQ_C1 = 3424.0 / 4096.0
_PQ_C2 = 2413.0 / 4096.0 * 32.0
_PQ_C3 = 2392.0 / 4096.0 * 32.0

# Linear BT.2020 RGB -> linear BT.709 RGB (ITU-R BT.2087)
BT2020_TO_BT709 = np.array([
    [1.6605, -0.5876, -0.0728],
    [-0.1246, 1.1329, -0.0083],
    [-0.0182, -0.1006, 1.1187],
])
BT709_LUMA = np.array([0.2126, 0.7152, 0.0722])

TARGET_MEDIAN = 0.18  # mid-grey for the clip's median luminance
WHITE_POINT = 4.0  # exposed luminance that maps to display white


def hlg_inverse_oetf(e: np.ndarray) -> np.ndarray:
    """HLG signal [0,1] -> normalised scene-linear light [0,1] (BT.2100)."""
    e = np.clip(np.asarray(e, dtype=np.float64), 0.0, 1.0)
    low = e * e / 3.0
    high = (np.exp((e - _HLG_C) / _HLG_A) + _HLG_B) / 12.0
    return np.where(e <= 0.5, low, high)


def pq_eotf(e: np.ndarray) -> np.ndarray:
    """PQ signal [0,1] -> linear light, 1.0 = 10000 cd/m^2."""
    e = np.clip(np.asarray(e, dtype=np.float64), 0.0, 1.0)
    p = e ** (1.0 / _PQ_M2)
    return (np.maximum(p - _PQ_C1, 0.0) / (_PQ_C2 - _PQ_C3 * p)) ** (1.0 / _PQ_M1)


def srgb_oetf(x: np.ndarray) -> np.ndarray:
    x = np.clip(np.asarray(x, dtype=np.float64), 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1.0 / 2.4) - 0.055)


def to_linear_709(rgb_signal: np.ndarray, transfer: str) -> np.ndarray:
    """(..., 3) HDR signal in [0,1] (BT.2020 primaries) -> linear BT.709, negatives clipped."""
    lin = hlg_inverse_oetf(rgb_signal) if transfer == "hlg" else pq_eotf(rgb_signal)
    return np.maximum(np.einsum("...j,ij->...i", lin, BT2020_TO_BT709), 0.0)


def luminance(lin709: np.ndarray) -> np.ndarray:
    return np.einsum("...j,j->...", lin709, BT709_LUMA)


def exposure_for(median_luminance: float, target: float = TARGET_MEDIAN) -> float:
    return target / max(float(median_luminance), 1e-6)


def reinhard(lum: np.ndarray, white: float = WHITE_POINT) -> np.ndarray:
    """Extended Reinhard: maps `white` to 1, near-linear in the shadows."""
    lum = np.maximum(lum, 0.0)
    return lum * (1.0 + lum / (white * white)) / (1.0 + lum)


def tonemap_to_srgb8(lin709: np.ndarray, exposure: float, white: float = WHITE_POINT) -> np.ndarray:
    """Linear BT.709 (..., 3) -> 8-bit sRGB, tonemapping luminance and keeping hue."""
    x = lin709 * exposure
    lum = luminance(x)
    ratio = np.where(lum > 1e-9, reinhard(lum, white) / np.maximum(lum, 1e-9), 0.0)
    out = np.clip(x * ratio[..., None], 0.0, 1.0)
    return np.round(srgb_oetf(out) * 255.0).astype(np.uint8)
