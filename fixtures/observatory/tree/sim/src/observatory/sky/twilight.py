"""Twilight: how dark the sky is, by how far the Sun is below the horizon."""

CIVIL = -6.0
NAUTICAL = -12.0
ASTRONOMICAL = -18.0


def twilight_phase(sun_altitude):
    """The phase of the sky for the Sun's altitude in degrees."""
    if sun_altitude > 0:
        return "day"
    if sun_altitude > CIVIL:
        return "civil twilight"
    if sun_altitude > NAUTICAL:
        return "nautical twilight"
    if sun_altitude > ASTRONOMICAL:
        return "astronomical twilight"
    return "night"


def is_dark_enough(sun_altitude):
    """Whether the faintest stars are out."""
    return twilight_phase(sun_altitude) == "night"
