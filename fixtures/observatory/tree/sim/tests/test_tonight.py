from datetime import datetime, timezone

from observatory.ephemeris.timescale import julian_day
from observatory.sky.coordinates import sun_ra_dec
from observatory.sky.tonight import tonight

LONDON = (51.5, -0.13)


def test_the_sun_is_far_south_at_the_december_solstice():
    _, dec = sun_ra_dec(julian_day(datetime(2026, 12, 21, 12, tzinfo=timezone.utc)))
    assert dec < -23.0


def test_midnight_in_december_is_night_in_london():
    report = tonight(*LONDON, datetime(2026, 12, 21, 0, 0, tzinfo=timezone.utc))
    assert report["phase"] == "night"
    assert report["stars"]
    assert all(altitude > 0 for _, altitude, _ in report["stars"])


def test_noon_in_june_is_day_in_london():
    report = tonight(*LONDON, datetime(2026, 6, 21, 12, 0, tzinfo=timezone.utc))
    assert report["phase"] == "day"
