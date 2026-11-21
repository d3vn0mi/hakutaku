"""Writes the stars visible under a sky as CSV, in the format the web map's catalog reads."""

import csv
import sys

from observatory.catalog.loader import CatalogView


def export_csv(bortle, out=sys.stdout):
    """Writes the stars visible under this Bortle class to out; returns how many."""
    view = CatalogView(bortle)
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["name", "ra_deg", "dec_deg", "magnitude"])
    for star in view.top(len(view.stars)):
        writer.writerow([star.name, f"{star.ra:.3f}", f"{star.dec:.3f}", f"{star.magnitude:.2f}"])
    return len(view.stars)
