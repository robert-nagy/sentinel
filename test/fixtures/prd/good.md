# PRD: Order tracking

## 1. Context & Problem Statement

Customers of the shop cannot see where their parcels are after checkout, so support receives
about 400 "where is my order" tickets per week. This product adds order tracking so customers
can follow each shipment without contacting support.

## 2. Functional Requirements

### FR-1: Customer views order status

The customer opens an order and sees the current shipment status.

- Given a signed-in customer with a shipped order
- When the customer opens the order page
- Then the page shows the latest carrier status and its timestamp

### FR-2: Customer receives status notifications

- **Given** a customer who enabled notifications
- **When** the carrier reports that the parcel is delivered
- **Then** the customer receives an email within 5 minutes

## 3. Non-Functional Requirements

- NFR-1: Latency: the order page responds in under 200 ms at the 95th percentile with 500 requests per second.
- NFR-2: Availability: 99.9% monthly uptime for the tracking API.
- NFR-3: Multi-tenancy: a tenant can read only its own orders, verified by 100% of integration tests.

## 4. Security

Authentication uses OAuth 2.0 with short-lived JWT access tokens. Authorisation is role based
(RBAC) with the roles admin, member and viewer. All input is validated against JSON schemas
and rejected with a 400 response when invalid.

## 5. Data Models

- `Order`: id, tenantId, customerId, status, createdAt
- `Shipment`: id, orderId, carrier, trackingCode, lastEvent, updatedAt

## 6. API Contracts

- `GET /orders/{id}` returns the order with its shipment status
- `POST /orders/{id}/subscriptions` enables notifications for the order

## 7. Test Strategy Matrix

| Tier        | Scope                                  | Tooling                |
| ----------- | -------------------------------------- | ---------------------- |
| Unit        | status mapping, validation             | vitest                 |
| Integration | API with a real database               | vitest, testcontainers |
| E2E         | order page in a browser                | playwright             |
| Load        | 500 requests per second for 10 minutes | k6                     |
