# Reviewed optimization submissions

Submit one portable `<id>.json` produced by `npm run experiment -- export` along with a reproducible experiment definition or a reference to an existing pinned definition. Do not commit private run directories, credentials, raw traces, or private datasets.

Run `npm run experiment -- validate --file contributions/<id>.json` before opening a PR. Include its findings, the source revision and dataset version, and the exact reproduction command in the PR. Review all component text, identifiers, and receipt fields before export. A valid digest detects changes; it does not authenticate a contributor's claims.

Synthetic examples, identity controls, unsuccessful runs, and regressions must not be presented as demonstrated improvements. The validator reports promotion eligibility separately from package validity. A passing package still needs independent reproduction and maintainer review.

Accepted text is applied manually to a versioned experiment or application configuration. It is not installed into Evopt or anyone's production agent by submitting this directory. Start later tuning with new held-out cases; an opened test set is no longer a fresh holdout.
