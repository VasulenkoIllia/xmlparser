FROM node:18-alpine

RUN apk add --no-cache tzdata

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY services ./services
COPY scripts ./scripts

CMD ["sh", "-lc", "sleep infinity"]
