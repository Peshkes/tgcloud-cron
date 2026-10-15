/**
 * `/run` executes a module from the module space sent with the request, not
 * from the deployed state. Tools add their own modules to that space for one
 * call; they are never deployed. Only modules under a runnable directory
 * (`handlers/`, `endpoints/`) can be the entry point.
 */
export function withModules(
  modules: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  for (const name of Object.keys(extra)) {
    if (name in modules) {
      throw new Error(`the project has its own module "${name}"; this name is reserved, rename it`);
    }
  }
  return { ...modules, ...extra };
}
