import type { AppBase, CameraComponent, ContainerResource, MeshInstance, RenderComponent, StandardMaterial } from 'playcanvas';
import { Asset, BoundingBox, Color, Entity, Plane, Ray, Vec3 } from 'playcanvas';

import { Element, ElementType } from '../element';
import type { Scene } from '../scene';
import type { Serializer } from '../serializer';

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

/**
 * Apply 6-DOF world-space clipping planes onto every MeshInstance under rootEntity
 * so moving Crop Box sliders slices away exterior scan clutter in real time.
 */
export const applyCropBoundsToEntity = (
    rootEntity: Entity | null | undefined,
    bounds?: [number, number, number, number, number, number] | null
): void => {
    if (!rootEntity) return;

    const planes: Plane[] =
        Array.isArray(bounds) && bounds.length === 6 && bounds.every((n) => Number.isFinite(n))
            ? [
                  new Plane().setFromPointNormal(new Vec3(bounds[0], 0, 0), new Vec3(1, 0, 0)),
                  new Plane().setFromPointNormal(new Vec3(bounds[1], 0, 0), new Vec3(-1, 0, 0)),
                  new Plane().setFromPointNormal(new Vec3(0, bounds[2], 0), new Vec3(0, 1, 0)),
                  new Plane().setFromPointNormal(new Vec3(0, bounds[3], 0), new Vec3(0, -1, 0)),
                  new Plane().setFromPointNormal(new Vec3(0, 0, bounds[4]), new Vec3(0, 0, 1)),
                  new Plane().setFromPointNormal(new Vec3(0, 0, bounds[5]), new Vec3(0, 0, -1))
              ]
            : [];

    const renders = rootEntity.findComponents('render') as RenderComponent[];
    for (const render of renders) {
        for (const mi of render.meshInstances) {
            mi.clippingPlanes = planes;
        }
    }
};

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

export class GlbModelElement extends Element {
    asset: Asset;
    entity: Entity;
    localBoundStorage = new BoundingBox();
    worldBoundStorage = new BoundingBox();

    constructor(asset: Asset, entity: Entity) {
        super(ElementType.model);
        this.asset = asset;
        this.entity = entity;
    }

    override add() {
        this.scene.contentRoot.addChild(this.entity);
        computeEntityMeshBound(this.entity, this.localBoundStorage);
        this.worldBoundStorage.copy(this.localBoundStorage);
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
        if (!this.entity) return null;
        this.worldBoundStorage.setFromTransformedAabb(this.localBoundStorage, this.entity.getWorldTransform());
        return this.worldBoundStorage;
    }
}

export const loadGlbEntityOnApp = (
    app: AppBase,
    url: string,
    filename: string
): Promise<{ asset: Asset; entity: Entity }> => {
    const assetName = filename.toLowerCase().endsWith('.glb') ? filename : `${filename}.glb`;
    const asset = new Asset(assetName, 'container', { url, filename: assetName });

    return new Promise<{ asset: Asset; entity: Entity }>((resolve, reject) => {
        asset.once('load', () => {
            try {
                const resource = asset.resource as ContainerResource;
                const containerEntity = resource.instantiateRenderEntity();
                containerEntity.name = assetName;
                applyUnlitMaterials(containerEntity);

                const wrapper = new Entity('glbModelRoot', app);
                wrapper.addChild(containerEntity);
                resolve({ asset, entity: wrapper });
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

export const loadGlbModelElement = async (scene: Scene, url: string, filename: string): Promise<GlbModelElement> => {
    const { asset, entity } = await loadGlbEntityOnApp(scene.app, url, filename);
    return new GlbModelElement(asset, entity);
};

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

const raycastMeshInstance = (ray: Ray, mi: MeshInstance): number | null => {
    if (!mi.aabb.intersectsRay(ray)) return null;

    const mesh = mi.mesh;
    if (!mesh) return null;

    const positions: number[] = [];
    const indices: number[] = [];
    try {
        mesh.getPositions(positions);
        mesh.getIndices(indices);
    } catch {
        return mi.aabb.intersectsRay(ray, tempHit) ? ray.origin.distance(tempHit) : null;
    }

    if (positions.length < 9) {
        return mi.aabb.intersectsRay(ray, tempHit) ? ray.origin.distance(tempHit) : null;
    }

    const worldMat = mi.node.getWorldTransform();
    let minT = Infinity;

    if (indices.length >= 3) {
        for (let i = 0; i + 2 < indices.length; i += 3) {
            const i0 = indices[i] * 3;
            const i1 = indices[i + 1] * 3;
            const i2 = indices[i + 2] * 3;
            v0.set(positions[i0], positions[i0 + 1], positions[i0 + 2]);
            v1.set(positions[i1], positions[i1 + 1], positions[i1 + 2]);
            v2.set(positions[i2], positions[i2 + 1], positions[i2 + 2]);
            worldMat.transformPoint(v0, v0);
            worldMat.transformPoint(v1, v1);
            worldMat.transformPoint(v2, v2);
            const t = intersectTriangle(ray.origin, ray.direction, v0, v1, v2);
            if (t !== null && t < minT) minT = t;
        }
    } else {
        for (let i = 0; i + 8 < positions.length; i += 9) {
            v0.set(positions[i], positions[i + 1], positions[i + 2]);
            v1.set(positions[i + 3], positions[i + 4], positions[i + 5]);
            v2.set(positions[i + 6], positions[i + 7], positions[i + 8]);
            worldMat.transformPoint(v0, v0);
            worldMat.transformPoint(v1, v1);
            worldMat.transformPoint(v2, v2);
            const t = intersectTriangle(ray.origin, ray.direction, v0, v1, v2);
            if (t !== null && t < minT) minT = t;
        }
    }

    if (Number.isFinite(minT)) return minT;
    return mi.aabb.intersectsRay(ray, tempHit) ? ray.origin.distance(tempHit) : null;
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
        const renders = rootEntity.findComponents('render') as RenderComponent[];
        for (const render of renders) {
            for (const mi of render.meshInstances) {
                const t = raycastMeshInstance(ray, mi);
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

export const raycastGlbModels = (
    scene: Scene,
    models: GlbModelElement[],
    clientX: number,
    clientY: number,
    rect: DOMRect
): Vec3 | null => {
    const cam = scene.camera?.mainCamera?.camera;
    if (!cam) return null;
    return raycastCameraAgainstEntities(
        cam,
        models.map((m) => m.entity),
        clientX,
        clientY,
        rect
    );
};
