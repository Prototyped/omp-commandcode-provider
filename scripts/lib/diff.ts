export type EditType = "equal" | "insert" | "delete";

export type Edit = {
	type: EditType;
	aStart: number;
	bStart: number;
	length: number;
};

export type Hunk = {
	aStart: number;
	aEnd: number;
	bStart: number;
	bEnd: number;
	deleted: number;
	inserted: number;
};

export function diff(a: string[], b: string[], maxDistance = 10_000): Edit[] | null {
	const n = a.length;
	const m = b.length;
	const max = Math.min(n + m, maxDistance);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
				x = v[offset + k + 1];
			} else {
				x = v[offset + k - 1] + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) return backtrack(trace, offset, n, m);
		}
	}
	return null;
}

function backtrack(trace: Int32Array[], offset: number, n: number, m: number): Edit[] {
	let x = n;
	let y = m;
	const reversed: Edit[] = [];
	for (let d = trace.length - 1; d >= 1; d--) {
		const v = trace[d];
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) prevK = k + 1;
		else prevK = k - 1;
		const prevX = v[offset + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			reversed.push({ type: "equal", aStart: x - 1, bStart: y - 1, length: 1 });
			x--;
			y--;
		}
		if (prevK === k + 1) {
			reversed.push({ type: "insert", aStart: x, bStart: y - 1, length: 1 });
			y--;
		} else {
			reversed.push({ type: "delete", aStart: x - 1, bStart: y, length: 1 });
			x--;
		}
		x = prevX;
		y = prevY;
	}
	while (x > 0 && y > 0) {
		reversed.push({ type: "equal", aStart: x - 1, bStart: y - 1, length: 1 });
		x--;
		y--;
	}
	reversed.reverse();
	return mergeEdits(reversed);
}

function mergeEdits(edits: Edit[]): Edit[] {
	const merged: Edit[] = [];
	for (const edit of edits) {
		const last = merged[merged.length - 1];
		if (
			last &&
			last.type === edit.type &&
			last.aStart + last.length === edit.aStart &&
			last.bStart + last.length === edit.bStart
		) {
			last.length++;
			continue;
		}
		merged.push({ ...edit });
	}
	return merged;
}

type Group = Hunk & { afterEqual: number };

export function hunks(edits: Edit[], context = 6): Hunk[] {
	const groups: Group[] = [];
	let current: Group | null = null;
	let prevEqual = 0;
	const close = (): void => {
		if (!current) return;
		const pad = Math.min(context, current.afterEqual);
		current.aEnd += current.deleted === 0 ? 0 : pad;
		current.bEnd += current.inserted === 0 ? 0 : pad;
		groups.push(current);
	};
	for (const edit of edits) {
		if (edit.type === "equal") {
			prevEqual = edit.length;
			if (current) current.afterEqual += edit.length;
			continue;
		}
		const changeEndA = edit.aStart + (edit.type === "delete" ? edit.length : 0);
		const changeEndB = edit.bStart + (edit.type === "insert" ? edit.length : 0);
		if (current && prevEqual <= context * 2) {
			current.aEnd = changeEndA;
			current.bEnd = changeEndB;
			current.afterEqual = 0;
		} else {
			close();
			current = {
				aStart: Math.max(0, edit.aStart - Math.min(context, prevEqual)),
				aEnd: changeEndA,
				bStart: Math.max(0, edit.bStart - Math.min(context, prevEqual)),
				bEnd: changeEndB,
				deleted: 0,
				inserted: 0,
				afterEqual: 0,
			};
		}
		if (edit.type === "delete") current.deleted += edit.length;
		if (edit.type === "insert") current.inserted += edit.length;
		prevEqual = 0;
	}
	close();
	return groups.map(({ afterEqual: _afterEqual, ...hunk }) => hunk);
}
