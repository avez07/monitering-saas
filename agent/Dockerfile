# Local build of the agent from source (no registry needed). Use this to build without pulling from Docker Hub.
#
#   docker build -t yuktiops-agent:local -f agent/Dockerfile agent
#
# Then run it with the same flags as the published image but with the tag yuktiops-agent:local
# (see agent/README.md, "Build the image yourself"). The release image is agent/Dockerfile.release.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=local
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/yuktiops-agent ./cmd/yuktiops-agent

FROM busybox:1.37 AS prepare
RUN mkdir -p /out/var/lib/yuktiops && chown -R 65532:65532 /out/var/lib/yuktiops

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/yuktiops-agent /usr/local/bin/yuktiops-agent
COPY --from=prepare --chown=65532:65532 /out/var/lib/yuktiops /var/lib/yuktiops
ENV YUKTIOPS_CONFIG_DIR=/var/lib/yuktiops/config \
    YUKTIOPS_STATE_DIR=/var/lib/yuktiops/state
VOLUME ["/var/lib/yuktiops"]
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/yuktiops-agent"]
CMD ["run"]
