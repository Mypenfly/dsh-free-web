# Mounting dsh-free-web

Three things must be true for the built-in `web_search` / `web_fetch` to use this plugin:

1. the plugin row is mounted (so its providers exist);
2. the `web` row's `searchProvider` names the id the plugin registers;
3. nothing else claims that id.

The package ships both halves as an installable **bundle**, so a normal install is one
dependency and one selection — no hand-edited patch rows.

## 1. Install the bundle (recommended)

The profile holds the package as a dependency and selects it as a bundle layer. For a
local checkout, `link:` keeps the profile on your working copy:

```bash
dsh plugin --profile desktop add link:/home/mypenfly/projects/dsh-plugins/free-web
```

then list it in `dsh.profile.bundles` in `~/.dsh/profiles/desktop/package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-free-web"]
    }
  },
  "dependencies": {
    "dsh-free-web": "link:/home/mypenfly/projects/dsh-plugins/free-web"
  }
}
```

The same two facts come from the GUI: **Plugins → Add plugin** with the directory path,
then **Enable now**. The bundle shows up in Installed plugins with its title, description,
and icon (from `locale/*.json` and `assets/icon.png`), and its switch turns the whole thing
on or off.

`cordis.patch.yml` in this package is the bundle patch — it is applied as a profile layer
after `@deepseek-ai/dsh-base`, and it carries the two entries a manual mount would:

```yaml
- insert:
    - id: free-web
      name: dsh-free-web          # bare package name: the profile resolves it
      config:
        engines: [duckduckgo, yahoojp, so360, sogou, wikipedia]
- id: web
  config:
    searchProvider: free-search
    fetchProvider: free-fetch
```

Edit the bundle patch to change engines for every profile that installs it; override
`free-web` in a profile patch (or `dsh.patch`) to change one profile.

## 2. Manual mount (no bundle)

If you would rather not install the package — a `--patch` overlay, a profile that keeps
plugins as file paths, an agent preset — point the row at the module and re-point the seam
(`mount.patch.yml` in this repo is exactly this):

```yaml
- insert:
    - id: free-web
      name: /home/mypenfly/projects/dsh-plugins/free-web/src/index.mjs
      config:
        engines: [duckduckgo, yahoojp, so360, sogou, wikipedia]
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
- With `name:` as a path, point it at an absolute path; a relative path resolves against
  the profile directory, not your checkout. A row installed this way is invisible to the
  Plugins page, which only manages packages.

## 3. Environment alternative

No patch edit at all, if you would rather select by environment:

```bash
DSH_WEB_SEARCH_PROVIDER=free-search DSH_WEB_FETCH_PROVIDER=free-fetch dsh web
```

The plugin row still has to exist somewhere (the bundle, a `--patch` overlay, or an agent
preset); the variables only pick which registered provider the seam uses. They are read
once, at service construction.

## 4. Verify the mount

Boot a headless run with `verbose: true` in the row config (or read the desktop log). On
mount you will see, on stderr:

```
free-web: search provider "free-search" registered with engines [yahoojp, so360, sogou, wikipedia]
free-web: fetch provider "free-fetch" registered (reader-mode extraction)
```

If those two lines are missing, the row did not mount — check for
`patch: entry "free-web" not found` in the boot log, or a bundle that is installed but not
selected.

If the lines appear but a search still bills, the seam selected something else. Inspect the
composed tree rather than guessing (a profile the desktop app owns can only be dumped by
that app; use a copy for the check):

```bash
dsh --profile <copy-of-desktop> --dump-config | grep -A4 '^- id: web$'
```

The printed `searchProvider` must be `free-search`. If it says `deepseek-official`, a later
`- id: web` patch or the Web-search settings page is overriding you — the settings scope
writes the same two fields.

## 5. Prove it in one call

With the desktop app running, ask the agent something that needs a search. A free result
carries the provider's provenance line as the summary:

```
Engines: yahoojp 10 · sogou 10 · skipped: duckduckgo unavailable
```

That line is the plugin's own text; the paid provider never emits it. A `web_fetch` result
comes back as readable Markdown (headings and code fences), not the raw page.

## 6. Rollback

Switch **dsh-free-web** off in **Plugins**, or delete `dsh-free-web` from
`dsh.profile.bundles`. The row unmounts with it and the seam falls back to
`searchProvider: deepseek-official` / `fetchProvider: http` from `@deepseek-ai/dsh-base`.

For a manual mount, delete the two entries from step 2.

Keep a dated copy before editing either one:

```bash
cp ~/.dsh/profiles/desktop/cordis.patch.yml ~/.dsh/profiles/desktop/cordis.patch.yml.bak-free-web-$(date +%Y%m%d-%H%M%S)
```

## 7. Unmount without losing the engines

The plugin is safe to leave mounted with the seam pointed elsewhere: unselected providers
cost nothing (selection is by id at call time). To silence the mount entirely but keep the
package installed, either switch the bundle off, or disable only the row:

```yaml
- id: free-web
  disabled: true
```

## 8. Networking (proxies, DNS, encodings)

The plugin brings its own HTTP client on Node core, so it does not inherit the host's undici
dispatcher. It reads the same environment variables instead, which means a proxy configured for
the host works here without extra configuration:

| variable | used for |
|---|---|
| `https_proxy` | `https:` destinations (CONNECT tunnel + TLS) |
| `http_proxy` | `http:` destinations (absolute-form request line) |
| `all_proxy` | fallback for both, when the scheme-specific one is unset |
| `no_proxy` | destinations that must go direct |

Lowercase wins over uppercase, as in curl. `no_proxy` entries may be `*`, an exact host, a
domain suffix (`.example.com` or `example.com`, which also covers subdomains), `host:port`,
a bracketed IPv6 literal, or an IPv4 CIDR block. A `socks*://` proxy variable is **not**
implemented: the request goes direct rather than pretending to use it.

What the transport does on its own:

- direct connections resolve the name once, refuse the request when any answer is non-public
  (`WEB_BLOCKED_URL`), and pin the verified addresses into the socket — no rebinding window;
- proxied fetches still run that public-destination check before opening the tunnel, even though
  the proxy resolves the name;
- `gzip`, `deflate` (zlib-wrapped and raw) and `br` bodies are decoded in-process, with the
  decoded size capped;
- one hop per call: the fetch provider validates origin and address on every redirect hop.

To see which path a request took, run the providers directly — a proxied run fails loudly with
`ECONNREFUSED`/`timed out` when the proxy is down, while a direct run works only for hosts in
`no_proxy`:

```bash
node scripts/smoke.mjs                     # live search + fetch, current environment
node --test "test/*.test.mjs"              # proxy rules, decoding, caps, cancellation, PIN
```

## 9. Changing the engine pool without editing a patch

`DSH_FREE_WEB_ENGINES` overrides the row's `config.engines`, which makes it the right lever
when an engine starts answering CAPTCHAs from this egress IP, or when a scripted run needs a
deterministic pool:

```bash
# comma or whitespace separated, case-insensitive, duplicates collapse
DSH_FREE_WEB_ENGINES=sogou,wikipedia dsh web
```

It is read at mount time, so the mount line in the log already shows the effective pool:

```
free-web: engine pool overridden by DSH_FREE_WEB_ENGINES=sogou,wikipedia
free-web: search provider "free-search" registered with engines [sogou, wikipedia]
```

Rules:

- unknown ids are warnings, not failures — the rest of the pool still mounts;
- a value that resolves to nothing usable falls back to the row config, so a typo costs a
  warning rather than the search tool;
- an empty or whitespace-only value is the same as not setting it.

The variable is a host-side escape hatch: it lives in the process environment, so it also
applies when the plugin runs inside the desktop app (start it from a shell with the variable
exported).
