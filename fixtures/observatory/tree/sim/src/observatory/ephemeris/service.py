"""The ephemeris service: where a body is, answered from tables it builds and keeps."""

from observatory.ephemeris import timescale
from observatory.ephemeris.planets import MEAN_ELEMENTS, heliocentric_xy
from observatory.ephemeris.table import EphemerisTable, Row

from .interpolate import lagrange

STEP_DAYS = 1.0
SPAN_DAYS = 60


class EphemerisService:
    """Builds a table for a body the first time it is asked about, and answers from it."""

    def __init__(self, step_days=STEP_DAYS, span_days=SPAN_DAYS):
        self.step_days = step_days
        self.span_days = span_days
        self._tables = {}

    def bodies(self):
        return sorted(MEAN_ELEMENTS)

    def table_for(self, body, around_jd):
        """The table for body that covers around_jd, built anew when none does."""
        table = self._tables.get(body)
        if table is None or not table.covers(around_jd):
            table = self._build(body, around_jd)
            self._tables[body] = table
        return table

    def _build(self, body, around_jd):
        half = self.span_days / 2
        count = int(self.span_days / self.step_days) + 1
        rows = []
        for i in range(count):
            jd = around_jd - half + i * self.step_days
            x, y = heliocentric_xy(body, jd)
            rows.append(Row(jd=jd, x=x, y=y, z=0.0))
        return EphemerisTable(body, rows)

    def where(self, body, moment):
        """A body's heliocentric (x, y, z) in AU at an aware datetime."""
        jd = timescale.utc_to_tt(timescale.julian_day(moment))
        table = self.table_for(body, jd)
        return table.interpolate(jd)

    def distance(self, body, moment, days=(-2, -1, 0, 1, 2)):
        """A body's distance from the Sun at moment, in AU, smoothed over a few days."""
        jd = timescale.julian_day(moment)
        table = self.table_for(body, jd)
        distances = [sum(c * c for c in table.interpolate(jd + d)) ** 0.5 for d in days]
        return lagrange(list(days), distances, 0)
