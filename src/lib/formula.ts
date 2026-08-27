// A small, safe arithmetic evaluator for the Amount field's "=100*.1"
// spreadsheet-style formulas — +, -, *, /, parentheses, decimals, unary
// minus. Deliberately NOT eval()/Function(): even for trusted internal
// users, there's no reason to run arbitrary JS just to add two numbers.
// Returns null for anything that isn't a clean, fully-consumed expression
// (invalid syntax, trailing garbage, non-finite result) so callers can
// fall back to treating the input as a plain, non-formula value.
export function evaluateFormula(expr: string): number | null {
  const src = expr.trim();
  if (!src || !/^[-+*/().\d\s]+$/.test(src)) return null;

  let i = 0;
  const peek = () => src[i];
  const skipSpace = () => {
    while (peek() === " ") i++;
  };

  function parseExpr(): number {
    let value = parseTerm();
    for (;;) {
      skipSpace();
      if (peek() === "+") {
        i++;
        value += parseTerm();
      } else if (peek() === "-") {
        i++;
        value -= parseTerm();
      } else {
        return value;
      }
    }
  }

  function parseTerm(): number {
    let value = parseFactor();
    for (;;) {
      skipSpace();
      if (peek() === "*") {
        i++;
        value *= parseFactor();
      } else if (peek() === "/") {
        i++;
        value /= parseFactor();
      } else {
        return value;
      }
    }
  }

  function parseFactor(): number {
    skipSpace();
    if (peek() === "+") {
      i++;
      return parseFactor();
    }
    if (peek() === "-") {
      i++;
      return -parseFactor();
    }
    if (peek() === "(") {
      i++;
      const value = parseExpr();
      skipSpace();
      if (peek() !== ")") throw new Error("expected )");
      i++;
      return value;
    }
    const start = i;
    while (i < src.length && /[\d.]/.test(src[i])) i++;
    if (start === i) throw new Error("expected number");
    const num = Number(src.slice(start, i));
    if (!Number.isFinite(num)) throw new Error("bad number");
    return num;
  }

  try {
    skipSpace();
    const result = parseExpr();
    skipSpace();
    if (i !== src.length) return null; // trailing garbage — not a clean expression
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}
