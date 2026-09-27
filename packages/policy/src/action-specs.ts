import type { ActionParam } from "@agent-gateway/contracts";

/** Returns what is wrong with one parameter value, or null. */
type ValueCheck = (value: string) => string | null;

type ActionSpec = Readonly<{
	/** Every parameter the action takes; none may be missing and no other may be added. */
	params: Readonly<Record<string, ValueCheck>>;
	/** Checks across parameters, run once every parameter passed its own. */
	whole?: (params: Readonly<Record<string, string>>) => string | null;
}>;

/** Supported currencies and the digits after the point their amounts must have exactly. */
const CURRENCY_DIGITS: Readonly<Record<string, number>> = {
	EUR: 2,
	USD: 2,
	GBP: 2,
	CHF: 2,
	JPY: 0,
};

const currency: ValueCheck = (value) =>
	Object.hasOwn(CURRENCY_DIGITS, value)
		? null
		: `currency must be one of ${Object.keys(CURRENCY_DIGITS).join(", ")}`;

/** A positive decimal in canonical form: no sign, no leading zeros, no exponent. */
const amount: ValueCheck = (value) =>
	/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,4})?$/.test(value) && /[1-9]/.test(value)
		? null
		: "amount must be a positive decimal like 120.00";

/**
 * The amount has exactly the currency's digits: `120.00 EUR`, `120 JPY`. One canonical form per
 * amount, so the hash and the card never differ over formatting.
 */
function amountPrecision(params: Readonly<Record<string, string>>): string | null {
	const digits = CURRENCY_DIGITS[params.currency ?? ""];
	const fraction = (params.amount ?? "").split(".")[1] ?? "";
	return digits === undefined || fraction.length === digits
		? null
		: `amount in ${params.currency} must have exactly ${digits} digits after the point`;
}

/** An exact account identifier: IBAN, account number, provider id or address. No prose. */
const recipient: ValueCheck = (value) =>
	/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/.test(value)
		? null
		: "recipient must be an exact identifier (letters, digits and ._:@/+- only)";

const purpose: ValueCheck = (value) =>
	value.length <= 500 ? null : "purpose must be at most 500 characters";

const oneOf =
	(allowed: Readonly<string[]>, name: string): ValueCheck =>
	(value) =>
		allowed.includes(value) ? null : `${name} must be one of ${allowed.join(", ")}`;

const isoDate: ValueCheck = (value) => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (match === null) {
		return "date must be YYYY-MM-DD";
	}
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
		? null
		: "date must be a real calendar date";
};

/**
 * Typed parameter sets of the finance actions the broker may execute. Every other `finance.*`
 * write has no schema and is denied: a payment whose terms are not all hashed must not be
 * approvable.
 */
const ACTION_SPECS: Readonly<Record<string, ActionSpec>> = {
	"finance.payment.create": {
		params: {
			amount,
			currency,
			recipient,
			purpose,
			// A recurring payment has terms (interval, start, end) a one-off payment cannot hash.
			recurring: (value) =>
				value === "false" ? null : "recurring payments are finance.subscription.create",
		},
		whole: amountPrecision,
	},
	"finance.subscription.create": {
		params: {
			amount,
			currency,
			recipient,
			purpose,
			interval: oneOf(["month", "year"], "interval"),
			first_payment_date: isoDate,
		},
		whole: amountPrecision,
	},
};

const FINANCE_READ = "finance.read";

/** The one finance tool that reads and may run without a human. */
export function isFinanceRead(actionType: string): boolean {
	return actionType === FINANCE_READ;
}

/** Whether the action has a typed parameter set. */
export function hasActionSpec(actionType: string): boolean {
	return Object.hasOwn(ACTION_SPECS, actionType);
}

/**
 * What is wrong with an action's parameters: for a typed action, each missing, extra or invalid
 * parameter; a finance write without a typed set is refused as a whole. Other actions keep
 * free-form parameters. Pure.
 */
export function actionParamIssues(
	actionType: string,
	actionParams: Readonly<ActionParam[]>,
): Readonly<string[]> {
	const spec = Object.hasOwn(ACTION_SPECS, actionType) ? ACTION_SPECS[actionType] : undefined;
	if (spec === undefined) {
		return actionType.startsWith("finance.") && !isFinanceRead(actionType)
			? [`finance action '${actionType}' has no typed parameter set and cannot be approved`]
			: [];
	}
	const given = new Map(actionParams.map((param) => [param.name, param.value]));
	const issues: string[] = [];
	for (const [name, check] of Object.entries(spec.params)) {
		const value = given.get(name);
		if (value === undefined) {
			issues.push(`parameter '${name}' is missing`);
			continue;
		}
		const problem = check(value);
		if (problem !== null) {
			issues.push(`parameter '${name}': ${problem}`);
		}
	}
	for (const name of given.keys()) {
		if (!Object.hasOwn(spec.params, name)) {
			issues.push(`parameter '${name}' is not part of '${actionType}'`);
		}
	}
	if (issues.length === 0 && spec.whole !== undefined) {
		const problem = spec.whole(Object.fromEntries(given));
		if (problem !== null) {
			issues.push(problem);
		}
	}
	return issues;
}
