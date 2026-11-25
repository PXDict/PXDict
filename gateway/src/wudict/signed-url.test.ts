import { describe, expect, it } from "vitest";
import { bucketMs, ResourceSigner, signArticle } from "./signed-url";

const secret = "s".repeat(40);

describe("ResourceSigner", () => {
  it("verifies its own tokens for the same dictionary only", () => {
    const signer = new ResourceSigner(secret, () => 1_000_000);
    const token = signer.token("user1", "aaaaaaaaaaaa");
    expect(signer.verify(token, "aaaaaaaaaaaa")).toMatchObject({ userId: "user1" });
    expect(signer.verify(token, "bbbbbbbbbbbb")).toBeUndefined();
    expect(new ResourceSigner("t".repeat(40), () => 1_000_000).verify(token, "aaaaaaaaaaaa")).toBeUndefined();
  });

  it("keeps the token stable within a bucket and expires it after one to two buckets", () => {
    let now = 5 * bucketMs + 10;
    const signer = new ResourceSigner(secret, () => now);
    const token = signer.token("u", "d");
    now += 1000;
    expect(signer.token("u", "d")).toBe(token);
    now = 6 * bucketMs + 1;
    expect(signer.verify(token, "d")).toBeDefined();
    now = 7 * bucketMs;
    expect(signer.verify(token, "d")).toBeUndefined();
  });

  it("rejects a changed payload", () => {
    const signer = new ResourceSigner(secret);
    const [, sig] = signer.token("alice", "d").split(".");
    const payload = Buffer.from(`bob:${String(Date.now() + bucketMs)}`).toString("base64url");
    expect(signer.verify(`${payload}.${sig ?? ""}`, "d")).toBeUndefined();
    expect(signer.verify("", "d")).toBeUndefined();
    expect(signer.verify("a.b.c", "d")).toBeUndefined();
  });
});

describe("signArticle", () => {
  it("rewrites only the dictionary's own prefix", () => {
    const html = '<img src="/res/d1/a.png"><link href="/res/d1/s.css"><img src="/res/d2/x.png">';
    expect(signArticle(html, "d1", "/r/T/d1/")).toBe(
      '<img src="/r/T/d1/a.png"><link href="/r/T/d1/s.css"><img src="/res/d2/x.png">',
    );
  });
});
