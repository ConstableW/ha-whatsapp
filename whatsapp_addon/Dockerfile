ARG BUILD_FROM
FROM ${BUILD_FROM}

# Installiere System-Dependencies
RUN apk add --no-cache git npm

# Kopiere package.json zuerst (für besseres Caching)
COPY package*.json ./

# Installiere npm-Dependencies (inkl. Baileys)
RUN npm install -f

# Kopiere restliche Dateien
COPY . .

# Setze Ausführungsrechte
RUN chmod a+x /run.sh
RUN chmod a+x /finish.sh

EXPOSE 3000
CMD ["npm", "start"]
