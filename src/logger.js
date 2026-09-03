/**
 * Actions logs on a public repository are world-readable.
 * `info`, `warn` and `error` must only ever receive aggregate, non-identifying
 * text. `detail` is for package names and app names and prints only in dry run.
 */
export function createLogger({ verbose = false, sink = console.log } = {}) {
  return {
    info: (message) => sink(message),
    warn: (message) => sink(`WARN: ${message}`),
    error: (message) => sink(`ERROR: ${message}`),
    detail: (message) => {
      if (verbose) sink(message);
    },
  };
}
