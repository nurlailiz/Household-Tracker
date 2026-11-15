FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production DATA_FILE=/data/db.json PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
