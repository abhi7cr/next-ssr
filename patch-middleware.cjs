#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const mwDir = path.join(__dirname, ".omega", "compute", "middleware");
const indexPath = path.join(mwDir, "index.js");
const middlewarePath = path.join(mwDir, "middleware.mjs");

if (!fs.existsSync(path.join(mwDir, "server.mjs"))) {
  console.log("No middleware server.mjs found, skipping patch.");
  process.exit(0);
}

// Patch middleware.mjs: fix the spread that loses Request.url
if (fs.existsSync(middlewarePath)) {
  let mw = fs.readFileSync(middlewarePath, "utf8");
  // Replace {...request, page: ...} with explicit url/headers/method + page
  const old = `request: {
      ...request,
      page: {
        name: correspondingRoute.name
      }
    }`;
  const fixed = `request: {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      page: {
        name: correspondingRoute.name
      }
    }`;
  if (mw.includes(old)) {
    mw = mw.replace(old, fixed);
    fs.writeFileSync(middlewarePath, mw);
    console.log("Patched middleware.mjs — fixed Request spread.");
  } else {
    console.log("WARNING: Could not find spread pattern in middleware.mjs to patch.");
  }
}

// Patch handler.mjs: fix header format order
// Adapter outputs: x-omega-middleware-{req|res}-header-{seq}-{op}-{key}
// Platform expects: x-omega-middleware-{req|res}-{seq}-header-{op}-{key}
const handlerPath = path.join(mwDir, "handler.mjs");
if (fs.existsSync(handlerPath)) {
  let hjs = fs.readFileSync(handlerPath, "utf8");
  hjs = hjs.replace(
    /`x-omega-middleware-req-header-\$\{seq\}-\$\{op\}-\$\{key\}`/g,
    '`x-omega-middleware-req-${seq}-header-${op}-${key}`'
  );
  hjs = hjs.replace(
    /`x-omega-middleware-res-header-\$\{seq\}-\$\{op\}-\$\{key\}`/g,
    '`x-omega-middleware-res-${seq}-header-${op}-${key}`'
  );
  hjs = hjs.replace(
    /`x-omega-middleware-res-header-\$\{seq\}-append-Set-Cookie`/g,
    '`x-omega-middleware-res-${seq}-header-append-Set-Cookie`'
  );
  fs.writeFileSync(handlerPath, hjs);
  console.log("Patched handler.mjs — fixed header format order.");
}

// Replace index.js with direct port binding
fs.writeFileSync(indexPath, `import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";

if (!globalThis.__openNextAls) {
  globalThis.__openNextAls = new AsyncLocalStorage();
}

const port = Number(process.env.PORT || process.env.AWS_LAMBDA_HTTP_ENDPOINT?.split(":").pop() || 3000);
const host = process.env.HOSTNAME || process.env.AWS_LAMBDA_HTTP_ENDPOINT?.split(":")[0] || "0.0.0.0";

const healthPath = "/__omega_middleware_health";
let handler = null;

const server = http.createServer((req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0];
  if (urlPath === healthPath) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  void (async () => {
    try {
      if (!handler) {
        const m = await import("./handler.mjs");
        handler = m.default;
      }
      const proto = req.headers["x-forwarded-proto"] ?? "http";
      const reqHost = req.headers.host ?? "localhost";
      const url = \`\${proto}://\${reqHost}\${req.url ?? "/"}\`;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }
      const request = new Request(url, { method: req.method ?? "GET", headers });
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

server.listen(port, host, () => {
  process.stdout.write(\`[middleware] listening on \${host}:\${server.address()?.port ?? port}\\n\`);
});
`);

console.log("Patched middleware index.js — direct port binding.");
