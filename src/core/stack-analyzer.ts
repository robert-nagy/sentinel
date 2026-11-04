import { join } from 'node:path';
import type { FileAccess } from './fs.js';

export const TEST_TIERS = ['unit', 'integration', 'e2e', 'load'] as const;
export type TestTier = (typeof TEST_TIERS)[number];

export type Ecosystem = 'node' | 'python' | 'go' | 'rust' | 'java' | 'dotnet' | 'ruby' | 'php';

export interface TierReport {
  /** Tooling already in use for this tier, if any. */
  readonly detected: string | null;
  /** Suggested tool when nothing is detected. */
  readonly recommended: string;
  /** Command that installs the recommended tool, or `null` when there is nothing to install. */
  readonly install: string | null;
}

export interface ProjectReport {
  /** Directory relative to the analysed root, using `/` (`.` for the root). */
  readonly path: string;
  readonly ecosystem: Ecosystem;
  readonly language: string;
  readonly packageManager: string | null;
  readonly frameworks: readonly string[];
  readonly tests: Readonly<Record<TestTier, TierReport>>;
}

export type StackReport =
  | { readonly empty: true; readonly projects: readonly [] }
  | { readonly empty: false; readonly projects: readonly ProjectReport[] };

interface Tier {
  readonly recommended: string;
  readonly install: string | null;
  /** Dependency names (lowercase) that mean this tier is covered, with a display name. */
  readonly known: readonly (readonly [string, string])[];
  /** Tool that is always available for the ecosystem (for example `go test`). */
  readonly builtin?: string;
}

interface EcosystemSpec {
  readonly language: string;
  /** Manifest file names, or predicates over file names, that mark a project. */
  readonly manifests: readonly (string | RegExp)[];
  readonly frameworks: readonly (readonly [string, string])[];
  readonly tiers: (pm: string | null) => Record<TestTier, Tier>;
}

const k6: Pick<Tier, 'recommended' | 'install'> = { recommended: 'k6', install: null };
const playwrightCli = 'npx playwright install --with-deps';

function nodeAdd(pm: string | null, packages: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm add -D ${packages}`;
    case 'yarn':
      return `yarn add -D ${packages}`;
    case 'bun':
      return `bun add -d ${packages}`;
    default:
      return `npm install -D ${packages}`;
  }
}

const SPECS: Readonly<Record<Ecosystem, EcosystemSpec>> = {
  node: {
    language: 'javascript',
    manifests: ['package.json'],
    frameworks: [
      ['next', 'Next.js'],
      ['nuxt', 'Nuxt'],
      ['react', 'React'],
      ['vue', 'Vue'],
      ['svelte', 'Svelte'],
      ['@angular/core', 'Angular'],
      ['express', 'Express'],
      ['fastify', 'Fastify'],
      ['@nestjs/core', 'NestJS'],
      ['hono', 'Hono'],
    ],
    tiers: (pm) => ({
      unit: {
        recommended: 'vitest',
        install: nodeAdd(pm, 'vitest'),
        known: [
          ['vitest', 'vitest'],
          ['jest', 'jest'],
          ['mocha', 'mocha'],
          ['ava', 'ava'],
        ],
      },
      integration: {
        recommended: 'vitest + testcontainers',
        install: nodeAdd(pm, 'testcontainers'),
        known: [['testcontainers', 'testcontainers']],
      },
      e2e: {
        recommended: 'playwright',
        install: `${nodeAdd(pm, '@playwright/test')} && ${playwrightCli}`,
        known: [
          ['@playwright/test', 'playwright'],
          ['playwright', 'playwright'],
          ['cypress', 'cypress'],
        ],
      },
      load: {
        ...k6,
        known: [
          ['k6', 'k6'],
          ['artillery', 'artillery'],
          ['autocannon', 'autocannon'],
        ],
      },
    }),
  },
  python: {
    language: 'python',
    manifests: ['pyproject.toml', 'setup.py', 'Pipfile', /^requirements.*\.txt$/],
    frameworks: [
      ['django', 'Django'],
      ['flask', 'Flask'],
      ['fastapi', 'FastAPI'],
    ],
    tiers: () => ({
      unit: {
        recommended: 'pytest',
        install: 'pip install pytest',
        known: [['pytest', 'pytest']],
      },
      integration: {
        recommended: 'pytest + testcontainers',
        install: 'pip install testcontainers',
        known: [['testcontainers', 'testcontainers']],
      },
      e2e: {
        recommended: 'playwright',
        install: 'pip install pytest-playwright && playwright install --with-deps',
        known: [
          ['playwright', 'playwright'],
          ['pytest-playwright', 'playwright'],
          ['selenium', 'selenium'],
        ],
      },
      load: {
        recommended: 'locust',
        install: 'pip install locust',
        known: [['locust', 'locust']],
      },
    }),
  },
  go: {
    language: 'go',
    manifests: ['go.mod'],
    frameworks: [
      ['github.com/gin-gonic/gin', 'Gin'],
      ['github.com/labstack/echo', 'Echo'],
      ['github.com/gofiber/fiber', 'Fiber'],
      ['github.com/go-chi/chi', 'chi'],
    ],
    tiers: () => ({
      unit: { recommended: 'go test', install: null, known: [], builtin: 'go test' },
      integration: {
        recommended: 'testcontainers-go',
        install: 'go get github.com/testcontainers/testcontainers-go',
        known: [['github.com/testcontainers/testcontainers-go', 'testcontainers-go']],
      },
      e2e: {
        recommended: 'playwright',
        install: 'go get github.com/playwright-community/playwright-go',
        known: [['github.com/playwright-community/playwright-go', 'playwright']],
      },
      load: { ...k6, known: [['k6', 'k6']] },
    }),
  },
  rust: {
    language: 'rust',
    manifests: ['Cargo.toml'],
    frameworks: [
      ['axum', 'axum'],
      ['actix-web', 'actix-web'],
      ['rocket', 'Rocket'],
    ],
    tiers: () => ({
      unit: { recommended: 'cargo test', install: null, known: [], builtin: 'cargo test' },
      integration: {
        recommended: 'testcontainers',
        install: 'cargo add --dev testcontainers',
        known: [['testcontainers', 'testcontainers']],
      },
      e2e: {
        recommended: 'playwright',
        install: 'cargo add --dev playwright',
        known: [
          ['playwright', 'playwright'],
          ['fantoccini', 'fantoccini'],
        ],
      },
      load: { ...k6, known: [['k6', 'k6']] },
    }),
  },
  java: {
    language: 'java',
    manifests: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    frameworks: [
      ['spring-boot', 'Spring Boot'],
      ['quarkus', 'Quarkus'],
      ['micronaut', 'Micronaut'],
    ],
    tiers: () => ({
      unit: {
        recommended: 'JUnit 5',
        install: null,
        known: [
          ['junit-jupiter', 'JUnit 5'],
          ['junit', 'JUnit'],
          ['testng', 'TestNG'],
        ],
      },
      integration: {
        recommended: 'Testcontainers',
        install: null,
        known: [['testcontainers', 'Testcontainers']],
      },
      e2e: {
        recommended: 'playwright',
        install: null,
        known: [
          ['playwright', 'playwright'],
          ['selenium', 'selenium'],
        ],
      },
      load: {
        ...k6,
        known: [
          ['gatling', 'gatling'],
          ['k6', 'k6'],
        ],
      },
    }),
  },
  dotnet: {
    language: 'csharp',
    manifests: [/\.csproj$/, /\.sln$/],
    frameworks: [['microsoft.net.sdk.web', 'ASP.NET Core']],
    tiers: () => ({
      unit: {
        recommended: 'xUnit',
        install: 'dotnet add package xunit',
        known: [
          ['xunit', 'xUnit'],
          ['nunit', 'NUnit'],
          ['mstest', 'MSTest'],
        ],
      },
      integration: {
        recommended: 'Testcontainers',
        install: 'dotnet add package Testcontainers',
        known: [['testcontainers', 'Testcontainers']],
      },
      e2e: {
        recommended: 'Playwright',
        install: 'dotnet add package Microsoft.Playwright',
        known: [['microsoft.playwright', 'Playwright']],
      },
      load: {
        ...k6,
        known: [
          ['nbomber', 'NBomber'],
          ['k6', 'k6'],
        ],
      },
    }),
  },
  ruby: {
    language: 'ruby',
    manifests: ['Gemfile'],
    frameworks: [
      ['rails', 'Rails'],
      ['sinatra', 'Sinatra'],
    ],
    tiers: () => ({
      unit: {
        recommended: 'rspec',
        install: 'bundle add rspec --group test',
        known: [
          ['rspec', 'rspec'],
          ['minitest', 'minitest'],
        ],
      },
      integration: {
        recommended: 'rspec + testcontainers',
        install: 'bundle add testcontainers --group test',
        known: [['testcontainers', 'testcontainers']],
      },
      e2e: {
        recommended: 'playwright',
        install: 'bundle add playwright-ruby-client --group test',
        known: [
          ['playwright-ruby-client', 'playwright'],
          ['capybara', 'capybara'],
        ],
      },
      load: { ...k6, known: [['k6', 'k6']] },
    }),
  },
  php: {
    language: 'php',
    manifests: ['composer.json'],
    frameworks: [
      ['laravel/framework', 'Laravel'],
      ['symfony/framework-bundle', 'Symfony'],
    ],
    tiers: () => ({
      unit: {
        recommended: 'phpunit',
        install: 'composer require --dev phpunit/phpunit',
        known: [
          ['phpunit/phpunit', 'phpunit'],
          ['pestphp/pest', 'pest'],
        ],
      },
      integration: {
        recommended: 'phpunit + testcontainers',
        install: 'composer require --dev testcontainers/testcontainers',
        known: [['testcontainers/testcontainers', 'testcontainers']],
      },
      e2e: {
        recommended: 'playwright',
        install: null,
        known: [
          ['laravel/dusk', 'dusk'],
          ['symfony/panther', 'panther'],
        ],
      },
      load: { ...k6, known: [['k6', 'k6']] },
    }),
  },
};

const IGNORED_DIRS = new Set([
  '.git',
  '.github',
  '.hg',
  '.idea',
  '.vscode',
  '.sentinel',
  '.worktrees',
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  'coverage',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  'bin',
  'obj',
]);

/** Root entries that do not make a repository "non-empty". */
const BOOTSTRAP_ENTRIES =
  /^(\.git|\.gitignore|\.gitattributes|\.sentinel|\.github|readme(\..+)?|license(\..+)?|sentinel\.config\.json)$/i;

const MAX_DEPTH = 3;
const MAX_DIRS = 500;
const MAX_MANIFEST_BYTES = 2_000_000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Does `needle` appear in a manifest as a dependency name? A longer name that merely
 * starts with it (`flask-cors` for `flask`) can still match; the report is advisory.
 */
function mentions(haystack: string, needle: string): boolean {
  const pattern = new RegExp(`(?<![a-z0-9_@-])${escapeRegExp(needle)}(?![a-z0-9_])`);
  return pattern.test(haystack);
}

function pickPackageManager(pkg: { packageManager?: unknown }, names: ReadonlySet<string>): string {
  if (typeof pkg.packageManager === 'string') {
    const declared = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager)?.[1];
    if (declared) return declared;
  }
  if (names.has('pnpm-lock.yaml')) return 'pnpm';
  if (names.has('yarn.lock')) return 'yarn';
  if (names.has('bun.lock') || names.has('bun.lockb')) return 'bun';
  return 'npm';
}

async function readManifestText(
  dir: string,
  names: readonly string[],
  spec: EcosystemSpec,
  files: FileAccess,
): Promise<string> {
  const matching = names.filter((name) =>
    spec.manifests.some((m) => (typeof m === 'string' ? m === name : m.test(name))),
  );
  const parts: string[] = [];
  for (const name of matching) {
    const text = await files.readText(join(dir, name));
    if (text !== undefined && text.length <= MAX_MANIFEST_BYTES) parts.push(text);
  }
  return parts.join('\n');
}

/** All dependency names for a node/php manifest; empty when the JSON is unreadable. */
function jsonDependencies(text: string): Set<string> {
  const deps = new Set<string>();
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    for (const key of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'require',
      'require-dev',
    ]) {
      const section = json[key];
      if (typeof section === 'object' && section !== null) {
        for (const name of Object.keys(section)) deps.add(name.toLowerCase());
      }
    }
  } catch {
    // An unreadable manifest simply contributes no dependencies.
  }
  return deps;
}

async function analyzeProject(
  root: string,
  relative: string,
  names: readonly string[],
  ecosystem: Ecosystem,
  files: FileAccess,
): Promise<ProjectReport> {
  const spec = SPECS[ecosystem];
  const dir = relative === '.' ? root : join(root, ...relative.split('/'));
  const text = await readManifestText(dir, names, spec, files);
  const nameSet = new Set(names);

  let has: (name: string) => boolean;
  let packageManager: string | null = null;
  let language = spec.language;

  if (ecosystem === 'node' || ecosystem === 'php') {
    const deps = jsonDependencies(text);
    has = (name) => deps.has(name);
    if (ecosystem === 'node') {
      let pkg: { packageManager?: unknown } = {};
      try {
        pkg = JSON.parse(text) as { packageManager?: unknown };
      } catch {
        // fall through to lockfile detection
      }
      packageManager = pickPackageManager(pkg, nameSet);
      if (has('typescript') || nameSet.has('tsconfig.json')) language = 'typescript';
    } else {
      packageManager = 'composer';
    }
  } else {
    const lowered = text.toLowerCase();
    has = (name) => mentions(lowered, name);
    packageManager =
      { python: 'pip', go: 'go', rust: 'cargo', java: null, dotnet: 'dotnet', ruby: 'bundler' }[
        ecosystem
      ] ?? null;
    if (ecosystem === 'python') {
      if (nameSet.has('uv.lock')) packageManager = 'uv';
      else if (nameSet.has('poetry.lock')) packageManager = 'poetry';
      else if (nameSet.has('Pipfile')) packageManager = 'pipenv';
    }
    if (ecosystem === 'java') {
      packageManager = nameSet.has('pom.xml') ? 'maven' : 'gradle';
      if (names.some((n) => n.endsWith('.kts'))) language = 'kotlin';
    }
  }

  const frameworks = spec.frameworks.filter(([dep]) => has(dep)).map(([, label]) => label);
  const tiers = spec.tiers(packageManager);
  const loadDirs = ['k6', 'load-tests', 'loadtests'];
  const tests = {} as Record<TestTier, TierReport>;
  for (const tier of TEST_TIERS) {
    const t = tiers[tier];
    let detected = t.known.find(([dep]) => has(dep))?.[1] ?? t.builtin ?? null;
    if (detected === null && tier === 'load' && names.some((n) => loadDirs.includes(n))) {
      detected = 'k6';
    }
    tests[tier] = {
      detected,
      recommended: t.recommended,
      install: detected === null ? t.install : null,
    };
  }

  return { path: relative, ecosystem, language, packageManager, frameworks, tests };
}

/**
 * Detects the projects, frameworks and test tooling in a directory tree. Monorepos are
 * handled by looking for manifests up to {@link MAX_DEPTH} levels down (skipping
 * dependency and build directories).
 */
export async function analyze(root: string, files: FileAccess): Promise<StackReport> {
  const rootNames = await files.listDir(root);
  if (rootNames === undefined || rootNames.every((name) => BOOTSTRAP_ENTRIES.test(name))) {
    return { empty: true, projects: [] };
  }

  const projects: ProjectReport[] = [];
  const queue: { relative: string; depth: number }[] = [{ relative: '.', depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && visited < MAX_DIRS) {
    const next = queue.shift();
    if (next === undefined) break;
    const { relative, depth } = next;
    visited += 1;
    const dir = relative === '.' ? root : join(root, ...relative.split('/'));
    const names = relative === '.' ? rootNames : await files.listDir(dir);
    if (names === undefined) continue;

    for (const ecosystem of Object.keys(SPECS) as Ecosystem[]) {
      const spec = SPECS[ecosystem];
      const marked = names.some((name) =>
        spec.manifests.some((m) => (typeof m === 'string' ? m === name : m.test(name))),
      );
      if (marked) projects.push(await analyzeProject(root, relative, names, ecosystem, files));
    }

    if (depth >= MAX_DEPTH) continue;
    for (const name of [...names].sort()) {
      if (IGNORED_DIRS.has(name) || name.startsWith('.')) continue;
      if ((await files.listDir(join(dir, name))) === undefined) continue;
      queue.push({ relative: relative === '.' ? name : `${relative}/${name}`, depth: depth + 1 });
    }
  }

  return { empty: false, projects };
}

/** Human-readable summary, one block per project. */
export function formatStackReport(report: StackReport): string {
  if (report.empty) {
    return 'Empty repository: no code or manifests found. Propose a stack during setup.';
  }
  if (report.projects.length === 0) {
    return 'No recognised project manifests found (supported: node, python, go, rust, java, dotnet, ruby, php).';
  }
  return report.projects
    .map((p) => {
      const lines = [
        `${p.path}  [${p.ecosystem}${p.language === p.ecosystem ? '' : `, ${p.language}`}${p.packageManager ? `, ${p.packageManager}` : ''}]`,
        `  frameworks: ${p.frameworks.length > 0 ? p.frameworks.join(', ') : '(none detected)'}`,
      ];
      for (const tier of TEST_TIERS) {
        const t = p.tests[tier];
        lines.push(`  ${tier.padEnd(11)} ${t.detected ?? `missing (recommend ${t.recommended})`}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Install commands for every missing tier, de-duplicated, in project order. */
export function installCommands(
  report: StackReport,
): { path: string; tier: TestTier; command: string }[] {
  const commands: { path: string; tier: TestTier; command: string }[] = [];
  for (const project of report.projects) {
    for (const tier of TEST_TIERS) {
      const command = project.tests[tier].install;
      if (command !== null) commands.push({ path: project.path, tier, command });
    }
  }
  return commands;
}
