# Development image. Production packaging is out of scope for EXP-5 (NG-5).
FROM node:22-alpine

WORKDIR /app

# Install dependencies against the workspace manifests first so that editing
# source does not invalidate the dependency layer.
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
RUN npm install

COPY apps/api ./apps/api

WORKDIR /app/apps/api

EXPOSE 3000

CMD ["npm", "run", "dev"]
