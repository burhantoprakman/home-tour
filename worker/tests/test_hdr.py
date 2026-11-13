import numpy as np
import pytest

from pipeline.hdr import (BT2020_TO_BT709, WHITE_POINT, exposure_for, hlg_inverse_oetf, luminance, pq_eotf,
                          reinhard, srgb_oetf, to_linear_709, tonemap_to_srgb8)


@pytest.mark.parametrize("e,expected", [(0.0, 0.0), (0.25, 0.0625 / 3), (0.5, 1 / 12), (1.0, 1.0)])
def test_hlg_inverse_oetf_known_values(e, expected):
    assert hlg_inverse_oetf(e) == pytest.approx(expected, abs=1e-6)


def test_hlg_is_continuous_and_monotonic():
    x = np.linspace(0, 1, 2001)
    y = hlg_inverse_oetf(x)
    assert np.all(np.diff(y) > 0)
    assert hlg_inverse_oetf(0.5 + 1e-9) == pytest.approx(hlg_inverse_oetf(0.5), abs=1e-7)


@pytest.mark.parametrize("e,nits", [(0.0, 0.0), (1.0, 10000.0), (0.5081, 100.0), (0.7518, 1000.0)])
def test_pq_eotf_known_values(e, nits):
    assert pq_eotf(e) * 10000 == pytest.approx(nits, rel=2e-3, abs=1e-6)


@pytest.mark.parametrize("x,expected", [(0.0, 0.0), (0.0031308, 0.04045), (0.18, 0.46135), (1.0, 1.0)])
def test_srgb_oetf_known_values(x, expected):
    assert srgb_oetf(x) == pytest.approx(expected, abs=2e-4)


def test_gamut_matrix_keeps_white_and_clips_out_of_gamut():
    assert np.allclose(BT2020_TO_BT709.sum(axis=1), 1.0, atol=1e-3)
    white = to_linear_709(np.array([0.75, 0.75, 0.75]), "hlg")
    assert np.allclose(white, white[0], rtol=1e-3)
    red2020 = to_linear_709(np.array([0.75, 0.0, 0.0]), "hlg")
    assert red2020[0] > 0 and red2020[1] == 0 and red2020[2] == 0


def test_reinhard_maps_white_point_to_one():
    assert reinhard(np.array(WHITE_POINT)) == pytest.approx(1.0)
    assert reinhard(np.array(0.01)) == pytest.approx(0.01, rel=0.02)


def test_tonemap_puts_median_near_mid_grey_and_keeps_hue():
    rng = np.random.default_rng(0)
    lin = rng.uniform(0.0, 0.2, (64, 64, 3))
    lin[..., 2] *= 0.2  # warm cast
    exp = exposure_for(float(np.median(luminance(lin))))
    out = tonemap_to_srgb8(lin, exp)
    assert out.dtype == np.uint8
    g = srgb_oetf(reinhard(np.array(0.18)))
    assert np.median(luminance(out / 255.0)) == pytest.approx(g, abs=0.1)
    assert out[..., 0].mean() > out[..., 2].mean()  # warm stays warm
