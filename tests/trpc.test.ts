import { expect, test } from "bun:test";

import { check } from "@gokayo43/dev-config/property";
import { initTRPC, lazy, TRPCError, type AnyTRPCRouter } from "@trpc/server";
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

import { fromTrpcRouter, type Json, type KoppelingMeta } from "../src/index";
import { contextFor, warehouseRouter } from "./fixtures/warehouse";

/** A signal no case aborts, for a run the case lets finish. */
const unaborted = new AbortController().signal;

const t = initTRPC
  .context<object>()
  .meta<{ description?: string; koppeling?: false | KoppelingMeta }>()
  .create();
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
    written: true,
    input: { type: "object", required: ["orderId"] },
  });
  expect(byName.get("zod")).toMatchObject({
    written: false,
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

test("a refusal's details are the cause's own details object, and nothing else of the cause", async () => {
  // The likeliest wrong forwards every field of the cause, so whatever object
  // a program attached, internal fields included, reaches the agent.
  class Refusal extends Error {
    readonly details: { readonly [key: string]: Json };
    constructor(message: string, details: { readonly [key: string]: Json }) {
      super(message);
      this.details = details;
    }
  }
  const databaseError = Object.assign(new Error("duplicate key"), {
    table: "carriers",
    details: "Key (name)=(ups) already exists.",
  });
  const router = t.router({
    carrier: t.procedure.input(z.object({ name: z.string() })).mutation(({ input }) => {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Onbekende vervoerder "${input.name}"`,
        cause: { details: { opties: ["dhl", "postnl"] }, internal: "carrier-table-v2" },
      });
    }),
    shelf: t.procedure.mutation(() => {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Onbekende plank",
        cause: new Refusal("Onbekende plank", { opties: ["A1", "B2"] }),
      });
    }),
    bare: t.procedure.mutation(() => {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Nee", cause: { options: ["a"] } });
    }),
    duplicate: t.procedure.mutation(() => {
      throw new TRPCError({ code: "CONFLICT", message: "Bestaat al", cause: databaseError });
    }),
  });
  const run = runner(router);

  expect(await run("carrier", { name: "ups" })).toEqual({
    refusal: 'Onbekende vervoerder "ups"',
    details: { opties: ["dhl", "postnl"] },
  });
  expect(await run("shelf", undefined)).toEqual({
    refusal: "Onbekende plank",
    details: { opties: ["A1", "B2"] },
  });
  expect(await run("bare", undefined)).toEqual({ refusal: "Nee" });
  expect(await run("duplicate", undefined)).toEqual({ refusal: "Bestaat al" });
});

test("an input's issues come from the procedure's own schema before it runs, and never from a program's error", async () => {
  // The likeliest wrong forwards any error cause's issues, so a program's
  // BAD_REQUEST that happens to carry them hands the agent its internals.
  const ran: string[] = [];
  const router = t.router({
    carrier: t.procedure
      .use(({ path, next }) => {
        ran.push(path);
        return next();
      })
      .input(z.object({ name: z.string() }))
      .input(z.object({ note: z.string().optional() }))
      .mutation(() => 1),
    thrown: t.procedure.mutation(() => {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Ongeldige order",
        cause: { issues: [{ message: "intern", path: ["secret"] }] },
      });
    }),
    both: t.procedure.mutation(() => {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Nee",
        cause: { issues: [{ message: "intern" }], details: { opties: ["a"] } },
      });
    }),
  });
  const run = runner(router);

  const refused = await run("carrier", { name: 7, note: 8 });
  expect(refused).toMatchObject({
    details: { issues: [{ path: ["name"] }, { path: ["note"] }] },
  });
  expect("refusal" in refused && refused.refusal).toBe(
    "Invalid input: expected string, received number",
  );
  expect(ran).toEqual([]);
  expect(await run("carrier", { name: "dhl" })).toEqual({ value: 1 });
  expect(ran).toEqual(["carrier"]);
  expect(await run("thrown", undefined)).toEqual({ refusal: "Ongeldige order" });
  expect(await run("both", undefined)).toEqual({ refusal: "Nee", details: { opties: ["a"] } });
});

test("details that loop, nest errors or cannot be read are bounded, and the refusal still comes back", async () => {
  interface Looping {
    readonly opties: readonly string[];
    self?: Looping;
  }
  interface Nested {
    readonly below?: Nested;
  }
  const looping: Looping = { opties: ["a"] };
  looping.self = looping;
  let deep: Nested = {};
  for (let level = 0; level < 50; level += 1) deep = { below: deep };
  const unreadable = Object.defineProperty(new Error("kapot"), "details", {
    get() {
      throw new Error("getter failed");
    },
  });
  const router = t.router({
    looping: t.procedure.mutation(() => {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Lus", cause: { details: looping } });
    }),
    nested: t.procedure.mutation(() => {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Genest",
        cause: { details: { reden: new Error("plank vol"), diep: deep } },
      });
    }),
    unreadable: t.procedure.mutation(() => {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Onleesbaar", cause: unreadable });
    }),
  });
  const run = runner(router);

  expect(await run("looping", undefined)).toEqual({
    refusal: "Lus",
    details: { opties: ["a"], self: "[ingekort]" },
  });
  const nested = await run("nested", undefined);
  expect(nested).toMatchObject({ refusal: "Genest", details: { reden: "plank vol" } });
  expect(JSON.stringify(nested).split("below").length - 1).toBeLessThan(50);
  expect(await run("unreadable", undefined)).toEqual({ refusal: "Onleesbaar" });
});

/** Runs a router's procedure by name, as nobody in particular. */
function runner(router: AnyTRPCRouter) {
  const operations = fromTrpcRouter(router, { contextFor: () => ({}) }).operations;
  return (name: string, input: Json | undefined) => {
    const found = operations.find((operation) => operation.name === name);
    if (found === undefined) throw new Error(`no ${name}`);
    return found.run(null, input, unaborted);
  };
}

test("a query neither destroys nor repeats anything, a mutation is destructive and not idempotent, and meta.koppeling overrides either", () => {
  // The likeliest wrong derivation calls a mutation harmless, so an agent
  // retries a payment; the override is the program's word on its own write.
  const router = t.router({
    stock: t.procedure.query(() => 1),
    ship: t.procedure.mutation(() => 1),
    setStatus: t.procedure
      .meta({ koppeling: { destructive: false, idempotent: true } })
      .mutation(() => 1),
    purge: t.procedure.meta({ koppeling: { idempotent: true } }).mutation(() => 1),
    secret: t.procedure.meta({ koppeling: false }).mutation(() => 1),
  });
  const hints = fromTrpcRouter(router, { contextFor: () => ({}) }).operations.map(
    ({ name, destructive, idempotent }) => [name, destructive, idempotent],
  );

  expect(hints).toEqual([
    ["purge", true, true],
    ["setStatus", false, true],
    ["ship", true, false],
    ["stock", false, true],
  ]);
});

test("a meta.koppeling that is neither false nor an object of the door's hints fails the boot, naming the procedure", () => {
  // A misspelled hint the door ignored would leave a write described wrongly
  // with nothing to say so.
  for (const koppeling of [{ destructve: false }, { idempotent: "yes" }, true, "nee"]) {
    const router = t.router({
      // oxlint-disable-next-line typescript/no-unsafe-argument -- a meta its type forbids, on purpose
      ship: t.procedure.meta(Object({ koppeling })).mutation(() => 1),
    });
    expect(() => fromTrpcRouter(router, { contextFor: () => ({}) })).toThrow(
      'tRPC procedure "ship": meta.koppeling',
    );
  }
});

test("a procedure without a description gets one line from its name's words and its input's fields; a written one wins", () => {
  const router = t.router({
    orders: t.router({
      claimPicking: t.procedure.input(z.object({ orderId: z.number() })).mutation(() => 1),
      shippingQueue: t.procedure.query(() => []),
      list: t.procedure
        .meta({ description: "De orders die nog gepickt moeten worden." })
        .query(() => []),
      ship: t.procedure
        .meta({
          description: "Verzendt een order.",
          koppeling: { description: "Verzendt een gepickte order en print het label." },
        })
        .mutation(() => 1),
    }),
  });
  const described = fromTrpcRouter(router, { contextFor: () => ({}) }).operations.map(
    ({ name, description, written }) => [name, description, written],
  );

  expect(described).toEqual([
    ["orders.claimPicking", "Voert uit: orders claim picking. Invoer: orderId.", false],
    ["orders.list", "De orders die nog gepickt moeten worden.", true],
    ["orders.ship", "Verzendt een gepickte order en print het label.", true],
    ["orders.shippingQueue", "Leest: orders shipping queue.", false],
  ]);
});

test("an output is described as what the procedure answers, its schema's output side, not what it takes", () => {
  // The likeliest wrong describes an output by its input side, as an input is
  // described: a string that a transform turns into a number then reads as a
  // string.
  const router = t.router({
    piped: t.procedure
      .output(z.object({ n: z.string().transform(Number).pipe(z.number()) }))
      .query(() => ({ n: "1" })),
    transformed: t.procedure
      .output(z.object({ n: z.string().transform(Number) }))
      .query(() => ({ n: "1" })),
    effect: t.procedure
      .output(Schema.standardSchemaV1(Schema.Struct({ n: Schema.NumberFromString })))
      .query(() => ({ n: "1" })),
  });
  const derived = fromTrpcRouter(router, { contextFor: () => ({}) });
  const outputOf = (name: string) =>
    derived.operations.find((operation) => operation.name === name)?.output;

  expect(outputOf("piped")).toMatchObject({ properties: { n: { type: "number" } } });
  expect(outputOf("effect")).toMatchObject({ properties: { n: { type: "number" } } });
  expect(outputOf("transformed")).not.toMatchObject({ properties: { n: { type: "string" } } });
  expect(derived.undescribed).toContainEqual({
    name: "transformed",
    reason: "output: Transforms cannot be represented in JSON Schema",
  });
});
