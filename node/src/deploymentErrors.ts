/** Shared error identity without importing either runtime agent/resolver. */
export class DeploymentResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentResolverError";
  }
}
