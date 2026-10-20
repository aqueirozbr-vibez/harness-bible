/*
 * The compose file read as text, for the suites that hold it to its rules (the observability profile, the workflow
 * engine). A YAML parser would be a dependency for two tests; the file's own indentation is enough to cut it into
 * its services.
 */

/** The compose file's services, each as its own block of text. Line endings must already be `\n`. */
export function servicesOf(text: string): ReadonlyMap<string, string> {
  const body = text.slice(text.indexOf("\nservices:\n") + "\nservices:\n".length, text.indexOf("\nnetworks:\n"));
  const out = new Map<string, string>();
  let name: string | null = null;
  for (const line of body.split("\n")) {
    const start = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (start !== null) {
      name = start[1] ?? null;
      if (name !== null) out.set(name, "");
    } else if (name !== null) {
      out.set(name, `${out.get(name) ?? ""}${line}\n`);
    }
  }
  return out;
}
