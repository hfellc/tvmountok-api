FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs mail.mjs ha.mjs ./
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=8083
VOLUME /data
EXPOSE 8083
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
