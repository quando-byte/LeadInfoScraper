FROM ghcr.io/puppeteer/puppeteer:24.38.0
WORKDIR /app
COPY package*.json ./
# Pin Chrome cache to /app so it works when DigitalOcean uses /workspace at runtime
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer
RUN npm ci --omit=dev
COPY . .
RUN chown -R pptruser:pptruser /app
EXPOSE 8080
ENV PORT=8080
USER pptruser
CMD ["node", "leadinfo-api.js"]