"""Fixtures shared by the service's tests."""

from datetime import datetime, timezone

import pytest

from observatory.ephemeris.service import EphemerisService


@pytest.fixture
def equinox():
    """The March equinox of 2026, at 14:46 UTC."""
    return datetime(2026, 3, 20, 14, 46, tzinfo=timezone.utc)


@pytest.fixture
def service():
    """A service with short tables, so that tests build them quickly."""
    return EphemerisService(step_days=1.0, span_days=20)
