import {
	Accessor,
	Document,
	Primitive,
	PrimitiveTarget,
	PropertyType,
	Transform,
	TransformContext,
	TypedArray,
	vec3,
} from '@gltf-transform/core';
import { dedup } from './dedup';
import { createIndices, createTransform, formatDeltaOp, isTransformPending } from './utils';

// DEVELOPER NOTES: The vertex welding function has been difficult to make both
// fast and robust / tunable. The writeup below tracks my attempts to solve for
// those constraints.
//
// (Approach #1) Follow the mergeVertices() implementation of three.js,
// hashing vertices with a string concatenation of all vertex attributes.
// The approach does not allow per-attribute tolerance in local units.
//
// (Approach #2) Sort points along the X axis, then make cheaper
// searches up/down the sorted list for merge candidates. While this allows
// simpler comparison based on specified tolerance, it's much slower, even
// for cases where choice of the X vs. Y or Z axes is reasonable.
//
// (Approach #3) Attempted a Delaunay triangulation in three dimensions,
// expecting it would be an n * log(n) algorithm, but the only implementation
// I found (with delaunay-triangulate) appeared to be much slower than that,
// and was notably slower than the sort-based approach, just building the
// Delaunay triangulation alone.
//
// (Approach #4) Hybrid of (1) and (2), assigning vertices to a spatial
// grid, then searching the local neighborhood (27 cells) for weld candidates.
//
// RESULTS: For the "Lovecraftian" sample model, after joining, a primitive
// with 873,000 vertices can be welded down to 230,000 vertices. Results:
// - (1) Not tested, but prior results suggest not robust enough.
// - (2) 30 seconds
// - (3) 660 seconds
// - (4) 13 seconds

const NAME = 'weld';

const Tolerance = {
	DEFAULT: 0.0001,
	TEXCOORD: 0.0001, // [0, 1]
	COLOR: 0.01, // [0, 1]
	NORMAL: 0.5, // [-1, 1]
	JOINTS: 0.0, // [0, ∞]
	WEIGHTS: 0.01, // [0, ∞]
};

/** Options for the {@link weld} function. */
export interface WeldOptions {
	/** Tolerance, as a fraction of primitive AABB, used when merging similar vertices. */
	tolerance?: number;
	/** Whether to overwrite existing indices. */
	overwrite?: boolean;
}

export const WELD_DEFAULTS: Required<WeldOptions> = {
	tolerance: Tolerance.DEFAULT,
	overwrite: true,
};

/**
 * Index {@link Primitive Primitives} and (optionally) merge similar vertices. When merged
 * and indexed, data is shared more efficiently between vertices. File size can
 * be reduced, and the GPU can sometimes use the vertex cache more efficiently.
 *
 * When welding, the 'tolerance' threshold determines which vertices qualify for
 * welding based on distance between the vertices as a fraction of the primitive's
 * bounding box (AABB). For example, tolerance=0.01 welds vertices within +/-1%
 * of the AABB's longest dimension. Other vertex attributes are also compared
 * during welding, with attribute-specific thresholds. For --tolerance=0, geometry
 * is indexed in place, without merging.
 *
 * Example:
 *
 * ```javascript
 * import { weld } from '@gltf-transform/functions';
 *
 * await document.transform(
 * 	weld({ tolerance: 0.001 })
 * );
 * ```
 */
export function weld(_options: WeldOptions = WELD_DEFAULTS): Transform {
	const options = { ...WELD_DEFAULTS, ..._options } as Required<WeldOptions>;

	if (options.tolerance > 0.1 || options.tolerance < 0) {
		throw new Error(`${NAME}: Requires 0 ≤ tolerance ≤ 0.1`);
	}

	return createTransform(NAME, async (doc: Document, context?: TransformContext): Promise<void> => {
		const logger = doc.getLogger();

		for (const mesh of doc.getRoot().listMeshes()) {
			for (const prim of mesh.listPrimitives()) {
				weldPrimitive(doc, prim, options);
			}
		}

		// TODO(perf): Suppose we just invoked simplify(), and dedup is not explicitly
		// in the transform stack .... now we are going to run it twice!
		if (!isTransformPending(context, NAME, 'dedup')) {
			await doc.transform(dedup({ propertyTypes: [PropertyType.ACCESSOR] }));
		}

		logger.debug(`${NAME}: Complete.`);
	});
}

/**
 * Index a {@link Primitive} and (optionally) weld similar vertices. When merged
 * and indexed, data is shared more efficiently between vertices. File size can
 * be reduced, and the GPU can sometimes use the vertex cache more efficiently.
 *
 * When welding, the 'tolerance' threshold determines which vertices qualify for
 * welding based on distance between the vertices as a fraction of the primitive's
 * bounding box (AABB). For example, tolerance=0.01 welds vertices within +/-1%
 * of the AABB's longest dimension. Other vertex attributes are also compared
 * during welding, with attribute-specific thresholds. For --tolerance=0, geometry
 * is indexed in place, without merging.
 *
 * Example:
 *
 * ```javascript
 * import { weldPrimitive } from '@gltf-transform/functions';
 *
 * const mesh = document.getRoot().listMeshes()
 * 	.find((mesh) => mesh.getName() === 'Gizmo');
 *
 * for (const prim of mesh.listPrimitives()) {
 *   weldPrimitive(document, prim, {tolerance: 0.0001});
 * }
 * ```
 */
export function weldPrimitive(doc: Document, prim: Primitive, options: Required<WeldOptions>): void {
	if (prim.getIndices() && !options.overwrite) return;
	if (prim.getMode() === Primitive.Mode.POINTS) return;
	if (options.tolerance === 0) {
		_indexPrimitive(doc, prim);
	} else {
		_weldPrimitive(doc, prim, options);
	}
}

/** @internal Adds indices, if missing. Does not merge vertices. */
function _indexPrimitive(doc: Document, prim: Primitive): void {
	// No need to overwrite here, even if options.overwrite=true.
	if (prim.getIndices()) return;

	const attr = prim.listAttributes()[0];
	const numVertices = attr.getCount();
	const buffer = attr.getBuffer();
	const indices = doc
		.createAccessor()
		.setBuffer(buffer)
		.setType(Accessor.Type.SCALAR)
		.setArray(createIndices(numVertices));
	prim.setIndices(indices);
}

/** @internal Weld and merge, combining vertices that are similar on all vertex attributes. */
function _weldPrimitive(doc: Document, prim: Primitive, options: Required<WeldOptions>): void {
	const logger = doc.getLogger();

	const srcPosition = prim.getAttribute('POSITION')!;
	const srcIndices = prim.getIndices() || doc.createAccessor().setArray(createIndices(srcPosition.getCount()));
	const uniqueIndices = new Uint32Array(new Set(srcIndices.getArray()!));

	// (1) Compute per-attribute tolerances and spatial grid for vertices.

	const tolerance = Math.max(options.tolerance, Number.EPSILON);
	const attributeTolerance: Record<string, number> = {};
	for (const semantic of prim.listSemantics()) {
		const attribute = prim.getAttribute(semantic)!;
		attributeTolerance[semantic] = getAttributeTolerance(semantic, attribute, tolerance);
	}

	logger.debug(`${NAME}: Tolerance thresholds: ${formatKV(attributeTolerance)}`);

	const posA: vec3 = [0, 0, 0];
	const posB: vec3 = [0, 0, 0];

	const grid = {} as Record<string, number[]>;

	for (let i = 0; i < uniqueIndices.length; i++) {
		srcPosition.getElement(uniqueIndices[i], posA);
		const key = getGridKey(posA[0], posA[1], posA[2], attributeTolerance.POSITION);
		grid[key] = grid[key] || [];
		grid[key].push(uniqueIndices[i]);
	}

	// (2) Compare and identify vertices to weld. Use sort to keep iterations below O(n²),

	const weldMap = createIndices(uniqueIndices.length); // oldIndex → oldCommonIndex
	const writeMap = createIndices(uniqueIndices.length); // oldIndex → newIndex

	const srcVertexCount = srcPosition.getCount();
	let dstVertexCount = 0;
	let searchIters = 0;

	for (let i = 0; i < uniqueIndices.length; i++) {
		const a = uniqueIndices[i];
		srcPosition.getElement(a, posA);

		for (const cellKey of getGridNeighborhoodKeys(posA[0], posA[1], posA[2], attributeTolerance.POSITION)) {
			if (!grid[cellKey]) continue;

			for (const j of grid[cellKey]) {
				const b = weldMap[j];
				srcPosition.getElement(b, posB);

				searchIters++;

				// Weld if base attributes and morph target attributes match.
				const isBaseMatch = prim.listSemantics().every((semantic) => {
					const attribute = prim.getAttribute(semantic)!;
					const tolerance = attributeTolerance[semantic];
					return compareAttributes(attribute, a, b, tolerance, semantic);
				});
				const isTargetMatch = prim.listTargets().every((target) => {
					return target.listSemantics().every((semantic) => {
						const attribute = target.getAttribute(semantic)!;
						const tolerance = attributeTolerance[semantic];
						return compareAttributes(attribute, a, b, tolerance, semantic);
					});
				});

				if (isBaseMatch && isTargetMatch) {
					weldMap[a] = b;
					break;
				}
			}
		}

		// Output the vertex if we didn't find a match, else record the index of the match.
		if (weldMap[a] === a) {
			writeMap[a] = dstVertexCount++; // note: reorders the primitive on x-axis sort.
		} else {
			writeMap[a] = writeMap[weldMap[a]];
		}
	}

	logger.debug(`${NAME}: Iterations per vertex: ${Math.round(searchIters / uniqueIndices.length)} (avg)`);
	logger.debug(`${NAME}: ${formatDeltaOp(srcVertexCount, dstVertexCount)} vertices.`);

	// (3) Update indices.

	const dstIndicesCount = srcIndices.getCount(); // # primitives does not change.
	const dstIndicesArray = createIndices(dstIndicesCount, uniqueIndices.length);
	for (let i = 0; i < dstIndicesCount; i++) {
		dstIndicesArray[i] = writeMap[srcIndices.getScalar(i)];
	}
	prim.setIndices(srcIndices.clone().setArray(dstIndicesArray));
	if (srcIndices.listParents().length === 1) srcIndices.dispose();

	// (4) Update vertex attributes.

	for (const srcAttr of prim.listAttributes()) {
		swapAttributes(prim, srcAttr, writeMap, dstVertexCount);
	}
	for (const target of prim.listTargets()) {
		for (const srcAttr of target.listAttributes()) {
			swapAttributes(target, srcAttr, writeMap, dstVertexCount);
		}
	}
}

/** Creates a new TypedArray of the same type as an original, with a new length. */
function createArrayOfType<T extends TypedArray>(array: T, length: number): T {
	const ArrayCtor = array.constructor as new (length: number) => T;
	return new ArrayCtor(length);
}

/** Replaces an {@link Attribute}, creating a new one with the given elements. */
function swapAttributes(
	parent: Primitive | PrimitiveTarget,
	srcAttr: Accessor,
	reorder: Uint32Array | Uint16Array,
	dstCount: number
): void {
	const dstAttrArray = createArrayOfType(srcAttr.getArray()!, dstCount * srcAttr.getElementSize());
	const dstAttr = srcAttr.clone().setArray(dstAttrArray);
	const done = new Uint8Array(dstCount);

	for (let i = 0, el = [] as number[]; i < reorder.length; i++) {
		if (!done[reorder[i]]) {
			dstAttr.setElement(reorder[i], srcAttr.getElement(i, el));
			done[reorder[i]] = 1;
		}
	}

	parent.swap(srcAttr, dstAttr);

	// Clean up.
	if (srcAttr.listParents().length === 1) srcAttr.dispose();
}

const _a = [] as number[];
const _b = [] as number[];

/** Computes a per-attribute tolerance, based on domain and usage of the attribute. */
function getAttributeTolerance(semantic: string, attribute: Accessor, tolerance: number): number {
	// Attributes like NORMAL and COLOR_# do not vary in range like POSITION,
	// so do not apply the given tolerance factor to these attributes.
	if (semantic === 'NORMAL' || semantic === 'TANGENT') return Tolerance.NORMAL;
	if (semantic.startsWith('COLOR_')) return Tolerance.COLOR;
	if (semantic.startsWith('TEXCOORD_')) return Tolerance.TEXCOORD;
	if (semantic.startsWith('JOINTS_')) return Tolerance.JOINTS;
	if (semantic.startsWith('WEIGHTS_')) return Tolerance.WEIGHTS;

	_a.length = _b.length = 0;
	attribute.getMinNormalized(_a);
	attribute.getMaxNormalized(_b);
	const range = Math.max(..._b) - Math.min(..._a) || 1;
	return tolerance * range;
}

/** Compares two vertex attributes against a tolerance threshold. */
function compareAttributes(attribute: Accessor, a: number, b: number, tolerance: number, _semantic: string): boolean {
	attribute.getElement(a, _a);
	attribute.getElement(b, _b);
	for (let i = 0, il = attribute.getElementSize(); i < il; i++) {
		if (Math.abs(_a[i] - _b[i]) > tolerance) {
			return false;
		}
	}
	return true;
}

function formatKV(kv: Record<string, unknown>): string {
	return Object.entries(kv)
		.map(([k, v]) => `${k}=${v}`)
		.join(', ');
}

function getGridNeighborhoodKeys(x: number, y: number, z: number, cellSize: number): string[] {
	// It's generally true that only 18/27 of these keys are unique, but
	// removing the redundant keys here (in a very hot loop) seems to
	// cost more than it saves.
	const keys = [] as string[];
	const hc = cellSize / 2;
	for (let i = -1; i <= 1; i++) {
		for (let j = -1; j <= 1; j++) {
			for (let k = -1; k <= 1; k++) {
				keys.push(getGridKey(x + i * hc, y + j * hc, z + k * hc, cellSize));
			}
		}
	}
	return keys;
}

function getGridKey(x: number, y: number, z: number, cellSize: number): string {
	const cellX = Math.fround(x * Math.round(x / cellSize));
	const cellY = Math.fround(y * Math.round(y / cellSize));
	const cellZ = Math.fround(z * Math.round(z / cellSize));
	return cellX + ':' + cellY + ':' + cellZ;
}
