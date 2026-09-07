FROM alpine:3.20
RUN apk add --no-cache curl jq bash openssl
COPY test.sh /test.sh
RUN chmod +x /test.sh
ENTRYPOINT ["/test.sh"]
