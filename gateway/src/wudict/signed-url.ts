// Signed resource URLs for sandboxed dictionary iframes (docs/PLAN.md Phase 4).
//
// A `sandbox="allow-scripts"` iframe has an opaque origin, so its requests carry no session cookie.
// Entry HTML returned by /api/search therefore references resources as
//   /r/<token>/<dict>/<path>     instead of     /res/<dict>/<path>
// where <token> = base64url("<userId>:<expiresAt>") "." base64url(HMAC-SHA256(key, payload + dict)).
//
// Expiry is rounded up to a whole bucket so a user's token for one dictionary stays the same for a
// while: browsers and the service worker can reuse cached resources, and offline copies of a lookup
// are served from the service worker's cache (keyed without the token). A token is valid for
// 1–2 buckets. It is a capability: anyone holding it can read that dictionary's resources until it
// expires, which is the same exposure as the entry HTML that contains it.
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** Length of one expiry bucket. */
export const bucketMs = 60 * 60 * 1000;

const sigBytes = 16;

export interface VerifiedToken {
  userId: string;
  expiresAt: number;
}

export class ResourceSigner {
  readonly #key: Buffer;
  readonly #now: () => number;

  /** `secret` is BETTER_AUTH_SECRET; a separate key is derived from it for this purpose only. */
  constructor(secret: string, now: () => number = Date.now) {
    this.#key = Buffer.from(hkdfSync("sha256", secret, "pxdict", "pxdict resource url v1", 32));
    this.#now = now;
  }

  #sign(payload: string, dict: string): Buffer {
    return createHmac("sha256", this.#key).update(`${payload}\n${dict}`).digest().subarray(0, sigBytes);
  }

  /** The token for one user and dictionary, valid until the end of the next bucket. */
  token(userId: string, dict: string): string {
    const expiresAt = (Math.floor(this.#now() / bucketMs) + 2) * bucketMs;
    const payload = `${userId}:${String(expiresAt)}`;
    return `${Buffer.from(payload).toString("base64url")}.${this.#sign(payload, dict).toString("base64url")}`;
  }

  /** The signed prefix replacing `/res/<dict>/`. */
  prefix(userId: string, dict: string): string {
    return `/r/${this.token(userId, dict)}/${dict}/`;
  }

  /** Checks a token for `dict`; undefined when malformed, forged, for another dictionary, or expired. */
  verify(token: string, dict: string): VerifiedToken | undefined {
    const dot = token.indexOf(".");
    if (dot <= 0 || token.length > 512) return undefined;
    const payload = Buffer.from(token.slice(0, dot), "base64url").toString();
    const given = Buffer.from(token.slice(dot + 1), "base64url");
    if (given.length !== sigBytes || !timingSafeEqual(given, this.#sign(payload, dict))) return undefined;
    const m = /^([^:]+):(\d{1,16})$/.exec(payload);
    if (!m?.[1] || !m[2]) return undefined;
    const expiresAt = Number(m[2]);
    if (expiresAt <= this.#now()) return undefined;
    return { userId: m[1], expiresAt };
  }
}

/** Rewrites wuDict's `/res/<dict>/` references in one article to the signed prefix. */
export function signArticle(body: string, dict: string, signedPrefix: string): string {
  return body.replaceAll(`/res/${dict}/`, signedPrefix);
}
