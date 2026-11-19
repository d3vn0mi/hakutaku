// The redaction rules, in the order they run. Their names are fixed: stores, gate reports and
// the sample's oracle name them.
//
// The patterns carry no "g" flag, so a caller's test() or exec() keeps no state between
// calls. Matching compiles its own copies.

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  // The capture group to replace; the whole match when absent.
  group?: number;
  // Bounds on the replaced text, in characters and in bits per character.
  minLength?: number;
  minEntropy?: number;
}

// Names under which an assigned value counts as a secret, matched case-insensitively.
const SECRET_NAMES = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "api-key",
  "apikey",
  "access_key",
  "private_key",
  "credential",
];

// assigned-secret, in parts:
// - a name that starts at a boundary and contains one of SECRET_NAMES (the lookahead keeps
//   the scan of a long name linear);
// - an optional closing quote, as in JSON or a dict key;
// - "=", ":", ":=" or "=>", with spaces or tabs around it;
// - the value, group 2: inside quotes (group 1 is the quote, and a backslash escapes the
//   next character), or a bare run of base64-like characters.
const NAME = String.raw`(?<![\w.-])(?=[\w.-]*?(?:${SECRET_NAMES.join("|")}))[\w.-]+["'${"`"}]?`;
const OPERATOR = String.raw`[ \t]*(?::=|=>|=|:)[ \t]*`;
const VALUE = String.raw`(["'${"`"}]?)((?<=["'${"`"}])(?:\\.|(?!\1)[^\\\n])*|(?<!["'${"`"}])[A-Za-z0-9+/=_.-]+)\1`;

export const REDACTION_RULES: readonly RedactionRule[] = [
  {
    // A "BEGIN ... PRIVATE KEY" block through its END line. The body never runs past another
    // BEGIN line, so a BEGIN without an END costs one scan to the next BEGIN.
    name: "private-key",
    pattern:
      /-----BEGIN[A-Z0-9 _-]{0,100}PRIVATE KEY(?: BLOCK)?-----(?:(?!-----BEGIN)[\s\S])*?-----END[A-Z0-9 _-]{0,100}PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    name: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/,
  },
  {
    name: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{82}(?!\w))/,
  },
  { name: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { name: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  {
    name: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/,
  },
  { name: "stripe-key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{24,}/ },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/ },
  {
    name: "jwt",
    pattern: /\beyJ[\w-]{5,}\.eyJ[\w-]{5,}\.[\w-]{8,}/,
  },
  {
    name: "assigned-secret",
    pattern: new RegExp(NAME + OPERATOR + VALUE, "i"),
    group: 2,
    minLength: 16,
    minEntropy: 3.5,
  },
];
