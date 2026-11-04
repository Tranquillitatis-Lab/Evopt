# Contribute an improvement

You can run optimization with your own agent and budget, then submit the result for review. The export contains the candidate text, paired outcomes, usage, and run provenance. The metadata template helps reviewers reproduce it; it is not itself an Evopt export.

1. Connect your agent and benchmark as described in the [main README](../README.md). Pick a USD ceiling you authorize and, optionally, a token ceiling. Run `doctor` and `preflight` before starting.
2. Run `evopt run --config <config>`, then `evopt validate --config <config>`. All configured lanes must finish search before validation; validation closes search for that run. Use a fresh output directory for another search.
3. Create `external-pr/<your-change>/` and copy [submission.template.json](submission.template.json) there as `submission.json`. Export each validated lane separately, for example:

   ```sh
   node dist/bin/evopt.js export --config <config> --lane <lane> --out external-pr/<your-change>/result.json
   node dist/bin/evopt.js verify --file external-pr/<your-change>/result.json
   ```

4. Fill in `submission.json`, including the agent and dataset versions, task partition method, settings, actual budget, results, limitations, and commands needed to reproduce the run. Copy result numbers from the export. Include a shareable, redacted configuration as `run-config.json`, provide the adapter and scorer or links to their source, and calculate SHA-256 hashes for the configuration and export. For example:

   ```sh
   node -e "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))" external-pr/<your-change>/result.json
   ```

5. Review all submitted files for credentials and private data and confirm redistribution is permitted. The export is integrity checked; editing its contents breaks verification. If it contains material you cannot share, do not submit it. Open a pull request with the metadata, export, configuration and reproduction notes; disclose evidence that reviewers cannot access.

The offline example exercises the workflow but is synthetic and cannot demonstrate a benchmark improvement. `verify` checks consistency, not authenticity. Reviewers should independently reproduce claims.

## Build on an accepted result

To explore a reviewed candidate, copy its `genome` object from `result.json` into the `seeds` array in a lane file. Use matching declared mutable components and respect that lane's constraints. Run a new search and held-out validation with your agent and budget, using test tasks that have not been used to select the seed or guide further changes. A previous result does not guarantee improvement for a different agent or dataset.
