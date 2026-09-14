/** Public, lossless-JSON researcher domain types. */
const researchIdBrand = Symbol('ResearchId');
const runIdBrand = Symbol('RunId');
export function isCheckpointRunDescription(value) {
    return value.version === 2 || value.version === 3;
}
export function samePlanVersionRef(left, right) {
    if (left === undefined || right === undefined)
        return left === right;
    return left.planId === right.planId && left.revision === right.revision && left.sha256 === right.sha256;
}
export function isCheckpointRunResult(value) {
    return value.version === 2 || value.version === 3;
}
//# sourceMappingURL=types.js.map