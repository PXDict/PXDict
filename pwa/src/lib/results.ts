// Folds the /api/search NDJSON stream into per-dictionary result slots (pure; tested).
import type { SearchLine, SearchResult } from "../api/wudict";

export type SlotState = "pending" | "found" | "empty" | "skipped" | "deferred" | "error";

export interface Slot {
  dict: string;
  name: string;
  state: SlotState;
  results: SearchResult[];
  /** The lemma these results answer, when wuDict searched a base form instead of the query. */
  lemma?: string;
}

export interface SearchState {
  slots: Slot[];
  /** Set by a `morph` line: following hits answer `to` instead of the query as typed. */
  morph?: { from: string; to: string };
  done: boolean;
}

export const emptySearch: SearchState = { slots: [], done: false };

export function applyLine(state: SearchState, line: SearchLine): SearchState {
  switch (line.t) {
    case "begin":
      return {
        done: false,
        slots: line.slots.map((s) => ({ dict: s.dict ?? "", name: s.name ?? s.dict ?? "", state: "pending", results: [] })),
      };
    case "morph":
      return { ...state, morph: { from: line.from, to: line.to } };
    case "hit": {
      const old = state.slots[line.i];
      if (!old) return state;
      // A dictionary may answer twice (a miss, then a hit for the lemma); a final answer stays.
      if (old.state !== "pending" && old.state !== "empty") return state;
      const results = line.results ?? [];
      const slot: Slot = {
        dict: line.dict ?? old.dict,
        name: line.name ?? old.name,
        results,
        state: line.error
          ? "error"
          : line.skipped
            ? "skipped"
            : line.deferred
              ? "deferred"
              : results.length
                ? "found"
                : "empty",
        ...(results.length && state.morph ? { lemma: state.morph.to } : {}),
      };
      const slots = state.slots.slice();
      slots[line.i] = slot;
      return { ...state, slots };
    }
    case "end":
      return {
        ...state,
        done: true,
        // A slot nobody answered is a miss.
        slots: state.slots.map((s) => (s.state === "pending" ? { ...s, state: "empty" } : s)),
      };
  }
}
