#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const serverPath = path.join(__dirname, ".omega", "compute", "middleware", "server.mjs");
if (!fs.existsSync(serverPath)) {
  console.log("No middleware server.mjs found, skipping patch.");
  process.exit(0);
}

fs.writeFileSync(serverPath, `import http from "node:http";

const port = Number(process.env.PORT);
const host = process.env.HOSTNAME ?? "0.0.0.0";
if (!Number.isInteger(port) || port < 1) {
  throw new Error("[middleware] PORT env var not set to a valid integer: " + String(process.env.PORT));
}

const healthPath = "/__omega_middleware_health";
let handler = null;

const loading = import("./handler.mjs").then((m) => {
  handler = m.default;
});

const server = http.createServer((req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0];
  if (urlPath === healthPath) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  void (async () => {
    try {
      await loading;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }
      const proto = req.headers["x-forwarded-proto"] ?? "http";
      const reqHost = req.headers.host ?? "localhost";
      const request = new Request(\`\${proto}://\${reqHost}\${req.url ?? "/"}\`, {
        method: req.method ?? "GET",
        headers,
      });
      const response = await handler(request);
      const headerMap = {};
      const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie") return;
        headerMap[key] = value;
      });
      if (setCookies.length > 0) headerMap["set-cookie"] = setCookies;
      res.writeHead(response.status, headerMap);
      if (response.body) res.write(Buffer.from(await response.arrayBuffer()));
      res.end();
    } catch (err) {
      process.stderr.write(\`[middleware] HTTP handler failed: \${err instanceof Error ? err.message : String(err)}\\n\`);
      if (!res.headersSent) res.writeHead(500, { "x-omega-middleware-result": "earlyResponse" });
      res.end();
    }
  })();
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, () => {
    server.removeListener("error", reject);
    process.stdout.write(\`[middleware] listening on \${host}:\${server.address()?.port ?? port}\\n\`);
    resolve();
  });
});
`);

console.log("Patched middleware server.mjs with lazy-loading handler.");
