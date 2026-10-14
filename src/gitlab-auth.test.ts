import { describe, expect, it } from 'vitest';
import { GitLabTokens } from './gitlab-auth.js';
import { SourceAuthError } from './sources.js';

const NOTES = { host: 'gitlab.futo.org', projectId: 488 };

describe('GitLabTokens', () => {
  it("gives a project its own token, under the project's own rate limit", () => {
    const credentials = new GitLabTokens(JSON.stringify({ 'gitlab.futo.org/488': 'glpat-notes' })).forProject(NOTES);

    expect(credentials.token()).toBe('glpat-notes');
    expect(credentials.rateLimitKey).toBe('gitlab:gitlab.futo.org:488');
  });

  it.each([
    ['without the binding', undefined],
    ['with an empty one', '{}'],
    ["with only another project's token", JSON.stringify({ 'gitlab.futo.org/9': 'glpat-other' })],
    ["with only another host's project 488", JSON.stringify({ 'gitlab.example.org/488': 'glpat-elsewhere' })],
  ])("reads a project anonymously %s, sharing its host's limit", (_, raw) => {
    const credentials = new GitLabTokens(raw).forProject(NOTES);

    expect(credentials.token()).toBeUndefined();
    expect(credentials.rateLimitKey).toBe('gitlab-anonymous:gitlab.futo.org');
  });

  it.each([
    ['not JSON', 'glpat-notes'],
    ['a list', '["glpat-notes"]'],
    ['a token that is not a string', JSON.stringify({ 'gitlab.futo.org/488': 488 })],
    ['an empty token', JSON.stringify({ 'gitlab.futo.org/488': '' })],
  ])('fails as auth when the binding is %s, without repeating it', (_, raw) => {
    const credentials = new GitLabTokens(raw).forProject(NOTES);

    expect(() => credentials.token()).toThrow(SourceAuthError);
    expect(() => credentials.token()).not.toThrow(/glpat/);
    expect(credentials.rateLimitKey).toBe('gitlab:gitlab.futo.org:488');
  });
});
