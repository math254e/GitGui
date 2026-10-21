/**
 * The typed RPC table and the Rust method registry must agree.
 *
 * The registry is generated into the contract from the Rust protocol crate,
 * and the table below maps each method to its payload and result. If the
 * server adds, removes, or renames a method, this test fails until the
 * table follows.
 */
import { WS_METHOD_NAMES as CONTRACT_METHOD_NAMES } from "@gitgui/contracts";
import { describe, expect, it } from "@effect/vitest";

import { WS_METHOD_NAMES, WS_METHODS } from "./protocol.ts";

describe("the GitGui RPC protocol", () => {
  it("covers every method the server accepts", () => {
    expect([...WS_METHOD_NAMES].sort()).toEqual([...CONTRACT_METHOD_NAMES].sort());
  });

  it("names every method once", () => {
    const named = Object.values(WS_METHODS);
    expect(new Set(named).size).toBe(named.length);
    expect(named.sort()).toEqual([...WS_METHOD_NAMES].sort());
  });
});
