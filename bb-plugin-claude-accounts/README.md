# Claude Accounts

Switch Claude Code subscription accounts on selected BB machines from any browser signed into BB. The browser's device does not need to be registered as a machine.

Open **Claude Accounts** in the sidebar, choose your machines, and click **Switch account**. All connected machines with a usable Claude Code installation are selected initially. Each selected machine gets its own **Open Claude login** button and code field. Choose the intended account in Claude's browser page and paste its code into that machine's field.

The result shows the account email and the machine list shows its organization. Choose the same account in each browser login if you want all machines to match. If you choose the wrong account, start another login to correct it. Cancellation does not undo a completed sign-in.

Pause active Claude sessions before switching and resume them afterward. The plugin does not stop or restart sessions. Usage checks and automatic switching are outside its scope. A work account with paid extra usage enabled can keep spending until you switch away.

## How it works

BB's host RPC runs the installed `claude auth login --claudeai` on each target. Claude owns the OAuth exchange, token refresh, and credential storage. The plugin keeps pending login links in memory, sends submitted codes directly to Claude's stdin, and discards them. It neither copies OAuth credentials between machines nor stores login codes in plugin settings or logs.

Each machine permits one pending login. Logins expire after ten minutes and stop when the plugin or host worker shuts down. Reloading the browser keeps pending logins accessible. Reloading the plugin cancels pending logins. Offline machines and failed logins do not roll back successful switches elsewhere.

Targets must be registered and connected to BB. Linux, WSL, and macOS are supported; native Windows is excluded. A recent Claude Code with `auth login`, `auth status --json`, `--claudeai`, and the remote code-paste login flow is required. API-key and gateway overrides need to be removed before switching subscription accounts.

## Development

```sh
npm install --include=dev
npm run typecheck
npm test
npm run build
bb plugin install . --yes
```

The plugin uses SDK 0.4.107. If that SDK is not yet on npm, pack the matching BB checkout's `packages/plugin-sdk` and install its tarball locally with `npm install --include=dev --no-save --package-lock=false /path/to/get-bb-plugin-sdk-0.4.107.tgz`.

The backend exports typed RPC methods for listing machines, starting logins, submitting codes, and cancelling logins. Login codes belong in the plugin page, never in a chat message or CLI arguments.
