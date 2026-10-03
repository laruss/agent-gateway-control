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
	});

	it("is null for a real hostname: that needs DNS, not literal parsing", () => {
		expect(parseIpLiteral("example.com")).toBeNull();
		expect(parseIpLiteral("api.example.com")).toBeNull();
	});
});
