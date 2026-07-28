FROM node:20-alpine
WORKDIR /app
COPY package.json server.mjs ./
CMD ["node", "server.mjs"]
