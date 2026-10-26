import { expect, test } from "bun:test";

import { check } from "@gokayo43/dev-config/property";
import { jsonValue, property } from "fast-check";

import { boundedJson, toJson, TRUNCATED } from "../src/json";

test("a JSON value becomes itself, as JSON.stringify would write it", () => {
  check(
    property(jsonValue(), (value) => {
      const generated: unknown = value;
      const written: unknown = JSON.parse(JSON.stringify(generated));
      const converted: unknown = toJson(generated);
      expect(converted).toEqual(written);
    }),
  );
});

test("what superjson and drizzle hand back is written as JSON rather than lost", () => {
  const decimal = { toJSON: () => "12.50" };
  expect(
    toJson({
      count: 12n,
      at: new Date(Date.UTC(2026, 0, 2)),
      bySku: new Map([["SKU-1", 3]]),
      tags: new Set(["a", "b"]),
      price: decimal,
      gone: undefined,
      notANumber: Number.NaN,
      nested: [undefined, () => 1],
    }),
  ).toEqual({
    count: "12",
    at: "2026-01-02T00:00:00.000Z",
    bySku: { "SKU-1": 3 },
    tags: ["a", "b"],
    price: "12.50",
    notANumber: null,
    nested: [null, null],
  });
  expect(toJson(undefined)).toBeNull();
  // The property above found it: JSON.stringify writes -0 as 0.
  expect(Object.is(toJson(-0), 0)).toBe(true);
});

test("a refusal's details are cut at a total budget of values, so shared references cannot make them explode", () => {
  // Shared references are walked once per parent: eight shared keys over ten
  // levels is 8^10 values, which never finished before the budget.
  interface Shared {
    readonly [key: string]: Shared;
  }
  let level: Shared = {};
  for (let depth = 0; depth < 10; depth += 1) {
    const below = level;
    level = Object.fromEntries(Array.from({ length: 8 }, (_, key) => [`k${key}`, below]));
  }
  const written = JSON.stringify(boundedJson(level));

  expect(written).toContain(JSON.stringify(TRUNCATED));
  expect(written.split("{").length - 1).toBeLessThanOrEqual(10_000);
});
