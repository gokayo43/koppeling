import { expect, test } from "bun:test";

import { toDirectory } from "../src/directory";
import { find, FIND_LIMIT, stems } from "../src/find";
import { sketched } from "./support/operations";

const names = (operations: readonly { readonly name: string }[]) =>
  operations.map(({ name }) => name);

test("an operation the words describe outranks one whose name only shares a word", () => {
  // The likeliest wrong ranking reads names alone: "stock" is in the first
  // name, while only the second's description says what the words ask for.
  const { operations } = sketched([
    { name: "stock.adjust", description: "Corrigeert een telling achteraf." },
    {
      name: "counting.countRow",
      kind: "write",
      description:
        "Legt de getelde voorraad van een sku op een plank vast; de stock van die plank wordt de telling.",
    },
  ]);

  expect(
    names(
      find(
        toDirectory({ operations, skipped: [], undescribed: [] }).search,
        "stock tellen op plank",
      ),
    ),
  ).toEqual(["counting.countRow", "stock.adjust"]);
});

test("Dutch inflections meet their stems, and camelCase names are words", () => {
  expect(stems("gepickt")).toEqual(stems("picked"));
  expect(stems("bestellingen")).toEqual(stems("bestelling"));
  expect(stems("leveranciers")).toEqual(stems("leverancier"));
  expect(stems("markPicked")).toEqual(["mark", ...stems("picked")]);
  expect(stems("welke van de")).toEqual([]);
});

test("a word in the input's fields counts, and a word no operation carries finds nothing", () => {
  const { operations } = sketched([
    { name: "orders.get", fields: ["orderId"] },
    { name: "inventory.bySku", fields: ["sku"] },
  ]);

  expect(
    names(find(toDirectory({ operations, skipped: [], undescribed: [] }).search, "sku")),
  ).toEqual(["inventory.bySku"]);
  expect(find(toDirectory({ operations, skipped: [], undescribed: [] }).search, "offerte")).toEqual(
    [],
  );
});

test("find answers at most ten, best first, ties in name order", () => {
  const { operations } = sketched(
    Array.from({ length: 14 }, (_, index) => ({
      name: `labels.l${String(index).padStart(2, "0")}`,
      description: "Print een label.",
    })),
  );
  const found = names(
    find(toDirectory({ operations, skipped: [], undescribed: [] }).search, "label"),
  );

  expect(found).toHaveLength(FIND_LIMIT);
  expect(found).toEqual(found.toSorted());
});
