# Mounting dsh-free-web

Three things must be true for the built-in `web_search` / `web_fetch` to use this plugin:

1. the plugin row is mounted (so its providers exist);
2. the `web` row's `searchProvider` names the id the plugin registers;
3. nothing else claims that id.

## 1. Profile patch (recommended)

Append to the profile patch that already carries your rows — for the desktop app that is
`~/.dsh/profiles/desktop/cordis.patch.yml` (file also works as a `--patch` overlay):

```yaml
# free-web: keyless search + reader-mode fetch behind the built-in web tools.
- insert:
    - id: free-web
      name: /home/mypenfly/projects/dsh-plugins/free-web/src/index.mjs
      config:
        engines: [duckduckgo, yahoojp, so360, sogou, wikipedia]
# `web` comes from @deepseek-ai/dsh-base and declares
#   searchProvider: deepseek-official, fetchProvider: http
# this patch re-points it. Same shape as the shipped settings page writes.
- id: web
  config:
    searchProvider: free-search
    fetchProvider: free-fetch
```

Notes:

- `insert:` is required for a *new* row; a patch entry that names an unknown `id` is
  skipped with `patch: entry "free-web" not found`.
- Your patch file already has a `- id: web` stanza? Merge the two `config` keys into it
  rather than adding a second entry — later entries win, and a silent duplicate is how a
  "why is it still billing me" hunt starts.
- Point `name:` at an absolute path. A relative path resolves against the profile
  directory, not your checkout.

## 2. Environment alternative

No patch edit at all, if you would rather select by environment:

```bash
DSH_WEB_SEARCH_PROVIDER=free-search DSH_WEB_FETCH_PROVIDER=free-fetch dsh web
```

The plugin row still has to exist somewhere (the desktop profile's `insert` block, a
`--patch` overlay, or an agent preset); the variables only pick which registered
provider the seam uses. They are read once, at service construction.

## 3. Verify the mount

Boot a headless run with `verbose: true` in the row config. On mount you will see, on stderr:

```
free-web: search provider "free-search" registered with engines [yahoojp, so360, sogou, wikipedia]
free-web: fetch provider "free-fetch" registered (reader-mode extraction)
```

If those two lines are missing, the row did not mount — check for
`patch: entry "free-web" not found` in the boot log.

If the lines appear but a search still bills, the seam selected something else. Inspect the
composed tree rather than guessing:

```bash
dsh --profile desktop --dump-config | grep -A4 '^- id: web$'
```

The printed `searchProvider` must be `free-search`. If it says `deepseek-official`, a later
`- id: web` patch or the Web-search settings page is overriding you — the settings scope
writes the same two fields.

## 4. Prove it in one call

With the desktop app running, ask the agent something that needs a search. A free result
carries the provider's provenance line as the summary:

```
Engines: yahoojp 9 · sogou 9 · wikipedia 5 · skipped: so360 unavailable
```

That line is the plugin's own text; the paid provider never emits it. A `web_fetch` result
comes back as readable Markdown (headings and code fences), not the raw page.

## 5. Rollback

Delete the two entries added in step 1 (the `insert:` block and the `web` override) and
reload. The seam falls back to `searchProvider: deepseek-official` / `fetchProvider: http`
from `@deepseek-ai/dsh-base`, and nothing else in the plugin loader changes.

Keep a dated copy of the patch before editing:

```bash
cp ~/.dsh/profiles/desktop/cordis.patch.yml ~/.dsh/profiles/desktop/cordis.patch.yml.bak-free-web-$(date +%Y%m%d-%H%M%S)
```

## 6. Unmount without losing the engines

The plugin is safe to leave mounted with the seam pointed elsewhere: unselected providers
cost nothing (selection is by id at call time). To silence the mount entirely, disable the
row instead of deleting it:

```yaml
- id: free-web
  disabled: true
```
