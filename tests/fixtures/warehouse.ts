/**
 * A warehouse router shaped like A1M4N3/wmstcs's: its areas, procedure names
 * and input shapes, with trivial handlers and invented values only.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import { Schema } from "effect";
import { z } from "zod";

export interface WarehouseActor {
  readonly id: number;
  readonly name: string;
  readonly role: "admin" | "picker";
}

export interface WarehouseContext {
  readonly user: WarehouseActor;
}

const t = initTRPC.context<WarehouseContext>().meta<{ description?: string }>().create();

const input = <A, I>(schema: Schema.Schema<A, I>) => Schema.standardSchemaV1(schema);
const OrderId = Schema.Struct({ orderId: Schema.Int });
const ShelfCode = Schema.String.pipe(Schema.pattern(/^[A-Z]\d+$/));
const Sku = Schema.NonEmptyString;

/**
 * Every procedure reports its path to `invoked` before it does anything, so a
 * test can count what the door ran.
 */
export function warehouseRouter(invoked: (path: string) => void = () => {}) {
  const procedure = t.procedure.use(({ path, next }) => {
    invoked(path);
    return next();
  });
  const adminProcedure = procedure.use(({ ctx, next }) => {
    if (ctx.user.role !== "admin")
      throw new TRPCError({ code: "FORBIDDEN", message: "Alleen voor admin" });
    return next();
  });

  const orders = t.router({
    list: procedure
      .meta({
        description:
          "De orders, gefilterd op status; zonder status de orders die nog gepickt moeten worden.",
      })
      .input(
        input(
          Schema.Struct({
            status: Schema.optional(Schema.String),
            page: Schema.optional(Schema.Int),
          }),
        ),
      )
      .query(() => [{ orderId: 1001, status: "processing", customer: "Klant Een" }]),
    get: procedure
      .meta({ description: "Eén order met zijn regels, picks en verzendingen." })
      .input(input(OrderId))
      .query(({ input: { orderId } }) => ({ orderId, status: "processing", lines: [] })),
    pickupSchedule: procedure
      .meta({ description: "De afhaalorders per dag." })
      .query(() => [{ day: "2026-01-05", orders: [1002] }]),
    shippingQueue: procedure
      .meta({ description: "Orders die gepickt zijn en klaar om te verzenden." })
      .input(input(Schema.Struct({ carrier: Schema.optional(Schema.String) })))
      .query(() => [{ orderId: 1003 }]),
    claimPicking: procedure
      .meta({
        description:
          "Begint het picken van een order en zet hem op jouw naam.\nGevolg: anderen zien de order als bezet.",
      })
      .input(input(Schema.Struct({ orderId: Schema.Int, force: Schema.optional(Schema.Boolean) })))
      .mutation(({ input: { orderId } }) => ({ orderId, claimed: true })),
    releasePicking: procedure
      .meta({ description: "Geeft een order die je aan het picken bent weer vrij." })
      .input(input(OrderId))
      .mutation(({ input: { orderId } }) => ({ orderId, claimed: false })),
    updatePicking: procedure
      .meta({
        description:
          "Legt vast wat er per orderregel gepickt is: aantal, sku en plank.\nGevolg: de order telt als gepickt zodra elke regel compleet is.",
      })
      .input(
        input(
          Schema.Struct({
            orderId: Schema.Int,
            pickedProducts: Schema.optional(
              Schema.Record({ key: Schema.String, value: Schema.Int }),
            ),
            pickedShelves: Schema.optional(
              Schema.Record({ key: Schema.String, value: Schema.String }),
            ),
          }),
        ),
      )
      .mutation(({ input: { orderId } }) => ({ orderId, picked: true })),
    ship: procedure
      .meta({
        description: "Verzendt een gepickte order: kiest de vervoerder en maakt het verzendlabel.",
      })
      .input(
        input(
          Schema.Struct({
            orderId: Schema.Int,
            selectedShippingMethod: Schema.optional(Schema.String),
          }),
        ),
      )
      .mutation(({ input: { orderId } }) => {
        if (orderId === 9999) throw new Error("connect ECONNREFUSED 10.0.0.9:443");
        return { orderId, shipped: true };
      }),
    reprintLabel: procedure
      .meta({ description: "Print het verzendlabel van een order opnieuw." })
      .input(input(OrderId))
      .mutation(() => ({ printed: true })),
    cancel: procedure
      .meta({ description: "Annuleert een handmatige afhaalorder zonder hem af te ronden." })
      .input(input(Schema.Struct({ orderId: Schema.Int, reason: Schema.optional(Schema.String) })))
      .mutation(({ input: { orderId } }) => ({ orderId, cancelled: true })),
    onChange: procedure.subscription(async function* () {
      yield { orderId: 1001 };
    }),
  });

  const bestellingen = t.router({
    list: adminProcedure
      .meta({ description: "De inkoopbestellingen bij leveranciers, op status." })
      .input(input(Schema.Struct({ status: Schema.optional(Schema.String) })))
      .query(() => [{ bestellingId: 501, supplier: "Leverancier A", status: "open" }]),
    get: adminProcedure
      .meta({ description: "Eén inkoopbestelling met haar regels." })
      .input(input(Schema.Struct({ bestellingId: Schema.Int })))
      .query(({ input: { bestellingId } }) => ({ bestellingId, lines: [] })),
    create: adminProcedure
      .meta({ description: "Maakt een nieuwe inkoopbestelling bij een leverancier." })
      .input(input(Schema.Struct({ supplierId: Schema.Int, note: Schema.optional(Schema.String) })))
      .mutation(() => ({ bestellingId: 502 })),
    setStatus: adminProcedure
      .meta({
        description: "Zet de status van een inkoopbestelling, zoals besteld of geannuleerd.",
      })
      .input(
        input(
          Schema.Struct({
            bestellingId: Schema.Int,
            status: Schema.Literal("open", "besteld", "geannuleerd"),
          }),
        ),
      )
      .mutation(({ input: { bestellingId, status } }) => ({ bestellingId, status })),
    addLine: adminProcedure
      .meta({ description: "Voegt een product toe aan een inkoopbestelling." })
      .input(input(Schema.Struct({ bestellingId: Schema.Int, sku: Sku, quantity: Schema.Int })))
      .mutation(() => ({ lineId: 9 })),
    removeLine: adminProcedure
      .meta({ description: "Haalt een regel van een inkoopbestelling." })
      .input(input(Schema.Struct({ lineId: Schema.Int })))
      .mutation(() => ({ removed: true })),
    bookReceipts: adminProcedure
      .meta({
        description:
          "Boekt ontvangen aantallen van een inkoopbestelling in de voorraad.\nGevolg: de voorraad gaat omhoog.",
      })
      .input(
        input(
          Schema.Struct({
            bestellingId: Schema.Int,
            received: Schema.Array(Schema.Struct({ lineId: Schema.Int, quantity: Schema.Int })),
          }),
        ),
      )
      .mutation(() => ({ booked: 1 })),
  });

  const inventory = t.router({
    bySku: procedure
      .meta({ description: "De voorraad van één sku: totaal en per plank." })
      .input(input(Schema.Struct({ sku: Sku })))
      .output(
        z.object({
          sku: z.string(),
          total: z.number(),
          shelves: z.array(z.object({ shelf: z.string(), quantity: z.number() })),
        }),
      )
      .query(({ input: { sku } }) => ({ sku, total: 7, shelves: [{ shelf: "A3", quantity: 7 }] })),
    lookupLocations: procedure
      .meta({ description: "Op welke planken een sku ligt." })
      .input(input(Schema.Struct({ skus: Schema.Array(Sku) })))
      .query(() => [{ sku: "SKU-1", shelves: ["A3"] }]),
    lastKnownPlaces: procedure
      .meta({ description: "Waar een sku het laatst gezien is, ook als hij nu nergens ligt." })
      .input(input(Schema.Struct({ sku: Sku })))
      .query(() => [{ shelf: "B1", seenAt: new Date(Date.UTC(2026, 0, 2)) }]),
    subcategories: procedure
      .meta({ description: "De subcategorieën van het assortiment." })
      .query(() => ["Uitlaat", "Remmen"]),
  });

  const counting = t.router({
    worklist: procedure
      .meta({ description: "De planken die nog geteld moeten worden." })
      .query(() => [{ shelfCode: "A3", lastCounted: null }]),
    countRow: procedure
      .meta({
        description:
          "Legt de getelde voorraad van één sku op een plank vast.\nGevolg: de voorraad van die plank wordt de telling.",
      })
      .input(
        input(
          Schema.Struct({
            shelfCode: ShelfCode,
            sku: Sku,
            quantity: Schema.Int,
            idempotencyKey: Schema.String,
          }),
        ),
      )
      .mutation(({ input: { shelfCode, sku, quantity } }) => ({ shelfCode, sku, quantity })),
    completeShelf: procedure
      .meta({
        description:
          "Meldt een plank klaar met alles wat erop ligt.\nGevolg: wat niet genoemd is, staat daarna op nul.",
      })
      .input(
        input(
          Schema.Struct({
            shelfCode: ShelfCode,
            idempotencyKey: Schema.String,
            rows: Schema.Array(Schema.Struct({ sku: Sku, quantity: Schema.Int })),
          }),
        ),
      )
      .mutation(({ input: { shelfCode } }) => ({ shelfCode, done: true })),
    skuRefusal: procedure
      .meta({ description: "Waarom een sku niet geteld mag worden, als dat zo is." })
      .input(input(Schema.Struct({ sku: Sku })))
      .query(() => null),
  });

  const warehouseRelocation = t.router({
    listShelves: procedure
      .meta({ description: "Alle planken van het magazijn." })
      .query(() => [{ code: "A3" }, { code: "B1" }]),
    listProducts: procedure
      .meta({ description: "De producten van een categorie met hun planken." })
      .input(input(Schema.Struct({ categoryId: Schema.Int })))
      .query(() => []),
    search: procedure
      .meta({ description: "Zoekt producten om te verplaatsen op sku of naam." })
      .input(input(Schema.Struct({ q: Schema.String })))
      .query(() => []),
    move: procedure
      .meta({
        description:
          "Verplaatst een aantal van een product van de ene plank naar de andere.\nGevolg: de voorraad van beide planken verandert.",
      })
      .input(
        input(
          Schema.Struct({
            code: Sku,
            fromShelf: ShelfCode,
            toShelf: ShelfCode,
            quantity: Schema.Int,
            idempotencyKey: Schema.String,
          }),
        ),
      )
      .mutation(({ input: { code, fromShelf, toShelf, quantity } }) => ({
        code,
        fromShelf,
        toShelf,
        quantity,
      })),
  });

  const SupplierFields = z.object({
    name: z.string().min(1),
    email: z.string().optional(),
    phone: z.string().optional(),
  });
  const suppliers = t.router({
    list: procedure
      .meta({ description: "De leveranciers, optioneel gezocht op naam." })
      .input(z.object({ search: z.string().optional() }))
      .query(() => [{ supplierId: 1, name: "Leverancier A" }]),
    get: procedure
      .meta({ description: "Eén leverancier met zijn contactpersonen." })
      .input(z.object({ supplierId: z.number().int() }))
      .query(({ input: { supplierId } }) => ({ supplierId, name: "Leverancier A", contacts: [] })),
    create: adminProcedure
      .meta({ description: "Voegt een nieuwe leverancier toe." })
      .input(SupplierFields)
      .mutation(() => ({ supplierId: 2 })),
    update: adminProcedure
      .meta({
        description: "Wijzigt de naam, het e-mailadres of het telefoonnummer van een leverancier.",
      })
      .input(SupplierFields.partial().extend({ supplierId: z.number().int() }))
      .mutation(({ input: { supplierId } }) => ({ supplierId })),
    delete: adminProcedure
      .meta({
        description: "Verwijdert een leverancier.\nGevolg: zijn producten houden geen leverancier.",
      })
      .input(z.object({ supplierId: z.number().int() }))
      .mutation(() => ({ deleted: true })),
    createContact: adminProcedure
      .meta({ description: "Voegt een contactpersoon toe aan een leverancier." })
      .input(
        z.object({ supplierId: z.number().int(), name: z.string(), phone: z.string().optional() }),
      )
      .mutation(() => ({ contactId: 3 })),
    updateContact: adminProcedure
      .meta({ description: "Wijzigt een contactpersoon van een leverancier." })
      .input(
        z.object({
          contactId: z.number().int(),
          name: z.string().optional(),
          phone: z.string().optional(),
        }),
      )
      .mutation(({ input: { contactId } }) => ({ contactId })),
  });

  const printer = t.router({
    status: procedure
      .meta({ description: "Of de labelprinter aan staat en papier heeft." })
      .query(() => ({ online: true })),
    printSticker: procedure
      .meta({ description: "Print een productsticker voor een sku." })
      .input(input(Schema.Struct({ sku: Sku, copies: Schema.optional(Schema.Int) })))
      .mutation(() => ({ printed: true })),
    printBarcodeLabel: procedure
      .meta({ description: "Print een barcodelabel met een vrije tekst." })
      .input(input(Schema.Struct({ text: Schema.String })))
      .mutation(() => ({ printed: true })),
    printShelve: procedure
      .meta({ description: "Print het label van een plank." })
      .input(input(Schema.Struct({ shelfCode: ShelfCode })))
      .mutation(() => ({ printed: true })),
    printBatchStickers: procedure
      .meta({ description: "Print stickers voor meerdere sku's tegelijk." })
      .input(input(Schema.Struct({ skus: Schema.Array(Sku) })))
      .mutation(() => ({ printed: true })),
  });

  return t.router({
    orders,
    bestellingen,
    inventory,
    counting,
    warehouseRelocation,
    suppliers,
    printer,
  });
}

/** The context the warehouse's UI requests get, built for the koppeling's actor. */
export const contextFor = (user: WarehouseActor): WarehouseContext => ({ user });

export const glossary = [
  "Magazijn (wmstcs). Woorden:",
  "- order: een bestelling van een klant, die gepickt en verzonden wordt.",
  "- bestelling: een inkoopbestelling bij een leverancier.",
  "- plank (shelf): een vaste plek in het magazijn, met een code als A3.",
  "- sku: de code van een product.",
].join("\n");
