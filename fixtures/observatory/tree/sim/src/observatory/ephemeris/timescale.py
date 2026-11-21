"""Time scales: Julian days, and the offset between UTC and terrestrial time."""

from datetime import datetime, timezone

J2000 = 2451545.0
UNIX_EPOCH_JD = 2440587.5
SECONDS_PER_DAY = 86400.0
# TT - UTC in seconds since 2017: TT runs 32.184 s ahead of TAI, and TAI 37 s ahead of UTC.
TT_MINUS_UTC = 69.184


def julian_day(moment):
    """The Julian day of an aware datetime."""
    if moment.tzinfo is None:
        raise ValueError("julian_day needs an aware datetime")
    return moment.timestamp() / SECONDS_PER_DAY + UNIX_EPOCH_JD


def from_julian_day(jd):
    """The aware UTC datetime of a Julian day."""
    return datetime.fromtimestamp((jd - UNIX_EPOCH_JD) * SECONDS_PER_DAY, tz=timezone.utc)


def utc_to_tt(jd_utc):
    """A Julian day in UTC, as a Julian day in terrestrial time."""
    return jd_utc + TT_MINUS_UTC / SECONDS_PER_DAY


def centuries_since_j2000(jd):
    """Julian centuries of 36,525 days since J2000."""
    return (jd - J2000) / 36525.0
