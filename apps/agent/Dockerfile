FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 VOICEAI_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 voiceai
WORKDIR /app
COPY requirements-deploy.txt ./requirements-deploy.txt
RUN pip install --no-cache-dir -r requirements-deploy.txt
COPY pyproject.toml ./pyproject.toml
COPY src ./src
RUN pip install --no-cache-dir --no-deps . && chown -R voiceai:voiceai /app
USER voiceai
RUN python -m livekit.agents download-files
CMD ["voiceai-agent", "start"]
