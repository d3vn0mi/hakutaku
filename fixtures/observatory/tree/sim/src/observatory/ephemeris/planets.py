"""Heliocentric places of the planets, from their mean elements at J2000."""

import math

from .timescale import J2000

# name: (semi-major axis in AU, eccentricity, sidereal period in days, mean anomaly at J2000
# in degrees)
MEAN_ELEMENTS = {
    "Mercury": (0.387098, 0.205630, 87.969, 174.796),
    "Venus": (0.723332, 0.006772, 224.701, 50.115),
    "Earth": (1.000001, 0.016709, 365.256, 358.617),
    "Mars": (1.523679, 0.093400, 686.980, 19.373),
    "Jupiter": (5.204400, 0.048900, 4332.590, 20.020),
    "Saturn": (9.582600, 0.056500, 10759.220, 317.020),
}


def eccentric_anomaly(mean, e, tolerance=1e-12):
    """Solves Kepler's equation, M = E - e sin E, for E by Newton's method."""
    ecc = mean if e < 0.8 else math.pi
    for _ in range(32):
        delta = (ecc - e * math.sin(ecc) - mean) / (1 - e * math.cos(ecc))
        ecc -= delta
        if abs(delta) < tolerance:
            break
    return ecc


def heliocentric_xy(name, jd):
    """A planet's (x, y) in AU, in the plane of its orbit, at Julian day jd."""
    a, e, period, m0 = MEAN_ELEMENTS[name]
    mean = (math.radians(m0) + 2 * math.pi * (jd - J2000) / period) % (2 * math.pi)
    ecc = eccentric_anomaly(mean, e)
    return a * (math.cos(ecc) - e), a * math.sqrt(1 - e * e) * math.sin(ecc)
