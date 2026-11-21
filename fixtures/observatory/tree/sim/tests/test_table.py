import pytest

from observatory.ephemeris.table import EphemerisTable, Row


def rows(count):
    return [Row(jd=float(i), x=float(i), y=2.0 * i, z=0.0) for i in range(count)]


def test_rows_are_sorted_by_day():
    table = EphemerisTable("Mars", list(reversed(rows(5))))
    assert [row.jd for row in table.rows] == [0.0, 1.0, 2.0, 3.0, 4.0]
    assert table.span == (0.0, 4.0)


def test_interpolates_between_rows():
    table = EphemerisTable("Mars", rows(10))
    assert table.interpolate(4.5) == pytest.approx((4.5, 9.0, 0.0))


def test_falls_back_to_a_line_with_few_rows():
    table = EphemerisTable("Mars", rows(2))
    assert table.interpolate(0.25) == pytest.approx((0.25, 0.5, 0.0))


def test_refuses_a_day_outside_the_table():
    with pytest.raises(ValueError, match="outside the table"):
        EphemerisTable("Mars", rows(3)).interpolate(7.0)


def test_needs_two_rows():
    with pytest.raises(ValueError):
        EphemerisTable("Mars", rows(1))
