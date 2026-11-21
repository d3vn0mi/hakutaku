import math

import pytest

from observatory.ephemeris import timescale
from observatory.ephemeris.planets import heliocentric_xy


def test_lists_the_planets(service):
    assert service.bodies() == ["Earth", "Jupiter", "Mars", "Mercury", "Saturn", "Venus"]


def test_answers_close_to_the_elements(service, equinox):
    x, y, z = service.where("Mars", equinox)
    jd = timescale.utc_to_tt(timescale.julian_day(equinox))
    ex, ey = heliocentric_xy("Mars", jd)
    assert (x, y, z) == pytest.approx((ex, ey, 0.0), abs=1e-6)


def test_keeps_a_table_that_still_covers_the_day(service, equinox):
    jd = timescale.julian_day(equinox)
    first = service.table_for("Venus", jd)
    assert service.table_for("Venus", jd + 1) is first


def test_builds_a_new_table_past_the_old_one(service, equinox):
    jd = timescale.julian_day(equinox)
    first = service.table_for("Venus", jd)
    assert service.table_for("Venus", jd + 100) is not first


def test_distance_stays_near_the_orbit(service, equinox):
    distance = service.distance("Earth", equinox)
    assert math.isclose(distance, 1.0, abs_tol=0.02)
