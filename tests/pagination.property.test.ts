import { expect, test } from "bun:test";

import { type Arbitrary, assert, double, integer, nat, oneof, property } from "fast-check";

import { MAX_SIZE, MIN_SIZE, pageCount, pageWindow } from "~/domain/pagination.ts";

/**
 * Whole and fractional both, because a page number and a page size arrive off a
 * query string and nothing upstream rounds them. Both, rather than `double`
 * alone: over 20,000 draws `double({ min: -1000, max: 1000 })` was integral
 * 0.82% of the time and the only integer it ever produced inside the clamp
 * window was 0, so dropping the integer arbitrary would trade away every
 * MIN_SIZE/MAX_SIZE boundary these generators used to reach.
 *
 * `total` stays whole: it is a row count, and the invariant below is about how
 * rows tile, not about what a fraction of one would mean.
 */
const anyNumber = (min: number, max: number): Arbitrary<number> =>
  oneof(integer({ min, max }), double({ min, max, noNaN: true }));

const anyPage = anyNumber(-1_000, 1_000);
const anySize = anyNumber(-1_000, 1_000);

test("the window is always a legal slice, whatever the caller asks for", () => {
  assert(
    property(anyPage, anySize, (page, size) => {
      const { limit, offset } = pageWindow(page, size);
      expect(limit).toBeGreaterThanOrEqual(MIN_SIZE);
      expect(limit).toBeLessThanOrEqual(MAX_SIZE);
      expect(Number.isInteger(limit)).toBe(true);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(offset)).toBe(true);
    }),
  );
});

test("consecutive pages tile the result set without gap or overlap", () => {
  assert(
    property(integer({ min: 1, max: 1_000 }), anySize, (page, size) => {
      const here = pageWindow(page, size);
      const next = pageWindow(page + 1, size);
      expect(next.offset).toBe(here.offset + here.limit);
    }),
  );
});

test("every row of a total lands on exactly one page", () => {
  assert(
    property(nat({ max: 10_000 }), anySize, (total, size) => {
      const pages = pageCount(total, size);
      const last = pageWindow(pages, size);
      expect(last.offset).toBeLessThan(Math.max(1, total));
      expect(last.offset + last.limit).toBeGreaterThanOrEqual(total);
    }),
  );
});
