# Export invoices as CSV

## Problem

Accountants export invoices by copying rows from the table into a spreadsheet, about 40 minutes
at each month-end close, and rows get missed.

## User story

As an accountant, I want to export a month's invoices as CSV, so that I can import them into
the ledger without retyping.

## Acceptance criteria

- [ ] AC-1: Given 120 invoices dated in March, when I export March, then the CSV has 120 rows
      and the header `number,date,customer,net,vat,gross`.
- [ ] AC-2: Given a user without the `billing:read` role, when they request an export, then
      the server returns 403 and no file.

## Out of scope

- PDF export.

## Constraints

- An export of 10 000 invoices finishes in under 5 s.

## Context

- The table is rendered in `src/invoices/table.ts:42`.
