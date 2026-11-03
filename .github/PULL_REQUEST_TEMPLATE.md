## Change

Describe the bounded configuration improvement or library fix and the behavior it changes.

## Evidence

For an optimization contribution, include the reviewed file under `contributions/` and its validation command/output. State baseline and candidate accuracy, task count, regressions, accounted USD cost, and whether the evidence is synthetic or an identity control. For a library fix, describe relevant verification.

## Reproduction

Link the shareable experiment definition and preparation instructions. Pin agent, proposer, model, dataset, and scorer versions. Explain any private dependencies or limits on independent reproduction. Identify the starting baseline and any previous accepted evidence.

## Review

- [ ] I reviewed shared text, identifiers, metadata, and evidence for private data and redistribution rights.
- [ ] The run's budget was explicitly authorized, billing is settled, and no paid operation was omitted from accounting.
- [ ] The held-out test partition did not influence candidate selection; follow-up tuning will use a fresh holdout.
- [ ] The requested promotion is a human review decision; this contribution does not automatically change production configuration.

Mark experiment-only items as not applicable for ordinary code or documentation changes.
