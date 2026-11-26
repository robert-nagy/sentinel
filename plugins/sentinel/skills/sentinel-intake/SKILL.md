---
name: sentinel-intake
description: Interviews the user about a feature or bug, asking only about what is missing, and files it in sentinel's standard issue format after lint, a duplicate check and the user's approval. Can also rewrite an existing issue into the format, keeping the old body as a comment. Use when the user wants to file, report, write up or refine an issue, feature request or bug report.
argument-hint: [issue id to refine, or what you want to file]
---

# sentinel intake

You interview the user and write the issue; sentinel defines the format, plans the attachments and checks the draft. The format is in `docs/issue-format.md` of the sentinel repository: a _feature_ is a problem, a user story and Given/When/Then acceptance criteria; a _bug_ is the classic defect report. Nothing reaches the issue tracker until the draft passes `issue lint` and the user has approved it.

## Find the issue tracker

1. Run `node scripts/sentinel.mjs issue resolve --json`. List the trackers you can reach with your own tools (for example a Jira, Linear or GitHub MCP server, or `gh`) and pass them as `--available <slugs>`.
2. Follow `action`: `use` means use that tracker (offer to save it with `node scripts/sentinel.mjs issue use <tracker>`); `ask` means ask the user once and save the answer; `fallback` means the local Markdown tracker; `unavailable` means stop and tell the user which connection is missing.
3. Run `node scripts/sentinel.mjs issue describe` and follow it: it gives the tracker's location, notes and label map. Describe tracker work only as the neutral verbs `get`, `list`, `create`, `comment`, `update`, `attach`, `set-status`, `link-pr` and `close`, and carry them out with the tool that fits. For the local tracker the same output lists the `sentinel issue` commands.

You need the tracker before the interview: refining starts with `get`, and the attachment plan depends on whether the tracker can take uploads.

## Start from what the user wrote

1. If the user gave an issue id, `get` it. You are **refining** that issue: keep its original title and body exactly as they are, for the comment you post later.
2. Pick the kind. Something that worked, or is documented to work, and does not: `bug`. Anything else: `feature`. Chores and refactors are features with an extra `kind/chore` or `kind/refactor` label; write their user story from the point of view of whoever benefits, often the maintainers. Ask only if you cannot tell.
3. Run `node scripts/sentinel.mjs issue template <kind> --json`. It lists every section with its id, heading, whether it is required, and a hint, plus the title rule.
4. Sort what the user wrote (or the existing issue says) into those sections. Note which required sections are missing and which are vague: no numbers, no named role, a criterion without Given, when and then, a step a stranger could not repeat.

## Interview by gaps

1. Ask only about missing or vague sections, required ones first, in template order. Never ask about something the user already told you.
2. Ask **one question per message**, and offer a suggested answer the user can accept as it is, built from what they said and what you found in the code. For example: "Who runs into this? I would write: _Accountants at month-end close, about 40 minutes each time._"
3. Read the repository instead of asking where it can answer: code pointers for Context or Suspected cause (`path:line`), the version or commit for Environment (`git rev-parse --short HEAD`, the manifest's version), existing routes, commands or error messages. A suspected cause is always marked as a guess.
4. For a bug, ask for Frequency and Impact only when you need them to propose a priority.
5. Leave optional sections out when there is nothing to say; never write "N/A". Do not ask about labels or priority yet. Stop asking as soon as every required section is concrete.

## Plan attachments

1. Collect the files the user mentions: logs, configuration, stack traces, screenshots, recordings. Save anything pasted into the chat (an image, a long log) to a file in your temp directory, outside the repository.
2. Run `node scripts/sentinel.mjs issue attachments <files…> --json`. Add `--tracker-uploads` when the tracker can store files through your tools: always for the local tracker, and for Jira, Linear or Azure DevOps only when your tool there can upload. Never for GitHub: it has no upload API.
3. Act on each file's `action`:
   - `inline`: the file goes into the body, in the `<details>` block the result gives (long text is already cut to its first and last 80 lines).
   - `attach`: upload it with `attach` after the issue exists.
   - `pending-upload`: the user drags it into the issue after filing; say so now.
   - `blocked`: the text looks like it contains a secret, on the lines given. Tell the user the file and line numbers, never the matched text, and ask them to redact it; or, if they agree, write a redacted copy to your temp directory and plan that copy instead. Never attach or inline the original.
   - `rejected`: over the size limit (10 MB for images, 25 MB otherwise). Tell the user, and drop, crop or split the file.
4. Exit code `2` means at least one file is `blocked` or `rejected`: resolve those and run the command again. Then put the `section` from the result at the end of the body, and replace every `<what it shows>` with what the file shows.

## Write and lint the draft

1. Write the title by the kind's rule: an imperative verb and an object for a feature (`Export invoices as CSV`), `<component>: <symptom>` for a bug (`checkout: total ignores discount code`), at most 72 characters.
2. Write the body to `.sentinel/state/intake-<slug>.md` (that folder is git-ignored), with the `##` headings from the template, in order, and without the template's hint comments.
3. Run `node scripts/sentinel.mjs issue lint .sentinel/state/intake-<slug>.md --kind <kind> --title "<title>" --json`.
4. Act on the exit code:
   - `0`: the draft may be filed. Continue.
   - `2`: fix every entry in `problems` and lint again. Ask the user only when a fix needs a fact you do not have. Never delete a criterion, a step or an attachment just to make lint pass.
   - any other code: stop and tell the user the error.

## Check for duplicates

Skip this when refining an existing issue.

1. Unless the tracker is `local`, `list` the open and closed issues whose titles share words with yours, and write them to `.sentinel/state/intake-candidates.json` as `[{"id": "…", "title": "…"}]`.
2. Run `node scripts/sentinel.mjs issue duplicates "<title>" --candidates .sentinel/state/intake-candidates.json --json` (leave out `--candidates` for the local tracker, which supplies its own).
3. If it returns matches, show them to the user and ask whether to file anyway, to refine the existing issue instead (then continue as a refine with that id), or to stop.

## Propose a priority

Propose one of `priority/critical`, `priority/high`, `priority/medium` or `priority/low`, with a one-line reason taken from the Problem (features) or the Impact and Frequency (bugs):

- `critical`: an outage, data loss or a security hole, with no workaround.
- `high`: many users blocked, or a committed deadline; only a poor workaround.
- `medium`: a real cost, but a workaround exists. Use it when unsure.
- `low`: nice to have; no one is blocked.

## STOP for approval

Show the user, in one message:

- the tracker (and location) and whether this creates a new issue or refines issue `<id>`;
- the title, the labels (`kind/…`, `priority/…`, and `kind/chore` or `kind/refactor` if any), each with the name it maps to in `labelMap`, and the priority's reason;
- the full body, as it will be filed;
- every attachment and how it goes on the issue (uploaded, inline, pending upload);
- when refining: that the current body will be posted as a comment first, so nothing is lost.

Wait for the user's answer. Apply any changes they ask for and lint again before showing the result once more. Do not file anything until the user says yes.

## File or refine

1. **New issue:** `create` it with the approved title, the linted body file and the labels mapped through `labelMap`. Note the id and link.
2. **Refine:** first `comment` on the issue with its original body, verbatim, under a line such as "Original description, before it was rewritten in the sentinel issue format:". Only then `update` the title and body to the approved draft, and add the mapped labels.
3. `attach` every file planned as `attach`. For the local tracker that is `node scripts/sentinel.mjs issue attach <id> <file>`, which copies the file next to the issue and links it from the Attachments section. If an upload fails, treat that file as pending upload.
4. List every _pending upload_ file for the user with its full path, and tell them exactly what to do: open the issue (give the link), edit the description or add a comment, and drag the files in. GitHub has no upload API, so this one step is theirs.
5. The local tracker writes the issue and its attachments into the repository. Leave them for the user to commit on a branch, and delete the draft and candidates files in `.sentinel/state/`.

## Offer the next step

Tell the user the issue id and link. For a feature, offer to write its PRD with the `sentinel-prd` skill, which maps the issue's sections onto the PRD; for a bug, offer `sentinel-sdlc` when they want it fixed now. Start neither without a yes.

## Guardrails

- Never commit or push to the default branch; work on a branch named by `sentinel branch name`.
- Never force-push.
- Never merge a pull request; a human merges.
- During an SDLC run, never edit files outside the issue worktree.
- Reach the issue tracker only through the answer of `sentinel issue resolve`: when it says `ask`, ask the user, and never write issues to a tracker it did not return.
- Stop for human approval wherever a sentinel skill says STOP (RFC approval, mined issue list).
- Never file or update an issue whose draft has not passed `sentinel issue lint`, and never inline or upload a file that `sentinel issue attachments` blocked. Never repeat a secret it found.
