import { isIP } from "node:net";

/**
 * Classifies an address as public or one of the non-public ranges a custom HTTPS tool's egress
 * must never reach (ADR-027's custom-tool section): loopback, link-local, private, carrier-grade
 * NAT, multicast, reserved, documentation/benchmark ranges, and the IPv6 forms that alias them
 * (unique-local, an IPv4-mapped address, ...). IPv4 is a deny-list (every specific non-global
 * range below); IPv6 is the reverse, an allow-list (`ipv6BlockedReason`'s own doc comment) —
 * a deny-list missed real non-global forms it simply never named (6to4, Teredo, ORCHIDv2,
 * benchmarking, the second NAT64 prefix, ...), where an allow-list can only ever be too strict,
 * never too permissive, as the universe of "global" shifts under it. Pure: no DNS, no sockets —
 * `packages/tool-broker`'s egress guard resolves a host once (or accepts an already-resolved
 * address from an injectable resolver) and calls this on the result before ever connecting.
 */

export type IpFamily = 4 | 6;
export type ParsedIp = Readonly<{ family: IpFamily; address: string }>;

/**
 * The historic `inet_aton` grammar: 1-4 dot-separated parts, each decimal, `0`-prefixed octal or
 * `0x`-prefixed hex; the last part absorbs whatever bits the earlier parts did not claim. This is
 * what lets a string like `2130706433`, `0x7f000001` or `017700000001` mean `127.0.0.1` to a C
 * resolver (and to curl, and to some HTTP clients) even though it is not a dotted-decimal address
 * at all — an SSRF classifier that only recognises `a.b.c.d` misses every one of these. Returns
 * the canonical dotted-decimal form, or null when `host` is not any numeric IPv4 form.
 */
export function parseIpv4Literal(host: string): string | null {
	if (!/^[0-9a-fA-Fx.]+$/.test(host) || host.length > 79) {
		return null;
	}
	const parts = host.split(".");
	if (parts.length === 0 || parts.length > 4 || parts.some((part) => part === "")) {
		return null;
	}
	const values: number[] = [];
	for (const part of parts) {
		let value: number;
		if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
			value = Number.parseInt(part.slice(2), 16);
		} else if (/^0[0-7]+$/.test(part)) {
			value = Number.parseInt(part, 8);
		} else if (/^(0|[1-9][0-9]*)$/.test(part)) {
			value = Number.parseInt(part, 10);
		} else {
			return null;
		}
		if (!Number.isSafeInteger(value) || value < 0) {
			return null;
		}
		values.push(value);
	}
	// Per `inet_aton`: every part but the last must fit a single octet; the last part absorbs
	// whatever bits remain (so `a.b.c` means `a.b.(c>>8).(c&255)`, and a lone `a` means the whole
	// 32-bit address).
	const maxForLastPart = [0xffffffff, 0xffffff, 0xffff, 0xff];
	const lastIndex = values.length - 1;
	for (let i = 0; i < lastIndex; i += 1) {
		if ((values[i] ?? 0) > 255) {
			return null;
		}
	}
	const last = values[lastIndex] ?? 0;
	if (last > (maxForLastPart[lastIndex] ?? 0xff)) {
		return null;
	}
	let combined = 0;
	for (let i = 0; i < lastIndex; i += 1) {
		combined |= (values[i] ?? 0) << (8 * (3 - i));
	}
	combined = (combined | last) >>> 0;
	const octets = [
		(combined >>> 24) & 255,
		(combined >>> 16) & 255,
		(combined >>> 8) & 255,
		combined & 255,
	];
	return octets.join(".");
}

/** Parses `host` as any literal IPv4 or IPv6 address — dotted-decimal, compressed IPv6, or one of
 * `parseIpv4Literal`'s numeric forms — never a real hostname (that needs DNS). */
export function parseIpLiteral(host: string): ParsedIp | null {
	if (isIP(host) === 6) {
		return { family: 6, address: host.toLowerCase() };
	}
	if (isIP(host) === 4) {
		return { family: 4, address: host };
	}
	const v4 = parseIpv4Literal(host);
	return v4 === null ? null : { family: 4, address: v4 };
}

function ipv4ToInt(address: string): number {
	const octets = address.split(".").map(Number);
	return (
		(((octets[0] ?? 0) << 24) |
			((octets[1] ?? 0) << 16) |
			((octets[2] ?? 0) << 8) |
			(octets[3] ?? 0)) >>>
		0
	);
}

const IPV4_BLOCKED_RANGES: Readonly<{ base: string; bits: number; label: string }[]> = [
	{ base: "0.0.0.0", bits: 8, label: "'this network' (RFC 791)" },
	{ base: "10.0.0.0", bits: 8, label: "private (RFC 1918)" },
	{ base: "100.64.0.0", bits: 10, label: "carrier-grade NAT (RFC 6598)" },
	{ base: "127.0.0.0", bits: 8, label: "loopback" },
	{ base: "169.254.0.0", bits: 16, label: "link-local" },
	{ base: "172.16.0.0", bits: 12, label: "private (RFC 1918)" },
	{ base: "192.0.0.0", bits: 24, label: "IETF protocol assignments (RFC 6890)" },
	{ base: "192.0.2.0", bits: 24, label: "documentation (TEST-NET-1)" },
	{ base: "192.168.0.0", bits: 16, label: "private (RFC 1918)" },
	{ base: "198.18.0.0", bits: 15, label: "benchmarking (RFC 2544)" },
	{ base: "198.51.100.0", bits: 24, label: "documentation (TEST-NET-2)" },
	{ base: "203.0.113.0", bits: 24, label: "documentation (TEST-NET-3)" },
	{ base: "224.0.0.0", bits: 4, label: "multicast" },
	// More specific than the `240.0.0.0/4` reserved block below; checked first, since the first
	// matching range wins.
	{ base: "255.255.255.255", bits: 32, label: "broadcast" },
	{ base: "240.0.0.0", bits: 4, label: "reserved" },
];

function ipv4BlockedReason(address: string): string | null {
	const value = ipv4ToInt(address);
	for (const range of IPV4_BLOCKED_RANGES) {
		const base = ipv4ToInt(range.base);
		const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
		if ((value & mask) >>> 0 === (base & mask) >>> 0) {
			return range.label;
		}
	}
	return null;
}

/** Parses a canonical (`isIP`-validated) IPv6 address into its eight 16-bit groups, resolving an
 * embedded IPv4 tail (`::ffff:127.0.0.1`, `::127.0.0.1`) into the last two groups. Null only when
 * `address` is not what `isIP` already said it was (defensive; should not happen). */
function ipv6Groups(address: string): Readonly<number[]> | null {
	let working = address;
	let embeddedV4: Readonly<number[]> | null = null;
	const lastColon = working.lastIndexOf(":");
	const tail = working.slice(lastColon + 1);
	if (tail.includes(".")) {
		const v4 = parseIpv4Literal(tail);
		if (v4 === null) {
			return null;
		}
		embeddedV4 = v4.split(".").map(Number);
		working = `${working.slice(0, lastColon + 1)}0:0`;
	}
	const doubleColon = working.indexOf("::");
	const head = doubleColon === -1 ? working : working.slice(0, doubleColon);
	const tailPart = doubleColon === -1 ? "" : working.slice(doubleColon + 2);
	const headParts = head === "" ? [] : head.split(":");
	const tailParts = tailPart === "" ? [] : tailPart.split(":");
	if (doubleColon === -1 && headParts.length !== 8) {
		return null;
	}
	const missing = doubleColon === -1 ? 0 : 8 - headParts.length - tailParts.length;
	if (missing < 0) {
		return null;
	}
	const allParts = [...headParts, ...Array(missing).fill("0"), ...tailParts];
	if (allParts.length !== 8) {
		return null;
	}
	const groups = allParts.map((part) => Number.parseInt(part, 16));
	if (groups.some((group) => !Number.isFinite(group) || group < 0 || group > 0xffff)) {
		return null;
	}
	if (embeddedV4 !== null) {
		const mutable = [...groups];
		mutable[6] = (((embeddedV4[0] ?? 0) << 8) | (embeddedV4[1] ?? 0)) & 0xffff;
		mutable[7] = (((embeddedV4[2] ?? 0) << 8) | (embeddedV4[3] ?? 0)) & 0xffff;
		return mutable;
	}
	return groups;
}

/**
 * IPv6 is checked the opposite way IPv4 is above: every specific non-global shape is checked
 * first (so a blocked address still gets its own precise label), and whatever is left is then
 * gated by one allow-list test — only global unicast (`2000::/3`) may ever pass. A deny-list here
 * would have to name every non-global range that exists, and a forgotten one (ORCHIDv2,
 * benchmarking, the second NAT64 prefix, a future IANA allocation outside `2000::/3`) would pass
 * silently; an allow-list can only ever refuse something that happens to be global, never admit
 * something that is not.
 */
function ipv6BlockedReason(address: string): string | null {
	const groups = ipv6Groups(address);
	if (groups === null) {
		return "unparseable";
	}
	const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
	if (groups.every((group) => group === 0)) {
		return "unspecified";
	}
	if (
		g0 === 0 &&
		g1 === 0 &&
		g2 === 0 &&
		g3 === 0 &&
		g4 === 0 &&
		g5 === 0 &&
		g6 === 0 &&
		g7 === 1
	) {
		return "loopback";
	}
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
		// ::ffff:a.b.c.d — an IPv4-mapped address always aliases its embedded address; reject the
		// form outright regardless of what that address is, so a resolver cannot smuggle a private
		// IPv4 target past an IPv6-shaped guard.
		return "IPv4-mapped";
	}
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
		// ::ffff:0:a.b.c.d, RFC 6052 §2.2's own second embedding (SIIT) — the same aliasing risk as
		// IPv4-mapped above, one group over.
		return "IPv4-translated (SIIT, RFC 6052 §2.2)";
	}
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
		// Any other '::/96' form left (the deprecated IPv4-compatible address, '::a.b.c.d'): checked
		// last of the four, since unspecified/loopback/both embeddings above are all more specific
		// shapes of this same "first 96 bits zero" prefix.
		return "IPv4-compatible (deprecated, RFC 4291)";
	}
	if (((g0 ?? 0) & 0xfe00) === 0xfc00) {
		return "unique local (RFC 4193)";
	}
	if (((g0 ?? 0) & 0xffc0) === 0xfe80) {
		return "link-local";
	}
	if (((g0 ?? 0) & 0xffc0) === 0xfec0) {
		return "site-local (deprecated, RFC 3879)";
	}
	if (((g0 ?? 0) & 0xff00) === 0xff00) {
		return "multicast";
	}
	if (g0 === 0x2001 && g1 === 0x0db8) {
		return "documentation (RFC 3849)";
	}
	if (g0 === 0x2001 && g1 === 0) {
		return "Teredo (RFC 4380)";
	}
	if (g0 === 0x2001 && ((g1 ?? 0) & 0xfff0) === 0x0020) {
		return "ORCHIDv2 (RFC 7343)";
	}
	if (g0 === 0x2001 && g1 === 2 && g2 === 0) {
		return "benchmarking (RFC 5180)";
	}
	if (g0 === 0x2002) {
		return "6to4 (RFC 3056)";
	}
	if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
		// 64:ff9b::/96 (NAT64) carries an embedded address too; refused regardless of what it is
		// (simpler, and just as safe, as unwrapping and classifying it).
		return "NAT64 (RFC 6052)";
	}
	if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) {
		return "NAT64 local-use (RFC 8215)";
	}
	if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) {
		return "discard-only (RFC 7707)";
	}
	if (((g0 ?? 0) & 0xe000) !== 0x2000) {
		// The allow-list gate: everything that reaches here passed every specific non-global check
		// above without matching, so this is the one remaining question — is it global unicast at
		// all? Only `2000::/3` ever is.
		return "not global unicast (outside '2000::/3')";
	}
	return null;
}

/** Why `parsed` may never be connected to, or null when it is an ordinary public address. */
export function blockedAddressReason(parsed: ParsedIp): string | null {
	return parsed.family === 4
		? ipv4BlockedReason(parsed.address)
		: ipv6BlockedReason(parsed.address);
}

export function isPublicAddress(parsed: ParsedIp): boolean {
	return blockedAddressReason(parsed) === null;
}
