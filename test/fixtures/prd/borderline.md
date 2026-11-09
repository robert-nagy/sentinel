# PRD: Order tracking

## Context & Problem Statement

Customers of the shop cannot see where their parcels are after checkout, so support receives
about 400 tickets per week. This product adds order tracking so customers can follow shipments.

## Functional Requirements

### FR-1: Customer views order status

- Given a signed-in customer with a shipped order
- When the customer opens the order page
- Then the page shows the latest carrier status

### FR-2: Customer receives status notifications

The customer gets a notification when the parcel is delivered.

## Non-Functional Requirements

- NFR-1: The order page must be fast.
- NFR-2: 99.9% monthly uptime for the tracking API.

## Security

Authentication uses OAuth 2.0 with JWT access tokens. Authorisation is role based (RBAC).

## Data Models

- `Order`: id, tenantId, customerId, status, createdAt
- `Shipment`: id, orderId, carrier, trackingCode, lastEvent

## API Contracts

- `GET /orders/{id}` returns the order with its shipment status

## Test Strategy Matrix

Unit tests cover status mapping, integration tests cover the API, E2E tests cover the page.
