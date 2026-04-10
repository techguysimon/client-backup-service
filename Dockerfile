FROM oven/bun:1-debian

WORKDIR /app
COPY package.json ./
RUN bun install --frozen-lockfile
COPY . .

EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
