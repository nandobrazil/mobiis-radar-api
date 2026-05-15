# Base image — versão full (não slim) necessária para compilar better-sqlite3
FROM node:24

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3000

# Volume para persistir o cache SQLite entre redeploys
VOLUME ["/usr/src/app/data"]

CMD ["node", "dist/main.js"]
