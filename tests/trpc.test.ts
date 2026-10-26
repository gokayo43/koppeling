import { expect, test } from "bun:test";

import { check } from "@gokayo43/dev-config/property";
import { initTRPC, lazy, type AnyTRPCRouter } from "@trpc/server";
import { Schema } from "effect";
import {
  constantFrom,
  dictionary,
  letrec,
  property,
  stringMatching,
  type Arbitrary,
} from "fast-check";
import { z } from "zod";

import { fromTrpcRouter } from "../src/index";
import { contextFor, warehouseRouter } from "./fixtures/warehouse";

/** A signal no case aborts, for a run the case lets finish. */
const unaborted = new AbortController().signal;

const t = initTRPC.context<object>().meta<{ description?: string; koppeling?: boolean }>().create();
const MCP_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

type Kind = "query" | "mutation" | "subscription";
interface Tree {
  readonly [key: string]: Kind | Tree;
}

/** Router trees of any depth and procedure mix, keyed the way router keys are written. */
const trees: Arbitrary<Tree> = letrec<{ tree: Tree; node: Kind | Tree }>((tie) => ({
  tree: dictionary(stringMatching(/^[a-z][A-Za-z0-9]{0,8}$/), tie("node"), { maxKeys: 4 }),
  node: constantFrom<Kind | "tree">("query", "mutation", "subscription", "tree").chain(
    (kind): Arbitrary<Kind | Tree> => (kind === "tree" ? tie("tree") : constantFrom(kind)),
  ),
})).tree;

function leaves(tree: Tree, prefix = ""): [string, Kind][] {
  return Object.entries(tree).flatMap(([key, node]) =>
    typeof node === "string" ? [[`${prefix}${key}`, node]] : leaves(node, `${prefix}${key}.`),
  );
}

function routerOf(tree: Tree): AnyTRPCRouter {
  return t.router(
    Object.fromEntries(
      Object.entries(tree).map(([key, node]) => {
        if (node === "query") return [key, t.procedure.query(() => key)];
        if (node === "mutation") return [key, t.procedure.mutation(() => key)];
        if (node === "subscription") return [key, t.procedure.subscription(async function* () {})];
        return [key, routerOf(node)];
      }),
    ),
  );
}

test("every query and mutation appears once, with its kind and area; subscriptions are skipped and named", () => {
  check(
    property(trees, (tree) => {
      const procedures = leaves(tree);
      const derived = fromTrpcRouter(routerOf(tree), { contextFor: () => ({}) });

      const served = procedures.filter(([, kind]) => kind !== "subscription");
      expect(
        derived.operations.map(({ name, kind, area }) => `${name} ${kind} ${area}`).toSorted(),
      ).toEqual(
        served
          .map(
            ([path, kind]) =>
              `${path} ${kind === "query" ? "read" : "write"} ${path.split(".")[0] ?? ""}`,
          )
          .toSorted(),
      );
      expect(derived.skipped.map(({ name }) => name).toSorted()).toEqual(
        procedures
          .filter(([, kind]) => kind === "subscription")
          .map(([path]) => path)
          .toSorted(),
      );
      for (const { name } of derived.operations) expect(name).toMatch(MCP_NAME);
      expect(new Set(derived.operations.map(({ name }) => name)).size).toBe(
        derived.operations.length,
      );
    }),
  );
});

test("two derivations of one router agree, in order", () => {
  check(
    property(trees, (tree) => {
      const once = fromTrpcRouter(routerOf(tree), { contextFor: () => ({}) });
      const again = fromTrpcRouter(routerOf(tree), { contextFor: () => ({}) });
      expect(again.operations.map(({ name }) => name)).toEqual(
        once.operations.map(({ name }) => name),
      );
    }),
  );
});

test("a procedure added to the router appears with no other change", () => {
  const before = fromTrpcRouter(warehouseRouter(), { contextFor });
  const grown = t.router({
    warehouse: warehouseRouter(),
    returns: t.router({
      announce: t.procedure.input(z.object({ orderId: z.number() })).mutation(() => ({})),
    }),
  });
  const after = fromTrpcRouter(grown, { contextFor: () => ({}) });

  expect(after.operations.map(({ name }) => name)).toEqual(
    [...before.operations.map(({ name }) => `warehouse.${name}`), "returns.announce"].toSorted(),
  );
});

test("each schema language's input becomes JSON Schema, and meta.description becomes the description", () => {
  const router = t.router({
    effect: t.procedure
      .meta({ description: "  Effect input.  " })
      .input(Schema.standardSchemaV1(Schema.Struct({ orderId: Schema.Int })))
      .query(() => 1),
    zod: t.procedure.input(z.object({ name: z.string() })).query(() => 1),
    none: t.procedure.query(() => 1),
    stacked: t.procedure
      .input(z.object({ a: z.string() }))
      .input(z.object({ b: z.number() }))
      .query(() => 1),
    omittable: t.procedure
      .input(Schema.standardSchemaV1(Schema.UndefinedOr(Schema.Struct({ page: Schema.Int }))))
      .query(() => 1),
  });
  const byName = new Map(
    fromTrpcRouter(router, { contextFor: () => ({}) }).operations.map((op) => [op.name, op]),
  );

  expect(byName.get("effect")).toMatchObject({
    description: "Effect input.",
    input: { type: "object", required: ["orderId"] },
  });
  expect(byName.get("zod")).toMatchObject({
    description: undefined,
    input: { type: "object", required: ["name"] },
  });
  expect(byName.get("none")?.input).toEqual({
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  expect(byName.get("stacked")?.input).toMatchObject({
    allOf: [{ required: ["a"] }, { required: ["b"] }],
  });
  expect(byName.get("omittable")?.input).toMatchObject({ type: "object", required: ["page"] });
});

test("a schema in no language the door reads fails the boot, naming the procedure", () => {
  const router = t.router({
    orders: t.router({ legacy: t.procedure.input((value) => value).query(() => 1) }),
  });

  expect(() => fromTrpcRouter(router, { contextFor: () => ({}) })).toThrow(
    'tRPC procedure "orders.legacy"',
  );
});

test("a schema its language cannot write as JSON Schema is served, described as such, and reported", () => {
  const router = t.router({
    users: t.router({
      get: t.procedure
        .output(Schema.standardSchemaV1(Schema.Struct({ createdAt: Schema.ValidDateFromSelf })))
        .query(() => ({ createdAt: new Date() })),
    }),
  });
  const derived = fromTrpcRouter(router, { contextFor: () => ({}) });

  expect(derived.operations.map(({ name }) => name)).toEqual(["users.get"]);
  expect(derived.operations[0]?.output).toHaveProperty("description");
  expect(derived.undescribed.map(({ name }) => name)).toEqual(["users.get"]);
  expect(derived.undescribed[0]?.reason).toStartWith("output: Missing annotation");
});

test("a router with lazy sub-routers fails the boot rather than offering part of itself", () => {
  const lazyRouter = t.router({
    later: lazy(async () => t.router({ x: t.procedure.query(() => 1) })),
  });

  expect(() => fromTrpcRouter(lazyRouter, { contextFor: () => ({}) })).toThrow("lazy");
});

test("a procedure the program withholds from the door is skipped and named", () => {
  const router = t.router({
    users: t.router({
      getWithPin: t.procedure.meta({ koppeling: false }).query(() => "0000"),
      list: t.procedure.query(() => []),
    }),
  });
  const derived = fromTrpcRouter(router, { contextFor: () => ({}) });

  expect(derived.operations.map(({ name }) => name)).toEqual(["users.list"]);
  expect(derived.skipped).toEqual([
    { name: "users.getWithPin", reason: "withheld by the program" },
  ]);
});

test("a name outside MCP's characters fails the boot", () => {
  expect(() =>
    fromTrpcRouter(t.router({ "zet op": t.procedure.query(() => 1) }), { contextFor: () => ({}) }),
  ).toThrow('"zet op" is not a valid operation name');
});

test("the router's own middleware chain runs for a call, with the context contextFor built", async () => {
  const seen: unknown[] = [];
  const guarded = t.router({
    whoami: t.procedure
      .use(({ ctx, next }) => {
        seen.push(ctx);
        return next();
      })
      .query(({ ctx }) => ctx),
  });
  const [whoami] = fromTrpcRouter(guarded, {
    contextFor: (actor: { readonly id: number }) => ({ person: actor.id }),
  }).operations;

  expect(await whoami?.run({ id: 7 }, undefined, unaborted)).toEqual({ value: { person: 7 } });
  expect(seen).toEqual([{ person: 7 }]);
});
