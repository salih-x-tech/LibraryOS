# Controlled local acceptance blocklist — October 24, 2026

Scope: local recovery acceptance only. This is not evidence of complete production compromised-password or passphrase coverage. The user requested selection of a suitable public source.

## Source and license

- Repository: https://github.com/danielmiessler/SecLists
- Revision: `c5a0b8c794699aa351e1425be4a33b2b88a20d1b`
- File: `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt`
- Pinned source: https://github.com/danielmiessler/SecLists/blob/c5a0b8c794699aa351e1425be4a33b2b88a20d1b/Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt
- Source description: https://github.com/danielmiessler/SecLists/blob/c5a0b8c794699aa351e1425be4a33b2b88a20d1b/Passwords/Common-Credentials/README.md
- Repository MIT license: https://github.com/danielmiessler/SecLists/blob/c5a0b8c794699aa351e1425be4a33b2b88a20d1b/LICENSE

The upstream README describes the full Xato list as unique passwords ranked by commonness from an older ten-million username/password-pair dataset. Repository hosting/license is the source assertion available here; it does not independently establish the collection history or rights of every original contributor. The repository license and source README are retained alongside the ignored local artifact. No username/password-pair data or executable repository content was downloaded.

## Exact artifact review

Original bytes: 8,557,632; 999,999 nonempty entries. Original SHA-256: `424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51`.

Review found two entries containing control characters, which the application loader intentionally rejects. The local derivative excludes exactly those entries, preserves all other entry contents/order and writes UTF-8 with LF delimiters and a trailing newline. No case folding, trimming, synthetic password additions or truncation was performed on the artifact. The existing validator independently compares whole passwords case-insensitively.

Derived bytes: 8,557,611; 999,997 entries. Derived SHA-256: `c5c8a1149426096a4ee3af27916e5071d70dd0ebf6744ae7715294410b3d9b16`.

The original includes 10,908 entries of 15–128 characters, no entries longer than 128, and no entries containing an ASCII space. This establishes some coverage beyond the application's 15-character minimum, but no spaced-passphrase coverage and no guarantee of modern or exhaustive compromise coverage. This bounded list is accepted as a controlled local-test baseline only. Production acceptance requires a separate coverage/source review, including long and spaced passphrases.

The real `loadPasswordBlocklist` successfully loaded the exact derived artifact using the configured checksum and returned 999,997 entries. It is below the 16 MiB/one-million-entry limits. Only counts and hashes were printed; user candidate passwords were not transmitted anywhere.

## Local configuration and maintenance

Artifacts are under ignored `.local/blocklists/`; path, checksum and pinned source are configured in ignored `.env.local`. An independent random queue key was also generated locally without displaying it. Preserve that key while queued records depend on it; the existing deployment backup/key-retention gate remains open. No HTTP/UI/worker activation switches were enabled by this work.

Before another live-acceptance session, recheck the checksum and upstream source status. For continuing development, review at least every 90 days and before production release; do not auto-download or silently replace the list. Review license/source/coverage and exact artifact changes before updating the pinned digest. Restart initialized runtimes after a reviewed update.

Gmail app-password format validation failed at the preceding checkpoint; no SMTP connection or email send was attempted. Live acceptance still requires a corrected credential and actual controlled delivery/consumption evidence. Phase 4 remains untouched.
