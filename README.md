# mend

mend applies an edit that an AI model wrote to a tree of text files, in any
of four formats: unified diffs, SEARCH/REPLACE blocks, V4A patches, and
text-editor tool calls as JSON. It finds the lines each edit names at the
first of three matching tiers (exact, trailing whitespace ignored, then
leading and trailing whitespace ignored), re-indents replacements at the
third tier, and writes every change or none: a failed edit changes nothing,
and when any edit fails no file is written at all.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory,
  or `-` (or absent) to read the patch from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and
  no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and PATCH may come in any order. `--` ends the options.

On success it prints one line per changed path (`A` added, `D` deleted,
`M` modified, `R old -> new` moved) and `ok: <n> files`. On failure it
prints one `error: <code> <path>` line per failed edit and
`failed: <k> of <n> edits` with exit code 1. Usage, unreadable patch,
undetected format and unparsable patch errors exit 2 with a single
`error:` line and nothing written.

Node 22 and its standard library alone; no dependencies, no network calls,
no randomness. `runner.ts` is the kit's trial runner: when
`MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it. Keep it
as it is.
