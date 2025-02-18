/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { IDiffAlgorithm, SequenceFromIntArray, OffsetRange, SequenceDiff, ISequence } from 'vs/editor/common/diff/algorithms/diffAlgorithm';
import { DynamicProgrammingDiffing } from 'vs/editor/common/diff/algorithms/dynamicProgrammingDiffing';
import { ILinesDiff, ILinesDiffComputer, ILinesDiffComputerOptions, LineRange, LineRangeMapping, RangeMapping } from 'vs/editor/common/diff/linesDiffComputer';

export class StandardLinesDiffComputer implements ILinesDiffComputer {
	private readonly lineDiffingAlgorithm = new DynamicProgrammingDiffing();

	constructor(
		private readonly detailedDiffingAlgorithm: IDiffAlgorithm
	) { }

	computeDiff(originalLines: string[], modifiedLines: string[], options: ILinesDiffComputerOptions): ILinesDiff {
		const perfectHashes = new Map<string, number>();
		function getOrCreateHash(text: string): number {
			let hash = perfectHashes.get(text);
			if (hash === undefined) {
				hash = perfectHashes.size;
				perfectHashes.set(text, hash);
			}
			return hash;
		}

		const srcDocLines = originalLines.map((l) => getOrCreateHash(l.trim()));
		const tgtDocLines = modifiedLines.map((l) => getOrCreateHash(l.trim()));

		const lineAlignments = this.lineDiffingAlgorithm.compute(
			new SequenceFromIntArray(srcDocLines),
			new SequenceFromIntArray(tgtDocLines),
			(offset1, offset2) =>
				originalLines[offset1] === modifiedLines[offset2]
					? modifiedLines[offset2].length === 0
						? 0.1
						: 1// + Math.log(1 + modifiedLines[offset2].length)
					: 0.99
		);

		const alignments: RangeMapping[] = [];
		for (let diff of lineAlignments) {
			// Move line diffs up to improve the case of
			// AxBAzB -> AxBA(yBA)zB to
			// AxBAzB -> AxB(AyB)AzB
			if (
				(diff.seq1Range.start > 0 &&
					diff.seq1Range.length > 0 &&
					srcDocLines[diff.seq1Range.start - 1] ===
					srcDocLines[diff.seq1Range.endExclusive - 1]) ||
				(diff.seq2Range.start > 0 &&
					diff.seq2Range.length > 0 &&
					tgtDocLines[diff.seq2Range.start - 1] ===
					tgtDocLines[diff.seq2Range.endExclusive - 1])
			) {
				diff = new SequenceDiff(
					diff.seq1Range.delta(-1),
					diff.seq2Range.delta(-1),
				);
			}

			for (const a of this.refineDiff(originalLines, modifiedLines, diff)) {
				alignments.push(a);
			}
		}

		const changes: LineRangeMapping[] = lineRangeMappingFromRangeMappings(alignments);

		return {
			quitEarly: false,
			changes: changes,
		};
	}

	private refineDiff(originalLines: string[], modifiedLines: string[], diff: SequenceDiff): RangeMapping[] {
		const sourceSlice = new Slice(originalLines, diff.seq1Range);
		const targetSlice = new Slice(modifiedLines, diff.seq2Range);

		const diffs = this.detailedDiffingAlgorithm.compute(sourceSlice, targetSlice);
		return diffs.map(
			(d) =>
				new RangeMapping(
					sourceSlice.translateRange(d.seq1Range).delta(diff.seq1Range.start),
					targetSlice.translateRange(d.seq2Range).delta(diff.seq2Range.start)
				)
		);
	}
}

export function lineRangeMappingFromRangeMappings(alignments: RangeMapping[]): LineRangeMapping[] {
	const changes: LineRangeMapping[] = [];
	for (const g of group(
		alignments,
		(a1, a2) => a2.modifiedRange.startLineNumber - (a1.modifiedRange.endLineNumber - (a1.modifiedRange.endColumn > 1 ? 0 : 1)) <= 1
	)) {
		const first = g[0];
		const last = g[g.length - 1];

		changes.push(new LineRangeMapping(
			new LineRange(
				first.originalRange.startLineNumber,
				last.originalRange.endLineNumber + (last.originalRange.endColumn > 1 || last.modifiedRange.endColumn > 1 ? 1 : 0)
			),
			new LineRange(
				first.modifiedRange.startLineNumber,
				last.modifiedRange.endLineNumber + (last.originalRange.endColumn > 1 || last.modifiedRange.endColumn > 1 ? 1 : 0)
			),
			g
		));
	}
	return changes;
}

function* group<T>(items: Iterable<T>, shouldBeGrouped: (item1: T, item2: T) => boolean): Iterable<T[]> {
	let currentGroup: T[] | undefined;
	let last: T | undefined;
	for (const item of items) {
		if (last !== undefined && shouldBeGrouped(last, item)) {
			currentGroup!.push(item);
		} else {
			if (currentGroup) {
				yield currentGroup;
			}
			currentGroup = [item];
		}
		last = item;
	}
	if (currentGroup) {
		yield currentGroup;
	}
}

class Slice implements ISequence {
	private readonly elements: Int32Array;
	private readonly firstCharOnLineOffsets: Int32Array;

	constructor(public readonly lines: string[], public readonly lineRange: OffsetRange) {
		let chars = 0;
		this.firstCharOnLineOffsets = new Int32Array(lineRange.length);

		for (let i = lineRange.start; i < lineRange.endExclusive; i++) {
			const line = lines[i];
			chars += line.length;
			this.firstCharOnLineOffsets[i - lineRange.start] = chars + 1;
			chars++;
		}

		this.elements = new Int32Array(chars);
		let offset = 0;
		for (let i = lineRange.start; i < lineRange.endExclusive; i++) {
			const line = lines[i];

			for (let i = 0; i < line.length; i++) {
				this.elements[offset + i] = line.charCodeAt(i);
			}
			offset += line.length;
			if (i < lines.length - 1) {
				this.elements[offset] = '\n'.charCodeAt(0);
				offset += 1;
			}
		}
	}

	getElement(offset: number): number {
		return this.elements[offset];
	}

	get length(): number {
		return this.elements.length;
	}

	public translateOffset(offset: number): Position {
		// find smallest i, so that lineBreakOffsets[i] > offset using binary search

		let i = 0;
		let j = this.firstCharOnLineOffsets.length;
		while (i < j) {
			const k = Math.floor((i + j) / 2);
			if (this.firstCharOnLineOffsets[k] > offset) {
				j = k;
			} else {
				i = k + 1;
			}
		}

		const offsetOfPrevLineBreak = i === 0 ? 0 : this.firstCharOnLineOffsets[i - 1];
		return new Position(i + 1, offset - offsetOfPrevLineBreak + 1);
	}

	public translateRange(range: OffsetRange): Range {
		return Range.fromPositions(this.translateOffset(range.start), this.translateOffset(range.endExclusive));
	}
}
