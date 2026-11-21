import pytest

from observatory.ephemeris.interpolate import lagrange, linear


def test_linear_halfway():
    assert linear(0, 0, 2, 10, 1) == 5


def test_linear_on_one_point():
    assert linear(1, 3, 1, 9, 1) == 3


def test_lagrange_is_exact_on_a_cubic():
    xs = [0, 1, 2, 3]
    ys = [x**3 - 2 * x for x in xs]
    assert lagrange(xs, ys, 1.5) == pytest.approx(1.5**3 - 3)


def test_lagrange_refuses_mismatched_points():
    with pytest.raises(ValueError):
        lagrange([0, 1], [0], 0.5)
