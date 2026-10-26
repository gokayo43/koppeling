import type { Json, JsonObject } from "./json";

/** What one tool call answers: its text, a line after it, data beside it, and whether it refused. */
export interface Answer {
  readonly text: string;
  /** A second text block after `text`: which page this is, and how to ask for the next. */
  readonly note?: string;
  readonly structured?: JsonObject;
  readonly isError?: true;
}

/** A tool error: the sentence, and beside it as data whatever details came with it. */
export const refusal = (text: string, details?: Json): Answer => ({
  text,
  isError: true,
  ...(details === undefined ? {} : { structured: { refusal: text, details } }),
});
