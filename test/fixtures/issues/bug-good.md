# checkout: total ignores discount code

## Summary

Applying a valid discount code at checkout does not change the order total, for every
customer who uses a code.

## Steps to reproduce

1. Sign in as any customer and add one item to the cart.
2. Open checkout and apply the code `SPRING10`.
3. Look at the order total.

## Expected

The total drops by 10 % and the discount appears as its own line.

## Actual

The total is unchanged. The browser console shows:

```text
TypeError: Cannot read properties of undefined (reading 'rate')
    at applyDiscount (total.ts:88)
```

## Environment

v2.3.1 (commit abc1234), macOS 15.1, Safari 19.0, `DISCOUNTS_V2=true`.

## Frequency

always

## Impact

Every customer with a code; no workaround.

## Suspected cause

Guess: `src/checkout/total.ts:88` reads the rate before the code is applied.

## Acceptance criteria

- [ ] AC-1: Given a cart with one item at 100 EUR, when I apply `SPRING10`, then the total
      is 90 EUR and a "Discount −10 EUR" line is shown.

## Attachments

- `server.log`: request trace for the failing order (inline, below)

<details><summary>server.log (3 lines)</summary>

```
12:00:01 POST /checkout/discount 200
12:00:01 recalc total=100.00 rate=undefined
12:00:02 GET /checkout 200
```

</details>
