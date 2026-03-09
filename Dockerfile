FROM ghcr.io/puppeteer/puppeteer:21.6.1
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
ENV PORT=8080
USER pptruser
CMD ["node", "leadinfo-api.js"]