import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../src/core/exec.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pluginDir = join(root, 'plugins', 'sentinel');
const skillsDir = join(pluginDir, 'skills');
const agentsDir = join(pluginDir, 'agents');

const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** `key: value` lines between the first two `---` lines; values are single-line strings. */
function frontmatter(text: string): Record<string, string> | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return undefined;
  const end = lines.indexOf('---', 1);
  if (end === -1) return undefined;
  const result: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(':');
    if (colon > 0) result[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return result;
}

/**
 * Commands a skill invokes: the words after `node scripts/sentinel.mjs`, up to the first
 * word that is not a plain lower-case command name. Skills must write arguments as
 * `<placeholder>` or flags, never as bare words.
 */
export function commandChains(text: string): string[][] {
  const chains: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = 'node scripts/sentinel.mjs';
    let from = line.indexOf(marker);
    while (from !== -1) {
      const words = line
        .slice(from + marker.length)
        .trim()
        .split(/\s+/);
      const chain: string[] = [];
      for (const word of words) {
        if (!/^[a-z][a-z-]*$/.test(word)) break;
        chain.push(word);
      }
      if (chain.length > 0) chains.push(chain);
      from = line.indexOf(marker, from + marker.length);
    }
  }
  return chains;
}

const TRACKER_PATTERNS: readonly [RegExp, string][] = [
  [/\b(?:gh|glab) issue\b/, 'gh/glab issue'],
  [/\baz boards\b/, 'az boards'],
  [/api\.github\.com\/repos\/[^\s]*issues/, 'GitHub issues REST call'],
  [/\/rest\/api\/\d/, 'Jira REST call'],
];

describe('skill files', () => {
  it('has at least one skill', () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  describe.each(skills)('%s', (name) => {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
    const meta = frontmatter(text);

    it('has valid Agent Skills frontmatter', () => {
      expect(meta, 'missing frontmatter').toBeDefined();
      expect(meta?.name).toBe(name);
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(name.length).toBeLessThanOrEqual(64);
      const description = meta?.description ?? '';
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(1024);
    });

    it('does not hard-code a tracker', () => {
      for (const [pattern, label] of TRACKER_PATTERNS) {
        expect(pattern.test(text), `${label} in ${name}`).toBe(false);
      }
    });

    it('only names CLI commands the committed bundle has', async () => {
      const bundle = join(skillsDir, name, 'scripts', 'sentinel.mjs');
      expect(existsSync(bundle)).toBe(true);
      const seen = new Set<string>();
      for (const chain of commandChains(text)) {
        const key = chain.join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        const result = await runCommand(process.execPath, [bundle, ...chain, '--help'], {
          cwd: root,
          timeoutMs: 45_000,
        });
        expect(result.exitCode, `"sentinel ${key}" in ${name}: ${result.stderr}`).toBe(0);
      }
    });
  });
});

describe('sub-agents', () => {
  const agents = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter((file) => file.endsWith('.md'))
    : [];

  it.each(agents)('%s has frontmatter and does not hard-code a tracker', (file) => {
    const text = readFileSync(join(agentsDir, file), 'utf8');
    expect(frontmatter(text)?.name).toBe(file.replace(/\.md$/, ''));
    for (const [pattern, label] of TRACKER_PATTERNS) {
      expect(pattern.test(text), `${label} in ${file}`).toBe(false);
    }
  });
});

describe('commandChains', () => {
  it('stops at placeholders, flags and paths', () => {
    expect(
      commandChains('Run `node scripts/sentinel.mjs prd validate docs/x.md --json` then done'),
    ).toEqual([['prd', 'validate']]);
    expect(commandChains('node scripts/sentinel.mjs rfc new <issue-id>')).toEqual([['rfc', 'new']]);
    expect(commandChains('no commands here')).toEqual([]);
  });
});
