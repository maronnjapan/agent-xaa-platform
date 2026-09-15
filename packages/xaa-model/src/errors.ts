/**
 * A model the deployment named but did not finish describing.
 *
 * This is the one failure a model must not answer `null` to. `null` means "the model was
 * asked and gave nothing usable", and a run that never had a reachable model in the first
 * place would then look exactly like a run whose model went quiet — the operator would go
 * looking at the prompt for a missing key or an uninstalled command. So a configuration
 * that cannot produce a client is thrown at startup, before a port is open, and the local
 * runner turns it into one line naming the variable to set.
 */
export class ModelConfigurationError extends Error {}
