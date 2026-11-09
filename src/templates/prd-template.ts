/**
 * PRD skeleton, aligned with IEEE 29148 (stakeholder needs, functional and non-functional
 * requirements, verification). Every `TODO` is flagged by the ambiguity lint until it is
 * replaced, so an unfilled scaffold can never pass validation.
 */
export const PRD_TEMPLATE = `# PRD: {{TITLE}}

> Slug: {{SLUG}} | Created: {{DATE}} | Issue: {{ISSUE}}

## 1. Context & Problem Statement

TODO: Describe who has the problem, how often it happens, what it costs them today, and why it needs solving now.

## 2. Functional Requirements

Number every requirement (FR-1, FR-2, ...). Each one needs at least one Given/When/Then scenario.

### FR-1: TODO short title

TODO: One sentence describing the behaviour.

- Given TODO the starting state
- When TODO the action
- Then TODO the observable result

### FR-2: TODO short title

TODO: One sentence describing the behaviour.

- Given TODO the starting state
- When TODO the action
- Then TODO the observable result

## 3. Non-Functional Requirements

Every item needs a number and a unit (latency, throughput, availability, limits).

- NFR-1: Latency: TODO p95 response time under 200 ms at 100 requests per second.
- NFR-2: Availability: TODO 99.9% monthly uptime.
- NFR-3: Multi-tenancy: TODO describe isolation and how it is verified (for example 100% of integration tests).

## 4. Security

TODO: Authentication: how users and services prove who they are. Authorisation: roles and permissions (RBAC) per resource. Input validation: what is validated, where, and what is returned on failure.

## 5. Data Models

TODO: List each entity with its fields and relations, for example Order: id, customerId, status, createdAt.

## 6. API Contracts

TODO: List endpoints with method, path, request and response, for example:

- \`GET /resource/{id}\` returns the resource or 404

## 7. Test Strategy Matrix

| Tier        | Scope                  | Tooling      |
| ----------- | ---------------------- | ------------ |
| Unit        | TODO what is covered   | TODO tool    |
| Integration | TODO what is covered   | TODO tool    |
| E2E         | TODO what is covered   | TODO tool    |
| Load        | TODO target and scale  | TODO tool    |
`;
