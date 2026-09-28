# anonfetch: one container runs the Anyone client (anon binary, SOCKS on
# 127.0.0.1:9050) and the payment-oblivious POST /fetch backend the connector
# terminates g.drew.anon at. Full bookworm, not slim: the prebuilt anon binary
# wants the usual shared libs.
FROM node:22-bookworm
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs receipt.mjs canonicalize.mjs ./
ENV PORT=3500 ANON_SOCKS_PORT=9050 ANON_CONTROL_PORT=9051
EXPOSE 3500
CMD ["node", "server.mjs"]
