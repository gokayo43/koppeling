/**
 * The grammar of a bearer challenge (RFC 6750 §3): the `scope` a person's
 * login is asked for, the `error_description` beside an error, and the
 * `WWW-Authenticate` header that carries them.
 */

/** One scope token: printable ASCII but space, `"` and `\`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/** What an `error_description` allows: printable ASCII but `"` and `\`. */
const OUTSIDE_DESCRIPTION = /[^\x20\x21\x23-\x5B\x5D-\x7E]/g;

/**
 * A `scope` value's tokens, split by one space; a value that is no such list
 * throws, naming `owner`, so a host learns which answer of its was wrong.
 */
export function scopeTokens(scope: string, owner: string): readonly string[] {
  const tokens = scope.split(" ");
  if (!tokens.every((token) => SCOPE_TOKEN.test(token))) {
    throw new Error(
      `${owner} answered the scope ${JSON.stringify(scope)}, which is no OAuth scope (printable ASCII but " and \\, words split by one space)`,
    );
  }
  return tokens;
}

/**
 * `text` as an `error_description` parameter, which allows one or more of its
 * characters: letters lose their accents, anything else is dropped, and a
 * text with nothing left gives no parameter.
 */
export function errorDescription(text: string): readonly string[] {
  const kept = text
    .normalize("NFKD")
    .replaceAll(/\s+/g, " ")
    .replaceAll(OUTSIDE_DESCRIPTION, "")
    .trim();
  return kept ? [`error_description="${kept}"`] : [];
}

/** The `WWW-Authenticate` header naming the metadata document at `metadataUrl`, then `params`. */
export const challenge = (metadataUrl: string, ...params: readonly string[]) => ({
  "WWW-Authenticate": [`Bearer resource_metadata="${metadataUrl}"`, ...params].join(", "),
});
