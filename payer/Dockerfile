FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs budget.mjs client-config.mjs ./
ENV PAYER_PORT=3502 PAYER_BIND=0.0.0.0 PAYER_HOME=/data
VOLUME /data
EXPOSE 3502
CMD ["node", "server.mjs"]
