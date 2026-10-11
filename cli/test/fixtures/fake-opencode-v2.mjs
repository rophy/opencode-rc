// Stand-in for `opencode serve --stdio` (2.x), used by server.test.ts.
import http from "node:http";

const want = ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"];
const args = process.argv.slice(2);
if (args.join(" ") !== want.join(" ")) {
  console.error(`unexpected args: ${args.join(" ")}`);
  process.exit(2);
}

const mode = process.env.FAKE_MODE;
if (mode === "silent") console.error(`pid ${process.pid}`);
const password = process.env.OPENCODE_PASSWORD;
const serverPassword = process.env.OPENCODE_SERVER_PASSWORD ?? null;
const expected = "Basic " + Buffer.from("opencode:" + password).toString("base64");

if (mode === "crash") {
  console.error("boom");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (req.headers.authorization !== expected || u.searchParams.has("auth_token")) {
    res.writeHead(401).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(u.pathname === "/env" ? JSON.stringify({ serverPassword }) : JSON.stringify({ ok: true }));
});

server.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  if (mode !== "silent") console.log(JSON.stringify({ url }));
  if (mode === "exit-later") setTimeout(() => process.exit(0), 500);
});

process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
