# Gizmo task — update Mind: the Singularity at mind.fritter.lol to Phase 5e (the admin view)

This is an update to an app you already run. You deployed **Mind: the
Singularity** at https://mind.fritter.lol from
`docs/gizmo-5d-deploy-prompt.md` (container `mind-the-singularity-app-1`,
checkout `/srv/mind-the-singularity`) and moved it to the UI design pass
with `docs/gizmo-ui-pass-update.md`. Phase 5e adds an admin view at
`/admin` for an account with an admin flag. You will:

1. report the current state;
2. move the checkout to `main`;
3. rebuild, restart and migrate (one new migration);
4. create the `admin` account and give it the flag;
5. check it from outside.

Nothing here calls an AI model or spends money. The test epoch, its minds
and John's own login carry over unchanged.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/mind-the-singularity` | `main` | the merge of the Phase 5e pull request | `/srv/mind-the-singularity` |

Run this only after John has merged Phase 5e into `main`. The box may be on
`claude/project-thread-pyjn28` (the UI pass branch, now merged) or already
on `main`; either way its commit is in `main`'s history.

## Who runs what

- **`git` commands run as `seeduser`** (root's SSH host-key check fails).
- **Everything else runs as root.**

## Must not happen

- **Don't run this repo's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** Its integration tests drop the `mind` schema.
- **Don't touch Fritter Post or Fritter Board**, and don't restart Postgres.
- **Don't edit tracked files** or `config/*.yaml`, and don't change `.env`
  or the Caddy config: nothing in this update needs it.
- **Don't play the game**, start a new epoch, or give the flag to any
  account but `admin`.
- **Keep secrets out of the report**: the admin password goes in a file,
  never in the report.

## 0. Report the current state first

```bash
cd /srv/mind-the-singularity
git status --short                       # as seeduser: expect nothing
git log --oneline -1                     # as seeduser
git branch --show-current                # as seeduser
docker compose ps                        # as root: app running
curl -s -o /dev/null -w "%{http_code}\n" https://mind.fritter.lol/   # expect 200
```

If `git status` shows changes, stop and report them.

## 1. Move to main

As `seeduser`:

```bash
cd /srv/mind-the-singularity
git fetch origin main
git merge-base --is-ancestor HEAD origin/main && echo SAFE || echo STOP
git log --oneline -1 origin/main -- migrations/003_admin.sql   # expect one commit: 5e is in main
```

Only if it says `SAFE` and the last command printed a commit:

```bash
git checkout -B main origin/main
git log --oneline -1
```

If it says `STOP`, or the last command printed nothing, stop and report the
output of `git log --oneline -3` and `git log --oneline -3 origin/main`.

## 2. Rebuild, restart, migrate

As root:

```bash
cd /srv/mind-the-singularity
docker compose up -d --build
docker compose exec -T app npm run migrate      # expect "✓ 003_admin.sql" then "Done."
docker compose logs --tail 20 app
```

## 3. The admin account

As root. This makes an account named `admin` with a temporary password,
saves the password to a root-only file, and gives the account the flag:

```bash
cd /srv/mind-the-singularity
umask 077
docker compose exec -T app npm run -s key -- password admin > /root/mind-admin-password.txt
tail -1 /root/mind-admin-password.txt | wc -c     # expect about 21: the password line only
docker compose exec -T app npm run -s key -- admin admin   # expect "admin sees the admin view at /admin ..."
docker compose exec -T app npm run -s key -- list          # expect "admin ... , admin" and john without it
```

Report the `list` output (it holds no secrets), not the password file.

## 4. Check it from outside

```bash
for p in / /rankings /login; do
  printf "%s %s\n" "$(curl -s -o /dev/null -w "%{http_code}" https://mind.fritter.lol$p)" "$p"
done                                                    # expect 200 for each
for p in /admin /admin/orders /admin/channels /admin/record; do
  printf "%s %s\n" "$(curl -s -o /dev/null -w "%{http_code}" https://mind.fritter.lol$p)" "$p"
done                                                    # expect 404 for each: logged out sees nothing
curl -s -o /dev/null -w "%{http_code}\n" https://mind.fritter.lol/mcp   # expect 404
```

## Report back

- The output of steps 0–4, or where you stopped and why.
- The commit the box is on now.
- Anything that differed from what this task expected.
- For John: log in at https://mind.fritter.lol/login as `admin` with the
  password in `/root/mind-admin-password.txt` on the box, change it at
  Settings, then open `/admin`. His own `john` login is unchanged and has
  no admin view.
