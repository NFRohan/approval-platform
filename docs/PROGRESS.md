# Admin demo — what changed

Week ending 23 August 2026.

| | |
|---|---|
| Live | https://approval-platform-omega.vercel.app |
| Repository | https://github.com/NFRohan/approval-platform |
| Health check | `/api/health` |

**Where it was:** a half-finished demo on Supabase — one shared dataset, no
login, the database credentials shipped inside the browser bundle, and an
approval system that did not actually enforce approvals.

**Where it is:** deployed, multi-tenant, behind a login, with a working
approval chain and five test suites.

*If the PM only wants one line: it went from a clickable mock-up to something
we can hand a prospect a login to.*

---

## Foundations

1. Rebuilt the database on plain Postgres — the Supabase dependency is gone
2. Added multi-tenancy: each prospect gets an isolated copy of the demo, so two
   can evaluate at the same time without seeing each other
3. Turned on real access control — every security policy had been set to
   "allow everything"
4. Moved all 156 database queries behind a server API. **The database password
   used to be downloadable from the browser**
5. Built provisioning: issue, extend, withdraw and reset an evaluation

## The approval engine — the core rebuild

6. **Approvals happen in order now.** Previously every approver was asked at
   once, so a CFO could sign off before the line manager had seen it
7. **Fixed escalation.** A 600,000 claim went straight to the CFO, skipping the
   Finance Controller and the Head of Finance. It now climbs all three in turn
8. Put Notices and Stationery on the real approval system — they walked a
   hardcoded list pointing at employees who no longer exist, so those approvals
   were going nowhere at all
9. Gave Maintenance its three approval tiers
10. Added forward-to-somebody-else, and add-a-reviewer mid-chain
11. Rejections stop the chain; clarification requests pause and resume it
12. Everything now appears in one queue, one history and one timeline

## Made real (was fake)

13. **Notifications** — the table existed and nothing had ever written to it.
    Approvers are told when it is their turn
14. **The search box** — an input with no code behind it, next to a badge
    advertising a keyboard shortcut that did nothing
15. **Dashboard panels** — invented names and dates, sitting directly beneath
    statistics that were already live
16. **The notification bell** — "3 new notifications" was typed text
17. **Approval amount tables** — two hardcoded copies that disagreed with each
    other *and* with the database
18. **The breadcrumb** — said "Home / Dashboard" on every screen
19. **Deadlines** — now counted in working days, and they actually chase people

## Access and delivery

20. Sign-in, with evaluation credentials that expire on their own
21. A staff console for issuing and withdrawing evaluations
22. Deployed to Vercel, hosted in the same region as the database
23. **Removed all client branding** — 180 references plus the client's own
    logo. The repository is public and names nobody
24. Draft submissions, and a receipt-acknowledgement step on stationery
25. Written up: README, deployment guide, six-sprint plan

## Notable bugs found and fixed

26. **Four of the five forms could not be submitted at all** — blocked on the
    first screen, telling the user to fill a field that had no input
27. **The persona switcher matched nobody** — every approval queue came up empty
28. **The staff console could never be opened** — you could sign in and still
    never get in
29. **Withdrawing an evaluation did nothing for twelve hours**
30. Sixteen broken save and approve buttons across four screens
31. The form builder could not save a field
32. Three stock functions were called by the app and existed nowhere

## Testing — there was none

33. Five suites: 196 call-site checks, 24 sign-in checks, 21 screens rendered,
    75 database checks, and 36 browser checks driven through a real Chromium

```
npm test        the first four
npm run qa -- <url> <user> <pass> [staffUser] [staffPass]
```

---

## Deliberately not built

Email and SMS delivery. Five of the ten specified admin modules — dispatch,
event coordination, visitor management, air ticketing and standalone stock —
each of which is its own project. Mobile app, ERP and Tableau integration.

Sequencing is in [SPRINT_PLAN.md](SPRINT_PLAN.md); deployment is in
[DEPLOY.md](DEPLOY.md).

## Open

- Manual QA — the things a script cannot judge: whether the builder's
  drag-and-drop feels right, whether the layout reads well, whether the copy
  sounds like something to put in front of a client
- The demo is public, gated only by the issued credential. That was a
  deliberate call once sign-in existed
