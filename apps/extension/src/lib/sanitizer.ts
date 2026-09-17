/**
 * DOM snapshot sanitizer. A captured DOM snapshot is a machine-oriented record
 * of the page's structure — never a security-sensitive dump. Before a snapshot
 * is persisted it is made INERT (no executable content) and stripped of secrets
 * (password/OTP/CSRF/auth values). The rules below are pure and unit-tested;
 * `sanitizeDom` applies them to a cloned subtree in the content script.
 */

/** Tags removed entirely — they carry executable or non-representational content. */
export const STRIPPED_TAGS = ["script", "noscript", "template", "iframe", "object", "embed"] as const;

/** Attribute name prefixes removed from every element (event handlers). */
export const STRIPPED_ATTR_PREFIXES = ["on"] as const;

/** Exact attributes removed from every element. */
export const STRIPPED_ATTRS = ["srcdoc", "formaction", "ping"] as const;

/** Input types whose value is always cleared. */
export const SENSITIVE_INPUT_TYPES = ["password", "hidden"] as const;

/**
 * Name/autocomplete tokens that mark a field as a secret whose value must be
 * cleared regardless of input type.
 */
const SENSITIVE_NAME_TOKENS = [
  "password",
  "passwd",
  "otp",
  "one-time",
  "mfa",
  "2fa",
  "totp",
  "csrf",
  "xsrf",
  "authenticity",
  "token",
  "secret",
  "apikey",
  "api-key",
  "session",
  "cvv",
  "cvc",
  "cardnumber",
  "card-number",
];

/** PURE: should this field's value be cleared before persistence? */
export function shouldClearInputValue(input: {
  type?: string | null;
  name?: string | null;
  id?: string | null;
  autocomplete?: string | null;
}): boolean {
  const type = (input.type ?? "").toLowerCase();
  if ((SENSITIVE_INPUT_TYPES as ReadonlyArray<string>).includes(type)) return true;
  const hay = `${input.name ?? ""} ${input.id ?? ""} ${input.autocomplete ?? ""}`.toLowerCase();
  return SENSITIVE_NAME_TOKENS.some((t) => hay.includes(t));
}

/** PURE: is this attribute stripped from every element? */
export function isStrippedAttr(attrName: string): boolean {
  const n = attrName.toLowerCase();
  if ((STRIPPED_ATTRS as ReadonlyArray<string>).includes(n)) return true;
  return STRIPPED_ATTR_PREFIXES.some((p) => n.startsWith(p));
}

/** PURE: is this tag removed entirely? */
export function isStrippedTag(tagName: string): boolean {
  return (STRIPPED_TAGS as ReadonlyArray<string>).includes(tagName.toLowerCase());
}

/**
 * Apply the rules to a cloned DOM subtree, in place. Only used in the content
 * script (needs a real DOM). Returns a bounded count of what it changed.
 */
export function sanitizeDom(root: Element | Document): {
  removedNodes: number;
  clearedValues: number;
  strippedAttrs: number;
} {
  const doc = (root as Document).documentElement ? (root as Document) : (root as Element).ownerDocument!;
  let removedNodes = 0;
  let clearedValues = 0;
  let strippedAttrs = 0;

  const scope: ParentNode = (root as Document).documentElement ?? (root as Element);

  // 1. Remove executable / non-representational elements.
  for (const tag of STRIPPED_TAGS) {
    for (const el of Array.from(scope.querySelectorAll(tag))) {
      el.remove();
      removedNodes += 1;
    }
  }

  // 2. Strip handler + injection attributes and clear secret field values.
  const walker = doc.createTreeWalker(scope as Node, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];
  let node = walker.nextNode();
  while (node) {
    elements.push(node as Element);
    node = walker.nextNode();
  }
  for (const el of elements) {
    for (const attr of Array.from(el.attributes)) {
      if (isStrippedAttr(attr.name)) {
        el.removeAttribute(attr.name);
        strippedAttrs += 1;
      }
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (
        shouldClearInputValue({
          type: (el as HTMLInputElement).type,
          name: el.getAttribute("name"),
          id: el.id,
          autocomplete: el.getAttribute("autocomplete"),
        })
      ) {
        el.setAttribute("value", "");
        (el as HTMLInputElement).value = "";
        clearedValues += 1;
      }
    }
  }

  return { removedNodes, clearedValues, strippedAttrs };
}
