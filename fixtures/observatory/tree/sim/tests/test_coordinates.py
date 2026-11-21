import pytest

from observatory.sky.coordinates import altitude_azimuth, local_sidereal_degrees


def test_a_star_on_the_meridian_at_the_zenith():
    alt, _ = altitude_azimuth(ra=100.0, dec=51.5, latitude=51.5, lst=100.0)
    assert alt == pytest.approx(90.0)


def test_the_celestial_pole_sits_at_the_observers_latitude():
    alt, az = altitude_azimuth(ra=0.0, dec=90.0, latitude=40.0, lst=123.0)
    assert alt == pytest.approx(40.0)
    assert az == pytest.approx(0.0, abs=1e-6)


def test_sidereal_time_is_in_one_turn():
    lst = local_sidereal_degrees(2461285.0, -0.13)
    assert 0.0 <= lst < 360.0
