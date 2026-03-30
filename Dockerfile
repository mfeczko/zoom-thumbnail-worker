# Update this first line to 1.58.2
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "bookwhen-scraper.mjs"]
