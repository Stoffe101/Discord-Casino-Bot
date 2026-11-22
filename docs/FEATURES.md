# Feature checklist

✅ implemented and covered by automated tests · 🟡 implemented, verified only headlessly (needs a
live Discord check) · ⏳ planned / not in this release

> No live Discord session has been run for this release. Every Discord-facing item below has been
> exercised through payload validation and fake-interaction router tests only, hence 🟡.

## Core experience
| Feature | Status |
| --- | --- |
| `/casino` home with balance, passive, daily, tables, navigation | 🟡 |
| Wallet, transaction history (paginated), lifetime stats | 🟡 |
| Profile (self/others, user context menu), achievements, cosmetics | 🟡 |
| Leaderboards: 8 categories, all-time/week/day for net & wins, pagination, viewer rank, profile picker, opt-out | ✅ queries · 🟡 UI |
| Rewards: daily (UTC, streaks), passive (timestamp-based, capped), 3 daily missions | ✅ |
| Help topics, rules screen | 🟡 |
| Persistent self-healing lobby (no duplicates across restarts) | 🟡 |
| Ephemeral personal panels updating in place | 🟡 |

## Blackjack
| Feature | Status |
| --- | --- |
| Engine: shoe, CSPRNG shuffle, soft/hard, naturals, peek, hit/stand/double/split/surrender, insurance, split aces, resplits, S17/H17, 3:2/6:5 | ✅ |
| Multiple concurrent tables, thread per table, fallback to channel | ✅ service · 🟡 threads |
| Seats (1–7), one table per player, join mid-hand → next hand, leave mid-hand, sit out, host transfer | ✅ |
| Private tables (access codes, private threads) | ✅ service · 🟡 threads |
| Escrowed bets, rebet, custom bet, deal early (host), kick (host), close table | ✅ |
| Turn/betting/insurance timers with grace and auto-stand; absent-player sit-out | ✅ |
| Stale/double-click protection via round sequence numbers | ✅ |
| Table image (dealer, hands, bets, active highlight, badges), alt text | ✅ render · 🟡 in Discord |
| Dealer reveal animation frames, results summary, achievements/level-ups in results | 🟡 |
| Idle table cleanup (never mid-hand) | ✅ |

## Other games
| Feature | Status |
| --- | --- |
| Roulette: shared European wheel, 13 bet types, betting window, history, wheel image | ✅ service · 🟡 UI |
| Slots: 3 reels, documented paytable, exact RTP 96.53% verified by enumeration | ✅ |
| Coinflip duels: escrow, accept/decline/cancel/expiry, duplicate-accept safety, restart | ✅ |

## Economy & safety
| Feature | Status |
| --- | --- |
| Append-only ledger, idempotency keys, integer-only, non-negative constraints | ✅ |
| Escrow/committed chips, exactly-once settlement, void/refund | ✅ |
| Reconciliation (tests, hourly self-audit, `/casinoadmin health`) | ✅ |
| Restart recovery for every phase, corrupt-state refunds, orphan refunds | ✅ |
| Admin panel (all settings), audited adjustments, audit log, force close, protected dev reset | ✅ logic · 🟡 UI |

## Progression
| Feature | Status |
| --- | --- |
| XP/levels/ranks with daily soft cap (not wealth-based) | ✅ |
| 21 achievements (counters + events, secrets), exactly-once rewards | ✅ |
| Card backs, felts, titles unlocked by level/achievement | ✅ logic · 🟡 UI |
| Lobby highlights (big wins, secret achievements) | 🟡 |

## Planned (not in this release)
| Feature | Notes |
| --- | --- |
| ⏳ Blackjack tournaments | Architecture supports it (separate escrow context per tournament, recorder per round); needs bracket/scoring service and UI |
| ⏳ Weekly achievements / seasonal cosmetics | Missions framework is the starting point |
| ⏳ Custom application emoji icons | Unicode icons are used today |
| ⏳ Personal match history screen | Data is already stored in `round_results` |
| ⏳ Multi-instance hosting | Not supported; single process by design |
