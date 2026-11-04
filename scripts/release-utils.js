// Pure helpers for the release scripts. No I/O here so they can be unit tested.

/**
 * Decide whether the release workflow should stage the current version on npm.
 *
 * Tokens issued through npm trusted publishing (OIDC) can run `npm stage publish`
 * but not `npm stage list`, so CI cannot ask npm what is already staged. Instead
 * it stages only when the version in package.json changed in the push that
 * triggered the run, which is the merge of the "chore: version packages" PR.
 * Later pushes while that version waits for approval therefore do not stage it
 * again. A manual run (`workflow_dispatch`) always attempts to stage, so a failed
 * or rejected stage can be retried.
 *
 * @param {object} input
 * @param {string} input.eventName GitHub event name (`push`, `workflow_dispatch`, ...)
 * @param {string | undefined} input.versionBefore package.json version before the push
 * @param {string} input.versionNow package.json version now
 * @param {boolean} input.live whether `versionNow` is already published on npm
 * @returns {{ action: 'stage' | 'skip', reason: string }}
 */
export function planStage({ eventName, versionBefore, versionNow, live }) {
  if (live) {
    return { action: 'skip', reason: `${versionNow} is already published on npm` };
  }
  if (eventName === 'push' && versionBefore === versionNow) {
    return {
      action: 'skip',
      reason: `the version (${versionNow}) did not change in this push, so there is nothing new to stage`,
    };
  }
  return {
    action: 'stage',
    reason:
      eventName === 'push'
        ? `the version changed from ${versionBefore ?? 'unknown'} to ${versionNow}`
        : `manual run: staging ${versionNow}`,
  };
}

/**
 * Read the `version` field from the text of a package.json file.
 * @param {string} packageJsonText
 * @returns {string | undefined}
 */
export function readVersion(packageJsonText) {
  try {
    const parsed = /** @type {{ version?: unknown }} */ (JSON.parse(packageJsonText));
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract the notes for one version from a changesets-generated CHANGELOG.md:
 * everything under `## <version>` up to the next `## ` heading.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string | undefined} the trimmed section body, or undefined if absent or empty
 */
export function extractChangelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return undefined;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body === '' ? undefined : body;
}

/**
 * Whether a semver string is a pre-release (`1.2.3-beta.1`).
 * @param {string} version
 */
export function isPrerelease(version) {
  return version.includes('-');
}

/**
 * Regular expression (for `git log -G`) matching a `"version": "<version>"` line in
 * package.json regardless of spacing. Dots are escaped so `0.1.0` does not match `0x1y0`.
 * @param {string} version
 */
export function versionLinePattern(version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `"version":\\s*"${escaped}"`;
}
