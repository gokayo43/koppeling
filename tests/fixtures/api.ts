/**
 * An API app shaped like gokayo43/nfp-elysia's vehicle and product routes:
 * their paths, query shapes and route details, with trivial handlers and
 * invented values only.
 */
import { Elysia, t } from "elysia";

export interface ApiActor {
  readonly key: string;
}

const API_KEY = "fixture-key";

/** A body schema that documents without gating, the way nfp-elysia's `documentedOnly()` builds one. */
const documentedOnly = (shape: ReturnType<typeof t.Object>) =>
  t.Union([t.Object(shape.properties, { additionalProperties: true }), t.Unknown()]);

export function apiApp(invoked: (route: string) => void = () => {}) {
  const auth = new Elysia({ name: "auth" }).onBeforeHandle(
    { as: "global" },
    ({ headers, status, path }) => {
      invoked(path);
      return headers["x-api-key"] === API_KEY ? undefined : status(401, "Unauthorized");
    },
  );

  const vehicles = new Elysia({ prefix: "/api/v1/vehicles" })
    .use(auth)
    .get(
      "/compatibility",
      ({ query }) => ({ data: { plate: query.license_plate ?? null, products: [] } }),
      {
        query: t.Object({
          license_plate: t.Optional(t.String()),
          chassis_id: t.Optional(t.Numeric()),
        }),
        detail: {
          summary: "Vehicle compatibility lookup",
          description:
            "Returns compatible products and services for a vehicle identified by license plate, chassis IDs, or vehicle parameters.",
        },
      },
    )
    .get(
      "/lookup",
      ({ query, status }) =>
        query.license_plate === "00-XX-00"
          ? status(404, { error: { code: "plate_not_found", message: "Kenteken niet gevonden" } })
          : { data: { lookup_id: "lk-1", vehicles: [{ brand: "Merk", model: "Model" }] } },
      {
        query: t.Object({ license_plate: t.String() }),
        detail: {
          summary: "License plate vehicle lookup",
          description: "Resolves a Dutch license plate to its vehicle.",
        },
      },
    )
    .get("/products", () => ({ data: [] }), {
      query: t.Object({ license_plate: t.Optional(t.String()), category: t.Optional(t.String()) }),
      detail: { summary: "Compatible products for a vehicle" },
    })
    .get("/services", () => ({ data: [] }), {
      query: t.Object({ license_plate: t.Optional(t.String()) }),
      detail: { summary: "Available services for a vehicle" },
    })
    .post("/lookup/:lookup_id/selection", ({ params }) => ({ logged: params.lookup_id }), {
      params: t.Object({ lookup_id: t.String() }),
      body: t.Object({ option_index: t.Number() }),
      detail: { summary: "Log user selection on an ambiguous lookup" },
    })
    .get("/tree", () => ({ brands: [] }), {
      detail: { summary: "The brand, model and chassis tree" },
    });

  const products = new Elysia({ prefix: "/api/v1/products" })
    .use(auth)
    .model({
      "nfp.products.item": t.Object({ id: t.Number(), name: t.String(), price: t.Number() }),
    })
    .get("/", () => ({ data: [] }), {
      query: t.Object({ search: t.Optional(t.String()), page: t.Optional(t.Numeric()) }),
      detail: { summary: "List published products with filtering and pagination" },
    })
    .get("/:id", ({ params }) => ({ id: params.id, name: "Product", price: 10 }), {
      params: t.Object({ id: t.Numeric() }),
      response: { 200: "nfp.products.item" },
      detail: { summary: "One published product" },
    })
    .get("/:id/vehicles", () => ({ data: [] }), {
      params: t.Object({ id: t.Numeric() }),
      detail: {
        summary: "Vehicles a product fits",
        description: "The chassis periods and trims this product is fitted to.",
      },
    })
    .get("/:id/price", () => ({ price: 10 }), {
      params: t.Object({ id: t.Numeric() }),
      query: t.Object({ chassis_period_id: t.Optional(t.Numeric()) }),
      detail: { summary: "Price of a product for a vehicle" },
    });

  const orders = new Elysia({ prefix: "/api/v1/orders" })
    .use(auth)
    .post("/", ({ body }) => ({ token: "ord-1", body }), {
      body: documentedOnly(
        t.Object({ items: t.Array(t.Object({ sku: t.String(), quantity: t.Number() })) }),
      ),
      detail: { summary: "Start a draft order" },
    })
    .get("/:token", ({ params }) => ({ token: params.token, lines: [] }), {
      detail: { summary: "A draft order" },
    })
    .patch("/:token/customer", () => ({ updated: true }), {
      body: t.Object({ name: t.Optional(t.String()), phone: t.Optional(t.String()) }),
      detail: { summary: "Update the customer on a draft order" },
    })
    .post("/discounts/validate", () => ({ valid: false }), {
      body: t.Object({ code: t.String() }),
      detail: { summary: "Check a discount code" },
    })
    .get("/fail", () => {
      throw new Error("database unavailable");
    });

  return new Elysia()
    .get("/health", () => "ok")
    .ws("/api/v1/live", { message() {} })
    .use(vehicles)
    .use(products)
    .use(orders);
}

export const credential = (actor: ApiActor) => ({ "x-api-key": actor.key });
