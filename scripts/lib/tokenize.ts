export type TokenKind = "ident" | "keyword" | "string" | "template" | "regex" | "number" | "punct";

export type Token = {
	kind: TokenKind;
	raw: string;
	start: number;
};

export type NormalizedToken = Token & { norm: string };

const KEYWORDS = new Set([
	"async",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"let",
	"new",
	"null",
	"of",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"undefined",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"enum",
	"implements",
	"interface",
	"package",
	"private",
	"protected",
	"public",
]);

const REGEX_PRECEDING_KEYWORDS = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);

const PUNCT = [
	">>>=",
	"===",
	"!==",
	"**=",
	"<<=",
	">>=",
	"&&=",
	"||=",
	"??=",
	"...",
	"=>",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"??",
	"?.",
	"++",
	"--",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"**",
	"<<",
	">>",
	">>>",
	"{",
	"}",
	"(",
	")",
	"[",
	"]",
	";",
	",",
	"<",
	">",
	"+",
	"-",
	"*",
	"%",
	"&",
	"|",
	"^",
	"!",
	"~",
	"?",
	":",
	"=",
	".",
	"/",
	"@",
	"#",
];

class Scanner {
	readonly tokens: Token[] = [];
	private i = 0;
	private prev: { kind: TokenKind; raw: string } | null = null;

	constructor(private readonly src: string) {}

	scanCode(stopAtBrace = false): void {
		const src = this.src;
		let depth = 0;
		while (this.i < src.length) {
			const c = src[this.i];
			if (c === "\n" || c === "\r" || c === " " || c === "\t") {
				this.i++;
				continue;
			}
			if (c === "/" && src[this.i + 1] === "/") {
				const e = src.indexOf("\n", this.i);
				this.i = e < 0 ? src.length : e;
				continue;
			}
			if (c === "/" && src[this.i + 1] === "*") {
				const e = src.indexOf("*/", this.i + 2);
				this.i = e < 0 ? src.length : e + 2;
				continue;
			}
			if (stopAtBrace && c === "}" && depth === 0) {
				this.i++;
				return;
			}
			if (c === "`") {
				this.scanTemplate();
				continue;
			}
			if (c === '"' || c === "'") {
				const e = this.readString(c, this.i);
				this.emit("string", this.i, e);
				this.i = e;
				continue;
			}
			if (c === "/" && this.regexAllowed()) {
				const e = this.readRegex(this.i);
				this.emit("regex", this.i, e);
				this.i = e;
				continue;
			}
			if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[this.i + 1] ?? ""))) {
				let j = this.i + 1;
				while (j < src.length && /[0-9a-zA-Z._]/.test(src[j])) j++;
				this.emit("number", this.i, j);
				this.i = j;
				continue;
			}
			if (/[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127) {
				let j = this.i + 1;
				while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
				const raw = src.slice(this.i, j);
				this.emit(KEYWORDS.has(raw) ? "keyword" : "ident", this.i, j);
				this.i = j;
				continue;
			}
			let matched: string | undefined;
			for (const p of PUNCT) {
				if (src.startsWith(p, this.i)) {
					matched = p;
					break;
				}
			}
			if (!matched) {
				this.emit("punct", this.i, this.i + 1);
				this.i++;
				continue;
			}
			if (matched === "{") depth++;
			else if (matched === "}") depth--;
			this.emit("punct", this.i, this.i + matched.length);
			this.i += matched.length;
		}
	}

	private emit(kind: TokenKind, start: number, end: number): void {
		const raw = this.src.slice(start, end);
		this.tokens.push({ kind, raw, start });
		this.prev = { kind, raw };
	}

	private readString(quote: string, from: number): number {
		let j = from + 1;
		while (j < this.src.length) {
			const c = this.src[j];
			if (c === "\\") {
				j += 2;
				continue;
			}
			if (c === quote) return j + 1;
			j++;
		}
		return this.src.length;
	}

	private readRegex(from: number): number {
		let j = from + 1;
		let inClass = false;
		while (j < this.src.length) {
			const c = this.src[j];
			if (c === "\\") {
				j += 2;
				continue;
			}
			if (c === "\n") break;
			if (c === "[") inClass = true;
			else if (c === "]") inClass = false;
			else if (c === "/" && !inClass) {
				j++;
				break;
			}
			j++;
		}
		while (j < this.src.length && /[a-z]/i.test(this.src[j])) j++;
		return j;
	}

	private regexAllowed(): boolean {
		if (this.prev === null) return true;
		if (this.prev.kind === "keyword") return REGEX_PRECEDING_KEYWORDS.has(this.prev.raw);
		if (this.prev.kind !== "punct") return false;
		return !([")", "]", "}", "++", "--"] as string[]).includes(this.prev.raw);
	}

	private scanTemplate(): void {
		const src = this.src;
		this.i++;
		let chunkStart = this.i;
		while (this.i < src.length) {
			const c = src[this.i];
			if (c === "\\") {
				this.i += 2;
				continue;
			}
			if (c === "`") {
				this.emit("template", chunkStart, this.i);
				this.i++;
				return;
			}
			if (c === "$" && src[this.i + 1] === "{") {
				this.emit("template", chunkStart, this.i);
				this.i += 2;
				this.scanCode(true);
				chunkStart = this.i;
				continue;
			}
			this.i++;
		}
		this.emit("template", chunkStart, src.length);
	}
}

export function tokenize(source: string): Token[] {
	const scanner = new Scanner(source);
	scanner.scanCode();
	return scanner.tokens;
}

export function normalize(tokens: Token[]): NormalizedToken[] {
	return tokens.map((token) => {
		let norm: string;
		switch (token.kind) {
			case "ident":
				norm = "#";
				break;
			case "keyword":
			case "punct":
				norm = token.raw;
				break;
			case "string":
				norm = `S${token.raw}`;
				break;
			case "template":
				norm = `T${token.raw}`;
				break;
			case "regex":
				norm = `R${token.raw}`;
				break;
			case "number":
				norm = `N${token.raw}`;
				break;
		}
		return { ...token, norm };
	});
}
