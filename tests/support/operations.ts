/** Operations built in a case, for the modules that read a catalogue without running it. */
import { catalogue, type Catalogue, type Kind } from "../../src/catalogue";

export interface Sketch {
  readonly name: string;
  readonly kind?: Kind;
  readonly description?: string;
  readonly fields?: readonly string[];
}

/** A catalogue of `sketches`, each of whose `run` counts into `ran` and answers its name. */
export function sketched(sketches: readonly Sketch[], ran: string[] = []): Catalogue<null> {
  return catalogue(
    sketches.map((sketch) => ({
      name: sketch.name,
      kind: sketch.kind ?? "read",
      description: sketch.description,
      input: {
        schema: {
          type: "object",
          properties: Object.fromEntries(
            (sketch.fields ?? []).map((field) => [field, { type: "string" }]),
          ),
        },
      },
      output: undefined,
      run: async () => {
        ran.push(sketch.name);
        return { value: sketch.name };
      },
    })),
    [],
  );
}
