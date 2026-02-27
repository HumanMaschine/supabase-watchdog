FROM denoland/deno:2.1.4 AS builder

WORKDIR /app

# Copy dependency manifest first for layer caching
COPY deno.json deno.lock ./
RUN deno install

# Copy source
COPY . .

# Cache dependencies
RUN deno cache main.ts

# --- Runtime stage ---

FROM denoland/deno:2.1.4

WORKDIR /app

COPY --from=builder /app .

# Deno permissions: read config, access env vars, network for API calls
CMD ["deno", "run", "--allow-read", "--allow-env", "--allow-net", "main.ts"]
