"""The Moon's phase, from the mean synodic month."""

import math

from .timescale import J2000

SYNODIC_MONTH = 29.530588853
# A new moon close to J2000, as a Julian day.
NEW_MOON_JD = 2451550.1

PHASES = (
    "new moon",
    "waxing crescent",
    "first quarter",
    "waxing gibbous",
    "full moon",
    "waning gibbous",
    "last quarter",
    "waning crescent",
)


def age(jd):
    """Days since the last new moon at Julian day jd."""
    return (jd - NEW_MOON_JD) % SYNODIC_MONTH


def illumination(jd):
    """The lit fraction of the Moon's disc, from 0 at new moon to 1 at full moon."""
    return (1 - math.cos(2 * math.pi * age(jd) / SYNODIC_MONTH)) / 2


def phase_name(jd):
    eighth = int(age(jd) / SYNODIC_MONTH * 8 + 0.5) % 8
    return PHASES[eighth]


def lunations_since_j2000(jd):
    return (jd - J2000) / SYNODIC_MONTH
