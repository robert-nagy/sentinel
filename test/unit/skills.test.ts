import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ARCHITECTURE_FILE } from '../../src/core/architecture.js';
import { runCommand } from '../../src/core/exec.js';
import { GUARDRAIL_RULES } from '../../src/core/guardrails.js';
import { TRACKER_VERBS } from '../../src/core/issue-tracker.js';
import { RFC_TEMPLATE } from '../../src/templates/rfc-template.js';

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
        const match = /^([a-z][a-z-]*)([`.,:;)]*)$/.exec(word);
        if (match?.[1] === undefined) break;
        chain.push(match[1]);
        if (match[2] !== '') break;
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
  [/\/repos\/\S*\/issues\b/, 'GitHub issues REST call'],
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

    it.skipIf(name === 'sentinel-doctor')('repeats every guardrail', () => {
      for (const rule of GUARDRAIL_RULES) expect(text, `${name} lacks: ${rule}`).toContain(rule);
    });

    it('does not hard-code a tracker', () => {
      for (const [pattern, label] of TRACKER_PATTERNS) {
        expect(pattern.test(text), `${label} in ${name}`).toBe(false);
      }
    });

    it('names only neutral tracker verbs', () => {
      const known: readonly string[] = TRACKER_VERBS.map((v) => v.verb);
      const sentence = /neutral verbs ((?:`[a-z-]+`(?:, | and )?)+)/.exec(text)?.[1];
      if (sentence === undefined) return;
      const named = [...sentence.matchAll(/`([a-z-]+)`/g)].map((m) => m[1] ?? '');
      for (const verb of named) expect(known, `${verb} in ${name}`).toContain(verb);
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

  it('have frontmatter and do not hard-code a tracker', () => {
    for (const file of agents) {
      const text = readFileSync(join(agentsDir, file), 'utf8');
      expect(frontmatter(text)?.name).toBe(file.replace(/\.md$/, ''));
      for (const [pattern, label] of TRACKER_PATTERNS) {
        expect(pattern.test(text), `${label} in ${file}`).toBe(false);
      }
    }
  });
});

describe('tracker verbs', () => {
  it('include the M9 verbs update and attach', () => {
    expect(TRACKER_VERBS.map((v) => v.verb)).toEqual(expect.arrayContaining(['update', 'attach']));
  });

  it('are all named by sentinel-intake', () => {
    const text = readFileSync(join(skillsDir, 'sentinel-intake', 'SKILL.md'), 'utf8');
    for (const { verb } of TRACKER_VERBS) {
      if (verb !== 'dedupe') expect(text, verb).toContain(`\`${verb}\``);
    }
  });
});

describe('learning steps (ADR-0008)', () => {
  const section = (name: string) => {
    const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    return /^## Lessons\n[\s\S]*?(?=^## )/m.exec(text)?.[0];
  };

  it('are identical in sentinel-sdlc and sentinel-sdlc-auto', () => {
    const sdlc = section('sentinel-sdlc');
    expect(sdlc, 'sentinel-sdlc has no Lessons section').toBeDefined();
    expect(section('sentinel-sdlc-auto')).toBe(sdlc);
  });

  it('recall, capture and offer PR lessons in both SDLC skills', () => {
    for (const name of ['sentinel-sdlc', 'sentinel-sdlc-auto']) {
      const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
      for (const step of ['learn suggest --offer', 'learn recall --paths', 'learn add --file']) {
        expect(text, `${name}: ${step}`).toContain(step);
      }
      expect(text).toContain('see Lessons');
    }
  });

  it('are used by review and babysit, and sentinel-learn-pr stops for the pick', () => {
    expect(readFileSync(join(skillsDir, 'sentinel-review', 'SKILL.md'), 'utf8')).toContain(
      'learn recall --paths',
    );
    expect(readFileSync(join(skillsDir, 'sentinel-babysit', 'SKILL.md'), 'utf8')).toContain(
      'recurring',
    );
    const learnPr = readFileSync(join(skillsDir, 'sentinel-learn-pr', 'SKILL.md'), 'utf8');
    expect(learnPr).toContain('## STOP');
    expect(learnPr).toContain('`6`');
    expect(frontmatter(learnPr)?.['disable-model-invocation']).toBeUndefined();
  });
});

describe('stack and architecture decision (issue 44)', () => {
  const read = (name: string) =>
    readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const section = (text: string, heading: string) =>
    new RegExp(`^## ${heading}\\n[\\s\\S]*?(?=^## )`, 'm').exec(text)?.[0];

  it('is decided with the user in sentinel-setup, with a STOP for each choice', () => {
    const decide = section(read('sentinel-setup'), 'Decide the stack and architecture');
    expect(decide, 'sentinel-setup has no decision section').toBeDefined();
    expect(decide?.match(/\*\*STOP\.\*\*/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    for (const step of ['2 to 3', 'setup --architecture', 'architecture show', 'ddd']) {
      expect(decide, step).toContain(step);
    }
    expect(read('sentinel-setup')).not.toContain('## Confirm the stack');
  });

  it('is checked before the RFC in both SDLC skills, identically, with a STOP', () => {
    const sdlc = section(read('sentinel-sdlc'), 'Stack and architecture');
    expect(sdlc, 'sentinel-sdlc has no Stack and architecture section').toBeDefined();
    expect(section(read('sentinel-sdlc-auto'), 'Stack and architecture')).toBe(sdlc);
    expect(sdlc).toContain('architecture show --json');
    expect(sdlc).toContain('**STOP.**');
    expect(sdlc).toContain('sentinel-sdlc-auto');
    for (const name of ['sentinel-sdlc', 'sentinel-sdlc-auto']) {
      expect(read(name), name).toContain('see Stack and architecture');
    }
  });

  it('is named in the RFC template and checked by the reviewers', () => {
    expect(RFC_TEMPLATE).toContain('## Stack and architecture');
    const reviewer = readFileSync(join(agentsDir, 'sentinel-reviewer.md'), 'utf8');
    for (const text of [reviewer, read('sentinel-review')]) {
      expect(text).toContain(ARCHITECTURE_FILE);
      expect(text).toContain('`architecture`');
    }
  });
});

describe('commandChains', () => {
  it('stops at placeholders, flags and paths', () => {
    expect(
      commandChains('Run `node scripts/sentinel.mjs prd validate docs/x.md --json` then done'),
    ).toEqual([['prd', 'validate']]);
    expect(commandChains('node scripts/sentinel.mjs rfc new <issue-id>')).toEqual([['rfc', 'new']]);
    expect(commandChains('Run `node scripts/sentinel.mjs issue describe` and follow it')).toEqual([
      ['issue', 'describe'],
    ]);
    expect(commandChains('no commands here')).toEqual([]);
  });
});
