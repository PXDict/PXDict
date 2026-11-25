import { describe, expect, it } from "vitest";
import type { SearchLine } from "../api/wudict";
import { applyLine, emptySearch, type SearchState } from "./results";

const run = (lines: SearchLine[]): SearchState => lines.reduce(applyLine, emptySearch);
const begin: SearchLine = { t: "begin", slots: [{ dict: "a", name: "a" }, { dict: "b", name: "b" }, { dict: "c", name: "c" }] };

describe("applyLine", () => {
  it("fills slots by index in slot order, whatever order hits arrive in", () => {
    const s = run([
      begin,
      { t: "hit", i: 2, dict: "c", name: "Gamma", results: [{ Headword: "cat", Body: "x" }] },
      { t: "hit", i: 0, dict: "a", name: "Alpha" },
    ]);
    expect(s.slots.map((x) => [x.name, x.state])).toEqual([
      ["Alpha", "empty"],
      ["b", "pending"],
      ["Gamma", "found"],
    ]);
    expect(s.done).toBe(false);
  });

  it("marks unanswered slots as misses at the end", () => {
    const s = run([begin, { t: "end" }]);
    expect(s.done).toBe(true);
    expect(s.slots.every((x) => x.state === "empty")).toBe(true);
  });

  it("lets a lemma hit replace a miss and records the lemma", () => {
    const s = run([
      begin,
      { t: "hit", i: 0, dict: "a" },
      { t: "morph", from: "cats", to: "cat", lang: "en" },
      { t: "hit", i: 0, dict: "a", results: [{ Headword: "cat", Body: "x" }] },
    ]);
    expect(s.morph).toEqual({ from: "cats", to: "cat" });
    expect(s.slots[0]).toMatchObject({ state: "found", lemma: "cat" });
  });

  it("keeps final answers and classifies skipped, deferred and failed dictionaries", () => {
    const s = run([
      begin,
      { t: "hit", i: 0, dict: "a", results: [{ Headword: "x", Body: "1" }] },
      { t: "hit", i: 0, dict: "a", results: [] },
      { t: "hit", i: 1, dict: "b", skipped: true },
      { t: "hit", i: 2, dict: "c", deferred: true },
      { t: "hit", i: 7, dict: "z", results: [] },
    ]);
    expect(s.slots.map((x) => x.state)).toEqual(["found", "skipped", "deferred"]);
    expect(run([begin, { t: "hit", i: 1, dict: "b", error: "dictionary unavailable" }]).slots[1]?.state).toBe("error");
  });
});
