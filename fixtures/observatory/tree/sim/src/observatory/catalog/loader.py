"""The catalog as one observer sees it: only the stars bright enough for their sky."""

from observatory.catalog import magnitudes
from observatory.catalog.stars import load_catalog


class CatalogView:
    """The stars visible under skies of one Bortle class, brightest first."""

    def __init__(self, bortle, stars=None):
        self.bortle = bortle
        self.limit = magnitudes.limiting_magnitude(bortle)
        everything = load_catalog() if stars is None else stars
        self.stars = [star for star in everything if star.magnitude <= self.limit]

    def top(self, count):
        return self.stars[:count]

    def find(self, name):
        wanted = name.casefold()
        return next((star for star in self.stars if star.name.casefold() == wanted), None)
