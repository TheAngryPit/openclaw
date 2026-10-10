# syntax=docker/dockerfile:1
ARG NODE_IMAGE=docker.io/library/node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
FROM docker.io/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun-binary
FROM ${NODE_IMAGE} AS package-build
COPY --from=bun-binary /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /build
COPY --from=product . .
ARG PRODUCT_SHA
ENV GIT_COMMIT=${PRODUCT_SHA} CI=true OPENCLAW_PREFER_PNPM=1
RUN corepack enable && \
    corepack prepare "$(node -p 'require("./package.json").packageManager')" --activate && \
    pnpm install --frozen-lockfile && \
    node scripts/package-openclaw-for-docker.mjs \
      --allow-unreleased-changelog --output-dir /out --output-name candidate.tgz && \
    sha256sum /out/candidate.tgz > /out/candidate.sha256

FROM scratch AS package-export
COPY --from=package-build /out/ /

FROM package-build AS tracked-startup-proof
ARG PRODUCT_SHA
ENV PRODUCT_SHA=${PRODUCT_SHA}
COPY tracked-startup-tests.patch tracked-startup-repair.patch tracked-startup-proof.mjs /qa/
RUN node /qa/tracked-startup-proof.mjs

FROM scratch AS tracked-startup-receipt
COPY --from=tracked-startup-proof /qa/public/ /

FROM ${NODE_IMAGE} AS gateway-runtime
COPY --from=package-build /out/candidate.tgz /qa/candidate.tgz
COPY --from=tailscale /tailscale /usr/local/bin/tailscale
RUN npm install --global --prefix /opt/openclaw /qa/candidate.tgz \
      --omit=dev --no-audit --no-fund && \
    chown -R node:node /opt/openclaw && \
    /opt/openclaw/bin/openclaw --version && \
    /usr/local/bin/tailscale version
ENV PATH=/opt/openclaw/bin:${PATH} NODE_ENV=production
USER node
ENTRYPOINT ["/opt/openclaw/bin/openclaw"]

FROM ${NODE_IMAGE} AS tailscale-runtime
COPY --from=tailscale /tailscale /usr/local/bin/tailscale
COPY --from=tailscale /tailscaled /usr/local/bin/tailscaled
ENTRYPOINT ["/usr/local/bin/tailscaled"]
