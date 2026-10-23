/**
 * Every sentence the door writes that a person may read, in Dutch as the
 * portal's door writes them. Names, schemas and the host's own words are
 * passed through as the host wrote them.
 */

const quoted = (names: readonly string[]) => names.map((name) => `"${name}"`).join(", ");

export const copy = {
  serverTitle: "Koppeling",
  tools: {
    list: {
      title: "Gebieden en operaties",
      description:
        "Zonder gebied: de gebieden van dit programma, elk met zijn regel en het aantal operaties. Met een gebied, precies zoals list het noemt: de operaties van dat gebied, elk met zijn soort en regel.",
      area: "Een gebied precies zoals list het noemt. Laat weg voor de lijst van gebieden.",
    },
    find: {
      title: "Operaties zoeken",
      description:
        "Zoekt operaties bij woorden uit hun naam, gebied, beschrijving en invoervelden, en geeft er hooguit tien, de beste eerst. Voert niets uit. Namen en velden zijn de woorden van het programma zelf, vaak Engels: zoek ook met die woorden.",
      words: "Waar de operatie over gaat, in een paar woorden.",
    },
    describe: {
      title: "Operatie lezen",
      description:
        "De volledige operatie: soort, beschrijving, invoerschema en uitvoerschema. Lees een operatie voordat je haar met call uitvoert.",
      name: "De naam van de operatie, precies zoals list of find haar noemt.",
    },
    call: {
      title: "Operatie uitvoeren",
      description:
        "Voert een operatie uit als de ingelogde persoon, met dezelfde rechten als in het programma zelf. Een operatie van soort write wijzigt gegevens: vraag de persoon eerst om toestemming en voer haar pas daarna uit. Lees de operatie eerst met describe.",
      name: "De naam van de operatie, precies zoals list of find haar noemt.",
      input:
        "De invoer volgens het invoerschema dat describe geeft. Laat weg als de operatie geen invoer heeft.",
    },
  },
  outline: (lines: readonly string[]) =>
    [
      "Gebieden van dit programma. Blader met list, zoek met find, lees een operatie met describe en voer haar uit met call. Een operatie van soort write wijzigt gegevens: vraag de persoon eerst.",
      ...lines,
    ].join("\n"),
  areaLine: (name: string, count: number, summary: string) =>
    `- ${name} (${count} ${count === 1 ? "operatie" : "operaties"}): ${summary}`,
  unknownArea: (area: string, areas: readonly string[]) =>
    `Onbekend gebied "${area}". Kies een gebied uit deze lijst: ${quoted(areas)}.`,
  unknownOperation: (name: string, names: readonly string[]) =>
    `Onbekende operatie "${name}". Kies een naam uit deze lijst: ${quoted(names)}.`,
  unknownOperationArea: (name: string, areas: readonly string[]) =>
    `Onbekende operatie "${name}". Kies eerst een gebied uit deze lijst en vraag met list zijn operaties op: ${quoted(areas)}.`,
  nothingFound: (words: string, areas: readonly string[]) =>
    `Geen operatie gevonden bij "${words}". Kies een gebied uit deze lijst en vraag met list zijn operaties op: ${quoted(areas)}.`,
  internalError: "Er is een interne fout opgetreden.",
  undescribedSchema:
    "Het programma beschrijft deze waarde in een vorm die de koppeling niet als JSON Schema kan schrijven; het programma controleert haar zelf bij call.",
  inputNotObject:
    "De invoer moet een object zijn, met params, query en body zoals het invoerschema ze noemt.",
  missingPathParameter: (name: string) => `De invoer mist params.${name}, dat in het pad staat.`,
  noBearer: "Niet geautoriseerd: deze koppeling vraagt een inlog.",
  badBearer: "Deze koppeling is verlopen of ongeldig. Log opnieuw in vanuit het programma.",
  keysUnreachable: "De inlog kan nu niet worden gecontroleerd. Probeer het later opnieuw.",
} as const;
