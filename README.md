# project-template

<!-- scaffold:template -->

A production-shaped starting point for the stack in `~/claude-shared/STACK.md`.
Create a repo from this template, then:

```sh
bun run setup
```

It asks for a name, a hostname and a shape — a single TanStack Start app, or Bun
workspaces with a standalone Elysia/Effect API and an optional worker — resolves
every dependency at today's versions under the seven-day release-age policy,
installs the git hooks, generates the first migration, installs the workflows
under `setup/` as the new repo's CI, reconciles the repo's labels to the two it
uses, and then deletes itself. What is left reads as a repo somebody
wrote by hand.

This repo's own CI is `.github/workflows/template.yml`: it scaffolds both shapes
and runs the scaffolded gate against each. It is what proves the scaffolder, and
it does not ship.

Everything below this line is the README the scaffolded project keeps.

---

<!-- scaffold:template -->

<One line: what this is.>

## Getting started

```sh
bun install
cp .env.example .env      # fill the password, the secret, and DATABASE_URL
bun run dev
```

`bun run check && bun test` is the local gate. CI runs it and then does what a
developer machine cannot: replays the migrations onto an empty Postgres, boots
the program that owns the database against the result, and ramps every route it
serves.
<!-- scaffold:single -->
It also mutates the domain files a branch changed, and fails on a mutant that
branch's own lines left undetected.
<!-- scaffold:single -->
`CLAUDE.md` documents the layout, the deploy, going live, and the framework
behaviour that costs a probe to rediscover.

## Worktrees and preview

`bun run dev` and `db:migrate` inside a linked git worktree derive their own
database and ports, and say so — after a `bun install`, which is all a new
worktree needs. They read the primary checkout's `.env` and never write to it;
the primary checkout is unchanged. Nothing else needs the derived world, so the
suite runs in a worktree with no Docker at all. `bun run worktree:clean` drops
the databases whose branch is gone.

`scripts/preview.sh` boots the real images on their own ports against their own
database — `--restore --key <age identity>` sources it from the latest backup,
which doubles as the restore drill. `scripts/preview-down.sh` removes it,
volumes included.

`scripts/preview-capacity.sh` ramps that stack and writes the number to
`capacity/`. It is the capacity measurement, as opposed to CI's: the images that
would ship, on the box that would run them. Take it before real users arrive and
again after a change to a hot path.

## Secrets

`.env` is gitignored and never leaves the box it runs on. `.env.example` is its
shape, checked in. `.env.enc` is the same file [age](https://age-encryption.org)-encrypted
to the owner's public key and **committed** — so the real configuration is
versioned alongside the code and survives losing the box, while the box itself
holds only what it needs to run.

```sh
# after editing .env
age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --armor -o .env.enc .env

# on a fresh box, with the private key available
age --decrypt --identity ~/.config/age/backup.key -o .env .env.enc
```

Generate the keypair once, off this machine: `age-keygen -o backup.key` writes the
private half and prints the public one. Both halves end up on the box — see
"Backups" below for why, and for what that does and does not buy.

`deploy.env` is not one of these: it holds the public origins a deployment
answers at, it is committed, and it is the only file the containers read them
from. A checkout's `.env` holds its own — see CLAUDE.md, "Deploy".

## Backups

`scripts/backup.sh` dumps Postgres, gzips, age-encrypts to that same public key
and uploads to Cloudflare R2 — one pipeline, so plaintext never touches the disk.

**What the encryption is and is not for.** The box holds the PRIVATE key too, at
`~/.config/age/backup.key`, mode `600` — the weekly restore drill below runs
unattended and cannot decrypt without it. So root on this host can read every
backup ever taken: encryption does not defend against a compromise of the
machine the data is already on. What it does defend against is everywhere the
archives go afterwards — R2 holds ciphertext, and whoever gets that bucket or
those credentials gets nothing. The owner's offline copy of the key is the other
half: it is what makes the archives readable after this box is gone, which is
the case backups exist for.

`scripts/restore-drill.sh` is what makes any of that a backup rather than a
hope. It pulls the newest archive under this stack's own prefix in the bucket
(or takes `--archive`), decrypts it with the private key `BACKUP_AGE_KEY` names,
restores into a throwaway database, fails if the result has implausibly few
tables, and drops the copy again once it has passed.

The prefix and the age bound are the two halves of "the right archive". A bucket
holds more than one stack's backups, so the drill reads only what
`scripts/backup.sh` wrote under `project-template/`; and an archive older than
`BACKUP_MAX_AGE_HOURS` (36 — nightly, plus a night's slack) fails the drill
outright, because a month-old dump restores perfectly and says nothing about the
nights nothing was written.

```sh
scripts/restore-drill.sh --dry-run   # decide everything, touch nothing
scripts/restore-drill.sh             # the real drill
```

The timer runs it as `--scratch-project project-template-drill`: a stack the
drill owns, brought up if it is down and taken down with `down -v` the moment
the drill passes. So a full copy of production is restored every week, in a
container and on a volume of its own rather than inside production's Postgres,
and none of it is anywhere afterwards. `--project` is the other answer, the one
`scripts/preview.sh` uses. What the two flags mean, why a failed drill leaves
its stack standing, and the four places a restore can land are all in the
script's own header — that is the single home for that rule.

One drill at a time per stack, refused rather than queued. The lock is a file
beside the checkout, `.restore-drill.<stack>.lock`, because that is the one path
a systemd unit, a `sudo` shell and a login shell all resolve alike — the runtime
directory each of those is given is private to it, and the collision worth
catching is precisely the one between the timer's drill and a drill run by hand.
Not `/tmp`: predictable name, mode 1777, and any local user could take the lock
first and stop the drill for good.

**When a job stops running.** Set `HEARTBEAT_URL` and `HEARTBEAT_TOKEN` in
`.env` and systemd reports both jobs through `scripts/notify.sh`:
`ExecStartPost=` POSTs `$HEARTBEAT_URL/heartbeat/<slug>` after a run that exited
0, and `OnFailure=` starts `project-template-notify-failure@<slug>`, which POSTs
`$HEARTBEAT_URL/failure/<slug>` carrying the failed unit's name as the body.
Both bear the token; both use the job's one slug, because the watchdog knows
only slugs a heartbeat has declared and 404s on the rest.

The reporting is in the units and not in the scripts on purpose. A heartbeat
means the **scheduled** run happened, and only systemd knows whether a run was
the scheduled one — a script that reported on itself would let
`scripts/preview.sh --restore`, or anybody rehearsing by hand, forge the weekly
drill's heartbeat and leave a dead timer looking healthy. Leave either variable
unset and all of it is a no-op. A ping that does not land is printed and
otherwise ignored — the job did its work, and the alert for a heartbeat that
never arrived is the same alert. It is bounded as well as ignored: an
unreachable watchdog that swallowed packets would otherwise hang `ExecStartPost=`
until the job's own `TimeoutStartSec` killed it, and systemd would then page for
a backup that had in fact succeeded.

Both jobs' `.timer` and `.service` are tracked here, and so is the notifier's
template, so the schedule is something a diff shows. Installing and enabling
them is the one step no repo can take for itself, and systemd's unit namespace
is the whole box, so they go in under this project's name:

```sh
for unit in backup restore-drill; do
  sudo cp "scripts/$unit.service" "/etc/systemd/system/project-template-$unit.service"
  sudo cp "scripts/$unit.timer" "/etc/systemd/system/project-template-$unit.timer"
done
# No timer of its own: the OnFailure= lines are the only thing that starts it.
sudo cp 'scripts/notify-failure@.service' \
  '/etc/systemd/system/project-template-notify-failure@.service'
sudo systemctl daemon-reload
sudo systemctl enable --now project-template-backup.timer project-template-restore-drill.timer
```

## Going live

`package.json` carries one field saying whether this repo is serving real
people:

```json
{ "lifecycle": "dev" }
```

Moving it to `"live"` is a deliberate commit, and it is the only thing to
remember: the repo contract derives the rest from that one word, and CI says so
by name until each is true. It only moves up — going back to `"dev"` is refused
unless the call site names `lifecycle-retire`. See CLAUDE.md, "Going live".

## Deploy

```sh
sudo docker compose build && sudo docker compose up -d
```

The app is built inside the image; `up -d` alone deploys nothing. Install
`infra/nginx/*.conf` into `/etc/nginx/sites-enabled/`, point the hostname at this
box in Cloudflare (proxied, Full (strict)), and put the origin certificate at the
paths that file names. Nothing here edits an environment file: `deploy.env`
already names what is served, and a checkout's `.env` is its own.
<!-- scaffold:monorepo -->

The API answers on `api.<hostname>`, so that name needs a record of its own and
the origin certificate has to cover both — the two names `deploy.env` carries.
<!-- scaffold:monorepo -->
