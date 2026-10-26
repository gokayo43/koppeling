import type { AnyTRPCRouter, inferRouterContext } from "@trpc/server";

import {
  catalogue,
  firstSegment,
  type Catalogue,
  type Declared,
  type Kind,
  type Note,
  type Outcome,
} from "../catalogue";
import { boundedJson, isJsonObject, toJson, type Json } from "../json";
import { allOf, describeSchema, type Described } from "../schema";

export interface TrpcOptions<Router extends AnyTRPCRouter, Actor> {
  /** The router's context for one call as `actor`: the same context the UI's requests get. */
  readonly contextFor: (
    actor: Actor,
  ) => inferRouterContext<Router> | Promise<inferRouterContext<Router>>;
}

/** What a procedure without `.input()` takes: nothing. */
const NO_INPUT: Described = {
  schema: { type: "object", properties: {}, additionalProperties: false },
};

function kindOf(type: string): Kind | undefined {
  if (type === "query") return "read";
  return type === "mutation" ? "write" : undefined;
}

/**
 * The catalogue of a tRPC v11 router: every query and mutation, named by its
 * path. Subscriptions and the procedures the program withholds from the door
 * (`meta.koppeling: false`) are skipped and named in the boot report.
 */
export function fromTrpcRouter<Router extends AnyTRPCRouter, Actor>(
  router: Router,
  options: TrpcOptions<Router, Actor>,
): Catalogue<Actor> {
  /**
   * tRPC's caller is a recursive proxy that answers no `in` and is typed `any`
   * for a router of unknown shape, so the path is walked by property access,
   * the one question it answers.
   */
  const run = async (
    actor: Actor,
    path: string,
    input: Json | undefined,
    signal: AbortSignal,
  ): Promise<Outcome> => {
    let target: unknown = router.createCaller(await options.contextFor(actor), { signal });
    for (const segment of path.split(".")) {
      // oxlint-disable-next-line typescript/no-unsafe-member-access -- the caller proxy, walked by the path tRPC itself named
      target = Object(target)[segment];
    }
    if (typeof target !== "function")
      throw new Error(`The tRPC caller has no procedure at "${path}"`);
    // From here the procedure's own chain runs: its refusal is the program's
    // sentence, and anything else it throws a failure after it was reached.
    try {
      // oxlint-disable-next-line typescript/no-unsafe-call -- the procedure the walk reached
      const answer: unknown = await target(input);
      return { value: toJson(answer) };
    } catch (error) {
      if (!isRefusal(error)) return { failed: error };
      const details = detailsOf(error);
      return details === undefined
        ? { refusal: error.message }
        : { refusal: error.message, details };
    }
  };
  const declared: Declared<Actor>[] = [];
  const skipped: Note[] = [];
  for (const [path, definition] of procedureDefinitions(router)) {
    const kind = kindOf(definition.type);
    if (kind === undefined) {
      skipped.push({ name: path, reason: `${definition.type}, which the door does not serve` });
      continue;
    }
    if (definition.withheld) {
      skipped.push({ name: path, reason: "withheld by the program" });
      continue;
    }
    const owner = `tRPC procedure "${path}"`;
    declared.push({
      name: path,
      area: firstSegment(path),
      kind,
      description: definition.description,
      input: allOf(definition.inputs.map((parser) => describeSchema(parser, owner))) ?? NO_INPUT,
      output:
        definition.output === undefined ? undefined : describeSchema(definition.output, owner),
      run: (actor, input, signal) => run(actor, path, input, signal),
    });
  }
  return catalogue(declared, skipped);
}

interface ProcedureDefinition {
  readonly type: string;
  readonly inputs: readonly unknown[];
  readonly output: unknown;
  readonly description: string | undefined;
  /** `meta.koppeling === false`: the program keeps this procedure from the door. */
  readonly withheld: boolean;
}

/**
 * `router._def.procedures`, the flat map from dotted path to procedure that
 * every tRPC v11 router carries. It is an internal the ecosystem relies on
 * rather than a published API (CLAUDE.md, Gotchas), so its shape is checked
 * here and a router that does not have it fails the boot.
 */
function procedureDefinitions(router: AnyTRPCRouter): [string, ProcedureDefinition][] {
  // oxlint-disable-next-line eslint/no-underscore-dangle -- tRPC's own name for the router's definition
  const definition: unknown = router._def;
  if (!hasKey(definition, "procedures") || !hasKey(definition, "lazy")) {
    throw new Error("Not a tRPC v11 router: it has no _def.procedures");
  }
  const { procedures, lazy } = definition;
  if (
    typeof procedures !== "object" ||
    procedures === null ||
    typeof lazy !== "object" ||
    lazy === null
  ) {
    throw new Error("Not a tRPC v11 router: _def.procedures or _def.lazy is not a map");
  }
  if (Object.keys(lazy).length > 0) {
    throw new Error("The router has lazy sub-routers, whose procedures exist only once loaded");
  }
  return Object.entries(procedures).map(([path, procedure]: [string, unknown]) => {
    // oxlint-disable-next-line eslint/no-underscore-dangle -- tRPC's own name for the procedure's definition
    const def = hasKey(procedure, "_def") ? procedure._def : undefined;
    if (!hasKey(def, "type") || !hasKey(def, "inputs") || typeof def.type !== "string") {
      throw new Error(`tRPC procedure "${path}" has no _def.type and _def.inputs`);
    }
    if (!Array.isArray(def.inputs))
      throw new Error(`tRPC procedure "${path}": _def.inputs is not a list`);
    const meta = hasKey(def, "meta") ? def.meta : undefined;
    const description = hasKey(meta, "description") ? meta.description : undefined;
    return [
      path,
      {
        type: def.type,
        inputs: def.inputs,
        output: hasKey(def, "output") ? def.output : undefined,
        description:
          typeof description === "string" && description.trim() ? description.trim() : undefined,
        withheld: hasKey(meta, "koppeling") && meta.koppeling === false,
      },
    ];
  });
}

/**
 * A refusal the program stated: a `TRPCError` it threw on purpose, the input
 * parser's included. `INTERNAL_SERVER_ERROR` is what tRPC wraps an unexpected
 * throw in, so it is a failure, not a refusal. Recognised by name rather than
 * class, so the door imports nothing from tRPC at run time.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever a procedure threw
function isRefusal(error: unknown): error is Error & { readonly code: unknown } {
  return (
    error instanceof Error &&
    error.name === "TRPCError" &&
    hasKey(error, "code") &&
    error.code !== "INTERNAL_SERVER_ERROR"
  );
}

/**
 * The structured details of a refusal, as data beside its sentence: the
 * cause's own `details` object (the convention a program's refusal follows,
 * such as `{ opties: [...] }`), and nothing else of the cause, since a cause
 * is whatever object the program attached; or, for tRPC's own input parse (a
 * `BAD_REQUEST` whose cause carries the parser's `issues` and no `details`),
 * those issues. Reading them never throws: a cause that cannot be read gives
 * none, and the refusal's sentence still reaches the agent.
 */
function detailsOf(error: Error & { readonly code: unknown }): Json | undefined {
  try {
    const cause = error.cause;
    const details = hasKey(cause, "details") ? boundedJson(cause.details) : undefined;
    if (isJsonObject(details)) return details;
    if (
      error.code === "BAD_REQUEST" &&
      !hasKey(cause, "details") &&
      hasKey(cause, "issues") &&
      Array.isArray(cause.issues)
    ) {
      return { issues: boundedJson(cause.issues) };
    }
  } catch {
    // A getter that throws, or a proxy that refuses to be read: no details.
  }
  return undefined;
}

/** The narrowing every read of a tRPC internal goes through. */
function hasKey<Key extends string>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a tRPC internal, not yet read
  value: unknown,
  key: Key,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the one key it has checked, still unread
): value is { readonly [K in Key]: unknown } {
  return (
    (typeof value === "object" || typeof value === "function") && value !== null && key in value
  );
}
