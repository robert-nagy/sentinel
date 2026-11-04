import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileAccess } from '../../src/core/fs.js';
import { analyze, formatStackReport, installCommands } from '../../src/core/stack-analyzer.js';

/** In-memory tree: keys are `/`-separated paths relative to `/r`; values are file contents. */
function tree(entries: Record<string, string>): FileAccess {
  const files = new Map<string, string>();
  const dirs = new Map<string, Set<string>>();
  const add = (dir: string, name: string) => {
    const set = dirs.get(dir) ?? new Set<string>();
    set.add(name);
    dirs.set(dir, set);
  };
  dirs.set(join('/r'), new Set());
  for (const [rel, content] of Object.entries(entries)) {
    const parts = rel.split('/');
    let current = join('/r');
    for (const [i, part] of parts.entries()) {
      add(current, part);
      current = join(current, part);
      if (i < parts.length - 1 && !dirs.has(current)) dirs.set(current, new Set());
    }
    files.set(current, content);
  }
  return {
    readText: (p) => Promise.resolve(files.get(p)),
    exists: (p) => Promise.resolve(files.has(p) || dirs.has(p)),
    listDir: (p) => Promise.resolve(dirs.has(p) ? [...(dirs.get(p) ?? [])] : undefined),
  };
}

const run = (entries: Record<string, string>) => analyze(join('/r'), tree(entries));

describe('analyze', () => {
  it('reports an empty repository', async () => {
    expect(await run({ '.git/HEAD': '', 'README.md': '# x', LICENSE: 'MIT' })).toEqual({
      empty: true,
      projects: [],
    });
  });

  it('treats a missing directory as empty', async () => {
    const files = tree({});
    expect(await analyze(join('/nope'), files)).toMatchObject({ empty: true });
  });

  it('detects a TypeScript project, its package manager, frameworks and test tools', async () => {
    const report = await run({
      'package.json': JSON.stringify({
        dependencies: { react: '^19', next: '^15' },
        devDependencies: { typescript: '^5', vitest: '^4', '@playwright/test': '^1' },
      }),
      'pnpm-lock.yaml': '',
    });
    expect(report.empty).toBe(false);
    const [project] = report.projects;
    expect(project).toMatchObject({
      path: '.',
      ecosystem: 'node',
      language: 'typescript',
      packageManager: 'pnpm',
      frameworks: ['Next.js', 'React'],
    });
    expect(project?.tests.unit.detected).toBe('vitest');
    expect(project?.tests.e2e.detected).toBe('playwright');
    expect(project?.tests.integration).toMatchObject({
      detected: null,
      recommended: 'vitest + testcontainers',
      install: 'pnpm add -D testcontainers',
    });
    expect(project?.tests.load.detected).toBeNull();
  });

  it('prefers the declared packageManager over lockfiles', async () => {
    const report = await run({
      'package.json': JSON.stringify({ packageManager: 'yarn@4.1.0' }),
      'package-lock.json': '',
    });
    expect(report.projects[0]?.packageManager).toBe('yarn');
  });

  it('survives an unreadable package.json', async () => {
    const report = await run({ 'package.json': '{nope' });
    expect(report.projects[0]).toMatchObject({ ecosystem: 'node', frameworks: [] });
  });

  it('detects python, go, rust, java, dotnet, ruby and php', async () => {
    const report = await run({
      'py/pyproject.toml': 'dependencies = ["fastapi>=0.1", "pytest", "pytest-playwright"]',
      'go/go.mod':
        'require (\n\tgithub.com/gin-gonic/gin v1\n\tgithub.com/testcontainers/testcontainers-go v0\n)',
      'rs/Cargo.toml': '[dependencies]\naxum = "0.7"',
      'jv/pom.xml':
        '<artifactId>spring-boot-starter-web</artifactId><artifactId>junit-jupiter</artifactId>',
      'dn/App.csproj':
        '<Project Sdk="Microsoft.NET.Sdk.Web"><PackageReference Include="xunit" /></Project>',
      'rb/Gemfile': "gem 'rails'\ngem 'rspec'",
      'ph/composer.json': JSON.stringify({
        require: { 'laravel/framework': '^11' },
        'require-dev': { 'pestphp/pest': '^3' },
      }),
    });
    const by = Object.fromEntries(report.projects.map((p) => [p.ecosystem, p]));
    expect(by['python']).toMatchObject({ frameworks: ['FastAPI'] });
    expect(by['python']?.tests.unit.detected).toBe('pytest');
    expect(by['python']?.tests.e2e.detected).toBe('playwright');
    expect(by['go']?.frameworks).toEqual(['Gin']);
    expect(by['go']?.tests.unit.detected).toBe('go test');
    expect(by['go']?.tests.integration.detected).toBe('testcontainers-go');
    expect(by['rust']?.frameworks).toEqual(['axum']);
    expect(by['rust']?.tests.unit.detected).toBe('cargo test');
    expect(by['java']).toMatchObject({ frameworks: ['Spring Boot'], packageManager: 'maven' });
    expect(by['java']?.tests.unit.detected).toBe('JUnit 5');
    expect(by['dotnet']?.frameworks).toEqual(['ASP.NET Core']);
    expect(by['dotnet']?.tests.unit.detected).toBe('xUnit');
    expect(by['ruby']?.frameworks).toEqual(['Rails']);
    expect(by['php']?.tests.unit.detected).toBe('pest');
  });

  it('finds monorepo packages and skips dependency directories', async () => {
    const report = await run({
      'package.json': '{}',
      'packages/a/package.json': '{}',
      'apps/web/package.json': '{}',
      'node_modules/dep/package.json': '{}',
      'packages/a/node_modules/x/package.json': '{}',
    });
    expect(report.projects.map((p) => p.path).sort()).toEqual(['.', 'apps/web', 'packages/a']);
  });

  it('detects load testing by directory convention', async () => {
    const report = await run({ 'package.json': '{}', 'k6/smoke.js': '' });
    expect(report.projects[0]?.tests.load.detected).toBe('k6');
  });

  it('is not empty but has no projects for unrecognised content', async () => {
    const report = await run({ 'notes.txt': 'hi' });
    expect(report).toEqual({ empty: false, projects: [] });
    expect(formatStackReport(report)).toContain('No recognised project manifests');
  });
});

describe('reports', () => {
  it('lists install commands only for missing tiers', async () => {
    const report = await run({
      'package.json': JSON.stringify({ devDependencies: { vitest: '1' } }),
    });
    const tiers = installCommands(report).map((c) => c.tier);
    expect(tiers).toEqual(['integration', 'e2e']);
  });

  it('formats a readable summary', async () => {
    const report = await run({
      'package.json': JSON.stringify({ devDependencies: { jest: '1' } }),
    });
    const text = formatStackReport(report);
    expect(text).toContain('jest');
    expect(text).toContain('missing (recommend playwright)');
  });

  it('describes the empty case', () => {
    expect(formatStackReport({ empty: true, projects: [] })).toContain('Empty repository');
  });
});
