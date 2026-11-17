FROM node:24-alpine
WORKDIR /app
COPY server.mjs deck.mjs coins.mjs challenges.mjs rankings.mjs browser-modules.mjs index.html app.js style.css media-admin.mjs season-media.mjs voice-media.mjs scratch-ticket.mjs group-chat.mjs pwa.mjs push.mjs profile.mjs scoring.mjs touch-selection.mjs ./
COPY supabase/functions/_shared/wheel.mjs ./supabase/functions/_shared/wheel.mjs
COPY bootcamp-brandung-192.png ./
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 REPDECK_DB=/data/repdeck.sqlite
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.mjs"]
