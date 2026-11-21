"""An ephemeris table: a body's places at Julian days, read at any day between them."""

from bisect import bisect_right
from dataclasses import dataclass

from .interpolate import lagrange, linear


@dataclass(frozen=True)
class Row:
    jd: float
    x: float  # astronomical units
    y: float
    z: float


class EphemerisTable:
    """A body's rows, sorted by Julian day, interpolated between."""

    def __init__(self, body, rows):
        if len(rows) < 2:
            raise ValueError("an ephemeris table needs at least two rows")
        self.body = body
        self.rows = sorted(rows, key=lambda row: row.jd)

    @property
    def span(self):
        """The first and last Julian days the table covers."""
        return self.rows[0].jd, self.rows[-1].jd

    def covers(self, jd):
        first, last = self.span
        return first <= jd <= last

    def _bracket(self, jd, width=4):
        """The width rows around jd, or as many as the table has."""
        i = bisect_right([row.jd for row in self.rows], jd)
        start = max(0, min(i - width // 2, len(self.rows) - width))
        return self.rows[start:start + width]

    def interpolate(self, jd):
        """The body's (x, y, z) at jd: a cubic through the four nearest rows."""
        if not self.covers(jd):
            raise ValueError(f"{self.body}: day {jd} is outside the table")
        rows = self._bracket(jd)
        if len(rows) < 4:
            a, b = rows[0], rows[-1]
            return tuple(linear(a.jd, getattr(a, k), b.jd, getattr(b, k), jd) for k in "xyz")
        days = [row.jd for row in rows]
        return tuple(lagrange(days, [getattr(row, k) for row in rows], jd) for k in "xyz")
