// The types of check-release.mjs, the checks a release runs before it publishes.

// The problems that stop a release. A tag that is not v<major>.<minor>.<patch> gives that one
// problem alone; otherwise, in this order: the tag against package.json's version, no notes
// under "## <version>" in the changelog, and each other version the README pins, once, in the
// order it first appears.
export function checkRelease(input: {
  tag: string;
  version: string;
  changelog: string;
  readme: string;
}): string[];

// The lines after the heading "## <version>", up to the next line that starts "## " or the end,
// with the blank lines at either end trimmed and one final newline; null when there is no such
// heading or its section is blank.
export function notesFor(changelog: string, version: string): string | null;

// Whether version is min or later, comparing major, minor and patch as numbers; false when
// either is not a version.
export function versionAtLeast(version: string, min: string): boolean;
