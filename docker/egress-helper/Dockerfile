FROM alpine:3.24.2
# The running helper needs nftables and its shell utilities. Remove the package
# manager after installation: its zlib dependency is unnecessary at runtime and
# currently has an unresolved security advisory. Preserve Alpine's package
# database so scanners can still inventory the remaining runtime dependencies.
RUN apk add --no-cache nftables && \
    apk del --no-network apk-tools alpine-keys && \
    test ! -e /sbin/apk && \
    test ! -e /lib/libz.so.1 && test ! -e /usr/lib/libz.so.1 && \
    nft --version
CMD ["sh"]
