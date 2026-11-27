import type {
    AppBase,
    CameraComponent,
    ContainerResource,
    MeshInstance,
    Quat,
    RenderComponent,
    StandardMaterial
} from 'playcanvas';
import { Asset, BoundingBox, Color, Entity, Mat4, Plane, Ray, Vec3 } from 'playcanvas';

import { Element, ElementType } from '../element';
import type { Scene } from '../scene';
import type { Serializer } from '../serializer';
import type { Transform } from '../transform';

export type CropBoxBounds = [number, number, number, number, number, number];

export interface RoomTransformDto {
    position: [number, number, number];
    rotationEulerDeg: [number, number, number];
    scale: number;
}

export interface GlbRaycastHit {
    point: Vec3;
    model: GlbModelElement | null;
    distance: number;
}

export const isGlbUrl = (url: string): boolean => {
    try {
        const pathname = new URL(url, window.location.href).pathname.toLowerCase();
        return pathname.endsWith('.glb');
    } catch {
        return url.split(/[?#]/)[0].toLowerCase().endsWith('.glb');
    }
};

export const extractModelFilename = (url: string, fallback = 'scene.glb'): string => {
    try {
        const pathname = new URL(url, window.location.href).pathname;
        return pathname.split('/').pop() || fallback;
    } catch {
        const clean = url.split(/[?#]/)[0];
        return clean.split('/').pop() || fallback;
    }
};

/**
 * Convert Meshroom baked PBR materials into Unlit emissive materials so walls
 * and baked textures render at full original brightness without dark lighting.
 */
export const applyUnlitMaterials = (rootEntity: Entity): void => {
    const renders = rootEntity.findComponents('render') as RenderComponent[];
    for (const render of renders) {
        for (const mi of render.meshInstances) {
            const mat = mi.material as StandardMaterial | null;
            if (!mat) continue;

            mat.useLighting = false;
            if (mat.diffuseMap) {
                mat.emissiveMap = mat.diffuseMap;
                mat.emissiveMapUv = mat.diffuseMapUv;
                mat.emissiveMapChannel = mat.diffuseMapChannel;
                mat.emissiveMapTiling.copy(mat.diffuseMapTiling);
                mat.emissiveMapOffset.copy(mat.diffuseMapOffset);
                mat.emissive = new Color(1, 1, 1);
            } else if (mat.diffuse) {
                mat.emissive = mat.diffuse.clone();
            } else {
                mat.emissive = new Color(1, 1, 1);
            }

            mat.diffuse = new Color(0, 0, 0);
            mat.update();
        }
    }
};

export const normalizeCropBounds = (
    bounds?: CropBoxBounds | { min: number[]; max: number[] } | number[] | null
): CropBoxBounds | null => {
    if (!bounds) return null;
    if (Array.isArray(bounds) && bounds.length === 6 && bounds.every((n) => Number.isFinite(n))) {
        return [bounds[0], bounds[1], bounds[2], bounds[3], bounds[4], bounds[5]];
    }
    if (!Array.isArray(bounds) && Array.isArray(bounds.min) && Array.isArray(bounds.max)) {
        if (
            bounds.min.length === 3 &&
            bounds.max.length === 3 &&
            bounds.min.every((n) => Number.isFinite(n)) &&
            bounds.max.every((n) => Number.isFinite(n))
        ) {
            return [bounds.min[0], bounds.max[0], bounds.min[1], bounds.max[1], bounds.min[2], bounds.max[2]];
        }
    }
    return null;
};

const tmpWorldMat = new Mat4();
const tmpNormalMat = new Mat4();
const tmpLocalPt = new Vec3();
const tmpLocalN = new Vec3();
const tmpWorldPt = new Vec3();
const tmpWorldN = new Vec3();

const LOCAL_CLIP_SPECS: [number, number, number, number, number, number][] = [
    [0, 0, 0, 1, 0, 0], // minX -> +X
    [1, 0, 0, -1, 0, 0], // maxX -> -X
    [2, 0, 0, 0, 1, 0], // minY -> +Y
    [3, 0, 0, 0, -1, 0], // maxY -> -Y
    [4, 0, 0, 0, 0, 1], // minZ -> +Z
    [5, 0, 0, 0, 0, -1] // maxZ -> -Z
];

/**
 * Transform 6-DOF local-space crop bounds by rootEntity's world matrix so
 * rotating, translating, or scaling the room keeps its clipping planes aligned.
 */
export const applyLocalCropBoundsToEntity = (
    rootEntity: Entity | null | undefined,
    bounds?: CropBoxBounds | { min: number[]; max: number[] } | number[] | null
): void => {
    if (!rootEntity) return;

    const normalized = normalizeCropBounds(bounds);
    let planes: Plane[] = [];

    if (normalized) {
        tmpWorldMat.copy(rootEntity.getWorldTransform());
        tmpNormalMat.copy(tmpWorldMat).invert().transpose();

        planes = LOCAL_CLIP_SPECS.map(([boundIdx, , , nx, ny, nz]) => {
            const coord = normalized[boundIdx];
            if (boundIdx < 2) {
                tmpLocalPt.set(coord, 0, 0);
            } else if (boundIdx < 4) {
                tmpLocalPt.set(0, coord, 0);
            } else {
                tmpLocalPt.set(0, 0, coord);
            }
            tmpLocalN.set(nx, ny, nz);

            tmpWorldMat.transformPoint(tmpLocalPt, tmpWorldPt);
            tmpNormalMat.transformVector(tmpLocalN, tmpWorldN);
            if (tmpWorldN.lengthSq() > 1e-12) {
                tmpWorldN.normalize();
            } else {
                tmpWorldN.copy(tmpLocalN);
            }
            return new Plane().setFromPointNormal(tmpWorldPt.clone(), tmpWorldN.clone());
        });
    }

    const renders = rootEntity.findComponents('render') as RenderComponent[];
    for (const render of renders) {
        for (const mi of render.meshInstances) {
            mi.clippingPlanes = planes;
        }
    }
};

export const applyCropBoundsToEntity = applyLocalCropBoundsToEntity;

export const computeEntityMeshBound = (rootEntity: Entity, target: BoundingBox): boolean => {
    const renders = rootEntity.findComponents('render') as RenderComponent[];
    let valid = false;
    for (const render of renders) {
        for (const mi of render.meshInstances) {
            if (!mi.aabb) continue;
            if (!valid) {
                target.copy(mi.aabb);
                valid = true;
            } else {
                target.add(mi.aabb);
            }
        }
    }
    return valid;
};

// ---------------------------------------------------------------------------
// CRIT-02: Cached Typed-Array + Iterative BVH Raycaster (built once on load)
// ---------------------------------------------------------------------------

interface MeshBvhCache {
    positions: Float32Array;
    indices: Uint32Array | null;
    triCount: number;
    triOrder: Uint32Array;
    nodeBounds: Float32Array; // 6 floats per node: minX, minY, minZ, maxX, maxY, maxZ
    nodeLeft: Int32Array;
    nodeRight: Int32Array;
    nodeStart: Int32Array;
    nodeCount: Int32Array;
}

const MAX_LEAF_TRIS = 8;
const meshBvhCacheMap = new WeakMap<MeshInstance, MeshBvhCache>();

const buildMeshBvh = (mi: MeshInstance): MeshBvhCache | null => {
    const existing = meshBvhCacheMap.get(mi);
    if (existing) return existing;

    const mesh = mi.mesh;
    if (!mesh) return null;

    const rawPositions: number[] = [];
    const rawIndices: number[] = [];
    try {
        mesh.getPositions(rawPositions);
        mesh.getIndices(rawIndices);
    } catch {
        return null;
    }

    if (rawPositions.length < 9) return null;

    const positions = new Float32Array(rawPositions);
    const hasIndices = rawIndices.length >= 3;
    const indices = hasIndices ? new Uint32Array(rawIndices) : null;
    const triCount = hasIndices ? Math.floor(indices!.length / 3) : Math.floor(positions.length / 9);
    if (triCount <= 0) return null;

    const triOrder = new Uint32Array(triCount);
    const triMinX = new Float32Array(triCount);
    const triMinY = new Float32Array(triCount);
    const triMinZ = new Float32Array(triCount);
    const triMaxX = new Float32Array(triCount);
    const triMaxY = new Float32Array(triCount);
    const triMaxZ = new Float32Array(triCount);
    const triCx = new Float32Array(triCount);
    const triCy = new Float32Array(triCount);
    const triCz = new Float32Array(triCount);

    for (let t = 0; t < triCount; t++) {
        triOrder[t] = t;
        let i0: number;
        let i1: number;
        let i2: number;
        if (indices) {
            const base = t * 3;
            i0 = indices[base] * 3;
            i1 = indices[base + 1] * 3;
            i2 = indices[base + 2] * 3;
        } else {
            const base = t * 9;
            i0 = base;
            i1 = base + 3;
            i2 = base + 6;
        }

        const x0 = positions[i0];
        const y0 = positions[i0 + 1];
        const z0 = positions[i0 + 2];
        const x1 = positions[i1];
        const y1 = positions[i1 + 1];
        const z1 = positions[i1 + 2];
        const x2 = positions[i2];
        const y2 = positions[i2 + 1];
        const z2 = positions[i2 + 2];

        const minX = x0 < x1 ? (x0 < x2 ? x0 : x2) : x1 < x2 ? x1 : x2;
        const minY = y0 < y1 ? (y0 < y2 ? y0 : y2) : y1 < y2 ? y1 : y2;
        const minZ = z0 < z1 ? (z0 < z2 ? z0 : z2) : z1 < z2 ? z1 : z2;
        const maxX = x0 > x1 ? (x0 > x2 ? x0 : x2) : x1 > x2 ? x1 : x2;
        const maxY = y0 > y1 ? (y0 > y2 ? y0 : y2) : y1 > y2 ? y1 : y2;
        const maxZ = z0 > z1 ? (z0 > z2 ? z0 : z2) : z1 > z2 ? z1 : z2;

        triMinX[t] = minX;
        triMinY[t] = minY;
        triMinZ[t] = minZ;
        triMaxX[t] = maxX;
        triMaxY[t] = maxY;
        triMaxZ[t] = maxZ;

        triCx[t] = (x0 + x1 + x2) / 3;
        triCy[t] = (y0 + y1 + y2) / 3;
        triCz[t] = (z0 + z1 + z2) / 3;
    }

    const maxNodes = Math.max(1, triCount * 2);
    const nodeBounds = new Float32Array(maxNodes * 6);
    const nodeLeft = new Int32Array(maxNodes).fill(-1);
    const nodeRight = new Int32Array(maxNodes).fill(-1);
    const nodeStart = new Int32Array(maxNodes);
    const nodeCount = new Int32Array(maxNodes);

    // Iterative build stack: [nodeIndex, start, end]
    const buildStack: number[] = [0, 0, triCount];
    let nextNode = 1;

    while (buildStack.length > 0) {
        const end = buildStack.pop()!;
        const start = buildStack.pop()!;
        const nodeIdx = buildStack.pop()!;
        const count = end - start;

        let bMinX = Infinity;
        let bMinY = Infinity;
        let bMinZ = Infinity;
        let bMaxX = -Infinity;
        let bMaxY = -Infinity;
        let bMaxZ = -Infinity;

        let cMinX = Infinity;
        let cMinY = Infinity;
        let cMinZ = Infinity;
        let cMaxX = -Infinity;
        let cMaxY = -Infinity;
        let cMaxZ = -Infinity;

        for (let i = start; i < end; i++) {
            const t = triOrder[i];
            if (triMinX[t] < bMinX) bMinX = triMinX[t];
            if (triMinY[t] < bMinY) bMinY = triMinY[t];
            if (triMinZ[t] < bMinZ) bMinZ = triMinZ[t];
            if (triMaxX[t] > bMaxX) bMaxX = triMaxX[t];
            if (triMaxY[t] > bMaxY) bMaxY = triMaxY[t];
            if (triMaxZ[t] > bMaxZ) bMaxZ = triMaxZ[t];

            const cx = triCx[t];
            const cy = triCy[t];
            const cz = triCz[t];
            if (cx < cMinX) cMinX = cx;
            if (cy < cMinY) cMinY = cy;
            if (cz < cMinZ) cMinZ = cz;
            if (cx > cMaxX) cMaxX = cx;
            if (cy > cMaxY) cMaxY = cy;
            if (cz > cMaxZ) cMaxZ = cz;
        }

        const bo = nodeIdx * 6;
        nodeBounds[bo] = bMinX;
        nodeBounds[bo + 1] = bMinY;
        nodeBounds[bo + 2] = bMinZ;
        nodeBounds[bo + 3] = bMaxX;
        nodeBounds[bo + 4] = bMaxY;
        nodeBounds[bo + 5] = bMaxZ;

        if (count <= MAX_LEAF_TRIS) {
            nodeStart[nodeIdx] = start;
            nodeCount[nodeIdx] = count;
            continue;
        }

        const extX = cMaxX - cMinX;
        const extY = cMaxY - cMinY;
        const extZ = cMaxZ - cMinZ;

        let mid = (start + end) >> 1;
        if (extX > 1e-6 || extY > 1e-6 || extZ > 1e-6) {
            const centroids = extX >= extY && extX >= extZ ? triCx : extY >= extZ ? triCy : triCz;
            const splitVal =
                extX >= extY && extX >= extZ
                    ? (cMinX + cMaxX) * 0.5
                    : extY >= extZ
                      ? (cMinY + cMaxY) * 0.5
                      : (cMinZ + cMaxZ) * 0.5;

            let leftPtr = start;
            let rightPtr = end - 1;
            while (leftPtr <= rightPtr) {
                if (centroids[triOrder[leftPtr]] < splitVal) {
                    leftPtr++;
                } else {
                    const tmp = triOrder[leftPtr];
                    triOrder[leftPtr] = triOrder[rightPtr];
                    triOrder[rightPtr] = tmp;
                    rightPtr--;
                }
            }
            if (leftPtr > start && leftPtr < end) {
                mid = leftPtr;
            }
        }

        const leftIdx = nextNode++;
        const rightIdx = nextNode++;
        nodeLeft[nodeIdx] = leftIdx;
        nodeRight[nodeIdx] = rightIdx;
        nodeStart[nodeIdx] = 0;
        nodeCount[nodeIdx] = 0;

        buildStack.push(rightIdx, mid, end);
        buildStack.push(leftIdx, start, mid);
    }

    const cache: MeshBvhCache = {
        positions,
        indices,
        triCount,
        triOrder,
        nodeBounds: nodeBounds.subarray(0, nextNode * 6),
        nodeLeft: nodeLeft.subarray(0, nextNode),
        nodeRight: nodeRight.subarray(0, nextNode),
        nodeStart: nodeStart.subarray(0, nextNode),
        nodeCount: nodeCount.subarray(0, nextNode)
    };
    meshBvhCacheMap.set(mi, cache);
    return cache;
};

export const buildEntityBvhCache = (rootEntity: Entity): number => {
    let totalTriangles = 0;
    const renders = rootEntity.findComponents('render') as RenderComponent[];
    for (const render of renders) {
        for (const mi of render.meshInstances) {
            const bvh = buildMeshBvh(mi);
            if (bvh) {
                totalTriangles += bvh.triCount;
            }
        }
    }
    return totalTriangles;
};

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const tmpPivotPos = new Vec3();
const tmpBoundCheck = new BoundingBox();

export class GlbModelElement extends Element {
    asset: Asset;
    entity: Entity;
    instanceId: string;
    displayLabel: string;
    cropBounds: CropBoxBounds | null = null;
    triangleCount = 0;
    localBoundStorage = new BoundingBox();
    worldBoundStorage = new BoundingBox();
    private _visible = true;

    constructor(asset: Asset, entity: Entity, instanceId = 'default', displayLabel = '') {
        super(ElementType.model);
        this.asset = asset;
        this.entity = entity;
        this.instanceId = instanceId;
        this.displayLabel = displayLabel || entity.name || instanceId;
    }

    get visible(): boolean {
        return this._visible;
    }

    set visible(value: boolean) {
        if (value !== this._visible) {
            this._visible = value;
            if (this.entity) {
                this.entity.enabled = value;
            }
            if (this.scene) {
                this.scene.boundDirty = true;
                this.scene.forceRender = true;
                this.scene.events.fire('glb.visibility', this);
            }
        }
    }

    override add() {
        this.scene.contentRoot.addChild(this.entity);
        computeEntityMeshBound(this.entity, this.localBoundStorage);
        this.worldBoundStorage.setFromTransformedAabb(this.localBoundStorage, this.entity.getWorldTransform());
        this.entity.enabled = this._visible;
        if (this.cropBounds) {
            applyLocalCropBoundsToEntity(this.entity, this.cropBounds);
        }
        this.scene.boundDirty = true;
    }

    override remove() {
        this.entity.remove();
        this.entity.destroy();
        if (this.scene) {
            this.scene.app.assets.remove(this.asset);
            this.scene.boundDirty = true;
        }
        this.asset.unload();
    }

    override serialize(serializer: Serializer) {
        serializer.packa(this.entity.getWorldTransform().data);
        serializer.pack(this.entity.enabled);
    }

    override get worldBound(): BoundingBox | null {
        if (!this.entity || !this._visible) return null;
        this.worldBoundStorage.setFromTransformedAabb(this.localBoundStorage, this.entity.getWorldTransform());
        return this.worldBoundStorage;
    }

    getPivot(result: Transform) {
        const { entity } = this;
        const hasValidBound =
            this.localBoundStorage.halfExtents.x > 0 ||
            this.localBoundStorage.halfExtents.y > 0 ||
            this.localBoundStorage.halfExtents.z > 0;
        if (hasValidBound) {
            entity.getLocalTransform().transformPoint(this.localBoundStorage.center, tmpPivotPos);
        } else {
            tmpPivotPos.copy(entity.getLocalPosition());
        }
        result.set(tmpPivotPos, entity.getLocalRotation(), entity.getLocalScale());
    }

    override move(position?: Vec3, rotation?: Quat, scale?: Vec3) {
        const entity = this.entity;
        if (position) {
            entity.setLocalPosition(position);
        }
        if (rotation) {
            entity.setLocalRotation(rotation);
        }
        if (scale) {
            entity.setLocalScale(scale);
        }

        this.worldBoundStorage.setFromTransformedAabb(this.localBoundStorage, entity.getWorldTransform());
        if (this.cropBounds) {
            applyLocalCropBoundsToEntity(entity, this.cropBounds);
        }
        if (this.scene) {
            this.scene.boundDirty = true;
            this.scene.forceRender = true;
            this.scene.events.fire('glb.moved', this);
        }
    }

    setCropBounds(bounds: CropBoxBounds | { min: number[]; max: number[] } | number[] | null) {
        this.cropBounds = normalizeCropBounds(bounds);
        applyLocalCropBoundsToEntity(this.entity, this.cropBounds);
        if (this.scene) {
            this.scene.boundDirty = true;
            this.scene.forceRender = true;
        }
    }

    getTransformDto(): RoomTransformDto {
        const pos = this.entity.getLocalPosition();
        const euler = this.entity.getLocalEulerAngles();
        const sc = this.entity.getLocalScale();
        return {
            position: [round4(pos.x), round4(pos.y), round4(pos.z)],
            rotationEulerDeg: [round4(euler.x), round4(euler.y), round4(euler.z)],
            scale: round4((sc.x + sc.y + sc.z) / 3)
        };
    }

    setTransformDto(t: Partial<RoomTransformDto>, fireLocalFrame = true) {
        if (Array.isArray(t.position) && t.position.length >= 3) {
            this.entity.setLocalPosition(
                Number(t.position[0]) || 0,
                Number(t.position[1]) || 0,
                Number(t.position[2]) || 0
            );
        }
        if (Array.isArray(t.rotationEulerDeg) && t.rotationEulerDeg.length >= 3) {
            this.entity.setLocalEulerAngles(
                Number(t.rotationEulerDeg[0]) || 0,
                Number(t.rotationEulerDeg[1]) || 0,
                Number(t.rotationEulerDeg[2]) || 0
            );
        }
        if (typeof t.scale === 'number' && Number.isFinite(t.scale)) {
            const safeScale = Math.max(0.01, t.scale);
            this.entity.setLocalScale(safeScale, safeScale, safeScale);
        }

        this.worldBoundStorage.setFromTransformedAabb(this.localBoundStorage, this.entity.getWorldTransform());
        if (this.cropBounds) {
            applyLocalCropBoundsToEntity(this.entity, this.cropBounds);
        }
        if (this.scene) {
            this.scene.boundDirty = true;
            this.scene.forceRender = true;
            if (fireLocalFrame) {
                this.scene.events.fire('glb.localFrame', this);
            }
        }
    }
}

export const loadGlbEntityOnApp = (
    app: AppBase,
    url: string,
    filename: string,
    instanceId = 'default'
): Promise<{ asset: Asset; entity: Entity; triangleCount: number }> => {
    const assetName = filename.toLowerCase().endsWith('.glb') ? filename : `${filename}.glb`;
    const asset = new Asset(assetName, 'container', { url, filename: assetName });

    return new Promise<{ asset: Asset; entity: Entity; triangleCount: number }>((resolve, reject) => {
        asset.once('load', () => {
            try {
                const resource = asset.resource as ContainerResource;
                const containerEntity = resource.instantiateRenderEntity();
                containerEntity.name = assetName;
                applyUnlitMaterials(containerEntity);

                const wrapper = new Entity(`glbModel:${instanceId}`, app);
                wrapper.addChild(containerEntity);

                // CRIT-02: Extract typed-arrays and build BVH once on load (never on pointer clicks)
                const triangleCount = buildEntityBvhCache(wrapper);
                computeEntityMeshBound(wrapper, tmpBoundCheck);

                resolve({ asset, entity: wrapper, triangleCount });
            } catch (err) {
                app.assets.remove(asset);
                asset.unload();
                reject(err);
            }
        });

        asset.once('error', (err) => {
            app.assets.remove(asset);
            reject(typeof err === 'string' ? new Error(err) : err);
        });

        app.assets.add(asset);
        app.assets.load(asset);
    });
};

export const loadGlbModelElement = async (
    scene: Scene,
    url: string,
    filename: string,
    instanceId = 'default',
    displayLabel = ''
): Promise<GlbModelElement> => {
    const { asset, entity, triangleCount } = await loadGlbEntityOnApp(scene.app, url, filename, instanceId);
    const el = new GlbModelElement(asset, entity, instanceId, displayLabel || filename);
    el.triangleCount = triangleCount;
    return el;
};

// ---------------------------------------------------------------------------
// Fast Zero-Allocation Ray-Triangle + BVH Traversal
// ---------------------------------------------------------------------------

const EPSILON = 1e-6;
const v0 = new Vec3();
const v1 = new Vec3();
const v2 = new Vec3();
const edge1 = new Vec3();
const edge2 = new Vec3();
const hVec = new Vec3();
const sVec = new Vec3();
const qVec = new Vec3();
const tempHit = new Vec3();
const invWorldMat = new Mat4();
const localOrigin = new Vec3();
const localDir = new Vec3();
const worldHitCheck = new Vec3();
const bvhTraverseStack = new Int32Array(128);

const intersectTriangle = (
    origin: Vec3,
    dir: Vec3,
    p0: Vec3,
    p1: Vec3,
    p2: Vec3
): number | null => {
    edge1.sub2(p1, p0);
    edge2.sub2(p2, p0);
    hVec.cross(dir, edge2);
    const a = edge1.dot(hVec);
    if (a > -EPSILON && a < EPSILON) return null;

    const f = 1.0 / a;
    sVec.sub2(origin, p0);
    const u = f * sVec.dot(hVec);
    if (u < 0.0 || u > 1.0) return null;

    qVec.cross(sVec, edge1);
    const v = f * dir.dot(qVec);
    if (v < 0.0 || u + v > 1.0) return null;

    const t = f * edge2.dot(qVec);
    return t > EPSILON ? t : null;
};

const rayIntersectsAabbSlab = (
    ox: number,
    oy: number,
    oz: number,
    invDx: number,
    invDy: number,
    invDz: number,
    bounds: Float32Array,
    bo: number,
    maxT: number
): number => {
    const tx1 = (bounds[bo] - ox) * invDx;
    const tx2 = (bounds[bo + 3] - ox) * invDx;
    let tMin = tx1 < tx2 ? tx1 : tx2;
    let tMax = tx1 > tx2 ? tx1 : tx2;

    const ty1 = (bounds[bo + 1] - oy) * invDy;
    const ty2 = (bounds[bo + 4] - oy) * invDy;
    const tyMin = ty1 < ty2 ? ty1 : ty2;
    const tyMax = ty1 > ty2 ? ty1 : ty2;

    if (tyMin > tMin) tMin = tyMin;
    if (tyMax < tMax) tMax = tyMax;

    const tz1 = (bounds[bo + 2] - oz) * invDz;
    const tz2 = (bounds[bo + 5] - oz) * invDz;
    const tzMin = tz1 < tz2 ? tz1 : tz2;
    const tzMax = tz1 > tz2 ? tz1 : tz2;

    if (tzMin > tMin) tMin = tzMin;
    if (tzMax < tMax) tMax = tzMax;

    if (tMax < 0 || tMin > tMax || tMin >= maxT) return Infinity;
    return tMin > 0 ? tMin : 0;
};

const isPointWithinClippingPlanes = (mi: MeshInstance, worldPoint: Vec3): boolean => {
    const planes = mi.clippingPlanes;
    if (!planes || planes.length === 0) return true;
    for (let i = 0; i < planes.length; i++) {
        const plane = planes[i];
        if (plane.normal.dot(worldPoint) + plane.distance < -1e-4) {
            return false;
        }
    }
    return true;
};

const raycastMeshInstance = (ray: Ray, mi: MeshInstance, maxT = Infinity): number | null => {
    if (!mi.aabb.intersectsRay(ray)) return null;

    let bvh = meshBvhCacheMap.get(mi);
    if (!bvh) {
        bvh = buildMeshBvh(mi) ?? undefined;
    }
    if (!bvh) {
        return mi.aabb.intersectsRay(ray, tempHit) ? ray.origin.distance(tempHit) : null;
    }

    // Transform world ray into mesh-instance local space (BVH is built in local space,
    // so moving/rotating/scaling the room requires zero BVH rebuilds).
    invWorldMat.copy(mi.node.getWorldTransform()).invert();
    invWorldMat.transformPoint(ray.origin, localOrigin);
    invWorldMat.transformVector(ray.direction, localDir);

    const ox = localOrigin.x;
    const oy = localOrigin.y;
    const oz = localOrigin.z;
    const invDx = Math.abs(localDir.x) > 1e-12 ? 1 / localDir.x : localDir.x >= 0 ? 1e12 : -1e12;
    const invDy = Math.abs(localDir.y) > 1e-12 ? 1 / localDir.y : localDir.y >= 0 ? 1e12 : -1e12;
    const invDz = Math.abs(localDir.z) > 1e-12 ? 1 / localDir.z : localDir.z >= 0 ? 1e12 : -1e12;

    const { positions, indices, triOrder, nodeBounds, nodeLeft, nodeRight, nodeStart, nodeCount } = bvh;

    let bestT = maxT;
    const rootT = rayIntersectsAabbSlab(ox, oy, oz, invDx, invDy, invDz, nodeBounds, 0, bestT);
    if (!Number.isFinite(rootT)) return null;

    let sp = 0;
    bvhTraverseStack[sp++] = 0;

    while (sp > 0) {
        const nodeIdx = bvhTraverseStack[--sp];
        const count = nodeCount[nodeIdx];

        if (count > 0) {
            const start = nodeStart[nodeIdx];
            const end = start + count;
            for (let i = start; i < end; i++) {
                const tri = triOrder[i];
                let i0: number;
                let i1: number;
                let i2: number;
                if (indices) {
                    const base = tri * 3;
                    i0 = indices[base] * 3;
                    i1 = indices[base + 1] * 3;
                    i2 = indices[base + 2] * 3;
                } else {
                    const base = tri * 9;
                    i0 = base;
                    i1 = base + 3;
                    i2 = base + 6;
                }

                v0.set(positions[i0], positions[i0 + 1], positions[i0 + 2]);
                v1.set(positions[i1], positions[i1 + 1], positions[i1 + 2]);
                v2.set(positions[i2], positions[i2 + 1], positions[i2 + 2]);

                const t = intersectTriangle(localOrigin, localDir, v0, v1, v2);
                if (t !== null && t < bestT) {
                    if (mi.clippingPlanes && mi.clippingPlanes.length > 0) {
                        worldHitCheck.set(
                            ray.origin.x + ray.direction.x * t,
                            ray.origin.y + ray.direction.y * t,
                            ray.origin.z + ray.direction.z * t
                        );
                        if (!isPointWithinClippingPlanes(mi, worldHitCheck)) {
                            continue;
                        }
                    }
                    bestT = t;
                }
            }
        } else {
            const left = nodeLeft[nodeIdx];
            const right = nodeRight[nodeIdx];
            const tLeft =
                left >= 0
                    ? rayIntersectsAabbSlab(ox, oy, oz, invDx, invDy, invDz, nodeBounds, left * 6, bestT)
                    : Infinity;
            const tRight =
                right >= 0
                    ? rayIntersectsAabbSlab(ox, oy, oz, invDx, invDy, invDz, nodeBounds, right * 6, bestT)
                    : Infinity;

            if (Number.isFinite(tLeft) && Number.isFinite(tRight)) {
                if (tLeft < tRight) {
                    if (sp + 2 <= bvhTraverseStack.length) {
                        bvhTraverseStack[sp++] = right;
                        bvhTraverseStack[sp++] = left;
                    }
                } else if (sp + 2 <= bvhTraverseStack.length) {
                    bvhTraverseStack[sp++] = left;
                    bvhTraverseStack[sp++] = right;
                }
            } else if (Number.isFinite(tLeft) && sp < bvhTraverseStack.length) {
                bvhTraverseStack[sp++] = left;
            } else if (Number.isFinite(tRight) && sp < bvhTraverseStack.length) {
                bvhTraverseStack[sp++] = right;
            }
        }
    }

    return Number.isFinite(bestT) && bestT < maxT ? bestT : null;
};

export const raycastCameraAgainstEntities = (
    cam: CameraComponent,
    entities: Entity[],
    clientX: number,
    clientY: number,
    rect: DOMRect
): Vec3 | null => {
    if (!cam) return null;

    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const nearPt = cam.screenToWorld(sx, sy, cam.nearClip);
    const farPt = cam.screenToWorld(sx, sy, cam.farClip);
    const dir = farPt.sub(nearPt).normalize();
    const ray = new Ray(nearPt, dir);

    let closestT = Infinity;
    for (const rootEntity of entities) {
        if (!rootEntity.enabled) continue;
        const renders = rootEntity.findComponents('render') as RenderComponent[];
        for (const render of renders) {
            if (!render.enabled) continue;
            for (const mi of render.meshInstances) {
                const t = raycastMeshInstance(ray, mi, closestT);
                if (t !== null && t < closestT) {
                    closestT = t;
                }
            }
        }
    }

    if (!Number.isFinite(closestT)) return null;
    return new Vec3(
        ray.origin.x + ray.direction.x * closestT,
        ray.origin.y + ray.direction.y * closestT,
        ray.origin.z + ray.direction.z * closestT
    );
};

export const raycastGlbModelsWithHit = (
    scene: Scene,
    models: GlbModelElement[],
    clientX: number,
    clientY: number,
    rect: DOMRect
): GlbRaycastHit | null => {
    const cam = scene.camera?.mainCamera?.camera;
    if (!cam || rect.width <= 0 || rect.height <= 0) return null;

    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const nearPt = cam.screenToWorld(sx, sy, cam.nearClip);
    const farPt = cam.screenToWorld(sx, sy, cam.farClip);
    const dir = farPt.sub(nearPt).normalize();
    const ray = new Ray(nearPt, dir);

    let closestT = Infinity;
    let hitModel: GlbModelElement | null = null;

    for (const model of models) {
        if (!model.visible || !model.entity.enabled) continue;
        const wb = model.worldBound;
        if (wb && !wb.intersectsRay(ray)) continue;

        const renders = model.entity.findComponents('render') as RenderComponent[];
        for (const render of renders) {
            if (!render.enabled) continue;
            for (const mi of render.meshInstances) {
                const t = raycastMeshInstance(ray, mi, closestT);
                if (t !== null && t < closestT) {
                    closestT = t;
                    hitModel = model;
                }
            }
        }
    }

    if (!Number.isFinite(closestT) || !hitModel) return null;
    return {
        point: new Vec3(
            ray.origin.x + ray.direction.x * closestT,
            ray.origin.y + ray.direction.y * closestT,
            ray.origin.z + ray.direction.z * closestT
        ),
        model: hitModel,
        distance: closestT
    };
};

export const raycastGlbModels = (
    scene: Scene,
    models: GlbModelElement[],
    clientX: number,
    clientY: number,
    rect: DOMRect
): Vec3 | null => {
    return raycastGlbModelsWithHit(scene, models, clientX, clientY, rect)?.point ?? null;
};
