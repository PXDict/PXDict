// Optional Prometheus metrics (docs/PLAN.md Phase 10): request counts and latency per route group,
// requests in flight, process memory and event-loop delay, and a few gateway totals. Served as the
// Prometheus text format at /metrics when METRICS=on (app.ts decides who may read it).
//
// Labels are bounded on purpose: the route is a fixed group name (never the raw path, which holds
// search words and dictionary ids), the status a number. Hand-written instead of prom-client to keep
// the gateway's dependency list short (AGENTS.md §5).
import { monitorEventLoopDelay, type ELDHistogram } from "node:perf_hooks";
import type { MiddlewareHandler } from "hono";

/** Latency buckets in seconds. */
export const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/** Route groups with their own series; everything else is "static" (PWA files) or "other". */
const apiGroups = new Set(["/api/search", "/api/suggest", "/api/dicts"]);
const appApiGroups = new Set(["auth", "me", "proposals", "admin"]);

/** The bounded route label for a request path. */
export function routeGroup(pathname: string): string {
  const segs = pathname.split("/");
  const root = segs[1] ?? "";
  switch (root) {
    case "api": {
      const p = `/api/${segs[2] ?? ""}`;
      return apiGroups.has(p) ? p : "/api/other";
    }
    case "app-api": {
      const g = segs[2] ?? "";
      return appApiGroups.has(g) ? `/app-api/${g}` : "/app-api/other";
    }
    case "res":
      return "/res";
    case "r":
      return "/r";
    case "healthz":
      return "/healthz";
    case "metrics":
      return "/metrics";
    case "assets":
    case "style":
    case "files":
    case "setup":
    case "lemmas":
    case "groups":
    case "browse":
    case "wudict-admin":
      return "other";
    default:
      return "static";
  }
}

interface Histogram {
  counts: number[];
  sum: number;
  count: number;
}

export interface ExtraGauge {
  name: string;
  help: string;
  /** One reading per label set; the labels object may be empty. */
  read: () => { labels: Record<string, string>; value: number }[];
}

const escapeLabel = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const labelText = (labels: Record<string, string>) => {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
};
const num = (v: number) => (Number.isFinite(v) ? String(v) : v > 0 ? "+Inf" : v < 0 ? "-Inf" : "NaN");

export class Metrics {
  readonly #requests = new Map<string, number>();
  readonly #durations = new Map<string, Histogram>();
  readonly #extra: ExtraGauge[] = [];
  readonly #loop: ELDHistogram;
  readonly #startedAt = Date.now() / 1000;
  #inFlight = 0;

  constructor() {
    this.#loop = monitorEventLoopDelay({ resolution: 20 });
    this.#loop.enable();
  }

  /** Counts one finished request (status known once the handler has returned its Response). */
  observe(method: string, route: string, status: number, seconds: number): void {
    const key = `${method}\n${route}\n${String(status)}`;
    this.#requests.set(key, (this.#requests.get(key) ?? 0) + 1);
    let h = this.#durations.get(route);
    if (!h) this.#durations.set(route, (h = { counts: durationBuckets.map(() => 0), sum: 0, count: 0 }));
    for (let i = 0; i < durationBuckets.length; i++) if (seconds <= (durationBuckets[i] ?? 0)) h.counts[i] = (h.counts[i] ?? 0) + 1;
    h.sum += seconds;
    h.count++;
  }

  /** Middleware that times every request; mount first so it sees the final status. */
  middleware(): MiddlewareHandler {
    return async (c, next) => {
      const start = process.hrtime.bigint();
      this.#inFlight++;
      try {
        await next();
      } finally {
        this.#inFlight--;
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        // An error that escaped every handler ends as 500 in app.onError.
        this.observe(c.req.method, routeGroup(c.req.path), c.res.status || 500, seconds);
      }
    };
  }

  /** Adds gauges read on every scrape (e.g. database totals). */
  addGauge(g: ExtraGauge): void {
    this.#extra.push(g);
  }

  /** Stops the event-loop monitor (tests, shutdown). */
  close(): void {
    this.#loop.disable();
  }

  /** The Prometheus text exposition format (version 0.0.4). */
  render(): string {
    const out: string[] = [];
    const head = (name: string, type: string, help: string) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    };

    head("pxdict_http_requests_total", "counter", "HTTP requests handled, by method, route group and status.");
    for (const [key, n] of [...this.#requests].sort(([a], [b]) => a.localeCompare(b))) {
      const [method = "", route = "", status = ""] = key.split("\n");
      out.push(`pxdict_http_requests_total${labelText({ method, route, status })} ${String(n)}`);
    }

    head(
      "pxdict_http_request_duration_seconds",
      "histogram",
      "Time until the response headers were ready, by route group (streamed bodies continue after).",
    );
    for (const [route, h] of [...this.#durations].sort(([a], [b]) => a.localeCompare(b))) {
      durationBuckets.forEach((le, i) => {
        out.push(`pxdict_http_request_duration_seconds_bucket${labelText({ route, le: String(le) })} ${String(h.counts[i] ?? 0)}`);
      });
      out.push(`pxdict_http_request_duration_seconds_bucket${labelText({ route, le: "+Inf" })} ${String(h.count)}`);
      out.push(`pxdict_http_request_duration_seconds_sum${labelText({ route })} ${num(h.sum)}`);
      out.push(`pxdict_http_request_duration_seconds_count${labelText({ route })} ${String(h.count)}`);
    }

    head("pxdict_http_requests_in_flight", "gauge", "HTTP requests being handled (this scrape included).");
    out.push(`pxdict_http_requests_in_flight ${String(this.#inFlight)}`);

    const mem = process.memoryUsage();
    head("pxdict_process_resident_memory_bytes", "gauge", "Resident set size of the gateway process.");
    out.push(`pxdict_process_resident_memory_bytes ${String(mem.rss)}`);
    head("pxdict_nodejs_heap_used_bytes", "gauge", "V8 heap in use.");
    out.push(`pxdict_nodejs_heap_used_bytes ${String(mem.heapUsed)}`);
    head("pxdict_nodejs_heap_total_bytes", "gauge", "V8 heap allocated.");
    out.push(`pxdict_nodejs_heap_total_bytes ${String(mem.heapTotal)}`);
    head("pxdict_nodejs_external_memory_bytes", "gauge", "Memory of C++ objects bound to JavaScript (buffers).");
    out.push(`pxdict_nodejs_external_memory_bytes ${String(mem.external)}`);

    // Percentiles since the previous scrape (the monitor is reset after reading).
    head("pxdict_nodejs_eventloop_delay_seconds", "gauge", "Event-loop delay since the previous scrape, by quantile.");
    const loop = this.#loop;
    const seconds = (ns: number) => num(Number.isFinite(ns) ? ns / 1e9 : 0);
    out.push(`pxdict_nodejs_eventloop_delay_seconds{quantile="0.5"} ${seconds(loop.count ? loop.percentile(50) : 0)}`);
    out.push(`pxdict_nodejs_eventloop_delay_seconds{quantile="0.99"} ${seconds(loop.count ? loop.percentile(99) : 0)}`);
    out.push(`pxdict_nodejs_eventloop_delay_seconds{quantile="1"} ${seconds(loop.count ? loop.max : 0)}`);
    loop.reset();

    head("pxdict_process_start_time_seconds", "gauge", "Start time of the gateway process (Unix seconds).");
    out.push(`pxdict_process_start_time_seconds ${num(Math.floor(this.#startedAt))}`);

    for (const g of this.#extra) {
      head(g.name, "gauge", g.help);
      for (const { labels, value } of g.read()) out.push(`${g.name}${labelText(labels)} ${num(value)}`);
    }
    return out.join("\n") + "\n";
  }
}

export const metricsContentType = "text/plain; version=0.0.4; charset=utf-8";
