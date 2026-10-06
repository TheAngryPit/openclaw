# Temporary navigation observation, not a product repair

Purpose: distinguish synthetic listener readiness/accepted connection/received headers from real WKWebView loading and foreground-scene state after run 37465872324 failed before receiving any HTTP request. The source owner is unchanged product 3c07fe17649715937b822ea0e1ed9cabd8c7c5ad.

The one-file test-only overlay adds two bounded arrays (32 events each), timestamps and final diagnostic output. It does not change selectors, test assertions, waits, timeouts, listener/client limits, response bytes, cancellation, ordering, product navigation or authority. No warmup, retry or new production seam is added. Source patch reviewed separately with isolated Codex Astra low P2, scoped-clean confidence 0.94; compilation/runtime remain unverified.

Workflow admission must pin original file, patch and result hashes, require exactly this dirty test path, retain applied/final patches and compare them, verify QA tooling remains clean, reverse only the same verified patch and require original-source hash and pristine checkout at cleanup. The initial canonical source hashes remain pre-overlay provenance; the instrumented target hash is separately recorded.

This run is explicitly instrumented. Observations can perturb timing; a pass does not prove the original timing or repair the original failure. Preserve the failed uninstrumented receipt and do not relabel historical c6 success or this instrumented output as exact unmodified 3c full qualification. Root independently inspects terminal outcomes, counts, source/patch hashes and cleanup before any qualified publication. No Claw queue for diagnostic admission alone.
