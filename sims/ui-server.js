"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const types = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".json":"application/json; charset=utf-8" };
const server = http.createServer((req, res) => {
  const raw = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = raw === "/" ? "index.html" : raw.replace(/^\/+/, "");
  const file = path.resolve(root, rel);
  if(file !== root && !file.startsWith(root + path.sep)){ res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(file, (err, body) => {
    if(err){ res.writeHead(err.code === "ENOENT" ? 404 : 500); res.end("Not found"); return; }
    res.writeHead(200, {"Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control":"no-store"});
    res.end(body);
  });
});
server.listen(4173, "127.0.0.1", () => console.log("UI server http://127.0.0.1:4173"));
