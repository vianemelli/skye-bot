FROM oven/bun:alpine

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

# Environment
ENV NODE_ENV=production

# Build output for production
RUN bun run build

# Run the bot from compiled output
CMD ["bun", "dist/index.js"]
