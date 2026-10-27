# Roadmap

## Todo

- **iOS offline bundle: check the server URL in `set-server-url.sh`.** The chart serves the API at
  `{prefix}.{host}` and the web UI at `{prefix}-ui.{host}`. Given the UI host, the script succeeds,
  but the app cannot sign in: the sign-in sheet opens the web UI, which reports "server is older
  than this app supports". Before it changes files, the script should request `<url>/healthz` and
  stop unless the reply is the API's JSON with `protocol`. Add `--offline` to skip the check on a
  Mac that cannot reach the server.
