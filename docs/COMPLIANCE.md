# Compliance notes

Reviewed November 2026 against Discord's published policies. This is an engineering summary, not
legal advice.

## What the policies say

- **Developer Policy** — apps must not be used for dangerous or illegal activity, including
  activities that facilitate or promote *illegal online gambling*.
  <https://support-dev.discord.com/hc/en-us/articles/8563934450327>
- **App Discovery content requirements** — discoverable apps must not contain content related to
  *gambling-adjacent or addictive behavior*. A casino simulator is therefore **not eligible for App
  Discovery / the App Directory**. <https://support-dev.discord.com/hc/en-us/articles/9489299950487>
- **Monetization Policy** — prohibits monetized offerings that facilitate gambling or
  gambling-adjacent activities, explicitly including *simulated casinos and their games*. This bot
  must **not be monetized** (no premium tiers, SKUs, subscriptions or paid perks).
  <https://support.discord.com/hc/en-us/articles/10575066024983>
- **Gambling Policy Explainer** — Discord's gambling concern centres on wagers or prizes of
  real-world value, including virtual currency that can be bought, sold or exchanged.
  <https://discord.com/safety/gambling-policy-explainer>

## How this project stays on the right side

- Chips are **fictional and free**. They have no real-world value. Purchases, sales, cash-out,
  external trading, exchange for products or services, redeemable prizes, crypto, loans and interest
  are prohibited. The bot contains no payment features.
- Small, one-way chip gifts are confined to the same private server. Gifting defaults to on and
  administrators can turn it off. Gifts require confirmation and established accounts, and respect
  the recipient opt-out and a daily sender limit. Both ledger entries share a transfer reference. These controls limit some forms
  of abuse, and operators must enforce the ban on outside trades. Discord's policy focuses on
  wagers and prizes with real-world value, including exchangeable virtual currency.
- Rewards (daily, passive, missions) never depend on bet size; XP has a daily soft cap; progression
  is cosmetic only. Leaderboard opt-out is available on the profile screen.
- Intended for a **private community server**. Keep the bot unlisted and unmonetized.
- You are responsible for local laws and for Discord's age requirements (13+ or the local minimum).
