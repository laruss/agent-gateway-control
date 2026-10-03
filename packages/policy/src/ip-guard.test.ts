import { describe, expect, it } from "vitest";
import {
	blockedAddressReason,
	isPublicAddress,
	parseIpLiteral,
	parseIpv4Literal,
} from "./ip-guard.ts";

describe("parseIpv4Literal", () => {
	it("parses dotted-decimal, short, octal and hex forms to the same address", () => {
		expect(parseIpv4Literal("127.0.0.1")).toBe("127.0.0.1");
		expect(parseIpv4Literal("2130706433")).toBe("127.0.0.1");
		expect(parseIpv4Literal("0x7f000001")).toBe("127.0.0.1");
		expect(parseIpv4Literal("017700000001")).toBe("127.0.0.1");
		expect(parseIpv4Literal("0177.0.0.1")).toBe("127.0.0.1");
		expect(parseIpv4Literal("127.1")).toBe("127.0.0.1");
		expect(parseIpv4Literal("0x7f.0.0.1")).toBe("127.0.0.1");
	});

	it("rejects out-of-range parts and non-numeric hosts", () => {
		expect(parseIpv4Literal("256.0.0.1")).toBeNull();
		expect(parseIpv4Literal("example.com")).toBeNull();
		expect(parseIpv4Literal("1.2.3.4.5")).toBeNull();
		expect(parseIpv4Literal("")).toBeNull();
		expect(parseIpv4Literal("1..2.3")).toBeNull();
	});
});

describe("parseIpLiteral + blockedAddressReason", () => {
	const blocked = (host: string) => {
		const parsed = parseIpLiteral(host);
		expect(parsed).not.toBeNull();
		return parsed === null ? "unparsed" : blockedAddressReason(parsed);
	};

	it("blocks loopback in every numeric notation", () => {
		expect(blocked("127.0.0.1")).toBe("loopback");
		expect(blocked("2130706433")).toBe("loopback");
		expect(blocked("0x7f000001")).toBe("loopback");
		expect(blocked("017700000001")).toBe("loopback");
		expect(blocked("::1")).toBe("loopback");
	});

	it("blocks private, link-local, CGNAT and the AWS metadata address", () => {
		expect(blocked("10.1.2.3")).toMatch(/private/);
		expect(blocked("172.16.0.5")).toMatch(/private/);
		expect(blocked("192.168.1.1")).toMatch(/private/);
		expect(blocked("169.254.169.254")).toBe("link-local");
		expect(blocked("100.64.0.1")).toMatch(/carrier-grade NAT/);
	});

	it("blocks multicast, reserved, broadcast and 'this network'", () => {
		expect(blocked("224.0.0.1")).toBe("multicast");
		expect(blocked("240.0.0.1")).toBe("reserved");
		expect(blocked("255.255.255.255")).toBe("broadcast");
		expect(blocked("0.0.0.0")).toMatch(/this network/);
	});

	it("blocks IPv6 loopback, link-local, unique-local, multicast and mapped forms", () => {
		expect(blocked("::1")).toBe("loopback");
		expect(blocked("fe80::1")).toBe("link-local");
		expect(blocked("fc00::1")).toMatch(/unique local/);
		expect(blocked("fd12:3456::1")).toMatch(/unique local/);
		expect(blocked("ff02::1")).toBe("multicast");
		expect(blocked("::ffff:127.0.0.1")).toBe("IPv4-mapped");
		expect(blocked("::ffff:8.8.8.8")).toBe("IPv4-mapped");
		expect(blocked("::")).toBe("unspecified");
	});

	it("allows ordinary public addresses", () => {
		const isPublic = (host: string) => {
			const parsed = parseIpLiteral(host);
			expect(parsed).not.toBeNull();
			return parsed !== null && isPublicAddress(parsed);
		};
		expect(isPublic("8.8.8.8")).toBe(true);
		expect(isPublic("1.1.1.1")).toBe(true);
		expect(isPublic("2606:4700:4700::1111")).toBe(true);
		expect(isPublic("2001:4860:4860::8888")).toBe(true);
	});

	it("is null for a real hostname: that needs DNS, not literal parsing", () => {
		expect(parseIpLiteral("example.com")).toBeNull();
		expect(parseIpLiteral("api.example.com")).toBeNull();
	});
});

describe("IPv6 allow-list: every special-purpose range ADR-027 names, plus what is left over", () => {
	const reasonOf = (host: string) => {
		const parsed = parseIpLiteral(host);
		expect(parsed).not.toBeNull();
		return parsed === null ? "unparsed" : blockedAddressReason(parsed);
	};

	it.each<[string, string, RegExp]>([
		["unspecified", "::", /unspecified/],
		["loopback", "::1", /loopback/],
		["IPv4-mapped ('::ffff:0:0/96')", "::ffff:127.0.0.1", /IPv4-mapped/],
		["IPv4-translated / SIIT ('::ffff:0:0:0/96')", "::ffff:0:1.2.3.4", /SIIT/],
		["IPv4-compatible, deprecated ('::/96')", "::0.0.0.5", /IPv4-compatible/],
		["unique local (RFC 4193)", "fc00::1", /unique local/],
		["unique local, the other half of fc00::/7", "fd12:3456::1", /unique local/],
		["link-local", "fe80::1", /link-local/],
		["site-local, deprecated ('fec0::/10')", "fec0::1", /site-local/],
		["multicast", "ff02::1", /multicast/],
		["documentation ('2001:db8::/32')", "2001:db8::1", /documentation/],
		["Teredo ('2001::/32')", "2001:0:ce49:7601::1", /Teredo/],
		["ORCHIDv2 ('2001:20::/28')", "2001:20::1", /ORCHIDv2/],
		["benchmarking ('2001:2::/48')", "2001:2::1", /benchmarking/],
		["6to4 ('2002::/16')", "2002:101:101::1", /6to4/],
		["NAT64 ('64:ff9b::/96')", "64:ff9b::1", /NAT64/],
		["NAT64 local-use ('64:ff9b:1::/48')", "64:ff9b:1::1", /NAT64 local-use/],
		["discard-only ('100::/64')", "100::1", /discard-only/],
		["every other range outside '2000::/3'", "4000::1", /not global unicast/],
		["every other range outside '2000::/3', low end", "1fff::1", /not global unicast/],
	])("blocks %s (%s)", (_label, host, reason) => {
		expect(reasonOf(host)).toMatch(reason);
	});

	it.each<[string, string]>([
		["the low end of 2000::/3", "2000::1"],
		["the high end of 2000::/3", "3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
		["an ordinary public address", "2001:4860:4860::8888"],
		["just past the Teredo prefix", "2001:1::1"],
		["just past the ORCHIDv2 range", "2001:30::1"],
	])("allows %s (%s)", (_label, host) => {
		expect(reasonOf(host)).toBeNull();
	});
});
