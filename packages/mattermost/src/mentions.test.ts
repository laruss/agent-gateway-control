import { describe, expect, it } from "vitest";
import { mentionedAgents, proseOf } from "./mentions.ts";

const AGENTS = new Set(["developer", "finance", "research"]);
const mentions = (text: string) => mentionedAgents(text, AGENTS);

describe("mention parsing", () => {
	it("finds exact mentions of registered agents in order, once each", () => {
		expect(mentions("@finance and @developer, then @finance again")).toEqual([
			"finance",
			"developer",
		]);
		expect(mentions("@Developer: please check.")).toEqual(["developer"]);
		expect(mentions("thanks @research.")).toEqual(["research"]);
	});

	it("ignores unknown names, look-alikes and text without @", () => {
		expect(mentions("developer please check")).toEqual([]);
		expect(mentions("@developers @dev @finance-team")).toEqual([]);
		expect(mentions("@developer_ and @finance- are other accounts")).toEqual([]);
		expect(mentions("mail me at ops@developer.example")).toEqual([]);
		expect(mentions("@all @here @channel")).toEqual([]);
	});

	it("ignores fenced and indented code blocks", () => {
		expect(mentions("look:\n```\n@developer run this\n```\n")).toEqual([]);
		expect(mentions("~~~ts\n@finance\n~~~")).toEqual([]);
		expect(mentions("````\n```\n@finance\n```\n````")).toEqual([]);
		expect(mentions("text\n\n    @developer indented\n")).toEqual([]);
		expect(mentions("```\nunterminated @developer")).toEqual([]);
		expect(mentions("```\ncode\n```\n@research after the block")).toEqual(["research"]);
	});

	it("ignores inline code, also across lines of a paragraph", () => {
		expect(mentions("run `@developer deploy` now")).toEqual([]);
		expect(mentions("``a ` @finance``")).toEqual([]);
		expect(mentions("start `code\n@developer` end")).toEqual([]);
		expect(mentions("`code\n    continuation\n@developer`")).toEqual([]);
		expect(mentions("`x` @research `y`")).toEqual(["research"]);
	});

	it("ignores quotes and their lazy continuation lines", () => {
		expect(mentions("> @developer said so")).toEqual([]);
		expect(mentions("> quoted\n@developer still quoted")).toEqual([]);
		expect(mentions("> quoted\n\n@developer after the quote")).toEqual(["developer"]);
		expect(mentions("- > @developer said deploy")).toEqual([]);
		expect(mentions("1. > @developer")).toEqual([]);
	});

	it("ignores names inside links, autolinks and URLs", () => {
		expect(mentions("read https://medium.com/@research/post")).toEqual([]);
		expect(mentions("see [the report](https://example.test/@developer)")).toEqual([]);
		expect(mentions("<https://x.test/@finance>")).toEqual([]);
		expect(mentions("www.example.test/@finance")).toEqual([]);
		expect(mentions("see [report](/docs/v1_(old)/@developer)")).toEqual([]);
		expect(mentions('[x](/a "title") then @research')).toEqual(["research"]);
		expect(mentions('[report](https://example.test "ask @developer")')).toEqual([]);
		expect(mentions('[report]: /@developer "ask @finance"')).toEqual([]);
		expect(mentions('[report](https://x.test "say \\"@developer\\"")')).toEqual([]);
		expect(mentions("[report](\n@developer)")).toEqual([]);
		expect(mentions("[report](\n@developer")).toEqual([]);
		expect(mentions('- [ref]: /@developer "title"')).toEqual([]);
		expect(mentions("an escaped \\@developer is a literal")).toEqual([]);
		expect(mentions("see example.com/@developer")).toEqual([]);
		expect(mentions("example.com?to=@developer")).toEqual([]);
		expect(mentions("example.com#@developer")).toEqual([]);
		expect(mentions("mailto:ops@example.com?subject=@developer")).toEqual([]);
		expect(mentions("note: @research please look")).toEqual(["research"]);
		expect(mentions("![chart mentioning @developer](https://example.test/c.png)")).toEqual([]);
		expect(mentions("![diagram [draft] @developer](x.png)")).toEqual([]);
		expect(mentions("![diagram\n@developer](x.png)")).toEqual([]);
		expect(mentions("![escaped \\] @developer](x.png)")).toEqual([]);
		expect(mentions("![chart](https://example.test/c.png) @research look")).toEqual(["research"]);
		expect(mentions('[manual]: /guide\n  "ask @developer"')).toEqual([]);
		expect(mentions("[manual]: /guide\n\n@research please")).toEqual(["research"]);
		expect(mentions("[report]\n\n[report]: /x\n\n@research")).toEqual(["research"]);
		expect(mentions("[ask @finance](https://example.test)")).toEqual(["finance"]);
	});

	it("ignores fences opened inside list items", () => {
		expect(mentions("- ```\n  @developer\n  ```\n- @research")).toEqual(["research"]);
		expect(mentions("1. ~~~\n@finance\n~~~")).toEqual([]);
	});

	it("keeps list items and ordinary paragraphs", () => {
		expect(proseOf("- item @finance\n  - nested @research")).toContain("@research");
		expect(mentions("- @finance\n- @research")).toEqual(["finance", "research"]);
	});
});
