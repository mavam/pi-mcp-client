---
title: More reliable OAuth connections and cancellation
type: bugfix
authors:
  - mavam
created: 2026-09-25T11:13:56.006593Z
---

OAuth connections now report credential-store failures after token refresh instead of silently starting another login. Connections also handle exact OAuth resource identifiers and request cancellation more reliably. Authentication recovery keeps remote error details out of terminal warnings.
