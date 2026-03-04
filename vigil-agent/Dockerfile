FROM rust:1.75-alpine AS builder
RUN apk add --no-cache musl-dev pkgconfig openssl-dev openssl-libs-static
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY vigil-agent ./vigil-agent
RUN cargo build --release -p vigil-agent

FROM alpine:3.19
RUN apk add --no-cache ca-certificates iputils && \
    adduser -D -u 1001 vigil
COPY --from=builder /app/target/release/vigil-agent /usr/local/bin/
USER vigil
ENTRYPOINT ["vigil-agent"]
