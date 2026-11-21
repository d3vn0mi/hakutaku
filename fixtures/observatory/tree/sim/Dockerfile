FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src/ ./src/
RUN pip install --no-cache-dir .

ENV EPHEMERIS_PORT=8080
EXPOSE 8080
CMD ["python", "-m", "observatory.ephemeris.cli", "serve", "--port", "8080"]
