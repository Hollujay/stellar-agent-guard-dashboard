# Client-Side Freighter Architecture

The dashboard is designed under a strict zero-trust principle:

## No Server-Side Private Keys

- No server API routes handle private keys or secrets.
- All write operations construct a `SorobanAuthorizationEntry` and transaction envelope in the operator's browser.
- The user's Freighter extension prompts the operator to review the exact authorization entries and fee parameters before signing.
- Broadcast transactions are submitted directly to Soroban RPC over CORS-enabled endpoints (`https://soroban-testnet.stellar.org`).

## Bounded Fleet Concurrency

- Manual refresh and automated fleet polling use a documented concurrency bound (`DEFAULT_FLEET_PROBE_CONCURRENCY = 5`) to prevent rate-limiting and browser socket exhaustion.
- Per-row errors are isolated so healthy guards update uninterrupted, and active refreshes cancel cleanly via `AbortSignal` upon navigation or network switch.

## Strict Payload Validation & Write Safety

- HTTP 200 responses with missing, partial, or malformed payloads for `status()`, `policy()`, `balance`, or event queries are parsed strictly without inventing defaults or assuming safe states.
- Malformed states surface localized errors and strictly prohibit initiating or confirming transactions until verified state is restored.

## Pending Action Signer Binding

- Every pending approval dialog (freezes, deployments, policy updates) binds the transaction to an immutable account snapshot displaying the shortened address, copy action, and network.
- If the operator switches accounts or disconnects in their wallet between review and signing, the pending action cancels safely to prevent signing unauthorized transactions.

## Third-Party Endpoint Evaluation

- Operators deploying or configuring custom endpoints can review the provider-neutral checklist in `docs/guides/evaluating-rpc-endpoints.md` covering integrity, availability, logging policies, and browser request data boundaries.
