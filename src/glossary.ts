import { copy } from "./copy";

export interface GlossaryOptions {
  /** The most characters the glossary may take, the closing line included. */
  readonly limit: number;
}

interface Section {
  readonly heading: string;
  readonly text: string[];
  readonly terms: string[];
  inTerms: boolean;
}

/** Markdown's inline marks taken off, so the words read as plain text. */
function plain(markdown: string): string {
  return markdown
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/(\*\*|__|\*|_|`)(.+?)\1/g, "$2")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function firstSentence(paragraph: string): string {
  return /^(.+?[.!?])(?:\s|$)/.exec(paragraph)?.[1] ?? paragraph;
}

function lineOf(section: Section): string {
  const own = section.text.length ? firstSentence(plain(section.text.join(" "))) : "";
  const terms = section.terms.length ? copy.glossaryTerms(section.terms) : "";
  return [`${section.heading.replace(/[.:]+$/, "")}.`, own, terms].filter(Boolean).join(" ");
}

/**
 * A program's glossary (its CONTEXT.md) as the door's opening words: one line
 * per `##` section, its heading, the first sentence of its own text where it
 * has one, and the names of its `###` terms. Lines are kept in order while
 * they fit within `limit`; a closing line names the sections left out.
 */
export function glossaryFrom(markdown: string, options: GlossaryOptions): string {
  const sections: Section[] = [];
  let paragraphDone = false;
  for (const line of markdown.split("\n")) {
    const heading = /^(#{2,3})\s+(.+?)\s*#*$/.exec(line);
    const current = sections.at(-1);
    if (heading?.[1] === "##") {
      sections.push({ heading: plain(heading[2] ?? ""), text: [], terms: [], inTerms: false });
      paragraphDone = false;
    } else if (heading?.[1] === "###") {
      if (current) {
        current.terms.push(plain(heading[2] ?? ""));
        current.inTerms = true;
      }
    } else if (current && !current.inTerms && !line.startsWith("#")) {
      if (line.trim() === "") paragraphDone ||= current.text.length > 0;
      else if (!paragraphDone) current.text.push(line.trim());
    }
  }
  const lines = sections.map(lineOf);
  for (let kept = lines.length; kept >= 0; kept -= 1) {
    const left = sections.slice(kept).map(({ heading }) => heading);
    const text = [
      ...lines.slice(0, kept),
      ...(left.length ? [copy.glossaryLeftOut(left)] : []),
    ].join("\n");
    if (text.length <= options.limit) return text;
  }
  return copy.glossaryLeftOut(sections.map(({ heading }) => heading)).slice(0, options.limit);
}
