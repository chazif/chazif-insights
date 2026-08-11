# Build for the REDESIGN Railway environment (redesign branch).
# Stage 1 builds the React app (frontend-next → dist); stage 2 is the Python runtime
# that runs FastAPI and serves that build at /next. The production (main) environment
# builds with Nixpacks and has no Dockerfile, so this affects the redesign env only.

# ---- stage 1: build the React frontend ----
FROM node:20-slim AS webbuild
WORKDIR /app/frontend-next
COPY frontend-next/package.json frontend-next/package-lock.json ./
RUN npm ci
COPY frontend-next/ ./
RUN npm run build            # -> /app/frontend-next/dist

# ---- stage 2: python runtime ----
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY . .
# overlay the built React assets (dist is gitignored / not in the build context)
COPY --from=webbuild /app/frontend-next/dist ./frontend-next/dist
EXPOSE 8000
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
