import { expect, test } from "bun:test";

import { check } from "@gokayo43/dev-config/property";
import { jsonValue, property } from "fast-check";

import { toJson } from "../src/json";

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
