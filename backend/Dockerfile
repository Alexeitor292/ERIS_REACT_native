# Supported Alpine 3.24 runtime with available OS fixes and audited packages.
FROM python:3.12-alpine@sha256:c5ba3deef00c7758561a0f03c26f44f10589263d40e732b8748e0d1f38f6dd89
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN apk upgrade --no-cache
COPY requirements.txt constraints.txt ./
# Package installation is a build operation; the deployed service needs no
# installer or its vendored libraries. Uninstall pip itself after resolving the
# locked runtime dependencies, keeping their dist-info metadata for audits.
RUN pip install --no-cache-dir --upgrade pip==26.3 setuptools==84.2.1 \
    && pip install --no-cache-dir -r requirements.txt \
    && python -m pip check \
    && python -m pip uninstall --yes pip
COPY app ./app
COPY alembic.ini .
COPY migrations ./migrations
RUN addgroup -g 10001 eris && adduser -D -H -u 10001 -G eris eris
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).read()"
EXPOSE 8000
CMD ["uvicorn", "app.asgi:app", "--host", "0.0.0.0", "--port", "8000"]
