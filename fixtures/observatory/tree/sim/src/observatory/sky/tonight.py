"""Tonight's sky for an observer: how dark it is, and which bright stars are up."""

from observatory.catalog.loader import CatalogView
from observatory.ephemeris.timescale import julian_day
from observatory.sky.coordinates import altitude_azimuth, local_sidereal_degrees, sun_ra_dec
from observatory.sky.refraction import apparent_altitude
from observatory.sky.twilight import twilight_phase


def tonight(latitude, longitude, moment, bortle=4):
    """The twilight phase at an aware datetime, and the bright stars above the horizon then,
    highest first, as (name, apparent altitude, azimuth) in degrees."""
    jd = julian_day(moment)
    lst = local_sidereal_degrees(jd, longitude)
    sun_ra, sun_dec = sun_ra_dec(jd)
    sun_altitude, _ = altitude_azimuth(sun_ra, sun_dec, latitude, lst)
    stars = []
    for star in CatalogView(bortle).stars:
        altitude, azimuth = altitude_azimuth(star.ra, star.dec, latitude, lst)
        if altitude > 0:
            stars.append((star.name, round(apparent_altitude(altitude), 1), round(azimuth, 1)))
    stars.sort(key=lambda entry: -entry[1])
    return {"phase": twilight_phase(sun_altitude), "stars": stars}
