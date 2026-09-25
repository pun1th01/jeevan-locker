/** Values the global setup hands to every test worker via `project.provide` / `inject`. */
declare module 'vitest' {
  export interface ProvidedContext {
    chain: {
      rpcUrl: string;
      documentRegistryAddress: string;
      auditAnchorAddress: string;
      /** Funded Hardhat account keys; index 0 deployed the contracts, index N belongs to worker N. */
      accountKeys: string[];
    };
    /** Base URI of the run's one mongod, e.g. mongodb://127.0.0.1:51234/ — each file appends its own database. */
    mongoBaseUri: string;
  }
}

export {};
