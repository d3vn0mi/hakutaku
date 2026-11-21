import pytest

from observatory.sky.twilight import is_dark_enough, twilight_phase


@pytest.mark.parametrize(
    ("altitude", "phase"),
    [
        (10.0, "day"),
        (-3.0, "civil twilight"),
        (-9.0, "nautical twilight"),
        (-15.0, "astronomical twilight"),
        (-25.0, "night"),
    ],
)
def test_phases(altitude, phase):
    assert twilight_phase(altitude) == phase


def test_only_night_is_dark_enough():
    assert is_dark_enough(-20.0)
    assert not is_dark_enough(-15.0)
