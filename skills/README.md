# Agent instructions

This directory contains distribution files for Strata users. They are included in packaged builds under `resources/skills/` on Linux and `Contents/Resources/skills/` on macOS. Editing or building the repository does not update anyone's installed skills or global instructions.

## Collaboration on an open document

[stratamd/SKILL.md](stratamd/SKILL.md) explains document attachment, deliveries, and actions. [stratamd/COMPONENTS.md](stratamd/COMPONENTS.md) supplies rendering examples. Keep both files together.

`stratamd setup --skill agents` installs or refreshes this directory under `~/.agents/skills/stratamd/`. Other supported targets are `claude`, `codex`, or a directory path. This is an explicit installation operation; if the target is a symlink, setup updates its destination. It can replace personal changes, so compare them before running it against a customized installation.

## Material for owner review

[plan-for-review/SKILL.md](plan-for-review/SKILL.md) is optional. Copy the `plan-for-review/` directory into your canonical skill directory using your agent environment's installation rules. The Strata setup command installs only the collaboration skill.

## Global rendering notice

[GLOBAL_INSTRUCTIONS.md](GLOBAL_INSTRUCTIONS.md) is an optional block to append to global `AGENTS.md` or `CLAUDE.md`. It describes rendering capabilities; skill descriptions own invocation rules. Installation never edits global instructions automatically.

## Keep personal skills independent

On a system with a shared canonical skill directory, keep active skills under `~/.agents/skills/`. Let harnesses that discover it use it directly. For harnesses that need their own directory, use directory symlinks to the canonical skill. For example, `~/.claude/skills/stratamd` can point to `~/.agents/skills/stratamd`.

Repository distribution files remain regular, independent copies. Do not link or automatically synchronize them with a personal installation. Personal instructions may intentionally differ from the distributed defaults. Explicit installation is the point at which a user chooses to update their copy.
