# Runs Tally. npm start brings the database up to date (src/migrate.js), then starts the server.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY db ./db
# Cloud Run sets PORT.
CMD ["npm", "start"]
