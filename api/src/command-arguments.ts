// opencode's tokenizer for a command's arguments, which fill $1..$n in the template: argsRegex
// and quoteTrimRegex in 1.x (vendor/opencode-v1/packages/opencode/src/session/prompt.ts) and
// 2.x (vendor/opencode-v2/packages/core/src/config/plugin/command.ts), the same in both.
const ARGS_REGEX = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi;
const QUOTE_TRIM_REGEX = /^["']|["']$/g;

export function argumentTokens(text: string): string[] {
  return (text.match(ARGS_REGEX) ?? []).map((arg) => arg.replace(QUOTE_TRIM_REGEX, ""));
}
