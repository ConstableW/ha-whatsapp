ARG BUILD_FROM
FROM ${BUILD_FROM}

# git is required: Baileys pulls libsignal from GitHub
RUN apk add --no-cache git npm

# Install dependencies first so the layer is cached between code changes
COPY package.json package-lock.json /
RUN npm ci --omit=dev

COPY . /
RUN chmod a+x /run.sh /finish.sh

EXPOSE 3000
CMD [ "/run.sh" ]
