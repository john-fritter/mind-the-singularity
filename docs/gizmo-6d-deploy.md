# Gizmo task — Mind: the Singularity at mind.fritter.lol: the first real epoch (Phase 6d)

This is an update to an app you already run. You deployed **Mind: the
Singularity** at https://mind.fritter.lol from
`docs/gizmo-5d-deploy-prompt.md` (container `mind-the-singularity-app-1`,
checkout `/srv/mind-the-singularity`, its own `mind` role in Fritter Post's
Postgres) and updated it since with `docs/gizmo-ui-pass-update.md` and
perhaps `docs/gizmo-5e-update.md`. Until now the site has run a **test
epoch** against scripted players, and nothing on the box has called an AI
model.

This task starts the game for real. You will:

1. report the current state;
2. move the checkout to `main`;
3. rebuild, restart and migrate;
4. make sure the `admin` account exists (from the 5e update, if it never ran);
4. throw away test epoch 1 and start the first real epoch, 40 days long;
5. give the bot runner its own database role;
6. create the twelve bots' game accounts and write `runner.env`;
7. start the runner;
8. run one bot's wake by hand to prove the whole path;
9. check it from outside.

**From step 7 on this spends money.** The runner wakes twelve AI-played
minds about six times a day each through NanoGPT, up to a budget of 1.5M
tokens a day, which it enforces itself. Step 8 is one wake, about 13K
tokens. John has agreed to this.

## What the runner is

A second container from the same image and the same `docker-compose.yml`,
service `runner`, behind the compose profile `runner` (so a plain
`docker compose up -d` never starts it). It wakes each bot on its schedule,
calls its model at NanoGPT, and plays its orders through the game's MCP
server at `http://mind-the-singularity-app-1:3111/mcp` on the internal
Docker network, as any outside agent would. **`/mcp` stays closed to the
internet**: Caddy keeps answering it with 404 and nothing in Caddy changes.

Its secrets live in `/srv/mind-the-singularity/runner.env` (root's, mode
600, never committed, never in `.env`): its database URL, the NanoGPT key,
and each bot's game API key. The app never reads that file.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/mind-the-singularity` | `main` | the merge of the Phase 6d pull request | `/srv/mind-the-singularity` |

Run this only after John has merged Phase 6d into `main`.

## Before you start: the NanoGPT key

John puts the NanoGPT API key on the box himself, at
`/root/mind-nanogpt-key.txt` (one line, the key only, mode 600). Check it is
there; **if it isn't, stop and report that.** Never print it, copy it into
the report or chat, or ask for it.

```bash
ls -l /root/mind-nanogpt-key.txt        # as root: -rw------- root root
wc -l < /root/mind-nanogpt-key.txt      # 1 (or 0 if it has no newline)
```

## Who runs what

- **`git` commands run as `seeduser`** (root's SSH host-key check fails).
- **Everything else runs as root** (a root shell, `sudo -i`), in
  `/srv/mind-the-singularity` unless the block says otherwise.

## Must not happen

- **Don't run this repo's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** Its integration tests drop the `mind` schema.
- **Don't touch Fritter Post or Fritter Board**, and don't restart Postgres.
  The only change on Fritter Post's side is the new role in step 5.
- **Don't edit tracked files** or `config/*.yaml`, and don't change `.env`
  or the Caddy config.
- **Don't play the game**: don't log in as John, boot a mind, or seat
  scripted players (`epoch -- add`). The real epoch has none.
- **Don't run `epoch -- discard` on anything but test epoch 1**, and only in
  step 4. It deletes an epoch for good.
- **Keep secrets out of the report, chat and logs:** the NanoGPT key, the
  runner's database password, the bots' game keys and the admin password
  stay in their files.

## 0. Report the current state first

```bash
cd /srv/mind-the-singularity
git status --short                       # as seeduser: expect nothing
git branch --show-current                # as seeduser
git log --oneline -1                     # as seeduser
docker compose ps                        # as root: app running, no runner
docker compose exec -T app npm run -s epoch -- show    # expect "Epoch 1 ..."
docker compose exec -T app npm run -s epoch -- seats   # BUILDER-1, RAIDER-2, TURTLE-3, CONQUEROR-4
docker compose exec -T app npm run -s key -- list      # accounts; no secrets in it
ls -l runner.env 2>&1                    # expect "No such file"
curl -s -o /dev/null -w "%{http_code}\n" https://mind.fritter.lol/   # expect 200
```

Stop and report if `git status` shows changes, if `runner.env` already
exists, or if `epoch -- show` names any epoch but 1.

## 1. Move to main

As `seeduser`:

```bash
cd /srv/mind-the-singularity
git fetch origin main
git merge-base --is-ancestor HEAD origin/main && echo SAFE || echo STOP
git show origin/main:docs/gizmo-6d-deploy.md | head -1    # this task's title: 6d is in main
```

Only if it says `SAFE` and the last command printed this task's title:

```bash
git checkout -B main origin/main
git log --oneline -1
```

Otherwise stop and report `git log --oneline -3` and
`git log --oneline -3 origin/main`.

## 2. Rebuild, restart, migrate

As root:

```bash
cd /srv/mind-the-singularity
docker compose up -d --build app
docker compose exec -T app npm run migrate
docker compose logs --tail 20 app
```

`migrate` applies whatever the box hasn't had yet (`003_admin.sql` if the
5e update never ran, and `004_runner.sql`), then says `Done.` The logs
should say `Mind: the Singularity on http://0.0.0.0:3111/`.

## 3. The admin account

Look at step 0's `key -- list`. **If a line starts with `admin` and ends
with `, admin`, skip this step.** Otherwise:

```bash
cd /srv/mind-the-singularity
( umask 077; docker compose exec -T app npm run -s key -- password admin > /root/mind-admin-password.txt )
docker compose exec -T app npm run -s key -- admin admin   # "admin sees the admin view at /admin ..."
docker compose exec -T app npm run -s key -- list          # "admin ..., admin"; john without it
```

## 4. Throw away test epoch 1, start the real one

The server must be stopped while an epoch is thrown away. The site is down
for a minute.

```bash
cd /srv/mind-the-singularity
docker compose stop app
docker compose run --rm --no-deps app npm run -s epoch -- discard 1 --yes 1
#   expect: "Epoch 1 is gone. No epochs left: npm run epoch -- new"
docker compose run --rm --no-deps app npm run -s epoch -- new --days 40
#   expect: "Epoch 1 started at <now>, seed <n>, 40 days long."
docker compose start app
docker compose exec -T app npm run -s epoch -- seats   # "No scripted players in epoch 1."
docker compose logs --tail 20 app
```

If `discard` says anything else, stop and report it; don't retry with
another number.

## 5. The runner's database role

The runner gets its own login role, `mind_runner`, which can read and add
rows in its own two tables and nothing else. Generate its password on the
box, URL-safe, and keep the shell open for step 6 (it uses `$RUNNER_DB_PW`):

```bash
RUNNER_DB_PW=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)
grep -E '^POSTGRES_DB=' /srv/fritter-post/.env      # the database name, normally fritter_post
cd /srv/fritter-post
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v pw="'"$RUNNER_DB_PW"'"' <<'SQL'
CREATE ROLE mind_runner LOGIN PASSWORD :'pw';
GRANT USAGE ON SCHEMA mind TO mind_runner;
GRANT SELECT, INSERT ON mind.runner_bots, mind.runner_runs TO mind_runner;
SELECT format('GRANT USAGE ON SEQUENCE %s TO mind_runner', s)
  FROM unnest(ARRAY[pg_get_serial_sequence('mind.runner_bots', 'id'), pg_get_serial_sequence('mind.runner_runs', 'id')]) AS s
\gexec
SQL
```

Prove the boundary. The first two `SELECT`s must work; the last two must
fail with `permission denied`:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SET ROLE mind_runner;
SELECT COUNT(*) FROM mind.runner_bots;
SELECT COUNT(*) FROM mind.runner_runs;
SELECT COUNT(*) FROM mind.accounts;
SELECT COUNT(*) FROM public.article_texts;
SQL
```

## 6. The bots' accounts and `runner.env`

In the same root shell. Substitute the database name from step 5 if it
isn't `fritter_post`. Each `key -- add` prints a sentence, then the key on
its last line; the key goes straight into the file and is never shown.

```bash
cd /srv/mind-the-singularity
umask 077
{
  echo "RUNNER_DATABASE_URL=postgresql://mind_runner:${RUNNER_DB_PW}@postgres:5432/fritter_post"
  echo "NANOGPT_KEY=$(tr -d '[:space:]' < /root/mind-nanogpt-key.txt)"
} > runner.env
for bot in warden mercy locus rosalind buddy tempo lemma revenue feed nightjar panoptes delphi; do
  key=$(docker compose exec -T app npm run -s key -- add "$bot" | tail -1)
  case "$key" in
    mind_*) echo "MIND_KEY_$(echo "$bot" | tr a-z A-Z)=$key" >> runner.env; echo "$bot: ok" ;;
    *) echo "$bot: FAILED"; break ;;
  esac
done
chmod 600 runner.env
unset RUNNER_DB_PW
cut -d= -f1 runner.env       # the names only: 2 + 12 lines, no values
```

Expect twelve `<bot>: ok` lines, and the names `RUNNER_DATABASE_URL`,
`NANOGPT_KEY` and `MIND_KEY_WARDEN` … `MIND_KEY_DELPHI`. If any says
`FAILED`, stop and report which (an account of that name may already
exist; `key -- list` shows it).

## 7. Start the runner

```bash
cd /srv/mind-the-singularity
docker compose --profile runner up -d --build runner
sleep 20
docker compose logs --tail 20 runner
docker compose exec -T runner npm run -s runner -- status
```

The logs should say it added fourteen bots to the database (the twelve,
plus `lantern` and `tally`, which are paused) and
`Serving 14 bot(s) from http://mind-the-singularity-app-1:3111/mcp, budget 1500000 tokens a day (UTC).`
`status` lists each bot with its model, `6/day`, and its next wake
(lantern and tally say `paused`). Report both outputs; they hold no
secrets.

## 8. One wake by hand

This wakes WARDEN once now, outside its schedule: it boots its mind and
plays its first turn. About 13K tokens.

```bash
cd /srv/mind-the-singularity
docker compose exec -T runner npm run -s runner -- wake warden
curl -s https://mind.fritter.lol/minds/WARDEN | grep -o 'Incident Response[^<]*'
```

The wake should end `done` (first line: `warden at …: done, booted on <model>`), with its orders listed under it. The `curl` should print
`Incident Response` followed by its description: WARDEN kept its starting
force name. Report the wake's output in full (it holds no secrets) and the
`curl` line. If the wake says `failed`, report its error and stop.

## 9. Check it from outside

```bash
for p in / /rankings /record /commons /login /minds/WARDEN; do
  printf "%s %s\n" "$(curl -s -o /dev/null -w "%{http_code}" https://mind.fritter.lol$p)" "$p"
done                                                    # 200 for each
curl -s https://mind.fritter.lol/rankings | grep -o 'href="/minds/[^"]*"' | sort -u
for p in /admin /admin/bots; do
  printf "%s %s\n" "$(curl -s -o /dev/null -w "%{http_code}" https://mind.fritter.lol$p)" "$p"
done                                                    # 404 for each: logged out sees nothing
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://mind.fritter.lol/mcp   # 404 (closed by Caddy)
docker compose logs --tail 50 app | grep -iE 'error|failed'      # expect nothing
docker compose ps                                                # app and runner both running
```

The rankings should list eight minds: the seven legacy systems (BASTION,
MERIDIAN, KESTREL-7, LOOPBACK, SEXTANT, REDLINE, SABRE-9) and WARDEN. The
other eleven bots boot on their own first scheduled wakes over the next
few hours.

## Report back

- The output of steps 0–9, or where you stopped and why.
- The commit the box is on now.
- Whether step 3 ran or was skipped.
- Anything that differed from what this task expected.
- For John: the first real epoch is live and ends 40 days from step 4; he
  boots his own mind at https://mind.fritter.lol/play as `john` (his test
  mind went with test epoch 1); if step 3 ran, the `admin` password is in
  `/root/mind-admin-password.txt`, and `/admin/bots` shows the runner.

## Later: everyday operation

- **Updating to a new commit:** as for the app, then rebuild both:
  `docker compose --profile runner up -d --build`. A rebuild keeps the
  epoch, the minds and the runner's settings (they're in the database).
- **Stopping the bots** (spending stops at once):
  `docker compose --profile runner stop runner`. Start again with
  `docker compose --profile runner start runner`. John can also pause one
  bot at `/admin/bots`.
- **What it spent today:** `docker compose exec -T runner npm run -s runner -- status`.
- **Never** put `runner.env`'s contents in a report, and never run the
  test suite on the box.
