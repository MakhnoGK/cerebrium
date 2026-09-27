# dashboard-api

The web dashboard's backend: a NestJS BFF over the kernel. Plain listings and stats read
Postgres through a read-only role; search, `get` and every write go through the kernel API,
so ranking, the single writer and the audit trail stay in one place.

Scaffold only. It is built after the cutover to the host (migration plan, Phase 8).
