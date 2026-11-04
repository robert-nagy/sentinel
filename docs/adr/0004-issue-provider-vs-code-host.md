# ADR-0004: Issue provider is separate from code host

- **Status:** Accepted; the `issueProvider` part is amended by
  [ADR-0005](0005-agent-native-issue-trackers.md) (no built-in remote tracker clients; config
  records intent only). The split between tracker and code host still stands.
- **Date:** 2026-11-02

## Context

The spec has a single "issue provider" (GitHub, Jira, Linear, Azure DevOps). In practice the
place issues live and the place code, pull requests and CI live are often different. Jira +
GitHub is the most common example. PR creation, CI babysitting and generated CI workflows
depend on where the code is hosted, not on the tracker.

## Decision

Two independent settings in `sentinel.config.json`:

- **`issueProvider`**: `github` | `jira` | `azure-devops` | `custom`.
  - GitHub via the `gh` CLI.
  - Jira via REST v3 (ADF ↔ Markdown, JQL, configurable workflow transitions).
  - Azure DevOps Boards via REST (WIQL, HTML ↔ Markdown).
  - Custom via user-configured shell-command templates with JSON output contracts. This is the
    escape hatch for Linear and anything else.
- **`codeHost`**: `github` only in v0.1. Covers PR creation, check status, failed-job logs,
  re-runs, comments and GitHub Actions workflow templates. The interface is designed so an
  Azure Repos/Pipelines host can be added later.

A `labelMap` translates sentinel's neutral labels (`kind/feature`, `priority/p1`) into each
tracker's own vocabulary (GitHub labels, Jira issue type/priority, ADO work item type/priority).

## Consequences

- Jira or Azure Boards users hosting code on GitHub are fully supported in v0.1.
- Teams fully on Azure DevOps (Repos + Pipelines) must wait for a second code host.
- Branch names accept tracker-native IDs (`PROJ-123`, numeric ADO IDs).
