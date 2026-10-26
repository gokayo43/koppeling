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

test("an area or a leaf named whole by the words outranks words matched across other names", () => {
  // Shaped like the API's door, where "product categories list" never
  // surfaced the area named "product-categories": summing word matches alone
  // ranks first whatever carries the rare "list" in its name.
  const { operations } = sketched([
    { name: "admin.products.categories.get", area: "admin.products", fields: ["search"] },
    { name: "admin.products.categories.id.get", area: "admin.products", fields: ["id"] },
    { name: "admin.products.get", area: "admin.products", fields: ["search", "category"] },
    { name: "product-categories.get" },
    { name: "product-categories.id.get", fields: ["id"] },
    { name: "products.get", fields: ["search", "category", "page"] },
    { name: "media-collections.list.get" },
  ]);

  expect(
    names(
      find(
        toDirectory({ operations, skipped: [], undescribed: [] }).search,
        "product categories list",
      ),
    ).slice(0, 2),
  ).toEqual(["product-categories.get", "product-categories.id.get"]);
});

test("an exact match on a one-word area ranks above a word met inside another name", () => {
  // "restock" carries "stock" inside it, and it is rarer than the area's
  // name, so ranking by rarity alone put orders.restock above stock.*.
  const { operations } = sketched([
    { name: "stock.get" },
    { name: "stock.levels" },
    { name: "stock.move", kind: "write" },
    { name: "orders.restock", kind: "write" },
    { name: "orders.get" },
    { name: "labels.get" },
  ]);
  const found = names(
    find(toDirectory({ operations, skipped: [], undescribed: [] }).search, "stock"),
  );

  expect(found.slice(0, 3).toSorted()).toEqual(["stock.get", "stock.levels", "stock.move"]);
});
