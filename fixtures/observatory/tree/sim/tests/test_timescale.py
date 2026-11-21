from datetime import datetime, timezone

import pytest

from observatory.ephemeris.timescale import (
    J2000,
    centuries_since_j2000,
    from_julian_day,
    julian_day,
    utc_to_tt,
)


def test_julian_day_of_j2000():
    assert julian_day(datetime(2000, 1, 1, 12, tzinfo=timezone.utc)) == J2000


def test_round_trip():
    moment = datetime(2026, 9, 1, 12, tzinfo=timezone.utc)
    assert from_julian_day(julian_day(moment)) == moment


def test_naive_datetimes_are_refused():
    with pytest.raises(ValueError):
        julian_day(datetime(2026, 9, 1, 12))


def test_tt_runs_ahead_of_utc():
    assert utc_to_tt(J2000) - J2000 == pytest.approx(69.184 / 86400)


def test_a_century_after_j2000():
    assert centuries_since_j2000(J2000 + 36525) == pytest.approx(1.0)
