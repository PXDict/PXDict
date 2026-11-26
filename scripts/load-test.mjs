#!/usr/bin/env node
// Light load test (docs/PLAN.md Phase 10): N virtual users look words up for a while, and the script
// reports throughput and latency percentiles of /api/search (time until the whole NDJSON body arrived).
// Run it once through the gateway and once against wuDict directly to see what the gateway adds.
//
// No dependencies (Node.js 22+). Words are seeded from /api/suggest for every letter a–z.
//
//   # through the gateway (signs in once; all virtual users share the session and its cookies)
//   node scripts/load-test.mjs --url https://dict.example.com --login admin --password '…' --users 15
//
//   # inside the container, gateway vs. wuDict on loopback (the script is read from stdin):
//   docker compose exec -T app node --input-type=module - --url http://127.0.0.1:8080 \
//     --origin "$PUBLIC_URL" --login admin --password '…' < scripts/load-test.mjs
//   docker compose exec -T app node --input-type=module - --direct http://127.0.0.1:6888 < scripts/load-test.mjs
//
// Options:
//   --url URL          gateway base URL (default http://127.0.0.1:8080)
//   --origin ORIGIN    Origin header for the sign-in request (default: --url's origin; must be PUBLIC_URL)
//   --login NAME       username or email to sign in with (or LOAD_LOGIN)
//   --password PW      password (or LOAD_PASSWORD; prefer the variable: arguments show up in `ps`)
//   --direct URL       test wuDict at URL instead (no sign-in; for loopback comparisons only); sends
//                      AUTH_TOKEN from the environment as a bearer token (set inside the container)
//   --users N          concurrent virtual users (default 15)
//   --duration S       seconds to run (default 30)
//   --think MS         pause between one user's lookups (default 0: back to back)
//   --mode MODE        search mode (default exact)
//   --json             print the result as one JSON line

import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:8080" },
    origin: { type: "string" },
    login: { type: "string", default: process.env.LOAD_LOGIN ?? "" },
    password: { type: "string", default: process.env.LOAD_PASSWORD ?? "" },
    direct: { type: "string" },
    users: { type: "string", default: "15" },
    duration: { type: "string", default: "30" },
    think: { type: "string", default: "0" },
    mode: { type: "string", default: "exact" },
    json: { type: "boolean", default: false },
  },
});

const die = (msg) => {
  console.error(`load-test: ${msg}`);
  process.exit(2);
};

const users = Number(opt.users);
const durationMs = Number(opt.duration) * 1000;
const thinkMs = Number(opt.think);
if (!(users >= 1 && users <= 1000)) die("--users must be 1–1000");
if (!(durationMs > 0)) die("--duration must be positive");
const base = new URL(opt.direct ?? opt.url);
const headers = {};

// Cookies like a browser keeps them: the session token plus Better Auth's short-lived session cache,
// which the gateway renews in its responses (all virtual users share one session).
const jar = new Map();
function keepCookies(res) {
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!value || /max-age=0/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

if (opt.direct) {
  if (process.env.AUTH_TOKEN) headers.Authorization = `Bearer ${process.env.AUTH_TOKEN}`;
} else {
  if (!opt.login || !opt.password) die("give --login and --password (or LOAD_LOGIN / LOAD_PASSWORD)");
  const byEmail = opt.login.includes("@");
  const res = await fetch(new URL(byEmail ? "/app-api/auth/sign-in/email" : "/app-api/auth/sign-in/username", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: opt.origin ?? base.origin },
    body: JSON.stringify(byEmail ? { email: opt.login, password: opt.password } : { username: opt.login, password: opt.password }),
  });
  if (res.status !== 200) die(`sign-in failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  keepCookies(res);
  if (![...jar.keys()].some((k) => k.endsWith("session_token"))) die("sign-in returned no session cookie");
}

// Seed words from suggestions.
const words = new Set();
for (const letter of "abcdefghijklmnopqrstuvwxyz") {
  const res = await fetch(new URL(`/api/suggest?q=${letter}`, base), { headers });
  if (res.status !== 200) die(`/api/suggest answered HTTP ${res.status}`);
  for (const w of (await res.json()).words ?? []) words.add(w);
}
const list = [...words];
if (!list.length) die("no words found: add a dictionary first");

const latencies = [];
let errors = 0;
const statuses = new Map();
const deadline = performance.now() + durationMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function virtualUser(seed) {
  let i = seed;
  while (performance.now() < deadline) {
    const word = list[(i = (i * 1103515245 + 12345) % 2 ** 31) % list.length];
    const url = new URL("/api/search", base);
    url.searchParams.set("q", word);
    url.searchParams.set("mode", opt.mode);
    const start = performance.now();
    try {
      const res = await fetch(url, { headers });
      keepCookies(res);
      await res.arrayBuffer();
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      if (res.status === 200) latencies.push(performance.now() - start);
      else errors++;
    } catch {
      errors++;
    }
    if (thinkMs) await sleep(thinkMs);
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: users }, (_, k) => virtualUser(k + 1)));
const elapsed = (performance.now() - started) / 1000;

latencies.sort((a, b) => a - b);
const pct = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)] : NaN);
const round = (ms) => Math.round(ms * 10) / 10;
const result = {
  target: opt.direct ? "wudict" : "gateway",
  url: base.origin,
  users,
  seconds: Math.round(elapsed),
  words: list.length,
  requests: latencies.length + errors,
  errors,
  statuses: Object.fromEntries(statuses),
  rps: Math.round((latencies.length / elapsed) * 10) / 10,
  ms: { p50: round(pct(50)), p95: round(pct(95)), p99: round(pct(99)), max: round(latencies.at(-1) ?? NaN) },
};
if (opt.json) console.log(JSON.stringify(result));
else {
  console.log(`${result.target} ${result.url}: ${users} users, ${result.seconds}s, ${result.words} words`);
  console.log(`  requests ${result.requests}  errors ${errors}  ${result.rps} req/s`);
  console.log(`  latency ms  p50 ${result.ms.p50}  p95 ${result.ms.p95}  p99 ${result.ms.p99}  max ${result.ms.max}`);
}
process.exit(errors ? 1 : 0);
