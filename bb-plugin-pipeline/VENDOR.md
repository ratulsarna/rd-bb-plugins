# VENDOR

## Shared agent model settings

`vendor/ratulsarna-agent-models-0.4.0.tgz` is the standalone `@ratulsarna/agent-models` package. Its source lives in `agents/skills/pair-review/agent-models` in `ratulsarna/scratchpad-mbp16-m3max`. The package owns the file format, defaults, validation, and safe writes. Pipeline installs the checked-in archive through `package.json`; it has no runtime dependency on a scratchpad checkout. The general skill runs the same package's CLI directly.

To update it, change and test the source package, bump its version, run `npm pack --ignore-scripts --pack-destination <pipeline>/vendor` there, and install the archive in Pipeline with `npm install --save-exact ./vendor/<archive>.tgz --ignore-scripts`. Remove the old archive and commit the new archive, dependency, and lockfile together.
