// A pragmatic .gitignore matcher — enough for real repos without a full git
// implementation. Supports comments, blank lines, negation (`!`), anchored patterns
// (a leading or embedded `/`), directory-only patterns (trailing `/`), and the
// `*` / `**` / `?` globs. Case-sensitive, posix paths. Nested .gitignore files and
// some edge cases of the spec are not modeled (documented in the README).

interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function toRegex(pattern: string): RegExp {
  let p = pattern.replace(/\/$/, "");
  const anchored = p.includes("/"); // a slash (other than trailing) anchors to the root
  if (p.startsWith("/")) p = p.slice(1);
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        out += ".*";
        i++;
        if (p[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") out += "[^/]";
    else if ("\\^$.|+()[]{}".includes(c)) out += "\\" + c;
    else out += c;
  }
  const prefix = anchored ? "^" : "(^|.*/)";
  return new RegExp(`${prefix}${out}(/.*)?$`);
}

export function compileIgnore(text: string): (relPath: string, isDir: boolean) => boolean {
  const rules: Rule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    const body = negate ? line.slice(1) : line;
    rules.push({ re: toRegex(body), negate, dirOnly: body.endsWith("/") });
  }
  return (relPath, isDir) => {
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(relPath)) ignored = !r.negate;
    }
    return ignored;
  };
}
