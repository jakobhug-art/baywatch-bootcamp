FROM node:24-alpine
WORKDIR /app
COPY server.mjs deck.mjs coins.mjs challenges.mjs rankings.mjs index.html app.js style.css media-admin.mjs season-media.mjs ./
COPY supabase/functions/_shared/wheel.mjs ./supabase/functions/_shared/wheel.mjs
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 REPDECK_DB=/data/repdeck.sqlite
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.mjs"]
