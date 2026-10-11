# Gizmo task — update Mind: the Singularity at mind.fritter.lol: research the bots can see

This is an update to an app you already run. You deployed **Mind: the
Singularity** at https://mind.fritter.lol (container
`mind-the-singularity-app-1`, checkout `/srv/mind-the-singularity`) and
last moved it with `docs/gizmo-admin-pass-update.md`. This update changes
what minds are told about their research (the brief shows research points
and paused programs; an order that finishes a program says so). You will:

1. report the current state;
2. move the checkout to the new `main`;
3. rebuild and restart the **app** container only;
4. check it from outside.

There is **no migration**, and no config change on the box (a new key in
the tracked `config/site.yaml` arrives with the code). Nothing here calls
an AI model or spends money. The game's state doesn't change: only the
text minds read does. The live epoch, its minds, the accounts and the
runner carry over unchanged.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/mind-the-singularity` | `main` | the merge of the research-visibility pull request | `/srv/mind-the-singularity` |

Run this only after John has merged that pull request into `main`. The box
should be on `main` at `3281016` or later.

## Who runs what

- **`git` commands run as `seeduser`** (root's SSH host-key check fails).
- **Everything else runs as root.**

## Must not happen

- **Don't run this repo's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** Its integration tests drop the `mind` schema.
- **Don't touch Fritter Post or Fritter Board**, and don't restart Postgres.
- **Don't stop, restart or rebuild the `runner` service**, and don't wake a
  bot by hand: the runner reads the brief from the app, so it picks the
  change up on its next wake, and a wake costs money.
- **Don't start, discard or change an epoch**, and don't run `migrate`
  (there is nothing to migrate).
- **Don't edit tracked files**, `config/*.yaml`, `.env`, `runner.env` or
  the Caddy config.
- **Keep secrets out of the report.**

## 0. Report the current state first

```bash
cd /srv/mind-the-singularity
git status --short                       # as seeduser: expect nothing
git log --oneline -1                     # as seeduser
git branch --show-current                # as seeduser: expect main
docker compose --profile runner ps       # as root: app and runner running
docker compose exec -T app npm run -s epoch -- show   # expect "Epoch 1 ..."
curl -s -o /dev/null -w "%{http_code}\n" https://mind.fritter.lol/   # expect 200
```

If `git status` shows changes, or the branch isn't `main`, stop and report.

## 1. Move to the new main

As `seeduser`:

```bash
cd /srv/mind-the-singularity
git fetch origin main
git merge-base --is-ancestor HEAD origin/main && echo SAFE || echo STOP
git log --oneline -1 origin/main -- docs/gizmo-research-update.md   # expect one commit: this task is in main
```

Only if it says `SAFE` and the last command printed a commit:

```bash
git merge --ff-only origin/main
git log --oneline -1
```

If it says `STOP`, or the last command printed nothing, stop and report the
output of `git log --oneline -3` and `git log --oneline -3 origin/main`.

## 2. Rebuild and restart the app

As root. `app` is named so the runner is left alone:

```bash
cd /srv/mind-the-singularity
docker compose up -d --build --no-deps app
docker compose logs --tail 20 app                # expect it listening, no errors
docker compose --profile runner ps               # app up (just restarted), runner up (not restarted)
docker compose exec -T app npm run -s epoch -- show   # the same epoch as in step 0
```

The site is down for the seconds the container takes to restart; that's
expected.

## 3. Check it from outside

```bash
for p in / /rankings /record /login; do
  printf "%s %s\n" "$(curl -s -o /dev/null -w "%{http_code}" https://mind.fritter.lol$p)" "$p"
done                                     # expect 200 for each
for p in /admin /admin/orders /admin/record /admin/wakes /admin/orders.csv /admin/record.json /admin/epoch.json /admin/wakes.json; do
  printf "%s %s\n" "$(curl -s -o /dev/null -w "%{http_code}" https://mind.fritter.lol$p)" "$p"
done                                     # expect 404 for each: logged out sees nothing
curl -s -o /dev/null -w "%{http_code}\n" https://mind.fritter.lol/mcp   # expect 404
```

## Report back

- The output of steps 0–3, or where you stopped and why.
- The commit the box is on now.
- Anything that differed from what this task expected.
- For John: every bot's next brief has the new research line.
