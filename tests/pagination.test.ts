import { describe, expect, test } from "bun:test";

import { MAX_SIZE, MIN_SIZE, pageCount, pageWindow } from "~/domain/pagination.ts";

describe("pageWindow", () => {
  test("the first page starts at zero", () => {
    expect(pageWindow(1, 20)).toEqual({ limit: 20, offset: 0 });
  });

  test("later pages step by the clamped size", () => {
    expect(pageWindow(3, 20)).toEqual({ limit: 20, offset: 40 });
  });

  test("a page below the first is answered with the first", () => {
    expect(pageWindow(0, 20)).toEqual({ limit: 20, offset: 0 });
  });

  test("a size beyond the cap is clamped, not rejected", () => {
    expect(pageWindow(2, 5_000)).toEqual({ limit: MAX_SIZE, offset: MAX_SIZE });
  });

  // A window is rows, and a fraction of a row is not one. No Stryker mutator
  // removes a `Math.trunc`, so the mutation lane cannot ask for this case: the
  // property test's integrality checks and the two here are the whole of what
  // holds those calls in place.
  test("a fractional page and size are truncated, not carried through", () => {
    expect(pageWindow(2.9, 20.7)).toEqual({ limit: 20, offset: 20 });
  });
});

describe("pageCount", () => {
  test("an empty result set is still one page", () => {
    expect(pageCount(0, 20)).toBe(1);
  });

  test("a partial last page counts", () => {
    expect(pageCount(41, 20)).toBe(3);
  });

  test("a size below the floor is clamped", () => {
    expect(pageCount(3, 0)).toBe(3 / MIN_SIZE);
  });

  test("a fractional total counts the whole rows in it", () => {
    expect(pageCount(2.9, 1)).toBe(2);
  });
});
