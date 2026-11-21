"""Atmospheric refraction, which lifts stars near the horizon."""

import math


def refraction_arcmin(altitude):
    """Bennett's formula: how far the air lifts a star at this true altitude, in arcminutes."""
    if altitude < -1.0:
        return 0.0
    return 1.0 / math.tan(math.radians(altitude + 7.31 / (altitude + 4.4)))


def apparent_altitude(true_altitude):
    """Where a star at this true altitude appears, in degrees."""
    return true_altitude + refraction_arcmin(true_altitude) / 60.0
