"""From equatorial coordinates to an observer's altitude and azimuth."""

import math

from observatory.ephemeris.planets import heliocentric_xy
from observatory.ephemeris.timescale import J2000

# The tilt of Earth's axis to the ecliptic, and the ecliptic longitude of Earth's perihelion,
# in degrees, near J2000.
OBLIQUITY = 23.4393
EARTH_PERIHELION = 102.9373


def local_sidereal_degrees(jd, longitude):
    """Local mean sidereal time in degrees, at Julian day jd and an east longitude."""
    return (280.46061837 + 360.98564736629 * (jd - J2000) + longitude) % 360.0


def sun_ra_dec(jd):
    """The Sun's (right ascension, declination) in degrees at Julian day jd, seen from Earth:
    opposite Earth's place on its orbit, tilted from the ecliptic onto the equator."""
    x, y = heliocentric_xy("Earth", jd)
    longitude = math.atan2(y, x) + math.radians(EARTH_PERIHELION) + math.pi
    eps = math.radians(OBLIQUITY)
    ra = math.atan2(math.cos(eps) * math.sin(longitude), math.cos(longitude))
    dec = math.asin(math.sin(eps) * math.sin(longitude))
    return math.degrees(ra) % 360.0, math.degrees(dec)


def altitude_azimuth(ra, dec, latitude, lst):
    """(altitude, azimuth) in degrees of a star at (ra, dec), for a latitude and local
    sidereal time, all in degrees. Azimuth runs from north through east."""
    ha = math.radians((lst - ra) % 360.0)
    dec_r = math.radians(dec)
    lat_r = math.radians(latitude)
    sin_alt = math.sin(dec_r) * math.sin(lat_r) + math.cos(dec_r) * math.cos(lat_r) * math.cos(ha)
    alt = math.asin(max(-1.0, min(1.0, sin_alt)))
    cos_az = (math.sin(dec_r) - math.sin(alt) * math.sin(lat_r)) / (math.cos(alt) * math.cos(lat_r))
    az = math.degrees(math.acos(max(-1.0, min(1.0, cos_az))))
    return math.degrees(alt), (360.0 - az if math.sin(ha) > 0 else az) % 360.0
