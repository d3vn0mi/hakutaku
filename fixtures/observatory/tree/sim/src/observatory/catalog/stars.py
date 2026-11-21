"""The bright stars: names, places and visual magnitudes."""

import csv
from dataclasses import dataclass
from pathlib import Path

DATA = Path(__file__).with_name("bright_stars.csv")


@dataclass(frozen=True)
class Star:
    name: str
    ra: float  # right ascension, degrees
    dec: float  # declination, degrees
    magnitude: float


def load_catalog(path=DATA):
    """The stars of a catalog CSV (name, ra_deg, dec_deg, magnitude), brightest first."""
    with open(path, newline="", encoding="utf-8") as f:
        stars = [
            Star(row["name"], float(row["ra_deg"]), float(row["dec_deg"]), float(row["magnitude"]))
            for row in csv.DictReader(f)
        ]
    return sorted(stars, key=lambda star: star.magnitude)
