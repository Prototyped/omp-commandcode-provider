import { describe, expect, test } from "bun:test";
import { diff, hunks } from "../scripts/lib/diff.ts";
import { normalize, tokenize } from "../scripts/lib/tokenize.ts";

const norms = (src) => normalize(tokenize(src)).map((t) => t.norm);

describe("tokenizer", () => {
	test("normalizes identifiers but keeps keywords and punctuation", () => {
		expect(norms("const a=b+c")).toEqual(["const", "#", "=", "#", "+", "#"]);
	});

	test("keeps escaped quotes inside one string token", () => {
		const tokens = tokenize('x="a\\"b";y');
		expect(tokens.filter((t) => t.kind === "string").map((t) => t.raw)).toEqual(['"a\\"b"']);
	});

	test("normalizes code inside template interpolations but preserves chunk text", () => {
		expect(norms("`a\u0024{x+y}b`")).toEqual(["Ta", "#", "+", "#", "Tb"]);
	});

	test("handles nested templates", () => {
		expect(norms("`x\u0024{`y\u0024{z}`}`")).toEqual(["Tx", "Ty", "#", "T", "T"]);
	});

	test("distinguishes regex literals from division", () => {
		expect(tokenize("a/b").filter((t) => t.kind === "regex")).toHaveLength(0);
		expect(
			tokenize("=(/x/g)")
				.filter((t) => t.kind === "regex")
				.map((t) => t.raw),
		).toEqual(["/x/g"]);
		expect(
			tokenize("return /x/;")
				.filter((t) => t.kind === "regex")
				.map((t) => t.raw),
		).toEqual(["/x/"]);
	});

	test("drops comments", () => {
		expect(norms("a/*c*/+b//d\n")).toEqual(["#", "+", "#"]);
	});

	test("normalizes identifier renames to nothing", () => {
		expect(norms("function f(a){return a}")).toEqual(norms("function g(b){return b}"));
	});
});

describe("diff", () => {
	const toEdits = (a, b) => diff(a.split(""), b.split(""));

	test("identical inputs produce no changes", () => {
		const edits = toEdits("abc", "abc");
		expect(edits.every((e) => e.type === "equal")).toBe(true);
	});

	test("substitution produces a delete and an insert", () => {
		const edits = toEdits("abc", "axc");
		expect(
			edits
				.filter((e) => e.type !== "equal")
				.map((e) => e.type)
				.sort(),
		).toEqual(["delete", "insert"]);
	});

	test("insertion at the end", () => {
		const edits = toEdits("abc", "abcd");
		const changes = edits.filter((e) => e.type !== "equal");
		expect(changes).toHaveLength(1);
		expect(changes[0].type).toBe("insert");
		expect(changes[0].bStart).toBe(3);
	});

	test("hunks group nearby changes and pad with context", () => {
		const a = [..."abcdefghijklmnopqrstuvwxyz"];
		const b = [...a];
		b[1] = "X";
		b[20] = "Y";
		const edits = diff(a, b);
		const hs = hunks(edits, 2);
		expect(hs).toHaveLength(2);
		expect(hs[0].aStart).toBe(0);
		expect(hs[1].bStart).toBe(18);
	});
});
