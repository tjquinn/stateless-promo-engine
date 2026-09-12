# Stateless Promo Engine

A lightweight, database-less promotion and checkout engine designed for rapid experimentation and clear auditability. Ship promotion rules as JSON, keep history in Git, and evaluate checkout scenarios locally or in CI without installing a database.

**Why Git-based promotion management**

- Minimal ops: no DB required — promotions live as JSON files under `data/promotions` and are versioned via Git.
- Deterministic and testable: the engine is plain JavaScript with clear inputs/outputs, making it easy to run in unit tests, CI, or as a local demo.
- Fast prototyping: iterate promotion rules quickly (bundles, BOGO, category discounts, fixed-package pricing).
- Auditability & rollback: every promotion change is committed so edits are traceable to a git hash and can be reverted or reviewed; this git-first approach provides a clear change history that can be simpler to manage than ad-hoc updates in environments where promotion edits are stored in opaque systems.

**Highlights**

- Promotion rule formats are JSON-first and human-editable.
- Checkout evaluation is stateless and returns detailed breakdowns (matched sets, applied promotion, savings).
- Built-in admin UI (`index.html`) for loading promotions, editing, and running checkout simulations.

Quick demo

1. Install dependencies:

```bash
npm install
```

2. Start the service:

```bash
npm start
# then open http://localhost:3000 in your browser
```

3. Try the sample Bags promotion with `BAG16` (or `Bag16` — matching is case-insensitive):

```bash
curl -s -X POST http://localhost:3000/api/checkout/evaluate \
	-H 'Content-Type: application/json' \
	-d '{"items":[{"sku":"SKU-200","quantity":2}],"promoCode":"Bag16"}'
```

What you get

- JSON response with `subtotal`, `discountAmount`, `grandTotal`, and `details.appliedPromotion`.
- A compact, auditable way to preview promotion effects before rolling them out.

Extending this project

- Add new promotion JSON files under `data/promotions` — the engine will read and normalize them.
- Implement new `match_type` values or reward handlers in `engine.js` for custom logic.

API surface

- `GET /api/admin/promotions` — list promotions
- `POST /api/checkout/evaluate` — evaluate cart with optional `promoCode`
- Admin routes exist for editing, retiring, and auditing promotion history via the UI.

License

This project is licensed under the terms in the `LICENSE` file.

This project demonstrates a production-friendly prototype for shipping experimentation and safe rollouts using a git-backed promotion workflow.
