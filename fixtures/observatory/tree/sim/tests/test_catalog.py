import pytest

from observatory.catalog.loader import CatalogView
from observatory.catalog.magnitudes import combined_magnitude, flux_ratio, limiting_magnitude
from observatory.catalog.stars import Star, load_catalog


def test_loads_the_catalog_brightest_first():
    stars = load_catalog()
    assert stars[0].name == "Sirius"
    assert [s.magnitude for s in stars] == sorted(s.magnitude for s in stars)


def test_a_city_sky_shows_fewer_stars():
    dark = CatalogView(1)
    city = CatalogView(9, stars=[Star("Faint", 0.0, 0.0, 4.0), Star("Vega", 279.2, 38.8, 0.03)])
    assert [s.name for s in city.stars] == ["Vega"]
    assert len(dark.stars) >= len(city.stars)


def test_finds_a_star_in_any_case():
    view = CatalogView(1)
    assert view.find("vega").magnitude == pytest.approx(0.03)
    assert view.find("Polaris") is None
    assert [s.name for s in view.top(2)] == ["Sirius", "Canopus"]


def test_five_magnitudes_are_a_hundred_times():
    assert flux_ratio(0, 5) == pytest.approx(100)


def test_two_equal_stars_are_brighter_by_three_quarters_of_a_magnitude():
    assert combined_magnitude([1.0, 1.0]) == pytest.approx(1.0 - 0.7526, abs=1e-3)


def test_limits_clamp_to_the_scale():
    assert limiting_magnitude(0) == limiting_magnitude(1)
    assert limiting_magnitude(12) == limiting_magnitude(9)
