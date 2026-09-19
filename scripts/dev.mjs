#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = path.join(root, "backend");
const frontend = path.join(root, "frontend");
const apiOnly = process.argv.includes("--api-only");

function loadDotenv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotenv(path.join(root, ".env"));

const apiPort = process.env.API_PORT || "8000";
const webPort = process.env.WEB_PORT || "3000";
const apiUrl = process.env.NEXT_PUBLIC_API_URL || `http://127.0.0.1:${apiPort}`;

function fstype() {
  const r = spawnSync("findmnt", ["-T", root, "-o", "FSTYPE", "-n"], { encoding: "utf8" });
  return (r.stdout || "").trim();
}

function uvEnv() {
  const env = { ...process.env, UV_CACHE_DIR: process.env.UV_CACHE_DIR || "/tmp/uv-cache" };
  const fs = fstype();
  if (["nfs", "nfs4", "ceph"].includes(fs)) {
    const venv = process.env.VIRTUAL_ENV || path.join(homedir(), ".uv-local/venvs/simple-annotator");
    env.VIRTUAL_ENV = venv;
    env.UV_PROJECT_ENVIRONMENT = venv;
  }
  return env;
}

function ensureUv() {
  const env = uvEnv();
  if (["nfs", "nfs4", "ceph"].includes(fstype())) {
    mkdirSync(env.VIRTUAL_ENV, { recursive: true });
  }
  const sync = spawnSync("uv", ["sync"], { cwd: backend, env, stdio: "inherit" });
  if (sync.status !== 0) process.exit(sync.status ?? 1);
  return env;
}

const children = [];

function start(cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: "inherit", ...opts });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      for (const c of children) {
        if (!c.killed) c.kill("SIGTERM");
      }
      process.exit(code);
    }
  });
  return child;
}

function shutdown() {
  for (const c of children) {
    if (!c.killed) c.kill("SIGTERM");
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const env = ensureUv();
const uvArgs = ["nfs", "nfs4", "ceph"].includes(fstype()) ? ["run", "--active"] : ["run"];

start(
  "uv",
  [...uvArgs, "uvicorn", "simple_annotator.main:app", "--reload", "--host", "127.0.0.1", "--port", apiPort],
  { cwd: backend, env: { ...env, PYTHONPATH: path.join(backend, "src") } },
);

if (!apiOnly) {
  if (!existsSync(path.join(frontend, "package.json"))) {
    console.error("frontend is missing; run create-next-app first");
    shutdown();
    process.exit(1);
  }
  start("npm", ["run", "dev", "--", "--port", webPort, "--hostname", "127.0.0.1"], {
    cwd: frontend,
    env: { ...process.env, NEXT_PUBLIC_API_URL: apiUrl },
  });
}
