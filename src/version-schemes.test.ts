import semver from 'semver';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  prereleaseLabel,
  versionSchemes,
  type ParsedVersion,
  type VersionSchemeName,
} from './version-schemes.js';

const parseSemver = (version: string) => versionSchemes.semver.parse(version);
const parseDotted = (version: string) => versionSchemes.dotted.parse(version);
const parsedVersion = (release: number[], prerelease: string[] = []): ParsedVersion => ({ release, prerelease });

const mustParse = (scheme: VersionSchemeName, version: string) => {
  const parsed = versionSchemes[scheme].parse(version);
  expect(parsed, `${scheme} parses ${version}`).not.toBeNull();
  return parsed!;
};

// Every pair in `versions` must compare in list order, both ways round.
const expectAscending = (scheme: VersionSchemeName, versions: string[]) => {
  const parsed = versions.map((version) => mustParse(scheme, version));
  for (let i = 0; i < versions.length; i++) {
    for (let j = i + 1; j < versions.length; j++) {
      expect(compareVersions(parsed[i], parsed[j]), `${versions[i]} < ${versions[j]}`).toBe(-1);
      expect(compareVersions(parsed[j], parsed[i]), `${versions[j]} > ${versions[i]}`).toBe(1);
    }
  }
};

describe('semver scheme', () => {
  it('parses a release and a prerelease', () => {
    expect(parseSemver('3.3.0')).toEqual({ release: [3, 3, 0], prerelease: [] });
    expect(parseSemver('3.3.0-rc.2')).toEqual({ release: [3, 3, 0], prerelease: ['rc', '2'] });
    expect(parseSemver('1.0.0-rc1')).toEqual({ release: [1, 0, 0], prerelease: ['rc1'] });
  });

  it('accepts build metadata, which does not affect ordering', () => {
    expect(parseSemver('1.2.3+build.5')).toEqual({ release: [1, 2, 3], prerelease: [] });
    expect(compareVersions(mustParse('semver', '1.2.3+a'), mustParse('semver', '1.2.3+b'))).toBe(0);
  });

  it.each(['v1.2.3', '=1.2.3', ' 1.2.3', '1.2.3 ', '1.2', '01.2.3', '1.2.3-rc.01', '1.2.3-', '1.2.3.4', ''])(
    'rejects %j',
    (version) => {
      expect(parseSemver(version)).toBeNull();
    },
  );

  it('orders the semver spec precedence example', () => {
    expectAscending('semver', [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ]);
  });

  it('orders Immich releases', () => {
    expectAscending('semver', [
      '1.99.0',
      '1.100.0',
      '2.0.0',
      '3.2.0-rc.1',
      '3.2.0-rc.2',
      '3.2.0-rc.9',
      '3.2.0-rc.10',
      '3.2.0',
      '3.2.4',
      '3.3.0-rc.0',
      '3.3.0',
      '10.0.0',
    ]);
  });

  it('orders letters-then-digits identifiers numerically: rc2 < rc10', () => {
    expectAscending('semver', ['1.0.0-rc', '1.0.0-rc1', '1.0.0-rc2', '1.0.0-rc9', '1.0.0-rc10', '1.0.0']);
    // Plain semver compares them as text and gets it backwards.
    expect(semver.compare('1.0.0-rc10', '1.0.0-rc9')).toBe(-1);
  });

  it('agrees with semver wherever no identifier mixes letters and digits', () => {
    const versions = [
      '0.0.1',
      '0.1.0',
      '1.0.0-0',
      '1.0.0-1',
      '1.0.0-alpha',
      '1.0.0-alpha.0',
      '1.0.0-alpha.beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0',
      '1.0.1',
      '1.10.0',
      '1.2.0',
      '2.0.0-rc.1',
      '2.0.0+build',
      '2.0.0',
    ];
    for (const a of versions) {
      for (const b of versions) {
        expect(compareVersions(mustParse('semver', a), mustParse('semver', b)), `${a} vs ${b}`).toBe(
          semver.compare(a, b),
        );
      }
    }
  });
});

describe('dotted scheme', () => {
  it('parses one to four components and a prerelease', () => {
    expect(parseDotted('391')).toEqual({ release: [391], prerelease: [] });
    expect(parseDotted('0.1.22')).toEqual({ release: [0, 1, 22], prerelease: [] });
    expect(parseDotted('0.1.29.1')).toEqual({ release: [0, 1, 29, 1], prerelease: [] });
    expect(parseDotted('0.1.29.1-rc2')).toEqual({ release: [0, 1, 29, 1], prerelease: ['rc2'] });
    expect(parseDotted('2.0-beta.3')).toEqual({ release: [2, 0], prerelease: ['beta', '3'] });
  });

  it.each([
    'v0.1.22',
    '1.2.3.4.5',
    '1..2',
    '1.2.',
    '1.2-',
    '1.2+build',
    '1.2-rc..1',
    ' 1.2',
    '1.2\n',
    '1.2\r',
    '99999999999999999',
    '',
  ])('rejects %j', (version) => {
    expect(parseDotted(version)).toBeNull();
  });

  it('orders component by component, a missing component counting as 0', () => {
    expectAscending('dotted', [
      '0.1.22',
      '0.1.29',
      '0.1.29.1-rc2',
      '0.1.29.1-rc10',
      '0.1.29.1',
      '0.1.30',
      '1',
      '2.0.1',
      '391',
    ]);
    expect(compareVersions(mustParse('dotted', '1.0'), mustParse('dotted', '1.0.0'))).toBe(0);
  });
});

describe('compareVersions', () => {
  it('ranks a release above its own prereleases', () => {
    expect(compareVersions(parsedVersion([1, 0, 0]), parsedVersion([1, 0, 0], ['rc', '1']))).toBe(1);
    expect(compareVersions(parsedVersion([1, 0, 0], ['rc', '1']), parsedVersion([1, 0, 0]))).toBe(-1);
  });

  it('treats rc2 and rc.2 as the same prerelease', () => {
    expect(compareVersions(parsedVersion([1, 0, 0], ['rc2']), parsedVersion([1, 0, 0], ['rc', '2']))).toBe(0);
  });

  it('orders numeric identifiers too long for a number', () => {
    const shorter = parsedVersion([1], ['99999999999999999998']);
    const longer = parsedVersion([1], ['99999999999999999999']);
    expect(compareVersions(shorter, longer)).toBe(-1);
    expect(compareVersions(parsedVersion([1], ['0010']), parsedVersion([1], ['9']))).toBe(1);
  });
});

describe('prereleaseLabel', () => {
  it.each([
    ['3.3.0', null],
    ['3.3.0-rc.2', 'rc'],
    ['1.0.0-rc1', 'rc'],
    ['1.0.0-RC1', 'rc'],
    ['1.0.0-beta', 'beta'],
    ['1.0.0-alpha-1.2', 'alpha'],
    ['1.0.0-8', ''],
  ])('labels %s as %j', (version, label) => {
    expect(prereleaseLabel(mustParse('semver', version))).toBe(label);
  });
});
