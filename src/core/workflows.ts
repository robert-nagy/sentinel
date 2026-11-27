import type { SentinelConfig } from './config-schema.js';
import type { Ecosystem, ProjectReport, TestTier } from './stack-analyzer.js';

export const TESTS_WORKFLOW_PATH = '.github/workflows/sentinel-tests.yml';
export const LOAD_WORKFLOW_PATH = '.github/workflows/sentinel-load.yml';

export interface GeneratedWorkflow {
  readonly path: string;
  readonly content: string;
}

/** Default test command per ecosystem and tier; `testing.*` in the config overrides them. */
const COMMANDS: Readonly<Record<Ecosystem, Readonly<Record<TestTier, string>>>> = {
  node: {
    unit: 'npm test',
    integration: 'npm run test:integration',
    e2e: 'npm run test:e2e',
    load: 'k6 run load/smoke.js',
  },
  python: {
    unit: 'pytest tests/unit',
    integration: 'pytest tests/integration',
    e2e: 'pytest tests/e2e',
    load: 'locust --headless -f load/locustfile.py -u 20 -r 5 -t 1m',
  },
  go: {
    unit: 'go test ./...',
    integration: 'go test -tags=integration ./...',
    e2e: 'go test -tags=e2e ./...',
    load: 'k6 run load/smoke.js',
  },
  rust: {
    unit: 'cargo test --lib',
    integration: 'cargo test --test integration',
    e2e: 'cargo test --test e2e',
    load: 'k6 run load/smoke.js',
  },
  java: {
    unit: 'mvn -B test',
    integration: 'mvn -B verify -Pintegration',
    e2e: 'mvn -B verify -Pe2e',
    load: 'k6 run load/smoke.js',
  },
  dotnet: {
    unit: 'dotnet test --filter Category=Unit',
    integration: 'dotnet test --filter Category=Integration',
    e2e: 'dotnet test --filter Category=E2E',
    load: 'k6 run load/smoke.js',
  },
  ruby: {
    unit: 'bundle exec rspec spec/unit',
    integration: 'bundle exec rspec spec/integration',
    e2e: 'bundle exec rspec spec/e2e',
    load: 'k6 run load/smoke.js',
  },
  php: {
    unit: 'vendor/bin/phpunit --testsuite unit',
    integration: 'vendor/bin/phpunit --testsuite integration',
    e2e: 'vendor/bin/phpunit --testsuite e2e',
    load: 'k6 run load/smoke.js',
  },
};

/** The command a tier runs for a project: the configured one, else the ecosystem default. */
export function tierCommand(
  project: Pick<ProjectReport, 'ecosystem'>,
  tier: TestTier,
  testing: SentinelConfig['testing'],
): string {
  return testing[tier] ?? COMMANDS[project.ecosystem][tier];
}

const LOCKFILES: Readonly<Record<string, string>> = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
};

/**
 * Setup steps for a project's toolchain. `uses:` steps ignore the job's default working
 * directory, so a project in a subfolder points them at its own files.
 */
function installStep(project: ProjectReport): string[] {
  const nested = project.path !== '.';
  const inProject = (file: string) => (nested ? `${project.path}/${file}` : file);
  switch (project.ecosystem) {
    case 'node': {
      const pm = project.packageManager ?? 'npm';
      const lockfile = LOCKFILES[pm];
      const cache =
        pm === 'bun'
          ? []
          : [
              `          cache: ${pm}`,
              ...(nested && lockfile !== undefined
                ? [`          cache-dependency-path: ${inProject(lockfile)}`]
                : []),
            ];
      const setup =
        pm === 'pnpm'
          ? [
              '      - uses: pnpm/action-setup@v4',
              ...(nested
                ? ['        with:', `          package_json_file: ${inProject('package.json')}`]
                : []),
            ]
          : pm === 'bun'
            ? ['      - uses: oven-sh/setup-bun@v2']
            : [];
      const install =
        pm === 'pnpm'
          ? 'pnpm install --frozen-lockfile'
          : pm === 'yarn'
            ? 'yarn install --frozen-lockfile'
            : pm === 'bun'
              ? 'bun install --frozen-lockfile'
              : 'npm ci';
      return [
        ...setup,
        '      - uses: actions/setup-node@v5',
        '        with:',
        '          node-version: 22',
        ...cache,
        `      - run: ${install}`,
      ];
    }
    case 'python':
      return [
        '      - uses: actions/setup-python@v5',
        '        with:',
        "          python-version: '3.12'",
        '      - run: |',
        '          if [ -f requirements.txt ]; then pip install -r requirements.txt; fi',
        '          pip install pytest',
      ];
    case 'go':
      return [
        '      - uses: actions/setup-go@v5',
        '        with:',
        `          go-version-file: ${inProject('go.mod')}`,
      ];
    case 'rust':
      return ['      - uses: dtolnay/rust-toolchain@stable'];
    case 'java':
      return [
        '      - uses: actions/setup-java@v4',
        '        with:',
        '          distribution: temurin',
        "          java-version: '21'",
      ];
    case 'dotnet':
      return [
        '      - uses: actions/setup-dotnet@v4',
        '        with:',
        "          dotnet-version: '8.0.x'",
      ];
    case 'ruby':
      return [
        '      - uses: ruby/setup-ruby@v1',
        '        with:',
        '          bundler-cache: true',
        ...(nested ? [`          working-directory: ${project.path}`] : []),
      ];
    case 'php':
      return [
        '      - uses: shivammathur/setup-php@v2',
        '        with:',
        "          php-version: '8.3'",
        '      - run: composer install --no-interaction --prefer-dist',
      ];
  }
}

function extraSteps(project: ProjectReport, tier: TestTier, command: string): string[] {
  if (tier === 'e2e') {
    if (project.ecosystem === 'node') return ['      - run: npx playwright install --with-deps'];
    if (project.ecosystem === 'python') return ['      - run: playwright install --with-deps'];
  }
  if (tier === 'load') {
    if (command.startsWith('k6 ')) return ['      - uses: grafana/setup-k6-action@v1'];
    if (command.startsWith('locust ')) return ['      - run: pip install locust'];
  }
  return [];
}

function slug(path: string): string {
  if (path === '.') return '';
  return `-${path
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part !== '')
    .join('-')}`;
}

/** Files whose presence means a planned project has code; globs as `hashFiles` takes them. */
const MANIFESTS: Readonly<Record<Ecosystem, readonly string[]>> = {
  node: ['package.json'],
  python: ['pyproject.toml', 'setup.py', 'requirements*.txt'],
  go: ['go.mod'],
  rust: ['Cargo.toml'],
  java: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  dotnet: ['**/*.csproj', '**/*.sln'],
  ruby: ['Gemfile'],
  php: ['composer.json'],
};

/**
 * A planned project has no code yet, so its steps run only once its manifest exists: the
 * bootstrap pull request stays green instead of failing on a missing lockfile or go.mod.
 */
function guardPlanned(project: ProjectReport, steps: readonly string[]): string[] {
  if (project.planned !== true) return [...steps];
  const prefix = project.path === '.' ? '' : `${project.path}/`;
  const patterns = MANIFESTS[project.ecosystem].map((p) => `'${prefix}${p}'`).join(', ');
  const present = `hashFiles(${patterns}) != ''`;
  const where = project.path === '.' ? 'the repository' : project.path;
  return [
    `      - if: hashFiles(${patterns}) == ''`,
    '        working-directory: .',
    `        run: echo "::notice::${where} has no ${project.ecosystem} project yet; skipping its steps"`,
    // The condition goes on the dash line, so it never lands inside a `run: |` block.
    ...steps.flatMap((line) =>
      line.startsWith('      - ')
        ? [`      - if: ${present}`, `        ${line.slice('      - '.length)}`]
        : [line],
    ),
  ];
}

function job(
  project: ProjectReport,
  tier: TestTier,
  command: string,
  id: string,
  single: boolean,
): string[] {
  const label = single ? tier : `${tier} (${project.path})`;
  const lines = [`  ${id}:`, `    name: ${label}`, '    runs-on: ubuntu-latest'];
  if (tier === 'load') lines.push('    timeout-minutes: 30');
  if (project.path !== '.') {
    lines.push('    defaults:', '      run:', `        working-directory: ${project.path}`);
  }
  lines.push(
    '    steps:',
    '      - uses: actions/checkout@v5',
    ...guardPlanned(project, [
      ...installStep(project),
      ...extraSteps(project, tier, command),
      `      - run: ${command}`,
    ]),
  );
  return lines;
}

function workflow(
  name: string,
  triggers: readonly string[],
  tiers: readonly TestTier[],
  projects: readonly ProjectReport[],
  config: Pick<SentinelConfig, 'testing'>,
): string {
  const single = projects.length === 1;
  const lines = [
    `name: ${name}`,
    '',
    '# Generated by `sentinel setup`. Edit freely: sentinel never rewrites this file.',
    '',
    'on:',
    ...triggers.map((t) => `  ${t}`),
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
  ];
  const jobs: string[][] = [];
  const used = new Set<string>();
  for (const tier of tiers) {
    for (const project of projects) {
      // Different paths can share a slug (src/web-app, src/web/app): number the repeats.
      const base = `${tier}${single ? '' : slug(project.path)}`;
      let id = base;
      for (let n = 2; used.has(id); n += 1) id = `${base}-${String(n)}`;
      used.add(id);
      jobs.push(job(project, tier, tierCommand(project, tier, config.testing), id, single));
    }
  }
  lines.push(...jobs.flatMap((j, index) => (index === 0 ? j : ['', ...j])));
  return `${lines.join('\n')}\n`;
}

/**
 * The test workflows for a stack: unit, integration and e2e jobs on push and pull request in
 * one file, and the load job on its own, run manually or weekly, never on every push.
 */
export function renderWorkflows(
  projects: readonly ProjectReport[],
  config: Pick<SentinelConfig, 'testing' | 'codeHost'>,
): GeneratedWorkflow[] {
  return [
    {
      path: TESTS_WORKFLOW_PATH,
      content: workflow(
        'Tests',
        ['push:', `    branches: [${config.codeHost.defaultBranch}]`, 'pull_request:'],
        ['unit', 'integration', 'e2e'],
        projects,
        config,
      ),
    },
    {
      path: LOAD_WORKFLOW_PATH,
      content: workflow(
        'Load tests',
        ['workflow_dispatch:', 'schedule:', "  - cron: '17 3 * * 1'"],
        ['load'],
        projects,
        config,
      ),
    },
  ];
}

export const LEARN_VERIFY_WORKFLOW_PATH = '.github/workflows/sentinel-lessons.yml';
/** The job name, which is also the status check name a ruleset requires. */
export const LEARN_VERIFY_CHECK = 'sentinel learn verify';
/** GitHub Actions' app id, so only Actions can satisfy the required check. */
export const GITHUB_ACTIONS_APP_ID = 15368;
export const SENTINEL_REPO = 'robert-nagy/sentinel';
const BUNDLE_PATH = 'plugins/sentinel/skills/sentinel-sdlc/scripts/sentinel.mjs';
/**
 * Actions pinned to full commit SHAs: the job runs with a token on pull requests from forks,
 * so a moved tag must not change what it runs. Bump them deliberately.
 */
const PINNED_ACTIONS = {
  checkout: 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5',
  setupNode: 'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5',
} as const;

/**
 * Gate 2 of the own-PR rule (ADR-0008, decision 13). `pull_request_target` runs the copy of
 * this file on the base branch, so a pull request cannot edit or remove the check. It never
 * checks out the pull request: `learn verify` reads the changed files through the API.
 *
 * `source: 'release'` downloads the sentinel bundle at a pinned release tag (for repositories
 * that use sentinel); `source: 'checkout'` runs the bundle from the base branch checkout (for
 * sentinel's own repository, which carries it).
 */
export function renderLearnVerifyWorkflow(
  version: string,
  source: 'release' | 'checkout',
  /** The commit the release tag points to; a commit cannot be moved the way a tag can. */
  commit?: string,
): string {
  if (commit !== undefined && !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`"${commit}" is not a full commit SHA`);
  }
  const ref = commit ?? `v${version}`;
  const fetch =
    source === 'release'
      ? [
          `      - name: Download sentinel v${version}${commit === undefined ? '' : ` (commit ${commit.slice(0, 12)})`}`,
          `        run: curl -fsSL --retry 3 -o "$RUNNER_TEMP/sentinel.mjs" "https://raw.githubusercontent.com/${SENTINEL_REPO}/${ref}/${BUNDLE_PATH}"`,
        ]
      : [
          '      # The base branch, never the pull request: pull_request_target checks out the base.',
          `      - uses: ${PINNED_ACTIONS.checkout}`,
          '        with:',
          '          persist-credentials: false',
          `      - run: cp ${BUNDLE_PATH} "$RUNNER_TEMP/sentinel.mjs"`,
        ];
  return [
    '# Generated by `sentinel setup --learn-verify` (ADR-0008). Checks that lessons added in a',
    "# pull request follow sentinel's own-PR rule. It runs from the base branch and reads the",
    "# pull request's files through the API; it never checks out or runs the pull request's code.",
    'name: Sentinel lessons',
    '',
    'on:',
    '  pull_request_target:',
    '    types: [opened, synchronize, reopened, edited]',
    '',
    'permissions:',
    '  contents: read',
    '  pull-requests: read',
    '',
    'jobs:',
    '  verify:',
    `    name: ${LEARN_VERIFY_CHECK}`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    `      - uses: ${PINNED_ACTIONS.setupNode}`,
    '        with:',
    '          node-version: 22',
    ...fetch,
    '      - name: Verify lesson changes',
    '        env:',
    '          GH_TOKEN: ${{ github.token }}',
    '          GH_REPO: ${{ github.repository }}',
    '          PR: ${{ github.event.pull_request.number }}',
    '          HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
    '        run: node "$RUNNER_TEMP/sentinel.mjs" learn verify --pr "$PR" --sha "$HEAD_SHA"',
    '',
  ].join('\n');
}

/** A ruleset that makes {@link LEARN_VERIFY_CHECK} required on the default branch, with no bypass. */
export function learnVerifyRuleset(): Record<string, unknown> {
  return {
    name: 'sentinel lessons',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: false,
          required_status_checks: [
            { context: LEARN_VERIFY_CHECK, integration_id: GITHUB_ACTIONS_APP_ID },
          ],
        },
      },
    ],
  };
}
