# The WireGuard sidecar Homeport manages for remote access.
# It does one thing: bring up the tunnel from /config/wg0.conf and keep Homeport's firewall rules in place.
FROM alpine:3.21
ARG VERSION=0
LABEL homeport.wireguard.version=$VERSION
RUN apk add --no-cache wireguard-tools iptables iproute2 musl-utils
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
