// The guard that stands between a drill and an outage, exercised against the
// real script: it is the one part of the restore path that must behave the same
// whether it is a person typing or scripts/preview.sh calling.
//
// --dry-run stops before anything is decrypted or connected to, so these run
// with no daemon, no archive and no key.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DRILL = new URL("./restore-drill.sh", import.meta.url).pathname;

let work = "";
let compose = "";
let key = "";

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "drill-"));
  compose = join(work, "docker-compose.yml");
  key = join(work, "identity.age");
  await writeFile(compose, "name: shop\nservices:\n  postgres:\n    image: postgres:16-alpine\n");
  await writeFile(key, "AGE-SECRET-KEY-not-a-real-one\n");
  // A repo has one; the drill now names it to compose unconditionally, so the
  // argv these tests read is the argv a real run would produce.
  await writeFile(join(work, ".env"), "POSTGRES_PASSWORD=hunter2\n");
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

interface Options {
  readonly composeFile?: string;
  readonly env?: Record<string, string>;
  /** Whether to pass --key. False is how the .env path below gets exercised. */
  readonly key?: boolean;
}

async function drill(args: string[], options: Options = {}) {
  const named = options.key === false ? [] : ["--key", key];
  const run = Bun.spawn(["bash", DRILL, ...named, "--dry-run", ...args], {
    env: {
      ...process.env,
      // A repo of its own, so the script reads this fixture rather than the
      // checkout it happens to live in.
      REPO_DIR: work,
      COMPOSE_FILE: options.composeFile ?? compose,
      DB_NAME: "shop",
      DB_USER: "shop",
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  return { exitCode, out: `${stdout}${stderr}` };
}

async function fixture(name: string, contents: string): Promise<string> {
  const path = join(work, name);
  await writeFile(path, contents);
  return path;
}

describe("restoring over the deployed database", () => {
  test("is refused, because a drill is never one typo from an outage", async () => {
    const { exitCode, out } = await drill(["--target", "shop"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("refusing to restore over 'shop'");
  });

  // Postgres stores an unquoted identifier folded to lower case, so `SHOP` IS
  // the deployed database — and a guard that compared the two as bytes read
  // them as different ones, dropped it, restored over it and printed PASS.
  test("is refused when only its case differs, because Postgres folds it", async () => {
    const { exitCode, out } = await drill(["--target", "SHOP"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("refusing to restore over 'shop'");
  });

  // Anything the catalogue could not hold under that spelling. Refused rather
  // than folded: a drill that quietly renamed its target is a drill whose log
  // names a database nobody asked for.
  test("a target Postgres could not store under that name is refused", async () => {
    const { exitCode, out } = await drill(["--target", "Shop_X"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("invalid target database name: 'Shop_X'");
  });

  // `docker compose -p shop` with the name the compose file already declares is
  // the deployed stack under another spelling — and it used to be the way past
  // this guard, in the exact syntax the preview flow teaches.
  test.each(["--project", "--scratch-project"])(
    "is refused when the deployed stack is named as %s with a target",
    async (flag) => {
      const { exitCode, out } = await drill([flag, "shop", "--target", "shop"]);
      expect(exitCode).toBe(2);
      expect(out).toContain("is the deployed stack");
    },
  );

  // Naming it with no target used to land in the throwaway, which made the
  // deployed name a spelling the drill quietly accepted. There is nothing it
  // could mean now: --scratch-project would take production down with its
  // volumes once the drill passed, and --project would restore over it.
  test.each(["--project", "--scratch-project"])(
    "is refused when the deployed stack is named as %s with no target at all",
    async (flag) => {
      const { exitCode, out } = await drill([flag, "shop"]);
      expect(exitCode).toBe(2);
      expect(out).toContain("is the deployed stack");
    },
  );

  test("is allowed with CONFIRM=yes, which is the whole point of asking", async () => {
    const { exitCode } = await drill(["--target", "shop"], { env: { CONFIRM: "yes" } });
    expect(exitCode).toBe(0);
  });
});

describe("which stack is the deployed one", () => {
  // A `name:` under a volume or a network is that resource's name, not the
  // project's — but it is indented, and an unanchored read takes whichever
  // comes first. Reading this file as "elsewhere" makes `--project shop` look
  // like another stack, and lets the restore through onto production.
  test("is not the nested name: of a volume", async () => {
    const composeFile = await fixture(
      "nested.yml",
      "volumes:\n  pgdata:\n    name: elsewhere\nname: shop\nservices:\n  postgres:\n    image: postgres:16-alpine\n",
    );
    const { exitCode, out } = await drill(["--project", "shop", "--target", "shop"], {
      composeFile,
    });
    expect(exitCode).toBe(2);
    // Read as anything else, this name would fall to "not a lane of this repo"
    // instead — which is the whole discrimination.
    expect(out).toContain("'shop' is the deployed stack");
  });

  test("is never guessed: a compose file that names no project is an error", async () => {
    const composeFile = await fixture(
      "unnamed.yml",
      "services:\n  postgres:\n    image: postgres:16-alpine\n",
    );
    const { exitCode, out } = await drill(["--project", "shop-preview"], { composeFile });
    expect(exitCode).toBe(2);
    expect(out).toContain("declares no top-level 'name:'");
  });

  // COMPOSE_PROJECT_NAME outranks the file, so the stack this checked and the
  // stack `docker compose` would then talk to need not be the same one.
  test("is not decided behind the script's back by the environment", async () => {
    const { exitCode, out } = await drill([], { env: { COMPOSE_PROJECT_NAME: "somewhere-else" } });
    expect(exitCode).toBe(2);
    expect(out).toContain("COMPOSE_PROJECT_NAME is set");
  });
});

describe("reading the compose file", () => {
  // Compose reads these as one name; `=` does not, and `=` is what the refusal
  // compares — so a quoted or CRLF file made --project <deployed> look like
  // somewhere else, which is the whole guard.
  test("a quoted project name is the same name", async () => {
    const composeFile = await fixture(
      "quoted.yml",
      'name: "shop"\nservices:\n  postgres:\n    image: postgres:16-alpine\n',
    );
    const { exitCode, out } = await drill(["--project", "shop", "--target", "shop"], {
      composeFile,
    });
    expect(exitCode).toBe(2);
    // Read as anything else, this name would fall to "not a lane of this repo"
    // instead — which is the whole discrimination.
    expect(out).toContain("'shop' is the deployed stack");
  });

  test("a file with CRLF line endings is the same name", async () => {
    const composeFile = await fixture(
      "crlf.yml",
      "name: shop\r\nservices:\r\n  postgres:\r\n    image: postgres:16-alpine\r\n",
    );
    const { exitCode, out } = await drill(["--project", "shop", "--target", "shop"], {
      composeFile,
    });
    expect(exitCode).toBe(2);
    // Read as anything else, this name would fall to "not a lane of this repo"
    // instead — which is the whole discrimination.
    expect(out).toContain("'shop' is the deployed stack");
  });
});

describe("what .env is allowed to change", () => {
  // The guard compares the target against DB_NAME, and .env sets DB_NAME. Read
  // afterwards, as it was, the refusal passed on one name and the DROP ran
  // against another.
  test("a database named in .env is still the one the guard protects", async () => {
    const composeFile = await fixture(
      "envnamed.yml",
      "name: shop\nservices:\n  postgres:\n    image: postgres:16-alpine\n",
    );
    const home = await mkdtemp(join(tmpdir(), "drill-env-"));
    await writeFile(join(home, ".env"), "DB_NAME=the_real_production_db\n");
    const { exitCode, out } = await drill(["--target", "the_real_production_db"], {
      composeFile,
      env: { REPO_DIR: home, DB_NAME: "" },
    });
    expect(exitCode).toBe(2);
    expect(out).toContain("refusing to restore over 'the_real_production_db'");
  });

  // `. file` under `set -a` executes what it reads, and the one file certain to
  // hold awkward characters is the one holding the passwords.
  test("a value that would be code as bash is read as a value", async () => {
    const composeFile = await fixture(
      "safe.yml",
      "name: shop\nservices:\n  postgres:\n    image: postgres:16-alpine\n",
    );
    const home = await mkdtemp(join(tmpdir(), "drill-code-"));
    const canary = join(home, "executed");
    await writeFile(
      join(home, ".env"),
      `DB_NAME=shop\nPASSWORD=a b $(touch ${canary})\`touch ${canary}\`\n`,
    );
    const { exitCode } = await drill(["--project", "shop-preview"], {
      composeFile,
      env: { REPO_DIR: home, DB_NAME: "" },
    });
    expect(exitCode).toBe(0);
    expect(await Bun.file(canary).exists()).toBe(false);
  });
});

describe("restoring into another stack", () => {
  // Compose resolves a project by its label alone, so an unrelated product's
  // stack on the same daemon answers to `-p` just as readily as this one's.
  test("that belongs to another product is refused, not treated as elsewhere", async () => {
    const { exitCode, out } = await drill(["--project", "postpad"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("not a lane of this repo");
  });

  // The separator is the whole rule. On a bare prefix this name — another
  // product's stack that merely begins with ours — read as a lane of this repo,
  // and the drill would have restored production's dump into it.
  test("whose name merely begins with this one is refused", async () => {
    const { exitCode, out } = await drill(["--project", "shopanalytics"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("not a lane of this repo");
  });

  test("fills that stack's own database, which is a throwaway", async () => {
    const { exitCode, out } = await drill(["--project", "shop-preview"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("into 'shop'");
  });

  test("without a project, the drill stays beside the deployed database", async () => {
    const { exitCode, out } = await drill([]);
    expect(exitCode).toBe(0);
    expect(out).toContain("into 'shop_restore_drill'");
  });
});

describe("who owns the stack", () => {
  // One question, so two answers is not a configuration — and the wrong
  // implementation is the tolerant one, where the last flag wins and the run
  // does something nobody asked for to a stack somebody is looking at.
  test.each([
    ["--project", "--scratch-project"],
    ["--scratch-project", "--project"],
  ])("is refused when %s and %s are both named", async (first, second) => {
    const { exitCode, out } = await drill([first, "shop-preview", second, "shop-drill"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("name one, not both");
  });

  // Whatever the drill would do to the stack, it has to be a lane of this repo:
  // compose resolves a project by its label alone, so another product's answers
  // to either flag just as readily.
  test.each(["--project", "--scratch-project"])(
    "%s still has to name a lane of this repo",
    async (flag) => {
      const { exitCode, out } = await drill([flag, "postpad"]);
      expect(exitCode).toBe(2);
      expect(out).toContain("not a lane of this repo");
    },
  );

  test("a scratch lane restores into that stack's own database", async () => {
    const { exitCode, out } = await drill(["--scratch-project", "shop-drill"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("into 'shop' (lane)");
  });
});

describe("where the identity comes from", () => {
  test("a run with neither --key nor BACKUP_AGE_KEY is refused, not defaulted", async () => {
    const { exitCode, out } = await drill([], { env: { BACKUP_AGE_KEY: "" }, key: false });
    expect(exitCode).toBe(2);
    expect(out).toContain("no age identity");
  });

  test("BACKUP_AGE_KEY out of .env is the identity when no flag names one", async () => {
    const home = await mkdtemp(join(tmpdir(), "drill-key-"));
    await writeFile(join(home, ".env"), `DB_NAME=shop\nBACKUP_AGE_KEY=${key}\n`);
    const { exitCode, out } = await drill([], {
      env: { REPO_DIR: home, DB_NAME: "", BACKUP_AGE_KEY: "" },
      key: false,
    });
    expect(exitCode).toBe(0);
    expect(out).toContain("into 'shop_restore_drill'");
  });
});

// Everything above stops at --dry-run. What the drill does to a database is
// only reachable past that point, so these run the whole script with the
// daemon, the decryptor and the dump replaced by scripts of this file's own.
// What they read is the argv the drill would have handed docker.
describe("a drill that runs", () => {
  let bin = "";
  let archive = "";

  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), "drill-bin-"));
    archive = join(work, "backup.sql.gz.age");
    // A few KiB, so a free-space figure that clears the archive and not the
    // multiplier can be written in the whole kibibytes df reports.
    await writeFile(archive, "-- a dump\n".repeat(500));
    // Records every invocation and answers the three questions the drill asks
    // of the database — is it up, how much room is left, how many tables came
    // back — then swallows the dump being piped at it, so the decrypt upstream
    // is not killed by a closed pipe.
    await writeFile(
      join(bin, "docker"),
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
        'case "$*" in',
        '  *pg_isready*) exit "${FAKE_DB_DOWN:-0}" ;;',
        '  *" df "*)',
        '    if [ -n "${FAKE_DF_FAILS:-}" ]; then echo "docker: cannot connect" >&2; exit 1; fi',
        '    printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/sda1 100 1 %s 1%% /\\n" "${FAKE_FREE_KB:-1048576}"',
        "    ;;",
        // psql's own exit for a statement that failed under ON_ERROR_STOP.
        // FAKE_GATE holds the restore open: the drill announces that it has
        // arrived, then waits to be let go, which is how a second drill can be
        // started while the first is provably mid-load and holding the lock.
        "  *ON_ERROR_STOP*)",
        "    cat > /dev/null",
        '    if [ -n "${FAKE_GATE:-}" ]; then',
        '      : > "$FAKE_GATE.reached"',
        '      while [ ! -f "$FAKE_GATE" ]; do sleep 0.02; done',
        "    fi",
        '    exit "${FAKE_RESTORE_FAILS:-0}"',
        "    ;;",
        '  *-tAc*) echo "${FAKE_TABLES:-9}" ;;',
        "  *) cat > /dev/null ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await writeFile(join(bin, "age"), '#!/usr/bin/env bash\nexec cat "${@: -1}"\n', {
      mode: 0o755,
    });
    await writeFile(join(bin, "gunzip"), "#!/usr/bin/env bash\nexec cat\n", { mode: 0o755 });
    // A bucket, as much of one as the two calls the drill makes can tell apart:
    // FAKE_BUCKET holds `key<TAB>LastModified` lines, list-objects-v2 filters
    // them by --prefix and answers with the newest, and `s3 cp` writes a dump
    // where it was asked to. Filtering and sorting are the API's own job, and a
    // fake that did neither would pass a drill that asked for neither.
    await writeFile(
      join(bin, "aws"),
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$FAKE_AWS_LOG"',
        'case "$1 $2" in',
        '  "s3api list-objects-v2")',
        "    prefix=''",
        "    while [ $# -gt 0 ]; do",
        '      if [ "$1" = --prefix ]; then prefix="$2"; fi',
        "      shift",
        "    done",
        "    key=''; modified=''",
        '    while IFS="$(printf "\\t")" read -r k m; do',
        '      [ -n "$k" ] || continue',
        '      case "$k" in "$prefix"*) ;; *) continue ;; esac',
        '      if [ -z "$key" ] || [[ "$m" > "$modified" ]]; then key="$k"; modified="$m"; fi',
        '    done <<< "${FAKE_BUCKET:-}"',
        '    if [ -z "$key" ]; then echo None; else printf "%s\\t%s\\n" "$key" "$modified"; fi',
        "    ;;",
        '  "s3 cp") printf -- "-- a dump\\n%.0s" {1..500} > "$4" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // Records both halves separately, because which half the token arrives in
    // is the whole point: argv is what `ps` shows another user, and the config
    // curl reads on stdin is what it does not.
    await writeFile(
      join(bin, "curl"),
      [
        "#!/usr/bin/env bash",
        'printf "argv %s\\n" "$*" >> "$FAKE_CURL_LOG"',
        'while IFS= read -r line; do printf "config %s\\n" "$line" >> "$FAKE_CURL_LOG"; done',
        'exit "${FAKE_CURL_FAILS:-0}"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  afterAll(async () => {
    await rm(bin, { recursive: true, force: true });
  });

  /** Lines of a fake's log, or none where it was never called at all. */
  async function logged(path: string): Promise<string[]> {
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    return (await file.text()).split("\n").filter((line) => line !== "");
  }

  /**
   * The whole script, against the fakes. No --archive: the tests that let the
   * drill choose one for itself pass none, and `run` below is every other test.
   */
  /** A drill left running, for the tests that need two of them at once. */
  async function startDrill(args: string[], env: Record<string, string> = {}) {
    const logs = await mkdtemp(join(tmpdir(), "drill-log-"));
    const docker = join(logs, "docker.log");
    const proc = Bun.spawn(["bash", DRILL, "--key", key, ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        DOCKER: join(bin, "docker"),
        FAKE_DOCKER_LOG: docker,
        FAKE_AWS_LOG: join(logs, "aws.log"),
        FAKE_CURL_LOG: join(logs, "curl.log"),
        REPO_DIR: work,
        COMPOSE_FILE: compose,
        DB_NAME: "shop",
        DB_USER: "shop",
        BACKUP_R2_BUCKET: "archives",
        BACKUP_R2_ENDPOINT: "https://r2.example.invalid",
        // Set, and deliberately not where the lock goes: a drill that read
        // its lock home from here would be one the timer could never see.
        XDG_RUNTIME_DIR: logs,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { proc, logs, docker };
  }

  /**
   * Waits for a started drill and reads back everything it asked of the world.
   * Pass `said` when a reader has already taken the drill's stdout: a stream
   * read from cannot then be handed to Response, so whoever started reading it
   * owns it to the end.
   */
  async function collect(started: Awaited<ReturnType<typeof startDrill>>, said?: string) {
    const { proc, logs, docker } = started;
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      said === undefined ? new Response(proc.stdout).text() : Promise.resolve(said),
      new Response(proc.stderr).text(),
    ]);
    const issued = await logged(docker);
    const asked = await logged(join(logs, "aws.log"));
    return {
      exitCode,
      out: `${stdout}${stderr}`,
      issued,
      asked,
      drops: issued.filter((line) => line.includes("DROP DATABASE")),
      teardowns: issued.filter((line) => line.includes(" down -v")),
      ups: issued.filter((line) => line.includes(" up -d")),
      fetched: asked.flatMap((line) =>
        line.startsWith("s3 cp ") ? [line.split(" ")[2] ?? ""] : [],
      ),
      pinged: await logged(join(logs, "curl.log")),
    };
  }

  async function runDrill(args: string[], env: Record<string, string> = {}) {
    return await collect(await startDrill(args, env));
  }

  async function run(args: string[], env: Record<string, string> = {}) {
    return await runDrill(["--archive", archive, ...args], env);
  }

  describe("what it leaves behind", () => {
    // Twice: the drill recreates the target on the way in, and this is the one
    // on the way out. Without it a weekly timer leaves a second full copy of
    // production beside production until the next run.
    test("the throwaway it chose for itself is dropped again", async () => {
      const { exitCode, out, drops } = await run([]);
      expect(exitCode).toBe(0);
      expect(out).toContain("dropping 'shop_restore_drill'");
      expect(
        drops.filter((line) => line.includes('DROP DATABASE IF EXISTS "shop_restore_drill";')),
      ).toHaveLength(2);
    });

    // The whole difference between a database this script picked and one a
    // person named. Nothing about a passing drill makes somebody else's copy
    // disposable.
    test("a database named with --target is kept, however the drill went", async () => {
      const { exitCode, out, drops } = await run(["--target", "keep_this_copy"]);
      expect(exitCode).toBe(0);
      expect(out).toContain("PASS");
      expect(out).not.toContain("dropping");
      expect(drops).toHaveLength(1);
    });

    // The stack being filled IS the point of --project, for scripts/preview.sh.
    // The next run's leading DROP is what reclaims it, which is also what
    // reclaims a copy TimeoutStartSec killed halfway.
    test("another stack's database is left filled", async () => {
      const { exitCode, out, drops } = await run(["--project", "shop-preview"]);
      expect(exitCode).toBe(0);
      expect(out).not.toContain("dropping");
      expect(drops).toHaveLength(1);
      expect(drops.join("\n")).toContain('DROP DATABASE IF EXISTS "shop";');
    });

    // The one target that is production. CONFIRM=yes is a way to restore over
    // it, never a way to delete it.
    test("the deployed database is never dropped afterwards", async () => {
      const { exitCode, out, drops } = await run(["--target", "shop"], { CONFIRM: "yes" });
      expect(exitCode).toBe(0);
      expect(out).not.toContain("dropping");
      expect(drops).toHaveLength(1);
    });

    // A drill that failed is the copy worth opening.
    test("a restore that fails the table floor is kept", async () => {
      const { exitCode, out, drops } = await run([], { FAKE_TABLES: "1" });
      expect(exitCode).toBe(1);
      expect(out).toContain("fewer than 4 tables");
      expect(drops).toHaveLength(1);
    });

    // The whole point of the timer's scratch lane: a full copy of production is
    // restored weekly and nothing the size of production is left on the disk.
    test("a scratch stack is taken down with its volumes", async () => {
      const { exitCode, out, teardowns } = await run(["--scratch-project", "shop-drill"], {
        FAKE_DB_DOWN: "1",
      });
      expect(exitCode).toBe(0);
      expect(out).toContain("taking 'shop-drill' down");
      expect(teardowns).toHaveLength(1);
    });

    // ...and it is the evidence when the drill failed.
    test("a failed drill leaves its scratch stack standing", async () => {
      const { exitCode, teardowns } = await run(["--scratch-project", "shop-drill"], {
        FAKE_DB_DOWN: "1",
        FAKE_TABLES: "1",
      });
      expect(exitCode).toBe(1);
      expect(teardowns).toEqual([]);
    });

    // The bug this flag pair was cut out of: ownership read off the stack's
    // state. A failed drill leaves its stack standing as the evidence, so the
    // next run found it answering, decided it was somebody else's and left it —
    // a full copy of production parked on the disk, and nothing to take it away
    // but a hand. Two runs, and the pass has to clear what the failure left.
    test("a scratch stack a failed run left standing is taken down by the next pass", async () => {
      const failed = await run(["--scratch-project", "shop-drill"], {
        FAKE_DB_DOWN: "1",
        FAKE_TABLES: "1",
      });
      expect(failed.exitCode).toBe(1);
      expect(failed.teardowns).toEqual([]);

      // Answering now, because the run above left it up.
      const passed = await run(["--scratch-project", "shop-drill"]);
      expect(passed.exitCode).toBe(0);
      expect(passed.teardowns).toHaveLength(1);
      expect(passed.teardowns.join("\n")).toContain("-p shop-drill");
    });

    // scripts/preview.sh started that one and is about to show it to somebody.
    // The wrong implementation is the one that asks whether this run started it
    // rather than which flag named it: a caller's stack that happened to be
    // down would be taken away underneath them.
    test("a --project stack is never taken down, however this run found it", async () => {
      const { exitCode, teardowns, issued } = await run(["--project", "shop-preview"]);
      expect(exitCode).toBe(0);
      expect(teardowns).toEqual([]);
      expect(issued.filter((line) => line.includes(" down "))).toEqual([]);
    });
  });

  describe("what it does with a dump that does not apply", () => {
    // psql's default is to report the error, carry on and exit 0, so a dump
    // that died a third of the way in restored enough tables to clear the floor
    // and printed PASS. ON_ERROR_STOP is what makes the pipeline's status real.
    test("a statement that errors fails the drill rather than passing it", async () => {
      const { exitCode, out } = await run([], { FAKE_RESTORE_FAILS: "3" });
      expect(exitCode).not.toBe(0);
      expect(out).not.toContain("PASS");
    });
  });

  describe("the stack it restores into", () => {
    // Nothing else starts the scratch project the timer names, and a restore
    // into production's own Postgres is what having a scratch project avoids.
    test("is brought up when --scratch-project names one that is down", async () => {
      const { exitCode, ups } = await run(["--scratch-project", "shop-drill"], {
        FAKE_DB_DOWN: "1",
      });
      expect(exitCode).toBe(0);
      expect(ups).toHaveLength(1);
      expect(ups.join("\n")).toContain("-p shop-drill");
    });

    // Owning a stack is not a reason to restart one that is already serving:
    // that is a scratch stack a failed run left behind, and the restore below
    // is what it is there for.
    test("is left as it stands when a scratch stack is already answering", async () => {
      const { exitCode, ups } = await run(["--scratch-project", "shop-drill"]);
      expect(exitCode).toBe(0);
      expect(ups).toEqual([]);
    });

    // scripts/preview.sh brings its own stack up before it calls this, and a
    // second `up` over a running one is a way to restart what somebody is
    // already looking at.
    test("is left alone when it is already answering", async () => {
      const { exitCode, ups } = await run(["--project", "shop-preview"]);
      expect(exitCode).toBe(0);
      expect(ups).toEqual([]);
    });

    // --project is a stack the caller holds. Starting one on their behalf is
    // how the drill ends up owning something it was told it does not own, and
    // the honest answer is that they have not brought it up yet.
    test("is refused rather than started when --project names one that is down", async () => {
      const { exitCode, out, ups } = await run(["--project", "shop-preview"], {
        FAKE_DB_DOWN: "1",
      });
      expect(exitCode).toBe(1);
      expect(out).toContain("is not answering");
      expect(ups).toEqual([]);
    });

    // A floor, not an estimate — but a restore that cannot possibly fit is worth
    // an hour of psql to nobody.
    test("is measured before the restore, and refused when the archive cannot fit", async () => {
      const { exitCode, out, drops } = await run([], { FAKE_FREE_KB: "0" });
      expect(exitCode).toBe(1);
      expect(out).toContain("the restore cannot finish");
      // Nothing was touched: the refusal is before the DROP that clears the way.
      expect(drops).toEqual([]);
    });

    // What a gzipped dump needs once Postgres has written it out, rather than
    // what the file weighs: room for the archive alone is not room to restore
    // into, and comparing the compressed size passed a disk that had no chance.
    test("asks for several times the archive, not the archive", async () => {
      const bytes = (await Bun.file(archive).stat()).size;
      const { exitCode, out } = await run([], { FAKE_FREE_KB: String(Math.ceil(bytes / 1024)) });
      expect(exitCode).toBe(1);
      expect(out).toContain("the restore cannot finish");
    });

    test("is refused rather than guessed at when the free space cannot be read", async () => {
      const { exitCode, out } = await run([], { FAKE_FREE_KB: "who knows" });
      expect(exitCode).toBe(1);
      expect(out).toContain("could not read the free space");
    });

    // `set -e` kills the script on a failing command substitution, so the
    // diagnostic below it was written for a line that could never be reached:
    // the drill died with docker's own message and nothing of its own.
    test("says so in its own words when the question cannot be asked at all", async () => {
      const { exitCode, out } = await run([], { FAKE_DF_FAILS: "1" });
      expect(exitCode).toBe(1);
      expect(out).toContain("could not ask");
    });
  });

  // With no --archive the drill picks one, and both halves of that choice are
  // load-bearing: WHICH object, out of a bucket that holds more than this
  // stack's, and HOW OLD it is allowed to be. A month-old dump restores
  // perfectly, clears the table floor and prints PASS.
  describe("the archive it chooses for itself", () => {
    /** An object written `hours` ago, in the shape the API reports it. */
    function written(hours: number): string {
      return new Date(Date.now() - hours * 3_600_000).toISOString();
    }

    /** `key<TAB>LastModified` lines, which is as much of a bucket as the fake holds. */
    function bucket(...objects: [string, number][]): string {
      return objects.map(([object, hours]) => `${object}\t${written(hours)}`).join("\n");
    }

    // The bucket is shared. Reading the newest object in the whole of it — which
    // is what a listing without a prefix returns — restores whichever product
    // was backed up last, and a foreign dump has no tables of ours at all.
    test("is the newest under this stack's own prefix, not the newest in the bucket", async () => {
      const { exitCode, out, fetched, asked } = await runDrill([], {
        FAKE_BUCKET: bucket(
          ["other-product/other-20260822.sql.gz.age", 1],
          ["shop/shop-20260821.sql.gz.age", 5],
        ),
      });
      expect(exitCode).toBe(0);
      expect(out).toContain("PASS");
      expect(fetched).toEqual(["s3://archives/shop/shop-20260821.sql.gz.age"]);
      // Asked of the bucket, not filtered afterwards: a listing of everything is
      // a listing this drill has no business receiving.
      expect(asked.join("\n")).toContain("--prefix shop/");
    });

    // The failure this bound exists for: backups stopped weeks ago, the drill
    // restored the last one that was ever taken, and printed PASS every Sunday
    // since.
    test("is refused when the newest one is older than the age bound", async () => {
      const { exitCode, out, fetched } = await runDrill([], {
        FAKE_BUCKET: bucket(["shop/shop-last-month.sql.gz.age", 40]),
      });
      expect(exitCode).toBe(1);
      expect(out).toContain("the backups have stopped");
      expect(out).not.toContain("PASS");
      expect(fetched).toEqual([]);
    });

    test("the bound is what BACKUP_MAX_AGE_HOURS says", async () => {
      const { exitCode, out } = await runDrill([], {
        FAKE_BUCKET: bucket(["shop/shop-last-month.sql.gz.age", 40]),
        BACKUP_MAX_AGE_HOURS: "72",
      });
      expect(exitCode).toBe(0);
      expect(out).toContain("PASS");
    });

    // The other end of the prefix: a bucket with plenty in it and nothing of
    // ours reads as a full bucket to anything that does not filter.
    test("a prefix nothing has been written under is an error, not a pull", async () => {
      const { exitCode, out, fetched } = await runDrill([], {
        FAKE_BUCKET: bucket(["other-product/other-20260822.sql.gz.age", 1]),
      });
      expect(exitCode).toBe(1);
      expect(out).toContain("has never been backed up");
      expect(fetched).toEqual([]);
    });

    // An endpoint answering in a shape this box cannot read is an age nobody
    // knows, and a drill that guessed would be back to restoring stale dumps.
    test("a timestamp that cannot be read stops the drill rather than being guessed at", async () => {
      const { exitCode, out, fetched } = await runDrill([], {
        FAKE_BUCKET: "shop/shop-odd.sql.gz.age\twhenever",
      });
      expect(exitCode).toBe(1);
      expect(out).toContain("could not read when");
      expect(fetched).toEqual([]);
    });
  });

  describe("two drills at once", () => {
    /** Where the lock actually goes: beside the checkout, for every caller. */
    function lockPath(stack: string): string {
      return join(work, `.restore-drill.${stack}.lock`);
    }

    /**
     * Another drill, as far as this one can tell: a process holding the lock
     * and doing nothing else. It blocks on stdin rather than on a timer, so
     * closing the pipe ends it at once and nothing outlives the test.
     */
    function holdLock(stack: string) {
      return Bun.spawn(["flock", lockPath(stack), "-c", "echo held; cat"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
    }

    /**
     * A drill's stdout, read as it is written. Waiting on the drill's own words
     * rather than on a clock is what makes the overlap below a fact instead of
     * a hope — a poll would be a race that passes against broken code.
     */
    function listen(started: Awaited<ReturnType<typeof startDrill>>) {
      const reader = started.proc.stdout.getReader();
      const decoder = new TextDecoder();
      let said = "";
      async function step(): Promise<boolean> {
        const { value, done } = await reader.read();
        if (!done) said += decoder.decode(value, { stream: true });
        return !done;
      }
      return {
        async until(needle: string): Promise<string> {
          while (!said.includes(needle) && (await step())) continue;
          return said;
        },
        async rest(): Promise<string> {
          while (await step()) continue;
          reader.releaseLock();
          return said;
        },
      };
    }

    /** Waits until the lock is actually held; a race here passes on broken code. */
    async function held(holder: ReturnType<typeof holdLock>): Promise<void> {
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
      reader.releaseLock();
    }

    async function release(holder: ReturnType<typeof holdLock>): Promise<void> {
      await holder.stdin.end();
      await holder.exited;
    }

    // Both would DROP and recreate the same database: the second one's DROP
    // lands while the first one's psql is still loading into it, and what the
    // first then counts is whatever survived. Refused, not queued — the caller
    // is a timer.
    test("the second is refused rather than dropping the database under the first", async () => {
      const holder = holdLock("shop-drill");
      try {
        await held(holder);
        const { exitCode, out } = await run(["--scratch-project", "shop-drill"]);
        expect(exitCode).toBe(1);
        expect(out).toContain("is being restored into right now");
      } finally {
        await release(holder);
      }
    });

    // The collision the lock exists for, and the only one it can ever win:
    // systemd refuses to run the drill's unit beside itself, so two drills mean
    // the timer's and somebody's. Those two run in different contexts, and a
    // lock kept in the runtime directory each context is given put them in two
    // disjoint files — both took a lock, both went on to DROP the database, and
    // the second one's DROP landed in the middle of the first one's load. Two
    // real drills here, the first held provably mid-restore.
    test("a drill in the timer's context and one in a shell see the same lock", async () => {
      const gate = join(await mkdtemp(join(tmpdir(), "drill-gate-")), "open");
      const unitRuntime = await mkdtemp(join(tmpdir(), "drill-rd-"));
      const shellRuntime = await mkdtemp(join(tmpdir(), "drill-xdg-"));

      // The timer's drill: a unit gets a RuntimeDirectory= of its own and no
      // XDG_RUNTIME_DIR at all.
      const timer = await startDrill(["--archive", archive, "--scratch-project", "shop-drill"], {
        FAKE_GATE: gate,
        RUNTIME_DIRECTORY: unitRuntime,
        XDG_RUNTIME_DIR: "",
      });
      const heard = listen(timer);
      try {
        // It says this on its way into the restore, and it has held the lock
        // since long before — so once this is out, the overlap below is real.
        expect(await heard.until("restoring")).toContain("restoring");

        // Somebody at a shell, into the same stack, while that load is open.
        const byHand = await run(["--scratch-project", "shop-drill"], {
          RUNTIME_DIRECTORY: "",
          XDG_RUNTIME_DIR: shellRuntime,
        });
        expect(byHand.exitCode).toBe(1);
        expect(byHand.out).toContain("is being restored into right now");
        // Nothing of the first drill's database was touched by the second.
        expect(byHand.drops).toEqual([]);
      } finally {
        await Bun.write(gate, "");
        const finished = await collect(timer, await heard.rest());
        expect(finished.exitCode).toBe(0);
        await Promise.all([
          rm(unitRuntime, { recursive: true, force: true }),
          rm(shellRuntime, { recursive: true, force: true }),
        ]);
      }
    });

    // Neither context has to provide anything. The drill that demanded a
    // private runtime directory refused to run at all under `sudo`, which
    // clears XDG_RUNTIME_DIR.
    test("needs no runtime directory of any kind, deciding or running", async () => {
      const bare = { RUNTIME_DIRECTORY: "", XDG_RUNTIME_DIR: "" };
      const decided = await runDrill(["--dry-run", "--scratch-project", "shop-drill"], bare);
      expect(decided.exitCode).toBe(0);

      const real = await run(["--scratch-project", "shop-drill"], bare);
      expect(real.exitCode).toBe(0);
      expect(real.out).toContain("PASS");
    });

    // Keyed on the stack, because that is what two of them would be fighting
    // over — a drill into the preview lane has nothing to do with one into the
    // scratch lane, and a single lock would make the timer and a person wait on
    // each other for no reason.
    test("a drill into another stack is not blocked by it", async () => {
      const holder = holdLock("shop-drill");
      try {
        await held(holder);
        const { exitCode, out } = await run(["--project", "shop-preview"]);
        expect(exitCode).toBe(0);
        expect(out).toContain("PASS");
      } finally {
        await release(holder);
      }
    });
  });

  // A heartbeat means THE SCHEDULED RUN happened, and this script is not the
  // thing that knows whether a run was scheduled: scripts/preview.sh --restore
  // calls it, and so does anybody rehearsing by hand. A heartbeat sent from in
  // here is one any of them forges, and the weekly drill can then be dead for a
  // month with the watchdog quiet the whole time. Reporting belongs to the
  // unit — ExecStartPost= for the success, OnFailure= for the failure — so this
  // script says nothing to anyone, ever.
  describe("what it tells the watchdog", () => {
    const watched = { HEARTBEAT_URL: "https://watch.example/api", HEARTBEAT_TOKEN: "s3cret" };

    test.each([
      ["the preview restore", ["--project", "shop-preview"]],
      ["a drill run by hand", []],
      ["the scratch drill the timer runs", ["--scratch-project", "shop-drill"]],
    ])("%s posts nothing, even with a watchdog configured", async (_which, args) => {
      const { exitCode, out, pinged } = await run(args, watched);
      expect(exitCode).toBe(0);
      expect(out).toContain("PASS");
      expect(pinged).toEqual([]);
    });

    test("nor does a drill that failed", async () => {
      const { exitCode, pinged } = await run([], { ...watched, FAKE_TABLES: "1" });
      expect(exitCode).toBe(1);
      expect(pinged).toEqual([]);
    });
  });

  // Compose resolves a relative .env against the working directory, and a
  // systemd unit's is `/`. Guarding on the file existing hands the missing case
  // straight back to that, so it is named every time and compose refuses one it
  // cannot find.
  describe("the environment it hands compose", () => {
    test("is always the repo's own .env, named outright", async () => {
      const { exitCode, issued } = await run(["--scratch-project", "shop-drill"]);
      expect(exitCode).toBe(0);
      expect(issued).not.toBeEmpty();
      for (const line of issued) expect(line).toContain(`--env-file ${work}/.env`);
    });
  });
});
