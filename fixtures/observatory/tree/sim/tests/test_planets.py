import math

import pytest

from observatory.ephemeris.planets import MEAN_ELEMENTS, eccentric_anomaly, heliocentric_xy
from observatory.ephemeris.timescale import J2000


def test_eccentric_anomaly_solves_keplers_equation():
    ecc = eccentric_anomaly(0.5, 0.6)
    assert ecc - 0.6 * math.sin(ecc) == pytest.approx(0.5, abs=1e-10)


@pytest.mark.parametrize("name", sorted(MEAN_ELEMENTS))
def test_each_planet_stays_between_perihelion_and_aphelion(name):
    a, e, _, _ = MEAN_ELEMENTS[name]
    for day in range(0, 4000, 97):
        x, y = heliocentric_xy(name, J2000 + day)
        r = math.hypot(x, y)
        assert a * (1 - e) - 1e-9 <= r <= a * (1 + e) + 1e-9
