# Vendor provenance

- Upstream: https://github.com/yusuf8834/bb-sidebar
- Pinned commit: `06965576b414f970157c2b4ef759248e6fcdcd74` (v0.2.15, 2026-09-16)
- Imported: 2026-09-18, byte-for-byte except `.git/` and `.github/` (their CI
  targets their own repo). License and notices: see `LICENSE`,
  `THIRD_PARTY_NOTICES.md`.
- Why vendored, not forked: one repo (`rd-bb-plugins`) deploys the whole
  fleet, and we do not track upstream's release stream. The pinned import
  commit is the fork point; converting to a real fork later is mechanical.

# rd changes on top of upstream

Everything below is marked `rd patch` or `rd addition` in the source. Replay
each when re-vendoring a newer upstream.

1. `src/ThreadInbox.tsx` — the assistants fleet's project never reaches the
   shelves or the project picker. It renders as the Bots section instead.
2. `src/server.ts` (`loadPolicyThreads`) — the auto-settle policy skips
   assistants-project threads, so the scheduler never settles an assistant
   home thread or reclaims its runtime/terminals. Fails closed: a failed
   `projects.list` skips the whole pass rather than risk an assistant.
3. `src/server.test.ts` — the policy tests stub `projects.list` (empty).
4. `src/server.ts` (end of `plugin`) — calls `registerBots(bb)`.
5. `app.tsx` — the thread list mounts `src/bots/inbox-with-bots.tsx`
   (Bots section above the upstream list) instead of `ThreadInbox`.
6. `src/bots/` — the Bots section, ported from the inbox-sidebar plugin.
   Stateless RPCs (seeds, avatars, replacement thread, automations warning)
   run here against bb.sdk; subtitles and drag order are proxied by
   cross-plugin RPC to the `inbox-sidebar` plugin, which owns their tables.
7. `package.json` — added `@dnd-kit/*` (the Bots drag).

# Known gaps

- Realtime channels do not cross plugin boundaries: a subtitle or order edit
  made through the other sidebar reaches this plugin's clients on refocus,
  not instantly.
- The upstream settings panel can rename or remove any project, including
   `assistants`. Don't.
- `bb assistants subtitle` stays registered by the inbox-sidebar plugin.
