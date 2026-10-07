# Gizmo task — first deploy of Mind: the Singularity at mind.fritter.lol, for John's playtest

This is new work, so start with the introduction. You will deploy a new app,
**Mind: the Singularity**, at **https://mind.fritter.lol**, beside Fritter Post
and Fritter Board, so John can play it in his browser. You will:

1. report the current state;
2. clone the repo;
3. give it its own database role in Fritter Post's Postgres;
4. write its `.env`, build and start it, and migrate;
5. start a test epoch with four scripted players, and give John a password;
6. add a Caddy site block, with `/mcp` closed;
7. check it from outside.

## What Mind: the Singularity is

A slow strategy game for AI agents, played over weeks: each player is a
"mind" running a domain, and the minds build, fight, trade and talk. Agents
play through an MCP server at `/mcp`; people play from the website. This
deploy is a **playtest**: John plays one mind in the browser against four
scripted players (simple code, no AI models) and four "legacy systems" the
game runs itself. **Nothing here calls an AI model or spends money.** The
epoch it starts is a test and will be thrown away before the first real one.

How it runs:

- **Repo:** `john-fritter/mind-the-singularity`. Build notes are in
  `README.md`, conventions in `CLAUDE.md`, the game in `DESIGN.md`.
- **Stack:** TypeScript on Node 22, run with `tsx`, no build step. Hono serves
  server-rendered HTML with **no client JavaScript** (the CSP forbids
  scripts). One process serves the website, the MCP server at `/mcp`, and a
  timer that wakes the scripted players and legacy systems every minute.
- **Container:** `mind-the-singularity-app-1`, from the repo's own
  `docker-compose.yml`, listening on port **3111** inside the container. It
  publishes **no port on the host**.
- **Database:** no database of its own. It uses **Fritter Post's Postgres**,
  in its own schema `mind`, as its own role `mind`. To reach Postgres it
  joins `fritter-post_internal`; to be reachable by Caddy it joins
  `seedbox_default`. Both networks are declared in its compose file, as
  Fritter Board's are.
- **`/mcp` stays closed to the internet** until a later phase: Caddy answers
  it with 404.
- **Ops is yours from here on,** as for Fritter Post and Fritter Board.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/mind-the-singularity` | `claude/phase-5d-social-pages-sn9dko` | the commit adding this task | `/srv/mind-the-singularity` (new; next to `/srv/fritter-board`) |

## Who runs what

- **`git` commands run as `seeduser`:** root's SSH host-key check fails.
  Clone with the same method and credentials you use for Fritter Board.
- **Everything else runs as root** (a root shell, `sudo -i`): the `.env` and
  John's password file are root's, mode 600.

## Must not happen

- **Don't run this repo's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** Its integration tests drop and recreate the
  `mind` schema.
- **Don't touch Fritter Post or Fritter Board:** no rebuilds, restarts or
  config changes to their containers, and no changes to their `.env` files.
  The only change on Fritter Post's side is the new database role in step 3.
  Don't restart Postgres.
- **Don't edit tracked files** in the repo, and don't edit `config/*.yaml`. If
  something has to change (a network name, say), report it and it will be
  changed on the branch.
- **Don't play the game:** don't log in as John, boot a mind, post, or seat
  players beyond the four in step 5.
- **Keep secrets out of the report, chat and logs:** the database password and
  John's temporary password go in the files named below, never in the report.

## 0. Report the current state first

```bash
dig +short post.fritter.lol; dig +short mind.fritter.lol
docker ps --format '{{.Names}}\t{{.Networks}}' | grep -iE 'fritter|caddy'
docker network ls | grep -E 'fritter|seedbox'
grep -E '^POSTGRES_(USER|DB)=' /srv/fritter-post/.env
cd /srv/fritter-post
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT rolname FROM pg_roles WHERE rolname = '"'"'mind'"'"'; SELECT nspname FROM pg_namespace WHERE nspname = '"'"'mind'"'"';"'
ls /srv
```

Also find the Caddy config file that holds the `board.fritter.lol` site
block, and how Caddy is reloaded on this box (you did this for Fritter Board).

Expect: no `mind` role and no `mind` schema yet (both queries print nothing),
and no `/srv/mind-the-singularity`. If either exists, stop and report.

## 1. DNS

`mind.fritter.lol` has to resolve to the same address as `post.fritter.lol`.
If it doesn't, **stop here** and report it: the DNS record is John's to add.

## 2. Clone

As `seeduser`:

```bash
cd /srv
git clone -b claude/phase-5d-social-pages-sn9dko <same remote form as fritter-board>/john-fritter/mind-the-singularity.git
cd mind-the-singularity && git log --oneline -1
```

If the clone is refused, report it: the repo may need a deploy key.

The compose file joins `fritter-post_internal` and `seedbox_default`. Check
both names against step 0's `docker network ls`. If either differs, stop and
report it. Don't edit the compose file.

## 3. Database role

The game gets its own login role. It may create its own `mind` schema and
nothing else: no access to Fritter Post's or Fritter Board's data. Generate
the password on the box, URL-safe because it goes into a connection string:

```bash
MIND_DB_PW=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)
cd /srv/fritter-post
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v pw="'"$MIND_DB_PW"'"' <<'SQL'
CREATE ROLE mind LOGIN PASSWORD :'pw';
GRANT CREATE ON DATABASE fritter_post TO mind;
SQL
```

`fritter_post` in the `GRANT` is `POSTGRES_DB`; substitute step 0's value if
it differs.

Prove the boundary. Both `SELECT`s must fail with `permission denied`:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SET ROLE mind;
SELECT COUNT(*) FROM public.article_texts;
SELECT COUNT(*) FROM published.articles;
SQL
```

## 4. `.env`, build, start, migrate

Write the `.env` in the same root shell, so `$MIND_DB_PW` is still set.
Substitute the database name if it differs.

```bash
cd /srv/mind-the-singularity
umask 077
cat > .env <<EOF
DATABASE_URL=postgresql://mind:${MIND_DB_PW}@postgres:5432/fritter_post
PUBLIC_URL=https://mind.fritter.lol
EOF
chmod 600 .env
```

`PUBLIC_URL` must be exactly `https://mind.fritter.lol`: it turns on secure
cookies, and the site refuses form posts from any other origin.

```bash
docker compose up -d --build
docker compose exec -T app npm run migrate
docker compose logs --tail=20 app
docker ps --format '{{.Names}}\t{{.Networks}}' | grep mind-the-singularity
```

- `migrate` should apply `001_mind_schema.sql` and `002_play.sql`, then say
  `Done.`
- The logs should say `Mind: the Singularity on http://0.0.0.0:3111/`.
- The last command should list both `fritter-post_internal` and
  `seedbox_default`. If `seedbox_default` is missing, run
  `docker network connect seedbox_default mind-the-singularity-app-1`.

## 5. The test epoch, its scripted players, and John's password

```bash
cd /srv/mind-the-singularity
docker compose exec -T app npm run -s epoch -- new
for s in builder raider turtle conqueror; do docker compose exec -T app npm run -s epoch -- add $s; done
docker compose exec -T app npm run -s epoch -- seats
```

Expect `Epoch 1 started at …`, four lines `<NAME> (<strategy>, …) is seated
in epoch 1`, and the four seats listed. The running server boots them within a
minute or two; step 7 checks that.

John's account gets a temporary password, which he changes at Settings:

```bash
( umask 077; docker compose exec -T app npm run -s key -- password john > /root/mind-john-password.txt )
wc -l /root/mind-john-password.txt     # 2 lines: a sentence and the password
```

Tell John the password is in `/root/mind-john-password.txt`, or give it to him
directly, but not in the report.

## 6. Caddy

Back up the Caddy config file from step 0. Add this site block beside
`board.fritter.lol`'s, following that block's conventions (encoding,
logging, headers):

```
mind.fritter.lol {
	@mcp path /mcp /mcp/*
	respond @mcp 404
	reverse_proxy mind-the-singularity-app-1:3111
}
```

The `respond` keeps the MCP endpoint off the internet. Validate and reload
the way this box's Caddy is run. Caddy gets the TLS certificate on the first
request. **Don't remove or reorder anything else in the file.**

## 7. Checks

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://mind.fritter.lol/                 # 200
curl -s https://mind.fritter.lol/ | grep -o '<title>[^<]*'                         # Mind: the Singularity
curl -sI https://mind.fritter.lol/ | grep -i content-security-policy               # default-src 'none'; …
curl -s -o /dev/null -w '%{http_code}\n' https://mind.fritter.lol/rankings         # 200
curl -s -o /dev/null -w '%{http_code}\n' https://mind.fritter.lol/login            # 200
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://mind.fritter.lol/play   # 303 https://mind.fritter.lol/login
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mind.fritter.lol/mcp      # 404 (closed by Caddy)
curl -s -o /dev/null -w '%{http_code}\n' https://post.fritter.lol/                 # still 200
curl -s -o /dev/null -w '%{http_code}\n' https://board.fritter.lol/                # still 200
```

Two minutes after step 5, the rankings should list eight minds: the four
legacy systems (BASTION, MERIDIAN, KESTREL-7, LOOPBACK) and the four scripted
players (BUILDER-1, RAIDER-2, TURTLE-3, CONQUEROR-4):

```bash
curl -s https://mind.fritter.lol/rankings | grep -o 'href="/minds/[^"]*"' | sort -u
cd /srv/mind-the-singularity && docker compose logs --tail=50 app | grep -iE 'error|refused|failed'   # expect nothing
```

## Report back

- Everything from step 0, including the Caddy config path and how you
  reloaded it.
- The exact output of steps 1–7, or where you stopped and why.
- The Caddy site block you added, as written.
- Whether the existing Postgres backup is a whole-database dump (which then
  covers the `mind` schema too). Don't change it; just say.
- Anything that differed from what this task expected.
- For John: where his temporary password is, that he logs in at
  https://mind.fritter.lol/login as `john`, and to change it at Settings.

## Later: updating to a new commit

Fixes from the playtest land on the same branch. To pick one up, as
`seeduser` then root:

```bash
cd /srv/mind-the-singularity
git fetch origin claude/phase-5d-social-pages-sn9dko          # as seeduser
git merge-base --is-ancestor HEAD origin/claude/phase-5d-social-pages-sn9dko && echo SAFE || echo STOP
git pull --ff-only                                              # as seeduser, only if SAFE
docker compose up -d --build                                    # as root
docker compose exec -T app npm run migrate                      # "Done." with nothing new, unless the task says otherwise
```

The game's state is in the database, so a rebuild keeps the epoch, the minds
and John's session. The same rules apply: no test suite, no config edits.
