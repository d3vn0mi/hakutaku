import pytest

from observatory.sky.refraction import apparent_altitude, refraction_arcmin


def test_about_half_a_degree_at_the_horizon():
    assert refraction_arcmin(0.0) == pytest.approx(34.5, abs=0.5)


def test_almost_nothing_overhead():
    assert refraction_arcmin(90.0) == pytest.approx(0.0, abs=0.01)


def test_stars_appear_higher_than_they_are():
    assert apparent_altitude(10.0) > 10.0
