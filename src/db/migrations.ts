export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Ordered, append-only schema migrations. Never edit a migration that has shipped —
 * add a new one instead. Each migration runs inside its own transaction.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'initial_schema',
    sql: /* sql */ `
      -- Per-server configuration. settings_json holds only overrides; defaults live in code.
      CREATE TABLE guild_settings (
        guild_id         TEXT PRIMARY KEY,
        settings_json    TEXT    NOT NULL DEFAULT '{}',
        lobby_channel_id TEXT,
        lobby_message_id TEXT,
        updated_at       INTEGER NOT NULL
      );

      -- One casino account per (server, Discord user). Discord user IDs are the identity;
      -- display_name is only a render cache and is refreshed on every interaction.
      CREATE TABLE players (
        guild_id            TEXT    NOT NULL,
        user_id             TEXT    NOT NULL,
        display_name        TEXT    NOT NULL DEFAULT '',
        balance             INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
        reserved            INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
        highest_balance     INTEGER NOT NULL DEFAULT 0,
        passive_anchor_at   INTEGER NOT NULL,
        daily_last_day      TEXT,
        daily_streak        INTEGER NOT NULL DEFAULT 0,
        xp                  INTEGER NOT NULL DEFAULT 0,
        title_id            TEXT,
        card_back_id        TEXT    NOT NULL DEFAULT 'emerald',
        felt_id             TEXT    NOT NULL DEFAULT 'emerald',
        leaderboard_opt_out INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL,
        last_seen_at        INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX players_by_balance ON players (guild_id, balance DESC);
      CREATE INDEX players_by_xp ON players (guild_id, xp DESC);

      -- Immutable ledger. amount is the signed change to the AVAILABLE balance.
      -- Invariant: players.balance = SUM(ledger.amount) for every player.
      CREATE TABLE ledger (
        id              TEXT    PRIMARY KEY,
        guild_id        TEXT    NOT NULL,
        user_id         TEXT    NOT NULL,
        type            TEXT    NOT NULL,
        game            TEXT,
        amount          INTEGER NOT NULL,
        balance_after   INTEGER NOT NULL CHECK (balance_after >= 0),
        reserved_after  INTEGER NOT NULL CHECK (reserved_after >= 0),
        reference       TEXT,
        idempotency_key TEXT    NOT NULL,
        memo            TEXT,
        actor_id        TEXT,
        created_at      INTEGER NOT NULL,
        UNIQUE (guild_id, idempotency_key)
      );
      CREATE INDEX ledger_by_user ON ledger (guild_id, user_id, created_at DESC);
      CREATE TRIGGER ledger_is_append_only_update BEFORE UPDATE ON ledger
        BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
      CREATE TRIGGER ledger_is_append_only_delete BEFORE DELETE ON ledger
        BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

      -- Chips committed to a game. Invariant: players.reserved = SUM(amount) of 'held' escrows.
      CREATE TABLE escrows (
        id          TEXT    PRIMARY KEY,
        guild_id    TEXT    NOT NULL,
        user_id     TEXT    NOT NULL,
        game        TEXT    NOT NULL,
        context_id  TEXT    NOT NULL,
        amount      INTEGER NOT NULL CHECK (amount > 0),
        status      TEXT    NOT NULL CHECK (status IN ('held', 'settled', 'refunded')),
        created_at  INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX escrows_by_context ON escrows (guild_id, context_id, status);
      CREATE INDEX escrows_by_user ON escrows (guild_id, user_id, status);
      CREATE INDEX escrows_held ON escrows (status) WHERE status = 'held';

      -- Game tables (blackjack tables, roulette wheels). state_json is the authoritative,
      -- fully serialised game state including the shoe, so a restart can resume exactly.
      CREATE TABLE game_tables (
        id               TEXT    PRIMARY KEY,
        guild_id         TEXT    NOT NULL,
        game             TEXT    NOT NULL,
        number           INTEGER NOT NULL,
        name             TEXT    NOT NULL,
        owner_id         TEXT    NOT NULL,
        is_private       INTEGER NOT NULL DEFAULT 0,
        access_code      TEXT,
        config_json      TEXT    NOT NULL,
        channel_id       TEXT,
        thread_id        TEXT,
        message_id       TEXT,
        status           TEXT    NOT NULL CHECK (status IN ('open', 'closed')),
        state_json       TEXT    NOT NULL,
        version          INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        closed_at        INTEGER
      );
      CREATE UNIQUE INDEX game_tables_open_number ON game_tables (guild_id, game, number) WHERE status = 'open';
      CREATE INDEX game_tables_open ON game_tables (status, guild_id);

      -- Seats. UNIQUE (guild_id, user_id) makes it impossible to sit at two tables at once.
      CREATE TABLE table_seats (
        table_id   TEXT    NOT NULL REFERENCES game_tables (id),
        guild_id   TEXT    NOT NULL,
        user_id    TEXT    NOT NULL,
        seat_index INTEGER NOT NULL,
        joined_at  INTEGER NOT NULL,
        PRIMARY KEY (table_id, seat_index),
        UNIQUE (guild_id, user_id)
      );

      -- Settled/voided rounds. The primary key makes settlement exactly-once.
      CREATE TABLE game_rounds (
        id           TEXT    PRIMARY KEY,
        guild_id     TEXT    NOT NULL,
        game         TEXT    NOT NULL,
        table_id     TEXT,
        status       TEXT    NOT NULL CHECK (status IN ('settled', 'void')),
        summary_json TEXT,
        created_at   INTEGER NOT NULL,
        settled_at   INTEGER NOT NULL
      );
      CREATE INDEX game_rounds_by_table ON game_rounds (table_id, settled_at DESC);

      -- Per-player outcome of each round (match history, period leaderboards).
      CREATE TABLE round_results (
        round_id    TEXT    NOT NULL,
        guild_id    TEXT    NOT NULL,
        user_id     TEXT    NOT NULL,
        game        TEXT    NOT NULL,
        wagered     INTEGER NOT NULL,
        returned    INTEGER NOT NULL,
        net         INTEGER NOT NULL,
        outcome     TEXT    NOT NULL,
        detail_json TEXT,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (round_id, user_id)
      );
      CREATE INDEX round_results_by_time ON round_results (guild_id, created_at);
      CREATE INDEX round_results_by_user ON round_results (guild_id, user_id, created_at DESC);

      -- Flexible integer statistics, keyed by game ('all' for cross-game totals).
      CREATE TABLE player_stats (
        guild_id TEXT    NOT NULL,
        user_id  TEXT    NOT NULL,
        game     TEXT    NOT NULL,
        stat     TEXT    NOT NULL,
        value    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id, game, stat)
      );
      CREATE INDEX player_stats_rank ON player_stats (guild_id, game, stat, value DESC);

      CREATE TABLE player_achievements (
        guild_id       TEXT    NOT NULL,
        user_id        TEXT    NOT NULL,
        achievement_id TEXT    NOT NULL,
        unlocked_at    INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id, achievement_id)
      );

      CREATE TABLE player_unlocks (
        guild_id    TEXT    NOT NULL,
        user_id     TEXT    NOT NULL,
        kind        TEXT    NOT NULL,
        item_id     TEXT    NOT NULL,
        unlocked_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id, kind, item_id)
      );

      CREATE TABLE player_missions (
        guild_id     TEXT    NOT NULL,
        user_id      TEXT    NOT NULL,
        day          TEXT    NOT NULL,
        mission_id   TEXT    NOT NULL,
        progress     INTEGER NOT NULL DEFAULT 0,
        target       INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY (guild_id, user_id, day, mission_id)
      );

      CREATE TABLE coinflip_challenges (
        id             TEXT    PRIMARY KEY,
        guild_id       TEXT    NOT NULL,
        challenger_id  TEXT    NOT NULL,
        opponent_id    TEXT    NOT NULL,
        amount         INTEGER NOT NULL CHECK (amount > 0),
        challenger_call TEXT   NOT NULL CHECK (challenger_call IN ('heads', 'tails')),
        status         TEXT    NOT NULL CHECK (status IN ('pending', 'resolved', 'declined', 'cancelled', 'expired')),
        result         TEXT,
        winner_id      TEXT,
        channel_id     TEXT,
        message_id     TEXT,
        created_at     INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL,
        resolved_at    INTEGER
      );
      CREATE INDEX coinflip_pending ON coinflip_challenges (status, expires_at);

      -- Notable moments shown in the lobby ("Hanna hit a natural for 750").
      CREATE TABLE highlights (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT    NOT NULL,
        kind       TEXT    NOT NULL,
        user_id    TEXT    NOT NULL,
        text       TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX highlights_recent ON highlights (guild_id, id DESC);
    `,
  },
  {
    id: 2,
    name: 'wallet_and_activity_preferences',
    sql: /* sql */ `
      ALTER TABLE players ADD COLUMN relief_title_until INTEGER;
      ALTER TABLE players ADD COLUMN gifts_opt_out INTEGER NOT NULL DEFAULT 0 CHECK (gifts_opt_out IN (0, 1));
      ALTER TABLE players ADD COLUMN highlights_opt_out INTEGER NOT NULL DEFAULT 0 CHECK (highlights_opt_out IN (0, 1));
      CREATE INDEX ledger_social_by_player ON ledger (guild_id, user_id, type, created_at DESC)
        WHERE type IN ('emergency_relief', 'gift_sent');
      CREATE INDEX round_results_by_user_game ON round_results (guild_id, user_id, game, created_at DESC);
      CREATE INDEX highlights_by_player ON highlights (guild_id, user_id, kind, created_at DESC);
    `,
  },
  {
    id: 3,
    name: 'casino_events',
    sql: /* sql */ `
      CREATE TABLE casino_events (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        organizer_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        game TEXT NOT NULL CHECK(game IN ('blackjack','poker')),
        starts_at INTEGER NOT NULL,
        min_players INTEGER NOT NULL CHECK(min_players >= 2),
        max_players INTEGER NOT NULL CHECK(max_players >= min_players),
        access_code TEXT,
        state TEXT NOT NULL CHECK(state IN ('scheduled','ready','awaiting','in_progress','completed','cancelled')),
        registration_open INTEGER NOT NULL CHECK(registration_open IN (0,1)),
        table_id TEXT,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(guild_id, access_code)
      );
      CREATE INDEX casino_events_schedule ON casino_events(guild_id, starts_at);
      CREATE INDEX casino_events_table ON casino_events(table_id) WHERE table_id IS NOT NULL;
      CREATE TABLE casino_event_players (
        event_id TEXT NOT NULL REFERENCES casino_events(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY(event_id, user_id)
      );
    `,
  },
];
