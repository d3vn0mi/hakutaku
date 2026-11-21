"""Visual magnitudes: how faint a star the eye can see, and how magnitudes add up."""

import math

# The faintest magnitude the eye reaches, by Bortle class: 1 is the darkest sky, 9 a city.
BORTLE_LIMITS = {1: 7.6, 2: 7.1, 3: 6.6, 4: 6.1, 5: 5.6, 6: 5.1, 7: 4.6, 8: 4.1, 9: 3.6}


def limiting_magnitude(bortle):
    return BORTLE_LIMITS[min(max(int(bortle), 1), 9)]


def flux_ratio(m1, m2):
    """How many times brighter a star of magnitude m1 is than one of magnitude m2."""
    return 10 ** (0.4 * (m2 - m1))


def combined_magnitude(magnitudes):
    """The magnitude of several stars seen as one point of light."""
    return -2.5 * math.log10(sum(10 ** (-0.4 * m) for m in magnitudes))
