"""Interpolation between the rows of an ephemeris table."""


def linear(x0, y0, x1, y1, x):
    """The straight line through (x0, y0) and (x1, y1), at x."""
    if x1 == x0:
        return y0
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0)


def lagrange(xs, ys, x):
    """The Lagrange polynomial through the points (xs[i], ys[i]), at x."""
    if len(xs) != len(ys) or not xs:
        raise ValueError("lagrange needs as many ys as xs, and at least one point")
    total = 0.0
    for i, (xi, yi) in enumerate(zip(xs, ys)):
        term = yi
        for j, xj in enumerate(xs):
            if j != i:
                term *= (x - xj) / (xi - xj)
        total += term
    return total
