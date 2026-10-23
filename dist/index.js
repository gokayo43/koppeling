import { Cause, Data, Effect, JSONSchema, Schema } from "effect";
import * as AST from "effect/SchemaAST";
import { McpServer, WebStandardStreamableHTTPServerTransport, createMcpHandler, fromJsonSchema, getOAuthProtectedResourceMetadataUrl, isLegacyRequest } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
//#region src/copy.ts
/**
* Every sentence the door writes that a person may read, in Dutch as the
* portal's door writes them. Names, schemas and the host's own words are
* passed through as the host wrote them.
*/
const quoted = (names) => names.map((name) => `"${name}"`).join(", ");
const copy = {
	serverTitle: "Koppeling",
	tools: {
		list: {
			title: "Gebieden en operaties",
			description: "Zonder gebied: de gebieden van dit programma, elk met zijn regel en het aantal operaties. Met een gebied, precies zoals list het noemt: de operaties van dat gebied, elk met zijn soort en regel.",
			area: "Een gebied precies zoals list het noemt. Laat weg voor de lijst van gebieden."
		},
		find: {
			title: "Operaties zoeken",
			description: "Zoekt operaties bij woorden uit hun naam, gebied, beschrijving en invoervelden, en geeft er hooguit tien, de beste eerst. Voert niets uit. Namen en velden zijn de woorden van het programma zelf, vaak Engels: zoek ook met die woorden.",
			words: "Waar de operatie over gaat, in een paar woorden."
		},
		describe: {
			title: "Operatie lezen",
			description: "De volledige operatie: soort, beschrijving, invoerschema en uitvoerschema. Lees een operatie voordat je haar met call uitvoert.",
			name: "De naam van de operatie, precies zoals list of find haar noemt."
		},
		call: {
			title: "Operatie uitvoeren",
			description: "Voert een operatie uit als de ingelogde persoon, met dezelfde rechten als in het programma zelf. Een operatie van soort write wijzigt gegevens: vraag de persoon eerst om toestemming en voer haar pas daarna uit. Lees de operatie eerst met describe.",
			name: "De naam van de operatie, precies zoals list of find haar noemt.",
			input: "De invoer volgens het invoerschema dat describe geeft. Laat weg als de operatie geen invoer heeft."
		}
	},
	outline: (lines) => ["Gebieden van dit programma. Blader met list, zoek met find, lees een operatie met describe en voer haar uit met call. Een operatie van soort write wijzigt gegevens: vraag de persoon eerst.", ...lines].join("\n"),
	areaLine: (name, count, summary) => `- ${name} (${count} ${count === 1 ? "operatie" : "operaties"}): ${summary}`,
	unknownArea: (area, areas) => `Onbekend gebied "${area}". Kies een gebied uit deze lijst: ${quoted(areas)}.`,
	unknownOperation: (name, names) => `Onbekende operatie "${name}". Kies een naam uit deze lijst: ${quoted(names)}.`,
	unknownOperationArea: (name, areas) => `Onbekende operatie "${name}". Kies eerst een gebied uit deze lijst en vraag met list zijn operaties op: ${quoted(areas)}.`,
	nothingFound: (words, areas) => `Geen operatie gevonden bij "${words}". Kies een gebied uit deze lijst en vraag met list zijn operaties op: ${quoted(areas)}.`,
	internalError: "Er is een interne fout opgetreden.",
	undescribedSchema: "Het programma beschrijft deze waarde in een vorm die de koppeling niet als JSON Schema kan schrijven; het programma controleert haar zelf bij call.",
	inputNotObject: "De invoer moet een object zijn, met params, query en body zoals het invoerschema ze noemt.",
	missingPathParameter: (name) => `De invoer mist params.${name}, dat in het pad staat.`,
	noBearer: "Niet geautoriseerd: deze koppeling vraagt een inlog.",
	badBearer: "Deze koppeling is verlopen of ongeldig. Log opnieuw in vanuit het programma.",
	keysUnreachable: "De inlog kan nu niet worden gecontroleerd. Probeer het later opnieuw."
};
//#endregion
//#region src/catalogue.ts
/** What `describe` shows for a schema the door could not write. */
const UNDESCRIBED = { description: copy.undescribedSchema };
/** MCP's name rule, which every operation name is held to. */
const NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const MAX_NAME_LENGTH = 128;
const byName = (left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
/**
* The catalogue of `declared`, in name order. A name outside MCP's characters
* or one two operations share throws, naming it: both are a program the door
* would otherwise offer wrongly, and the boot is where a host can fix it.
*/
function catalogue(declared, skipped) {
	const seen = /* @__PURE__ */ new Set();
	for (const { name } of declared) {
		if (!NAME.test(name) || name.length > MAX_NAME_LENGTH) throw new Error(`"${name}" is not a valid operation name (letters, digits, _, - and .)`);
		if (seen.has(name)) throw new Error(`Two operations are both named "${name}"`);
		seen.add(name);
	}
	const undescribed = [];
	const schemaOf = (name, part, described) => {
		if ("schema" in described) return described.schema;
		undescribed.push({
			name,
			reason: `${part}: ${described.undescribable}`
		});
		return UNDESCRIBED;
	};
	return {
		operations: declared.map((operation) => ({
			...operation,
			area: areaOf(operation.name),
			input: schemaOf(operation.name, "input", operation.input),
			output: operation.output === void 0 ? void 0 : schemaOf(operation.name, "output", operation.output)
		})).toSorted(byName),
		skipped: skipped.toSorted(byName),
		undescribed: undescribed.toSorted(byName)
	};
}
function areaOf(name) {
	const dot = name.indexOf(".");
	return dot === -1 ? name : name.slice(0, dot);
}
//#endregion
//#region src/json.ts
function isJsonObject(value) {
	return typeof value === "object" && value !== null && !isJsonArray(value);
}
function isJsonArray(value) {
	return Array.isArray(value);
}
/**
* The JSON a program's own value becomes, as `JSON.stringify` would write it,
* except that a `bigint` becomes its decimal string and a `Map` or `Set` keeps
* its entries: a tRPC program on superjson returns all three, and
* `JSON.stringify` throws on the first and writes `{}` for the other two.
*/
function toJson(value) {
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value + 0 : null;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "object" && value !== null) return objectToJson(value);
	return null;
}
function objectToJson(value) {
	if (Array.isArray(value)) return value.map((item) => toJson(item));
	if (value instanceof Map) return Object.fromEntries(Array.from(value, ([key, item]) => [String(key), toJson(item)]));
	if (value instanceof Set) return Array.from(value, (item) => toJson(item));
	if ("toJSON" in value && typeof value.toJSON === "function") return toJson(value.toJSON());
	const entries = [];
	for (const [key, item] of Object.entries(value)) {
		const kind = typeof item;
		if (kind !== "undefined" && kind !== "function" && kind !== "symbol") entries.push([key, toJson(item)]);
	}
	return Object.fromEntries(entries);
}
//#endregion
//#region src/schema.ts
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");
/**
* A program's own schema for one value, as JSON Schema: Effect Schema through
* `JSONSchema.make`, TypeBox as it is (it is JSON Schema already), and anything
* implementing Standard JSON Schema (zod 4, ArkType, Valibot) through its own
* converter. A schema in any other language throws, naming `owner`, so a host
* learns at boot which operation the door cannot read.
*/
function describeSchema(schema, owner) {
	let converted;
	try {
		converted = convert(schema);
	} catch (cause) {
		return { undescribable: String(cause instanceof Error ? cause.message : cause).split("\n", 2).join(" ") };
	}
	if (converted === void 0) throw new Error(`${owner}: its schema is not Effect Schema, TypeBox or a Standard JSON Schema (zod 4), so the koppeling cannot read it`);
	if (!isJsonObject(converted)) return { undescribable: `it converts to ${JSON.stringify(converted)}` };
	return { schema: converted };
}
/** The schema in JSON Schema, or `undefined` when it is in no language the door reads. */
function convert(schema) {
	if (Schema.isSchema(schema)) return toJson(JSONSchema.make(definedPart(schema)));
	if (typeof schema !== "object" || schema === null) return void 0;
	if (TYPEBOX_KIND in schema) return toJson(schema);
	return standardJsonSchema(schema);
}
/**
* An Effect input whose encoded side is `X | undefined` (`Schema.UndefinedOr`,
* or a default filled in when the input is left out) says the input may be
* left out, which the door's `call` already allows. JSON Schema has no
* `undefined`, and `JSONSchema.make` writes the encoded side, so the schema the
* door writes is the encoded `X`'s.
*/
function definedPart(schema) {
	let ast = schema.ast;
	while (AST.isTransformation(ast)) ast = ast.from;
	if (!AST.isUnion(ast)) return schema;
	const defined = ast.types.filter((member) => !AST.isUndefinedKeyword(member));
	return defined.length === ast.types.length ? schema : Schema.make(AST.Union.make(defined));
}
/** The schema's input side through its own Standard JSON Schema converter, if it has one. */
function standardJsonSchema(schema) {
	if (!("~standard" in schema)) return void 0;
	const props = schema["~standard"];
	if (typeof props !== "object" || props === null || !("jsonSchema" in props)) return void 0;
	const converter = props.jsonSchema;
	if (typeof converter !== "object" || converter === null || !("input" in converter)) return;
	const input = converter.input;
	if (typeof input !== "function") return void 0;
	return toJson(input.call(converter, { target: "draft-2020-12" }));
}
/**
* Several schemas one value must satisfy at once, as one: `allOf` of them, or
* the reasons when any of them cannot be written; `undefined` for none.
*/
function allOf(parts) {
	const reasons = parts.flatMap((part) => "undescribable" in part ? [part.undescribable] : []);
	if (reasons.length) return { undescribable: reasons.join("; ") };
	const [only, ...more] = parts.flatMap((part) => "schema" in part ? [part.schema] : []);
	if (only === void 0) return void 0;
	return { schema: more.length ? { allOf: [only, ...more] } : only };
}
//#endregion
//#region src/adapters/elysia.ts
const PARTS = [
	"params",
	"query",
	"body"
];
/**
* Elysia finds a request's path by searching for the first `/` from index 11
* of its URL, so an origin shorter than that loses the path's start and every
* route answers 404 (measured on 1.4.30 with `http://x`).
*/
const ORIGIN = "http://localhost";
/**
* The catalogue of an Elysia 1.4 app's routes under `mount`: each named by its
* path's segments and its method, and run through `app.handle` with the
* actor's credential, so the route's own auth and validation run as for any
* client. WebSocket routes are skipped and named in the boot report.
*/
function fromElysia(app, options) {
	const mount = (options.mount ?? "").replace(/\/+$/, "");
	const declared = [];
	const skipped = [];
	for (const route of app.routes) {
		if (!route.path.startsWith(`${mount}/`)) continue;
		const segments = route.path.slice(mount.length).split("/").filter(Boolean);
		const name = [...segments.map(nameSegment), route.method.toLowerCase()].join(".");
		if (route.method === "WS") {
			skipped.push({
				name,
				reason: "a WebSocket route, which the door does not serve"
			});
			continue;
		}
		if (segments.length === 0) {
			skipped.push({
				name,
				reason: `the mount itself, which names no area`
			});
			continue;
		}
		const owner = `Elysia route ${route.method} ${route.path}`;
		const hooks = route.hooks;
		const schemas = new Map(PARTS.map((part) => [part, partSchema(app, hooks, part, owner)]));
		schemas.set("params", schemas.get("params") ?? pathParameters(segments));
		const method = route.method;
		declared.push({
			name,
			kind: method === "GET" || method === "HEAD" ? "read" : "write",
			description: description(hooks),
			input: inputSchema(schemas),
			output: responseSchema(app, hooks, owner),
			run: (actor, input) => request(app, {
				method,
				path: route.path,
				headers: options.credential(actor)
			}, input)
		});
	}
	return catalogue(declared, skipped);
}
function nameSegment(segment) {
	return segment.replace(/^:/, "").replace(/\?$/, "").replaceAll(/[^A-Za-z0-9_-]/g, "_");
}
/** The route's own schema for one part, with each guard's beside it. */
function partSchema(app, hooks, part, owner) {
	const own = field(hooks, part);
	const guards = field(hooks, "standaloneValidator");
	return allOf([own, ...Array.isArray(guards) ? guards.map((guard) => field(guard, part)) : []].filter((schema) => schema !== void 0).map((schema) => resolved(app, schema, `${owner} (${part})`)));
}
/** What a path's `:name` segments ask for when the route declares no params schema. */
function pathParameters(segments) {
	const names = segments.filter((segment) => segment.startsWith(":")).map(parameterName);
	if (names.length === 0) return void 0;
	return { schema: {
		type: "object",
		properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
		required: names
	} };
}
function parameterName(segment) {
	return segment.slice(1).replace(/\?$/, "");
}
/** The route's parts as one object: `{ params, query, body }`, each as the route declares it. */
function inputSchema(schemas) {
	const present = [];
	const reasons = [];
	for (const part of PARTS) {
		const described = schemas.get(part);
		if (described === void 0) continue;
		if ("schema" in described) present.push([part, described.schema]);
		else reasons.push(`${part}: ${described.undescribable}`);
	}
	if (reasons.length) return { undescribable: reasons.join("; ") };
	return { schema: {
		type: "object",
		properties: Object.fromEntries(present),
		required: present.filter(([part, schema]) => part !== "query" || requires(schema)).map(([part]) => part),
		additionalProperties: false
	} };
}
function requires(schema) {
	const required = schema["required"];
	return isJsonArray(required) && required.length > 0 || isJsonArray(schema["allOf"]);
}
function responseSchema(app, hooks, owner) {
	const response = field(hooks, "response");
	if (response === void 0) return void 0;
	return resolved(app, typeof response === "string" || field(response, "200") === void 0 ? response : field(response, "200"), `${owner} (response 200)`);
}
/** A schema the route names by model, looked up the way Elysia looks it up. */
function resolved(app, schema, owner) {
	if (typeof schema !== "string") return describeSchema(schema, owner);
	const model = field(app.models, schema);
	if (model === void 0) throw new Error(`${owner}: names a model "${schema}" the app does not have`);
	return describeSchema(field(model, "schema"), owner);
}
/** `detail.summary` as the operation's line and `detail.description` below it. */
function description(hooks) {
	const detail = field(hooks, "detail");
	const lines = [field(detail, "summary"), field(detail, "description")].filter((text) => typeof text === "string").map((text) => text.trim()).filter(Boolean);
	return lines.length ? lines.join("\n") : void 0;
}
async function request(app, target, input) {
	const parts = input === void 0 ? {} : input;
	if (!isJsonObject(parts)) return { refusal: copy.inputNotObject };
	const url = urlOf(target.path, parts["params"], parts["query"]);
	if ("refusal" in url) return url;
	const headers = new Headers(target.headers);
	const body = parts["body"];
	const carriesBody = body !== void 0 && target.method !== "GET" && target.method !== "HEAD";
	if (carriesBody) headers.set("content-type", "application/json");
	const response = await app.handle(new Request(url.href, {
		method: target.method,
		headers,
		...carriesBody ? { body: JSON.stringify(body) } : {}
	}));
	const text = await response.text();
	if (!response.ok) return { refusal: `HTTP ${response.status}: ${text}` };
	if (text === "") return { value: null };
	if (!response.headers.get("content-type")?.includes("json")) return { value: text };
	return { value: toJson(JSON.parse(text)) };
}
function urlOf(path, params, query) {
	const given = isJsonObject(params) ? params : {};
	const segments = [];
	for (const segment of path.split("/")) {
		if (!segment.startsWith(":")) {
			segments.push(segment);
			continue;
		}
		const name = parameterName(segment);
		const value = given[name];
		if (value === void 0) {
			if (segment.endsWith("?")) continue;
			return { refusal: copy.missingPathParameter(name) };
		}
		segments.push(encodeURIComponent(textOf(value)));
	}
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(isJsonObject(query) ? query : {})) for (const item of isJsonArray(value) ? value : [value]) search.append(key, textOf(item));
	const queryString = search.size ? `?${search.toString()}` : "";
	return { href: `${ORIGIN}${segments.join("/")}${queryString}` };
}
function textOf(value) {
	return typeof value === "string" ? value : JSON.stringify(value);
}
function field(value, key) {
	if (typeof value !== "object" || value === null || !(key in value)) return void 0;
	return Object.getOwnPropertyDescriptor(value, key)?.value;
}
//#endregion
//#region src/adapters/trpc.ts
/** What a procedure without `.input()` takes: nothing. */
const NO_INPUT = { schema: {
	type: "object",
	properties: {},
	additionalProperties: false
} };
function kindOf(type) {
	if (type === "query") return "read";
	return type === "mutation" ? "write" : void 0;
}
/**
* The catalogue of a tRPC v11 router: every query and mutation, named by its
* path. Subscriptions are skipped and named in the boot report.
*/
function fromTrpcRouter(router, options) {
	/**
	* tRPC's caller is a recursive proxy that answers no `in` and is typed `any`
	* for a router of unknown shape, so the path is walked by property access,
	* the one question it answers.
	*/
	const call = async (actor, path, input) => {
		let target = router.createCaller(await options.contextFor(actor));
		for (const segment of path.split(".")) target = Object(target)[segment];
		if (typeof target !== "function") throw new Error(`The tRPC caller has no procedure at "${path}"`);
		return toJson(await target(input));
	};
	const declared = [];
	const skipped = [];
	for (const [path, definition] of procedureDefinitions(router)) {
		const kind = kindOf(definition.type);
		if (kind === void 0) {
			skipped.push({
				name: path,
				reason: `${definition.type}, which the door does not serve`
			});
			continue;
		}
		const owner = `tRPC procedure "${path}"`;
		declared.push({
			name: path,
			kind,
			description: definition.description,
			input: allOf(definition.inputs.map((parser) => describeSchema(parser, owner))) ?? NO_INPUT,
			output: definition.output === void 0 ? void 0 : describeSchema(definition.output, owner),
			run: async (actor, input) => {
				try {
					return { value: await call(actor, path, input) };
				} catch (error) {
					if (isRefusal(error)) return { refusal: error.message };
					throw error;
				}
			}
		});
	}
	return catalogue(declared, skipped);
}
/**
* `router._def.procedures`, the flat map from dotted path to procedure that
* every tRPC v11 router carries. It is an internal the ecosystem relies on
* rather than a published API (CLAUDE.md, Gotchas), so its shape is checked
* here and a router that does not have it fails the boot.
*/
function procedureDefinitions(router) {
	const definition = router._def;
	if (!hasKey(definition, "procedures") || !hasKey(definition, "lazy")) throw new Error("Not a tRPC v11 router: it has no _def.procedures");
	const { procedures, lazy } = definition;
	if (typeof procedures !== "object" || procedures === null || typeof lazy !== "object" || lazy === null) throw new Error("Not a tRPC v11 router: _def.procedures or _def.lazy is not a map");
	if (Object.keys(lazy).length > 0) throw new Error("The router has lazy sub-routers, whose procedures exist only once loaded");
	return Object.entries(procedures).map(([path, procedure]) => {
		const def = hasKey(procedure, "_def") ? procedure._def : void 0;
		if (!hasKey(def, "type") || !hasKey(def, "inputs") || typeof def.type !== "string") throw new Error(`tRPC procedure "${path}" has no _def.type and _def.inputs`);
		if (!Array.isArray(def.inputs)) throw new Error(`tRPC procedure "${path}": _def.inputs is not a list`);
		const meta = hasKey(def, "meta") ? def.meta : void 0;
		const description = hasKey(meta, "description") ? meta.description : void 0;
		return [path, {
			type: def.type,
			inputs: def.inputs,
			output: hasKey(def, "output") ? def.output : void 0,
			description: typeof description === "string" && description.trim() ? description.trim() : void 0
		}];
	});
}
/**
* A refusal the program stated: a `TRPCError` it threw on purpose, the input
* parser's included. `INTERNAL_SERVER_ERROR` is what tRPC wraps an unexpected
* throw in, so it is a failure, not a refusal. Recognised by name rather than
* class, so the door imports nothing from tRPC at run time.
*/
function isRefusal(error) {
	return error instanceof Error && error.name === "TRPCError" && hasKey(error, "code") && error.code !== "INTERNAL_SERVER_ERROR";
}
/** The narrowing every read of a tRPC internal goes through. */
function hasKey(value, key) {
	return (typeof value === "object" || typeof value === "function") && value !== null && key in value;
}
//#endregion
//#region src/auth.ts
var Unauthenticated = class extends Data.TaggedError("Unauthenticated") {};
var KeysUnreachable = class extends Data.TaggedError("KeysUnreachable") {};
/**
* jose's codes for a key set it could not fetch or read, as opposed to a token
* it refused; anything that is not a jose error at all is the fetch failing.
*/
const KEYS_FAILED = /* @__PURE__ */ new Set([
	"ERR_JWKS_TIMEOUT",
	"ERR_JWKS_INVALID",
	"ERR_JOSE_GENERIC"
]);
const BEARER = /^Bearer\s+(\S+)\s*$/i;
/**
* Verifies a request's bearer as a JWT from `identity` for `audience`: its
* signature against the provider's key set (cached, and fetched again for a
* key id it has not seen), its `iss`, its `aud`, `exp` and `nbf`.
*/
function bearerVerifier(identity, audience) {
	const jwksUrl = identity.jwksUrl ?? `${identity.issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
	const keys = createRemoteJWKSet(new URL(jwksUrl));
	return (request) => {
		const token = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
		if (token === void 0) return Effect.fail(new Unauthenticated({
			sentence: copy.noBearer,
			tokenGiven: false
		}));
		return Effect.tryPromise({
			try: () => jwtVerify(token, keys, {
				issuer: identity.issuer,
				audience
			}),
			catch: (cause) => !(cause instanceof errors.JOSEError) || KEYS_FAILED.has(cause.code) ? new KeysUnreachable({ cause }) : new Unauthenticated({
				sentence: copy.badBearer,
				tokenGiven: true
			})
		}).pipe(Effect.map(({ payload }) => payload));
	};
}
/**
* Words that say nothing about which operation is meant, in the two languages
* a person here asks in. Without them "welke bestellingen moeten nog" would
* rank on "moeten" as much as on "bestellingen".
*/
const STOPWORDS = new Set("de het een en of van voor op in naar met aan bij uit om over tot als dat die dit deze wat welk welke wie waar hoe hoeveel hebben heeft hebt is zijn was moet moeten mag kan kunnen worden wordt nog al er we wij ik je jij u ons onze mijn alle alles niet geen ook maar dan ander andere staan staat ligt liggen gaat gaan komt komen wil willen graag even nu the a an and or of for on in to with at by from as that this these those what which who where how many much is are was be been has have do does can should must all any not no".split(" "));
/** How much a word found in each field counts; the name and the description say the most. */
const WEIGHTS = {
	name: 3,
	description: 2,
	area: 2,
	input: 1
};
const FIELDS = [
	"name",
	"description",
	"area",
	"input"
];
/** The shortest stem a prefix match may take, so "in" does not match "inventory". */
const MIN_PREFIX = 4;
/** The shortest shared start that makes two words cousins. */
const COGNATE_PREFIX = 5;
/**
* The words of a text: split on anything but letters and digits and at
* camelCase humps, lower-cased, stopwords dropped, each reduced to a stem.
*/
function stems(text) {
	return text.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word && !STOPWORDS.has(word)).map(stem);
}
/**
* A light stem for Dutch and English: the past participle's "ge-" and the
* plural, tense and inflection endings go, so "gepickt" meets "picked",
* "getelde" meets "tel", "bestellingen" meets "bestelling" and "leveranciers"
* meets "leverancier".
*/
function stem(word) {
	let base = word.length >= 6 && word.startsWith("ge") ? word.slice(2) : word;
	for (const ending of [
		"ingen",
		"en",
		"es",
		"ed",
		"de",
		"te",
		"s",
		"t",
		"d",
		"e"
	]) if (base.endsWith(ending) && base.length - ending.length >= 3) {
		base = ending === "ingen" ? `${base.slice(0, -ending.length)}ing` : base.slice(0, -ending.length);
		break;
	}
	return base;
}
/**
* How well a query stem meets an operation's stem: the same; one a prefix of
* the other; one inside the other (a Dutch compound such as "verzendlabel");
* or the two sharing most of the shorter one's start, which is how a Dutch
* word meets its English cousin ("locatie" and "location").
*/
function closeness(query, word) {
	if (query === word) return 1;
	const [short, long] = query.length <= word.length ? [query, word] : [word, query];
	if (short.length < MIN_PREFIX) return 0;
	if (long.startsWith(short)) return .6;
	if (long.includes(short)) return .4;
	let shared = 0;
	while (shared < short.length && short[shared] === long[shared]) shared += 1;
	return shared >= COGNATE_PREFIX && shared >= short.length * .7 ? .4 : 0;
}
function indexOf(operation) {
	return {
		name: stems(operation.name.slice(operation.area.length)),
		area: stems(operation.area),
		description: stems(operation.description ?? ""),
		input: stems(fieldNames(operation.input).join(" "))
	};
}
/** The property names of a schema, two levels deep, through allOf and anyOf. */
function fieldNames(schema, depth = 0) {
	if (depth > 2) return [];
	const properties = schema["properties"];
	const own = isJsonObject(properties) ? Object.entries(properties) : [];
	const nested = own.flatMap(([, child]) => isJsonObject(child) ? fieldNames(child, depth + 1) : []);
	const combined = [schema["allOf"], schema["anyOf"]].flatMap((list) => isJsonArray(list) ? list.flatMap((part) => isJsonObject(part) ? fieldNames(part, depth) : []) : []);
	return [
		...own.map(([name]) => name),
		...nested,
		...combined
	];
}
/**
* The operations whose words best meet `words`, best first, at most
* {@link FIND_LIMIT}, and none that meets none of them. A word counts in each
* field it meets, by that field's weight and by how rare its match is among the
* operations, so a word every operation carries ranks nothing.
*/
function find(operations, words) {
	const query = [...new Set(stems(words))];
	const indexed = operations.map((operation) => ({
		operation,
		index: indexOf(operation)
	}));
	const rarities = /* @__PURE__ */ new Map();
	const rarity = (word) => {
		const known = rarities.get(word);
		if (known !== void 0) return known;
		const carrying = indexed.filter(({ index }) => FIELDS.some((field) => index[field].includes(word))).length;
		const computed = Math.log(1 + operations.length / Math.max(carrying, 1));
		rarities.set(word, computed);
		return computed;
	};
	return indexed.map(({ operation, index }) => {
		let score = 0;
		for (const word of query) for (const field of FIELDS) {
			let best = 0;
			for (const candidate of index[field]) best = Math.max(best, WEIGHTS[field] * closeness(word, candidate) * rarity(candidate));
			score += best;
		}
		return {
			operation,
			score
		};
	}).filter(({ score }) => score > 0).toSorted((left, right) => right.score - left.score || (left.operation.name < right.operation.name ? -1 : 1)).slice(0, 10).map(({ operation }) => operation);
}
//#endregion
//#region src/tools.ts
/** How many of an area's operation names its one line carries. */
const AREA_LINE_NAMES = 10;
function toDirectory(catalogue) {
	const grouped = /* @__PURE__ */ new Map();
	for (const operation of catalogue.operations) grouped.set(operation.area, [...grouped.get(operation.area) ?? [], operation]);
	const areas = new Map(Array.from(grouped, ([name, operations]) => [name, {
		name,
		summary: summaryOf(name, operations),
		operations
	}]));
	return {
		operations: catalogue.operations,
		areas,
		byName: new Map(catalogue.operations.map((operation) => [operation.name, operation]))
	};
}
/** An area's one line: the names of its operations, the area itself left off. */
function summaryOf(area, operations) {
	const leaves = operations.map(({ name }) => name === area ? name : name.slice(area.length + 1));
	const shown = leaves.slice(0, AREA_LINE_NAMES).join(", ");
	const rest = leaves.length - AREA_LINE_NAMES;
	return rest > 0 ? `${shown} en ${rest} meer` : shown;
}
/** The server's instructions: the host's glossary, then the outline of every area. */
function instructionsFor(glossary, directory) {
	const outline = copy.outline(Array.from(directory.areas.values(), (area) => copy.areaLine(area.name, area.operations.length, area.summary)));
	return [glossary.trim(), outline].filter(Boolean).join("\n\n");
}
const refusal = (text) => ({
	text,
	isError: true
});
const answer = (structured) => ({
	text: JSON.stringify(structured),
	structured
});
function summaryLine(operation) {
	return operation.description?.split("\n", 1)[0] ?? null;
}
function list(directory, area) {
	if (area === void 0) return answer({ areas: Array.from(directory.areas.values(), (entry) => ({
		name: entry.name,
		summary: entry.summary,
		operations: entry.operations.length
	})) });
	const entry = directory.areas.get(area);
	if (entry === void 0) return refusal(copy.unknownArea(area, [...directory.areas.keys()]));
	return answer({
		area: entry.name,
		operations: entry.operations.map((operation) => ({
			name: operation.name,
			kind: operation.kind,
			summary: summaryLine(operation)
		}))
	});
}
/** The refusal for a name no operation has: the canonical list to pick from. */
function unknownOperation(directory, name) {
	const area = [...directory.areas.values()].find((entry) => name.startsWith(`${entry.name}.`));
	return refusal(area === void 0 ? copy.unknownOperationArea(name, [...directory.areas.keys()]) : copy.unknownOperation(name, area.operations.map((operation) => operation.name)));
}
/** A description's line that starts with `Gevolg:` states what the operation changes. */
const SIDE_EFFECT = /^Gevolg:\s*(.+)$/m;
function describe(directory, name) {
	const operation = directory.byName.get(name);
	if (operation === void 0) return unknownOperation(directory, name);
	return answer({
		name: operation.name,
		area: operation.area,
		kind: operation.kind,
		description: operation.description ?? null,
		sideEffect: operation.description?.match(SIDE_EFFECT)?.[1] ?? null,
		input: operation.input,
		output: operation.output ?? null
	});
}
function findAnswer(directory, words) {
	const found = find(directory.operations, words);
	if (found.length === 0) return answer({
		operations: [],
		message: copy.nothingFound(words, [...directory.areas.keys()])
	});
	return answer({ operations: found.map((operation) => ({
		name: operation.name,
		area: operation.area,
		kind: operation.kind,
		summary: summaryLine(operation)
	})) });
}
var OperationFailed = class extends Data.TaggedError("OperationFailed") {};
/**
* Runs the named operation once, as `actor`. The program's refusal comes back
* as a tool error carrying its sentence; a failure it did not mean to show is
* logged and answered with the door's generic sentence, so a database's words
* never reach the person.
*/
function call(directory, actor, name, input) {
	const operation = directory.byName.get(name);
	if (operation === void 0) return Effect.succeed(unknownOperation(directory, name));
	return Effect.tryPromise({
		try: () => operation.run(actor, input),
		catch: (cause) => new OperationFailed({
			name,
			cause
		})
	}).pipe(Effect.map((outcome) => "refusal" in outcome ? refusal(outcome.refusal) : {
		text: JSON.stringify(outcome.value),
		structured: { result: outcome.value }
	}), Effect.catchTag("OperationFailed", (failure) => Effect.logError(`Operation ${failure.name} failed`, Cause.die(failure.cause)).pipe(Effect.as(refusal(copy.internalError)))));
}
function result(answered) {
	return {
		content: [{
			type: "text",
			text: answered.text
		}],
		...answered.structured === void 0 ? {} : { structuredContent: answered.structured },
		...answered.isError ? { isError: true } : {}
	};
}
const text = (description) => ({
	type: "string",
	description
});
/**
* The MCP server for one request as `actor`: the four tools, in the order a
* person works, and the instructions.
*/
function mcpServer(directory, instructions, actor) {
	const server = new McpServer({
		name: "koppeling",
		version: "1"
	}, { instructions });
	const tools = copy.tools;
	server.registerTool("list", {
		title: tools.list.title,
		description: tools.list.description,
		inputSchema: fromJsonSchema({
			type: "object",
			properties: { area: text(tools.list.area) },
			additionalProperties: false
		}),
		annotations: { readOnlyHint: true }
	}, ({ area }) => result(list(directory, area)));
	server.registerTool("find", {
		title: tools.find.title,
		description: tools.find.description,
		inputSchema: fromJsonSchema({
			type: "object",
			properties: { words: text(tools.find.words) },
			required: ["words"],
			additionalProperties: false
		}),
		annotations: { readOnlyHint: true }
	}, ({ words }) => result(findAnswer(directory, words)));
	server.registerTool("describe", {
		title: tools.describe.title,
		description: tools.describe.description,
		inputSchema: fromJsonSchema({
			type: "object",
			properties: { name: text(tools.describe.name) },
			required: ["name"],
			additionalProperties: false
		}),
		annotations: { readOnlyHint: true }
	}, ({ name }) => result(describe(directory, name)));
	server.registerTool("call", {
		title: tools.call.title,
		description: tools.call.description,
		inputSchema: fromJsonSchema({
			type: "object",
			properties: {
				name: text(tools.call.name),
				input: { description: tools.call.input }
			},
			required: ["name"],
			additionalProperties: false
		}),
		annotations: {
			readOnlyHint: false,
			destructiveHint: true
		}
	}, async ({ name, input }) => result(await Effect.runPromise(call(directory, actor, name, input))));
	return server;
}
//#endregion
//#region src/door.ts
var Refused = class extends Data.TaggedError("Refused") {};
const refusalResponse = (status, sentence, headers = {}) => Response.json({ error: sentence }, {
	status,
	headers
});
/**
* The door: an MCP server over Streamable HTTP, stateless, that offers the
* catalogue through four tools to whoever the bearer token names.
*/
function koppeling(options) {
	const operations = toDirectory(options.catalogue);
	const instructions = instructionsFor(options.glossary, operations);
	const metadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(options.resource.url));
	const verify = bearerVerifier(options.identity, options.resource.url);
	const document = {
		resource: options.resource.url,
		authorization_servers: [options.identity.authorizationServer],
		scopes_supported: options.resource.scopes,
		bearer_methods_supported: ["header"]
	};
	const serverFor = (actor) => mcpServer(operations, instructions, actor);
	/**
	* A 2025-era request (the `initialize` handshake and what follows it) is
	* served the way the portal's door serves Claude Desktop today; a 2026-07-28
	* request goes to the SDK's own per-request handler.
	*/
	const serve = async (request, actor) => {
		if (await isLegacyRequest(request)) {
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: void 0,
				enableJsonResponse: true
			});
			await serverFor(actor).connect(transport);
			return transport.handleRequest(request);
		}
		const modern = createMcpHandler(() => serverFor(actor), { legacy: "reject" });
		try {
			return await modern.fetch(request);
		} finally {
			await modern.close();
		}
	};
	/**
	* Only POST: the door keeps no session, so it has no stream to open on a GET
	* and none to end on a DELETE.
	*/
	const handle = (request) => request.method !== "POST" ? Promise.resolve(new Response(null, {
		status: 405,
		headers: { Allow: "POST" }
	})) : Effect.runPromise(verify(request).pipe(Effect.flatMap((claims) => Effect.promise(async () => options.actorFor(claims))), Effect.flatMap((decision) => "refusal" in decision ? Effect.fail(new Refused({ sentence: decision.refusal })) : Effect.promise(() => serve(request, decision.actor))), Effect.catchTags({
		Unauthenticated: ({ sentence, tokenGiven }) => Effect.succeed(refusalResponse(401, sentence, { "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"${tokenGiven ? ", error=\"invalid_token\"" : ""}` })),
		Refused: ({ sentence }) => Effect.succeed(refusalResponse(403, sentence)),
		KeysUnreachable: ({ cause }) => Effect.logError("The identity provider's key set could not be read", Cause.die(cause)).pipe(Effect.as(refusalResponse(503, copy.keysUnreachable)))
	})));
	const metadata = (request) => request.method === "GET" || request.method === "HEAD" ? Response.json(document) : new Response(null, {
		status: 405,
		headers: { Allow: "GET, HEAD" }
	});
	return {
		handle,
		metadata,
		report: {
			areas: Object.fromEntries(Array.from(operations.areas.values(), (area) => [area.name, area.operations.length])),
			skipped: options.catalogue.skipped,
			undescribed: options.catalogue.undescribed
		}
	};
}
//#endregion
export { fromElysia, fromTrpcRouter, koppeling };
