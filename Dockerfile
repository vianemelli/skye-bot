FROM node:22-alpine

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Environment
ENV NODE_ENV=production

# Run the bot (tsx runs TypeScript directly)
CMD ["npm", "run", "start"]


