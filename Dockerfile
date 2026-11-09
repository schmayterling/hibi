# ==============================================================================
# Stage 1: Build Base with Node v26, Latest PNPM, System Deps & Non-Root User
# ==============================================================================
FROM node:26-bookworm AS build-base

ENV DEBIAN_FRONTEND=noninteractive
ENV CI=true

# Install packages required for git docs fetching, native build tools, and Electron
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libasound2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxtst6 \
    libxss1 \
    libgl1 \
    xvfb \
    dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

# Install latest PNPM version
RUN npm install -g --allow-scripts=pnpm pnpm@latest

# Create dedicated non-root user 'hibi' and app directory
RUN useradd -m -s /bin/bash hibi && \
    mkdir -p /app && \
    chown -R hibi:hibi /app

WORKDIR /app
USER hibi

ENV PNPM_HOME="/home/hibi/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Configure Git safe directory for non-root user
RUN git config --global --add safe.directory '*'

# ==============================================================================
# Stage 2: Dependencies
# ==============================================================================
FROM build-base AS deps

# Copy dependency manifests, workspace config, and postinstall patches
COPY --chown=hibi:hibi package.json .npmrc pnpm-workspace.yaml* package-lock.json* ./
COPY --chown=hibi:hibi scripts/patch-*.mjs ./scripts/

# Install dependencies using PNPM (hoist dependencies to match npm resolution expected by patches)
RUN pnpm install

# ==============================================================================
# Stage 3: Development Environment Target
# Can be run directly or mounted with source code
# ==============================================================================
FROM deps AS dev

COPY --chown=hibi:hibi . .

CMD ["pnpm", "run", "dev"]

# ==============================================================================
# Stage 4: Production Builder & Packager
# ==============================================================================
FROM deps AS builder

COPY --chown=hibi:hibi . .

# Compile application (typecheck, fetch docs, electron-vite build, site export)
RUN pnpm run build

# Package unpacked Linux binary into release/linux-unpacked
RUN pnpm run package

# ==============================================================================
# Stage 5: Pure Artifact Export (scratch)
# Usage: docker build --target artifact --output ./dist .
# ==============================================================================
FROM scratch AS artifact
COPY --from=builder /app/release/linux-unpacked/ /

# ==============================================================================
# Stage 6: Minimal Production Runtime
# Drops Node.js, PNPM, devDependencies, and build toolchain
# ==============================================================================
FROM debian:bookworm-slim AS runner

ENV DEBIAN_FRONTEND=noninteractive

# Install only the minimal shared libraries required by the packaged Electron app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libasound2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxtst6 \
    libxss1 \
    libgl1 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user in runtime image
RUN useradd -m -s /bin/bash hibi

WORKDIR /opt/hibi

# Copy only the compiled application from the builder stage
COPY --from=builder --chown=hibi:hibi /app/release/linux-unpacked/ .

# Symlink executable to PATH
RUN ln -s /opt/hibi/hibi /usr/local/bin/hibi

USER hibi

ENTRYPOINT ["hibi"]
