import { expect, test } from "bun:test";

import { copy } from "../src/copy";
import { glossaryFrom } from "../src/index";

/** The API's shape: sections whose terms are bold paragraphs, invented text. */
const API = `# CONTEXT — what our words mean

Intro the door leaves out.

## Who calls us

**Storefront side** — the part of this API a shop's own visitors reach. Whoever asks is a customer.

**Internal side** — the part only our own systems call.

## The vehicle catalog

**Brand** — the manufacturer.

## What we sell

Everything a shop lists, with its \`price\` and its [fit](https://example.invalid).
`;

/** The warehouse's shape: a domain heading with its own text and \`###\` terms, invented text. */
const WAREHOUSE = `# CONTEXT.md

Domain glossary.

## Order domain

How an order moves through the warehouse. Every order ends shipped or picked up.

### Order

A customer's order.

### Werkorder

A job in the workshop.

## Stock

### Shelf

A fixed place, coded like A3.
`;

test("each section gives its heading, its own first sentence and its terms, in order", () => {
  expect(glossaryFrom(API, { limit: 2000 }).split("\n")).toEqual([
    "Who calls us. Storefront side — the part of this API a shop's own visitors reach.",
    "The vehicle catalog. Brand — the manufacturer.",
    "What we sell. Everything a shop lists, with its price and its fit.",
  ]);
  expect(glossaryFrom(WAREHOUSE, { limit: 2000 }).split("\n")).toEqual([
    "Order domain. How an order moves through the warehouse. Termen: Order, Werkorder.",
    "Stock. Termen: Shelf.",
  ]);
});

test("past the limit, whole sections are left out and a closing line names them", () => {
  const glossary = glossaryFrom(API, { limit: 160 });

  expect(glossary.length).toBeLessThanOrEqual(160);
  expect(glossary.split("\n")).toEqual([
    "Who calls us. Storefront side — the part of this API a shop's own visitors reach.",
    copy.glossaryLeftOut(["The vehicle catalog", "What we sell"]),
  ]);
});
