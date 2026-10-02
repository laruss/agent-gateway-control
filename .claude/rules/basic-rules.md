# Rules

1. always use bun instead of npm;
2. if you need a new UI component, try to get first from `shadcn/ui`, if it's not there, create a new one.
3. if you write tailwind classes, use spacing (1 = 4px) values, not pixel values (e.g. `w-16` instead of `w-[64px]`)

## Validation

For validation the results, please use `bun run fix` - this runs Biome (lint, format, check, with `--write`) and then `tsc` typecheck.

## Ignore directives are forbidden

- Never add ignore/suppression directives to silence linters, type checkers, or formatters. This includes (
  non-exhaustive):
  `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`, `eslint-disable-next-line`, `biome-ignore`,
  `prettier-ignore`, `// @vitest-ignore`, `/* istanbul ignore */`, and any equivalent tool-specific pragma.
- Don't use `any` or `unknown` to silence linters or type checkers either - it hides the same defect a directive would.
- Fix the underlying issue instead: correct the types, narrow the value, refactor the code, or adjust the tool config.
- If an ignore directive genuinely seems necessary, stop and ask the user to approve it explicitly before adding it.
  Describe what the directive would silence and why the root cause cannot be fixed.

## TYPES

- Use `Readonly<T>` instead of `type T = readonly T[]`.
- Before creating a new type, search for an existing one - duplicate types drift apart.
- Declare named, reusable types instead of inline ones; inline only when a named type would genuinely add nothing.

## DATABASE

- Change the database schema only through a new migration. Never edit or reset an existing migration - existing saves have already applied it.

## PROJECT STRUCTURE

- Follow the project structure in @docs/project-structure.md

## ABOUT

- What the project is: @docs/about.md
