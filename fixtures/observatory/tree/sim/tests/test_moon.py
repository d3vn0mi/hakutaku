import pytest

from observatory.ephemeris.moon import NEW_MOON_JD, SYNODIC_MONTH, age, illumination, phase_name


def test_new_moon_is_dark():
    assert age(NEW_MOON_JD) == pytest.approx(0.0)
    assert illumination(NEW_MOON_JD) == pytest.approx(0.0)
    assert phase_name(NEW_MOON_JD) == "new moon"


def test_full_moon_half_a_month_later():
    full = NEW_MOON_JD + SYNODIC_MONTH / 2
    assert illumination(full) == pytest.approx(1.0)
    assert phase_name(full) == "full moon"


def test_first_quarter_is_half_lit():
    assert illumination(NEW_MOON_JD + SYNODIC_MONTH / 4) == pytest.approx(0.5)
