<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# Notify

**BB notifications on macOS and iPhone Home Screen apps.**

![bb 0.39+](https://img.shields.io/badge/bb-0.39%2B-88C0D0?style=flat-square)
![macOS](https://img.shields.io/badge/platform-macOS-3FA266?style=flat-square)
![iOS 16.4+](https://img.shields.io/badge/iOS-16.4%2B-3FA266?style=flat-square)

</div>

Native macOS and iPhone notifications when a bb thread finishes or fails, plus
a `notify_user` tool for agents and a `bb notify` command for you or a script.

Both delivery methods use the same filters, formatting, dedupe, CLI, and agent
tool. Each subscribed phone receives its own encrypted Web Push. Click any
notification to open the thread it came from.

## Install

Install dependencies, build, then install the local path:

```sh
cd bb-plugin-notify
npm install
npm run build
bb plugin install .
```

The path install reads these files in place. Rebuild and reload after a change.

The desktop app asks for notification permission when it mounts. iPhone
permission is only requested after you tap **Enable** in the plugin settings.

## Requirements

- bb 0.39+.
- Desktop alerts need macOS, notification permission, and an open bb desktop
  window. The durable desktop queue waits up to 10 minutes for a window.
- iPhone alerts need iOS 16.4+, HTTPS, and BB added to the Home Screen. Open BB
  from the Home Screen before enabling notifications.
- The VPS must be able to make outbound HTTPS requests to each browser push
  endpoint.

## What fires a notification

| Source             | Trigger                               | Opens                                                     |
| ------------------ | ------------------------------------- | --------------------------------------------------------- |
| `thread.idle`      | A thread finished its final turn       | That thread                                               |
| `thread.failed`    | A thread errored                      | That thread                                               |
| `notify_user` tool | An agent decides you need to know now | The agent's thread                                        |
| `bb notify send`   | You or a script                       | The thread the command ran in — `--thread <id>` overrides |

A successful turn does not spend a line saying "finished". Only a failure earns
words, as `Failed — <error>`.

If a parent thread goes idle while delegated agents are still running, Notify
waits. It sends the completion notification after the last agent reports back
and the parent finishes its final turn.

## Commands

```sh
bb notify status                            # desktop, phones, and filters
bb notify test                              # post a sample notification
bb notify send "Build is green" --title CI
bb notify send "Ready" --thread thr_abc123  # open a thread other than this one
```

`send` takes `--flag value` or `--flag=value`, and `--` ends the flags. It
refuses a misspelled flag, and refuses a `--thread` value that is not a thread
id.

```console
$ bb notify status
window:     listening (1 polling)
phones:     0 subscribed
held:       0
on idle:    true
on failed:  true
children:   false
hidden:     false
min run:    0s
sound:      off
agent tool: disabled
```

## Agent tool

`notify_user` takes one parameter, `message`, and posts a notification titled
with the thread and tagged with the project. It is off by default. Turn it on
with:

```sh
bb plugin config notify set agentTool true
```

## Settings

`bb plugin config notify set <key> <value>` — changes apply live, no reload.

| Key                    | Default | Meaning                                                        |
| ---------------------- | ------- | -------------------------------------------------------------- |
| `notifyOnIdle`         | `true`  | Notify when a thread finishes                                  |
| `notifyOnFailed`       | `true`  | Notify when a thread fails                                     |
| `includeChildThreads`  | `false` | Include subagent threads                                       |
| `includeHiddenThreads` | `false` | Include hidden plugin worker threads                           |
| `minRunSeconds`        | `0`     | Skip threads that finished faster than this. Capped at 30 days |
| `sound`                | `off`   | `off`, `system default`, or a named macOS server tone          |
| `agentTool`            | `false` | Offer the `notify_user` tool to agents                         |

The defaults are the quiet ones: a notification arrives silently, and no agent
can interrupt you until you turn the tool on.

### iPhone Home Screen

1. Open BB in Safari on the iPhone.
2. Use **Share → Add to Home Screen**.
3. Open BB from its Home Screen icon.
4. Go to **Settings → Plugins → Notify** and tap **Enable**.
5. Tap **Test**.

The status shows whether this device is enabled and how many devices are
subscribed. **Disable** removes this phone from the VPS and unsubscribes it in
the browser. The plugin creates one VAPID key pair and keeps it in its private
plugin database. It keeps one row per phone and removes endpoints that return
404 or 410.

### Sound

| Choice             | Desktop                                              | iPhone        |
| ------------------ | ---------------------------------------------------- | ------------- |
| `off`              | silent                                               | silent        |
| `system default`   | system sound                                         | system sound  |
| `Ping`, `Glass`, … | named tone on a Mac server, otherwise system sound   | system sound  |

A named tone comes from the BB server. If the server is not a Mac, each device
uses its system sound instead.

## Behaviour worth knowing

- **Quiet by default.** Child threads (subagents) and hidden threads (plugin
  workers) are skipped. Two events about one thread inside 3 seconds collapse
  into the first. A turn you stopped with the stop button produces no
  notification.
- **Desktop alerts wait while bb is closed.** With no bb window open, a notification
  waits in a durable queue and appears when one opens. It survives plugin
  reloads and server restarts, and expires after 10 minutes.
- **Phones are independent.** Web Push sends the same formatted alert to every
  subscribed phone. One failed phone does not block another phone or desktop
  delivery.
- **Every completed turn can alert.** Notifications use a unique system tag, so
  a later turn from the same thread does not become a history-only replacement
  for an earlier macOS notification.
- **Markdown is flattened.** A notification body is plain text, so formatting is
  reduced to the words it decorated.

## Troubleshooting

**Nothing arrives.** Run `bb notify test`. If it reports `Held — no BB window is
open`, open a bb window. If it reports `Queued`, but no notification shows,
check **System Settings → Notifications → bb**.

**The iPhone Enable button is unavailable.** Open BB from its Home Screen icon,
not a Safari tab. The page must use HTTPS.

**The iPhone test fails.** Disable and enable the device again. If it still
fails, check that the VPS can reach the subscription endpoint over HTTPS.

**`bb notify` is not a command.** The command appears only after the plugin
installs and loads. Run `bb plugin list` to confirm that `notify` is there.

**Too many notifications.** Raise `minRunSeconds` to skip short turns, or set
`notifyOnIdle` to `false` to keep only the failures.

**The same notification shows twice.** Delivery is at least once. A window that
displays a notification and closes before it acknowledges the item can show that
item again after the 30-second lease expires.

## Develop from source

Install from source as shown under [Install](#install), then check a change
with:

```sh
npm run typecheck
npm test
npm run build
```

The test script needs Node 22.6+.

The desktop implementation and artwork started in Scott Sunarto's
[`notify`](https://github.com/smsunarto/bb-plugins/tree/main/plugins/notify)
plugin.
