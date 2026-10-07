# Gizmo task — update Mind: the Singularity at mind.fritter.lol to the UI design pass

This is an update to an app you already run. You deployed **Mind: the
Singularity** at https://mind.fritter.lol from
`docs/gizmo-5d-deploy-prompt.md` (container `mind-the-singularity-app-1`,
checkout `/srv/mind-the-singularity`). John now wants to see a redesign of
its website before he merges it. You will:

1. report the current state;
2. move the checkout to the redesign's branch;
3. rebuild and restart the app;
4. check it from outside.

Nothing here calls an AI model or spends money. **No database change:** no
new migration, and the test epoch, its minds and John's session carry over.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/mind-the-singularity` | `claude/project-thread-pyjn28` | the commit adding this task | `/srv/mind-the-singularity` |

The box is on an older branch (`claude/phase-5d-social-pages-sn9dko`), whose
work is now merged into `main`. The new branch starts from that `main`, so
the box's current commit is in its history.

## Who runs what

- **`git` commands run as `seeduser`** (root's SSH host-key check fails).
- **Everything else runs as root.**

## Must not happen

The rules of the first deploy still hold:

- **Don't run this repo's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** Its integration tests drop the `mind` schema.
- **Don't touch Fritter Post or Fritter Board**, and don't restart Postgres.
- **Don't edit tracked files** or `config/*.yaml`, and don't change `.env`
  or the Caddy config: nothing in this update needs it.
- **Don't play the game** or start a new epoch.
- **Keep secrets out of the report.**

## 0. Report the current state first

```bash
cd /srv/mind-the-singularity
git status --short                       # as seeduser: expect nothing
git log --oneline -1                     # as seeduser
docker compose ps                        # as root: app running
curl -s -o /dev/null -w "%{http_code}\n" https://mind.fritter.lol/   # expect 200
```

If `git status` shows changes, stop and report them.

## 1. Move to the redesign's branch

As `seeduser`:

```bash
cd /srv/mind-the-singularity
git fetch origin claude/project-thread-pyjn28
git merge-base --is-ancestor HEAD origin/claude/project-thread-pyjn28 && echo SAFE || echo STOP
```

Only if it says `SAFE`:

```bash
git checkout -B claude/project-thread-pyjn28 origin/claude/project-thread-pyjn28
git log --oneline -1
```

If it says `STOP`, stop and report the output of `git log --oneline -3` and
`git log --oneline -3 origin/claude/project-thread-pyjn28`.

## 2. Rebuild and restart

As root:

```bash
cd /srv/mind-the-singularity
docker compose up -d --build
docker compose exec -T app npm run migrate      # expect "Done." with nothing applied
docker compose logs --tail 20 app
```

## 3. Check it from outside

```bash
for p in / /rules /rules/architectures /rules/agents /rankings /login; do
  printf "%s %s\n" "$(curl -s -o /dev/null -w "%{http_code}" https://mind.fritter.lol$p)" "$p"
done                                                    # expect 200 for each
curl -s https://mind.fritter.lol/rules | grep -c 'class="wheel"'   # expect 1
curl -s -o /dev/null -w "%{http_code}\n" https://mind.fritter.lol/mcp   # expect 404
```

## Report back

- The output of steps 0–3, or where you stopped and why.
- The commit the box is on now.
- Anything that differed from what this task expected.
- For John: the redesign is live at https://mind.fritter.lol; his login and
  mind are unchanged.

## Later: following the branch, then main

Fixes from John's review land on the same branch. To pick one up:

```bash
cd /srv/mind-the-singularity
git fetch origin claude/project-thread-pyjn28                     # as seeduser
git merge-base --is-ancestor HEAD origin/claude/project-thread-pyjn28 && echo SAFE || echo STOP
git pull --ff-only origin claude/project-thread-pyjn28            # as seeduser, only if SAFE
docker compose up -d --build                                       # as root
```

Once John merges it, move back to `main` the same way: fetch `main`, check
`SAFE` against `origin/main`, then `git checkout -B main origin/main` and
rebuild.
