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

- Chips are **fictional, free and non-transferable**: no purchases, no cash-out, no trading, no
  player-to-player transfers, no redeemable prizes, no crypto, no payment code of any kind.
- The only way chips move between players is a coinflip **duel** both players opt into; chips still
  have no value outside the game and cannot leave it.
- Rewards (daily, passive, missions) never depend on bet size; XP has a daily soft cap; progression
  is cosmetic only. Leaderboard opt-out is available on the profile screen.
- Intended for a **private community server**. Keep the bot unlisted and unmonetized.
- You are responsible for local laws and for Discord's age requirements (13+ or the local minimum).
