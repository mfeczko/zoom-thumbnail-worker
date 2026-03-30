FROM mcr.microsoft.com/playwright:v1.42.0-jammy

# Set the working directory
WORKDIR /app

# Copy package files and install
COPY package*.json ./
RUN npm install

# Copy the rest of the code
COPY . .

# Run the scraper
CMD ["node", "bookwhen-scraper.mjs"]
