import { describe, expect, it } from 'vitest';
import {
  ARCHITECTURE_FILE,
  ArchitectureError,
  buildDecision,
  formatDecision,
  nextAdrPath,
  parseDecision,
  parseStackOption,
  plannedProjects,
  renderDecisionAdr,
  validateDecision,
} from '../../src/core/architecture.js';

interface FixtureLayer {
  name: string;
  path?: string;
  ecosystem?: string;
  language: string;
  frameworks: string[];
}

const layers: FixtureLayer[] = [
  {
    name: 'backend',
    path: 'src/backend',
    ecosystem: 'dotnet',
    language: 'C#',
    frameworks: ['ASP.NET Core'],
  },
  {
    name: 'frontend',
    path: 'src/web',
    ecosystem: 'node',
    language: 'TypeScript',
    frameworks: ['React'],
  },
  { name: 'database', language: 'SQL', frameworks: ['PostgreSQL'] },
];

const input = {
  layers,
  architecture: {
    style: 'Vertical slices around a pure domain project',
    ddd: 'tactical',
    principles: ['SOLID'],
    rationale: 'One small team; features ship end to end; the domain stays free of I/O.',
  },
  alternatives: [{ style: 'Clean Architecture', reason: 'More layers than a team of 2 needs.' }],
  folders: [
    { path: 'src/backend/Domain', purpose: 'Entities and rules, no I/O' },
    { path: 'src/backend/Features', purpose: 'One folder per vertical slice' },
    { path: 'src/web', purpose: 'React app' },
  ],
};

const now = new Date('2026-11-27T12:00:00Z');

function problemsOf(value: unknown): string[] {
  const result = validateDecision(value);
  return result.ok ? [] : [...result.problems];
}

function withChange(change: (copy: typeof input) => void): typeof input {
  const copy = structuredClone(input);
  change(copy);
  return copy;
}

describe('validateDecision', () => {
  it('accepts a complete decision', () => {
    const result = validateDecision(input);
    expect(result.ok).toBe(true);
  });

  it('reports missing sections by field path', () => {
    const problems = problemsOf({ layers: [] });
    expect(problems.join('\n')).toMatch(/layers/);
    expect(problems.join('\n')).toMatch(/architecture/);
    expect(problems.join('\n')).toMatch(/alternatives/);
    expect(problems.join('\n')).toMatch(/folders/);
  });

  it('rejects an unknown ecosystem and an unknown DDD level', () => {
    const problems = problemsOf(
      withChange((c) => {
        (c.layers[0] as { ecosystem: string }).ecosystem = 'cobol';
        c.architecture.ddd = 'lots';
      }),
    );
    expect(problems.some((p) => p.includes('layers.0.ecosystem'))).toBe(true);
    expect(problems.some((p) => p.includes('architecture.ddd'))).toBe(true);
  });

  it('rejects duplicate layer names and folder paths', () => {
    const problems = problemsOf(
      withChange((c) => {
        c.layers[1] = { ...c.layers[1], name: 'backend' } as FixtureLayer;
        c.folders.push({ path: 'src/web/', purpose: 'again' });
      }),
    );
    expect(problems).toContain('layers: duplicate name "backend"');
    expect(problems).toContain('folders: duplicate path "src/web"');
  });

  it('rejects absolute and parent paths', () => {
    for (const path of ['/srv/app', '../outside', 'src/../..', 'C:\\app']) {
      const problems = problemsOf(
        withChange((c) => {
          c.folders[0] = { path, purpose: 'x' };
        }),
      );
      expect(problems.join('\n'), path).toMatch(/folders\.0\.path/);
    }
  });

  it('needs a distinct path for each layer with an ecosystem when there are several', () => {
    const missing = problemsOf(
      withChange((c) => {
        delete (c.layers[0] as { path?: string }).path;
      }),
    );
    expect(missing).toContain(
      'layers.0.path: required when more than one layer has an ecosystem (the workflows need a working directory for each)',
    );
    const shared = problemsOf(
      withChange((c) => {
        c.layers[1] = { ...c.layers[1], path: 'src/backend' } as FixtureLayer;
      }),
    );
    expect(shared).toContain('layers.1.path: "src/backend" is already used by layer "backend"');
  });

  it('lets a single layer with an ecosystem live at the root', () => {
    const result = validateDecision(
      withChange((c) => {
        c.layers = [{ name: 'app', ecosystem: 'node', language: 'TypeScript', frameworks: [] }];
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects secrets and sentinel:managed markers in text', () => {
    const secret = problemsOf(
      withChange((c) => {
        c.architecture.rationale = 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789';
      }),
    );
    expect(secret.join('\n')).toMatch(/architecture\.rationale: looks like it contains a secret/);
    expect(secret.join('\n')).not.toContain('ghp_');
    const marker = problemsOf(
      withChange((c) => {
        c.folders[0] = { path: 'src', purpose: '<!-- sentinel:managed -->' };
      }),
    );
    expect(marker.join('\n')).toMatch(/folders\.0\.purpose: must not contain sentinel:managed/);
  });

  it('caps text lengths and keeps names single-line', () => {
    const problems = problemsOf(
      withChange((c) => {
        c.architecture.style = 'x'.repeat(121);
        c.architecture.rationale = 'y'.repeat(601);
        c.layers[2] = { ...c.layers[2], name: 'Data Base' } as FixtureLayer;
      }),
    );
    expect(problems.some((p) => p.startsWith('architecture.style'))).toBe(true);
    expect(problems.some((p) => p.startsWith('architecture.rationale'))).toBe(true);
    expect(problems.some((p) => p.startsWith('layers.2.name'))).toBe(true);
  });

  it('rejects fields sentinel sets itself', () => {
    const problems = problemsOf({ ...input, decidedAt: 'yesterday' });
    expect(problems.join('\n')).toMatch(/decidedAt/);
  });
});

describe('buildDecision and parseDecision', () => {
  it('adds the version, the date and the ADR path, and round-trips', () => {
    const checked = validateDecision(input);
    if (!checked.ok) throw new Error('invalid fixture');
    const decision = buildDecision(
      checked.decision,
      now,
      'docs/adr/0001-stack-and-architecture.md',
    );
    expect(decision).toMatchObject({
      version: 1,
      decidedAt: '2026-11-27T12:00:00.000Z',
      adr: 'docs/adr/0001-stack-and-architecture.md',
    });
    expect(decision.folders.map((f) => f.path)).toContain('src/web');
    expect(parseDecision(JSON.stringify(decision), ARCHITECTURE_FILE)).toEqual(decision);
  });

  it('rejects a recorded ADR path outside docs/adr and broken cross-field rules', () => {
    const checked = validateDecision(input);
    if (!checked.ok) throw new Error('invalid fixture');
    const decision = buildDecision(checked.decision, now, nextAdrPath(undefined));
    expect(() =>
      parseDecision(JSON.stringify({ ...decision, adr: 'README.md' }), ARCHITECTURE_FILE),
    ).toThrow(/adr/);
    const pathless = {
      ...decision,
      layers: decision.layers.map((layer) => ({ ...layer, path: undefined })),
    };
    expect(() => parseDecision(JSON.stringify(pathless), ARCHITECTURE_FILE)).toThrow(
      /layers\.0\.path: required/,
    );
  });

  it('throws an ArchitectureError naming the file when it is invalid', () => {
    expect(() => parseDecision('{', ARCHITECTURE_FILE)).toThrow(ArchitectureError);
    expect(() => parseDecision('{"version":1}', ARCHITECTURE_FILE)).toThrow(
      /\.sentinel\/architecture\.json/,
    );
  });
});

describe('nextAdrPath', () => {
  it('starts at 0001 when there is no ADR folder', () => {
    expect(nextAdrPath(undefined)).toBe('docs/adr/0001-stack-and-architecture.md');
  });

  it('takes the next free number', () => {
    expect(nextAdrPath(['0001-a.md', '0007-b.md', 'README.md', 'template.md'])).toBe(
      'docs/adr/0008-stack-and-architecture.md',
    );
  });

  it('reuses an existing stack-and-architecture ADR', () => {
    expect(nextAdrPath(['0001-a.md', '0003-stack-and-architecture.md', '0004-c.md'])).toBe(
      'docs/adr/0003-stack-and-architecture.md',
    );
  });
});

describe('renderDecisionAdr', () => {
  it('records the stack, the choice, the alternatives and the folders', () => {
    const checked = validateDecision(input);
    if (!checked.ok) throw new Error('invalid fixture');
    const decision = buildDecision(
      checked.decision,
      now,
      'docs/adr/0003-stack-and-architecture.md',
    );
    const adr = renderDecisionAdr(decision);
    expect(adr).toMatch(/^# ADR-0003: Stack and architecture\n/);
    expect(adr).toContain('- **Date:** 2026-11-27');
    expect(adr).toContain('Vertical slices around a pure domain project');
    expect(adr).toContain('| backend | C# | ASP.NET Core | `src/backend` |');
    expect(adr).toContain('| database | SQL | PostgreSQL | — |');
    expect(adr).toContain('- **Clean Architecture**: More layers than a team of 2 needs.');
    expect(adr).toContain('- `src/backend/Features`: One folder per vertical slice');
    expect(adr).toContain('tactical');
    expect(adr).toContain('.sentinel/architecture.json');
  });

  it('escapes table cells', () => {
    const checked = validateDecision(
      withChange((c) => {
        c.layers[2] = { ...c.layers[2], frameworks: ['A|B'] } as FixtureLayer;
      }),
    );
    if (!checked.ok) throw new Error('invalid fixture');
    const adr = renderDecisionAdr(buildDecision(checked.decision, now, nextAdrPath(undefined)));
    expect(adr).toContain('A\\|B');
    const slashed = validateDecision(
      withChange((c) => {
        c.layers[2] = { ...c.layers[2], frameworks: ['A\\|B'] } as FixtureLayer;
      }),
    );
    if (!slashed.ok) throw new Error('invalid fixture');
    expect(
      renderDecisionAdr(buildDecision(slashed.decision, now, nextAdrPath(undefined))),
    ).toContain('A\\\\\\|B');
  });
});

describe('plannedProjects', () => {
  it('plans one project per layer with an ecosystem, at its path', () => {
    const checked = validateDecision(input);
    if (!checked.ok) throw new Error('invalid fixture');
    const projects = plannedProjects(buildDecision(checked.decision, now, nextAdrPath(undefined)));
    expect(projects.map((p) => [p.path, p.ecosystem, p.frameworks])).toEqual([
      ['src/backend', 'dotnet', ['ASP.NET Core']],
      ['src/web', 'node', ['React']],
    ]);
    expect(projects[0]?.tests.unit.detected).toBeNull();
  });

  it('puts a single layer without a path at the root', () => {
    const checked = validateDecision(
      withChange((c) => {
        c.layers = [{ name: 'app', ecosystem: 'go', language: 'Go', frameworks: [] }];
      }),
    );
    if (!checked.ok) throw new Error('invalid fixture');
    const projects = plannedProjects(buildDecision(checked.decision, now, nextAdrPath(undefined)));
    expect(projects.map((p) => p.path)).toEqual(['.']);
  });
});

describe('parseStackOption', () => {
  it('reads one bare ecosystem as the root', () => {
    expect(parseStackOption('node')).toEqual([{ ecosystem: 'node', path: '.' }]);
  });

  it('reads a list of ecosystems with paths', () => {
    expect(parseStackOption('dotnet:src/backend, node:src/web/')).toEqual([
      { ecosystem: 'dotnet', path: 'src/backend' },
      { ecosystem: 'node', path: 'src/web' },
    ]);
  });

  it('rejects unknown ecosystems, unsafe paths and duplicates', () => {
    expect(() => parseStackOption('cobol')).toThrow(/unknown stack "cobol"/);
    expect(() => parseStackOption('node:../x')).toThrow(/path/);
    expect(() => parseStackOption('node:/x')).toThrow(/path/);
    expect(() => parseStackOption('node:@app')).toThrow(/path/);
    expect(() => parseStackOption('node:web,go:web')).toThrow(/"web" is used twice/);
    expect(() => parseStackOption('node,go')).toThrow(/give each a path/);
    expect(() => parseStackOption('')).toThrow(/empty/);
  });
});

describe('formatDecision', () => {
  it('summarises the decision in plain text', () => {
    const checked = validateDecision(input);
    if (!checked.ok) throw new Error('invalid fixture');
    const text = formatDecision(buildDecision(checked.decision, now, nextAdrPath(undefined)));
    expect(text).toContain('architecture: Vertical slices around a pure domain project');
    expect(text).toContain('ddd: tactical');
    expect(text).toContain('backend: C# (ASP.NET Core) at src/backend [dotnet]');
    expect(text).toContain('adr: docs/adr/0001-stack-and-architecture.md');
  });
});
