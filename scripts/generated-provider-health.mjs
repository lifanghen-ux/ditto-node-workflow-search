/** Infrastructure failures remain failures even when generated code catches a Worker result. */
export function createProviderHealth(currentContext) {
  const failures = new WeakMap();
  let accountFailure;
  return {
    record(error) {
      const context = currentContext();
      if (context && !failures.has(context)) failures.set(context, error);
      if (/HTTP (?:401|402|403)|insufficient.*(?:balance|quota)|authentication|unauthorized/i.test(String(error?.message ?? error)))
        accountFailure ??= error;
    },
    failure(context = currentContext()) { return context && failures.get(context); },
    assert(context = currentContext()) {
      const error = this.failure(context);
      if (error) throw error;
    },
    admit() { if (accountFailure) throw accountFailure; this.assert(); },
  };
}
