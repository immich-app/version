import { parse } from 'semver';

/**
 * A version split into its numeric release components and its prerelease
 * identifiers. Every scheme parses into this shape, so one comparator orders
 * them all.
 */
export interface ParsedVersion {
  release: number[];
  prerelease: string[];
}

export interface VersionScheme {
  parse(version: string): ParsedVersion | null;
}

const DOTTED = /^(\d+(?:\.\d+){0,3})(?:-([\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*))?$/;

export const versionSchemes = {
  // Strict semver, without a leading v (the tag pattern strips it). Build
  // metadata is accepted and, as semver says, ignored for ordering.
  semver: {
    parse(version) {
      const parsed = parse(version);
      const build = parsed?.build.length ? `+${parsed.build.join('.')}` : '';
      return parsed && `${parsed.version}${build}` === version
        ? { release: [parsed.major, parsed.minor, parsed.patch], prerelease: parsed.prerelease.map(String) }
        : null;
    },
  },
  // One to four numeric components (391, 0.1.29.1), optionally followed by a
  // semver-style prerelease (0.1.29.1-rc2).
  dotted: {
    parse(version) {
      const match = DOTTED.exec(version);
      if (!match) {
        return null;
      }
      const release = match[1].split('.').map(Number);
      return release.some((component) => !Number.isSafeInteger(component))
        ? null
        : { release, prerelease: match[2]?.split('.') ?? [] };
    },
  },
} satisfies Record<string, VersionScheme>;

export type VersionSchemeName = keyof typeof versionSchemes;

export const isVersionSchemeName = (name: string): name is VersionSchemeName =>
  Object.keys(versionSchemes).includes(name);

/**
 * The prerelease label channels select on: the leading letters of the first
 * prerelease identifier, lowercased (rc.2 and rc1 are both `rc`). It is `null`
 * for a stable release, and empty for a prerelease that starts with a digit,
 * which only a channel admitting every prerelease (`*`) serves.
 */
export function prereleaseLabel({ prerelease }: ParsedVersion): string | null {
  return prerelease.length === 0 ? null : /^[A-Za-z]*/.exec(prerelease[0])![0].toLowerCase();
}

/**
 * Orders two versions, negative when `a` is older. Release components compare
 * numerically, a missing one counting as 0 (1.0 equals 1.0.0). Prereleases
 * follow semver: a release outranks its own prereleases, and identifiers
 * compare left to right, numbers numerically and below text. One deliberate
 * difference: an identifier of letters then digits counts as those two parts,
 * so rc2 < rc10, where semver compares them as text and ranks rc9 above rc10.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  const length = Math.max(a.release.length, b.release.length);
  for (let index = 0; index < length; index++) {
    const difference = (a.release[index] ?? 0) - (b.release[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }

  const stable = Number(a.prerelease.length === 0) - Number(b.prerelease.length === 0);
  if (stable !== 0 || a.prerelease.length === 0) {
    return stable;
  }

  const left = splitIdentifiers(a.prerelease);
  const right = splitIdentifiers(b.prerelease);
  for (const [index, identifier] of left.entries()) {
    if (index >= right.length) {
      return 1;
    }
    const order = compareIdentifiers(identifier, right[index]);
    if (order !== 0) {
      return order;
    }
  }
  return left.length < right.length ? -1 : 0;
}

const NUMERIC = /^\d+$/;
const LETTERS_THEN_DIGITS = /^([A-Za-z]+)(\d+)$/;

const splitIdentifiers = (identifiers: string[]) =>
  identifiers.flatMap((identifier) => {
    const match = LETTERS_THEN_DIGITS.exec(identifier);
    return match ? [match[1], match[2]] : [identifier];
  });

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) {
    // Compared as digit strings, so no identifier is too long to order.
    const aDigits = a.replace(/^0+(?=\d)/, '');
    const bDigits = b.replace(/^0+(?=\d)/, '');
    return Math.sign(aDigits.length - bDigits.length) || compareText(aDigits, bDigits);
  }
  if (aNumeric !== bNumeric) {
    return aNumeric ? -1 : 1;
  }
  return compareText(a, b);
}

const compareText = (a: string, b: string) => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};
