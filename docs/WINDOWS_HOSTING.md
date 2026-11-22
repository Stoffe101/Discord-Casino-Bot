# Running on Windows 11

## Continuous operation

```powershell
npm ci
npm run build
npm start
```

- State lives in `data/casino.db` (SQLite, WAL mode). Logs go to `logs/casino-YYYY-MM-DD.log`
  (JSON lines) and the console.
- **Ctrl+C** shuts down gracefully: pending panel edits flush (≤5 s), timers stop, the database is
  checkpointed and closed. Even an abrupt stop is safe — see the recovery table in the README.
- Run only **one** instance per database.

## Start automatically with Task Scheduler (optional)

`scripts/start-casino.ps1` builds nothing; it runs the compiled bot and restarts it if it exits
unexpectedly (with a short back-off), appending output to `logs/runner.log`.

Exit codes: `0` graceful stop (the runner stops), `1` crash or failed login (the runner restarts),
`2` configuration problem or **another copy already running against the same database** (the runner
stops; fix it first). Only one bot can use a database at a time: a second copy started from another
terminal or by `npm run dev` refuses to start rather than conflicting.

Nothing is registered for you. If you want the bot to start when you log in:

1. Build once: `npm run build`.
2. Open **Task Scheduler** → *Create Task…*
   - **General:** name *Emerald Room Casino*; *Run only when user is logged on* (simplest).
   - **Triggers:** *At log on* (your account).
   - **Actions:** *Start a program*
     - Program: `powershell.exe`
     - Arguments: `-NoProfile -ExecutionPolicy Bypass -File "C:\path\to\Discord-Casino-Bot\scripts\start-casino.ps1"`
     - Start in: `C:\path\to\Discord-Casino-Bot`
   - **Settings:** untick *Stop the task if it runs longer than…*.
3. Right-click the task → *Run* to test, and check `logs/`.

To stop it: end the task in Task Scheduler (the runner stops restarting when the task ends).

## Backups

The whole casino is `data/casino.db` (plus `-wal`/`-shm` while running). To back up safely while
running, copy all three files, or stop the bot and copy `casino.db`. Restoring = putting the file
back before starting.

## Updating

```powershell
git pull
npm ci
npm run build
npm run register-commands   # only if commands changed
```

Database migrations run automatically at startup and are append-only.
