# Carries an iOS offline bundle. Extract it with:
#   docker create --name b <image> && docker cp b:/bundle/<bundle>.tgz . && docker rm b
FROM busybox:1.37
ARG BUNDLE
LABEL org.opencontainers.image.source="https://github.com/rophy/opencode-rc" \
      org.opencontainers.image.description="OpenCode RC iOS Xcode project that builds without internet" \
      org.opencontainers.image.licenses="MIT"
COPY ${BUNDLE}.tgz ${BUNDLE}.tgz.sha256 /bundle/
WORKDIR /bundle
CMD ["ls", "-l", "/bundle"]
