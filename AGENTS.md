# Shade dashboard repository guidance

For live Home Assistant work, load `james-ha-development` and current
agent-config access/gotchas documentation. The card deployment recipe is
[deploy-card](.claude/skills/deploy-card/SKILL.md). Commands execute on bee2;
credentials are retrieved in-process from its Secret Service. Repository edits
alone do not authorize a live deployment or HA restart.

## Workspaces and merge authority

OPM is the default review and merge pipeline when this repository is enrolled.
Keep the primary checkout read-only and use a separate owned branch/worktree
from fresh remote `main`. When OPM or its wrapper is unavailable and manual
preparation is authorized, verify, commit, push and open a PR. Do not activate
projects or create OPM issues without authorization. Retain the clean worktree
when the owner requests pending-review retention.

An agent may ask the owner to approve a particular direct merge outside OPM
for any reason, not only emergencies or pipeline outages. Present the exact
repository, PR URL/number, base and source branches, full head SHA, tests/checks
actually run and their results, and every skipped or unsatisfied OPM gate.
Disclose missing evidence and automatic on-merge effects, including releases.

Merge only after explicit informed approval for that exact repo/PR/head and
skipped gates. Recheck the head, mergeability and check results immediately
before acting and bind the merge to the approved head. A changed head requires
fresh approval. Record approval, merged head, tests and skipped gates in the PR.
Coordinate active OPM work without changing enabled/paused state without consent.

This grants no automatic bypass or blanket future authority and changes no
pipeline code, branch protection, independent-review or deployment/verification
gate. Implementation or push approval alone is not merge approval. Do not
report skipped checks as passing or infer deployment, issue closure, project
activation or live HA mutation authority from permission to merge. A task that
requests open PRs for review stops there.
