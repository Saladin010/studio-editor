import { Vec3 } from 'playcanvas';

import { BoxShape } from '../box-shape';
import { ElementType } from '../element';
import type { Events } from '../events';
import type { Scene } from '../scene';
import type { Splat } from '../splat';

import {
    extractModelFilename,
    isGlbUrl,
    loadGlbModelElement,
    normalizeCropBounds,
    raycastGlbModelsWithHit
} from './glb-model';
import type { CropBoxBounds, GlbModelElement, RoomTransformDto } from './glb-model';

export type { CropBoxBounds, RoomTransformDto };

export type GizmoMode = 'translate' | 'rotate' | 'scale' | 'none';

export interface AssemblyRoomLoadItem {
    instanceId: string;
    signedModelUrl: string;
    displayLabel?: string;
    transform?: Partial<RoomTransformDto>;
    cropBounds?: CropBoxBounds | { min: number[]; max: number[] } | null;
    visible?: boolean;
}

export interface LoadAssemblyRoomsPayload {
    rooms: AssemblyRoomLoadItem[];
    activeInstanceId?: string;
    concurrency?: number;
}

export interface LoadAssemblyRoomsResult {
    success: boolean;
    loadedCount: number;
    failedInstanceIds: string[];
    totalTriangles: number;
}

export interface SpawnPose {
    position: [number, number, number];
    target: [number, number, number];
    matrix: number[];
    fov: number;
    pose: number[];
}

export interface StudioBridgeAPI {
    loadSog(signedModelUrl: string): Promise<boolean>;
    getCropBox(): CropBoxBounds;
    setCropBox(bounds: CropBoxBounds): void;
    getFloorTilt(): number;
    setFloorTilt(degrees: number): void;
    calibrateDoorScale(
        doorHeightMeters?: number,
        instanceId?: string
    ): { scaleFactor: number; currentScale: number; instanceId?: string; transform?: RoomTransformDto };
    captureSpawnPose(instanceId?: string): SpawnPose;
    enableSplatPick(callback?: (coords: [number, number, number]) => void): void;
    disableSplatPick(): void;
    loadAssemblyRooms?(payload: LoadAssemblyRoomsPayload): Promise<LoadAssemblyRoomsResult>;
    addRoomInstance?(
        payload: AssemblyRoomLoadItem & { select?: boolean; focus?: boolean }
    ): Promise<{ success: boolean; instanceId: string; triangles: number }>;
    removeRoomInstance?(instanceId: string): { success: boolean };
    selectRoomInstance?(instanceId: string | null, focus?: boolean): { success: boolean; instanceId: string | null };
    setRoomTransform?(
        instanceId: string,
        transform: Partial<RoomTransformDto>
    ): { success: boolean; transform: RoomTransformDto | null };
    setRoomVisibility?(instanceId: string, visible: boolean): { success: boolean };
    alignFloorY?(
        instanceId: string,
        targetFloorY?: number,
        referenceInstanceId?: string
    ): { success: boolean; instanceId: string; transform: RoomTransformDto | null; worldMinY: number };
    setGizmoMode?(mode: GizmoMode): { success: boolean; mode: GizmoMode };
    setRoomCropBox?(
        instanceId: string,
        bounds: CropBoxBounds | { min: number[]; max: number[] } | null
    ): { success: boolean };
    setCameraPose?(
        position: [number, number, number],
        target: [number, number, number],
        fov?: number,
        speed?: number
    ): { success: boolean };
}

export interface StudioMessage {
    type: string;
    id?: string;
    payload?: Record<string, unknown>;
    coords?: [number, number, number];
    pose?: SpawnPose;
    bounds?: CropBoxBounds;
    degrees?: number;
    instanceId?: string | null;
    transform?: RoomTransformDto;
    isFinal?: boolean;
    loaded?: number;
    total?: number;
    loadedCount?: number;
    failedInstanceIds?: string[];
    totalTriangles?: number;
    triangles?: number;
    data?: unknown;
    error?: string;
}

export const notifyParent = (msg: StudioMessage) => {
    if (window.parent && window.parent !== window) {
        window.parent.postMessage(msg, '*');
    }
};

const respond = (targetWindow: Window | null, origin: string, id: string | undefined, data?: unknown, error?: string) => {
    if (!targetWindow) return;
    targetWindow.postMessage(
        {
            type: 'studio:response',
            id,
            data,
            error
        },
        origin === 'null' ? '*' : origin
    );
};

export const registerStudioBridgeListener = (bridge: StudioBridgeAPI): void => {
    (window as Window & { studioBridge?: StudioBridgeAPI }).studioBridge = bridge;

    window.addEventListener('message', async (event: MessageEvent) => {
        const data = event.data as { type?: unknown; payload?: Record<string, unknown>; id?: string } | null;
        if (!data || typeof data !== 'object') return;

        const { type, payload, id } = data;
        if (!type || typeof type !== 'string' || !type.startsWith('studio:')) return;

        const source = event.source as Window | null;

        try {
            switch (type) {
                case 'studio:ping': {
                    respond(source, event.origin, id, { status: 'ready' });
                    break;
                }
                case 'studio:loadSog': {
                    const ok = await bridge.loadSog(payload?.signedModelUrl as string);
                    respond(source, event.origin, id, { success: ok });
                    break;
                }
                case 'studio:getCropBox': {
                    const bounds = bridge.getCropBox();
                    respond(source, event.origin, id, { bounds });
                    break;
                }
                case 'studio:setCropBox': {
                    if (payload?.bounds) {
                        bridge.setCropBox(payload.bounds as CropBoxBounds);
                    }
                    respond(source, event.origin, id, { success: true });
                    break;
                }
                case 'studio:getFloorTilt': {
                    const degrees = bridge.getFloorTilt();
                    respond(source, event.origin, id, { degrees });
                    break;
                }
                case 'studio:setFloorTilt': {
                    bridge.setFloorTilt((payload?.degrees as number | undefined) ?? 0);
                    respond(source, event.origin, id, { success: true });
                    break;
                }
                case 'studio:calibrateDoorScale': {
                    const res = bridge.calibrateDoorScale(
                        payload?.doorHeightMeters as number | undefined,
                        payload?.instanceId as string | undefined
                    );
                    respond(source, event.origin, id, res);
                    break;
                }
                case 'studio:captureSpawnPose': {
                    const instanceId = payload?.instanceId as string | undefined;
                    const pose = bridge.captureSpawnPose(instanceId);
                    respond(source, event.origin, id, { pose, instanceId: instanceId ?? null });
                    break;
                }
                case 'studio:enableSplatPick': {
                    bridge.enableSplatPick();
                    respond(source, event.origin, id, { enabled: true });
                    break;
                }
                case 'studio:disableSplatPick': {
                    bridge.disableSplatPick();
                    respond(source, event.origin, id, { disabled: true });
                    break;
                }
                case 'studio:loadAssemblyRooms': {
                    if (!bridge.loadAssemblyRooms) {
                        throw new Error('loadAssemblyRooms is not supported in this renderer');
                    }
                    const res = await bridge.loadAssemblyRooms(
                        (payload as unknown as LoadAssemblyRoomsPayload) ?? { rooms: [] }
                    );
                    respond(source, event.origin, id, res);
                    break;
                }
                case 'studio:addRoomInstance': {
                    if (!bridge.addRoomInstance) {
                        throw new Error('addRoomInstance is not supported in this renderer');
                    }
                    const res = await bridge.addRoomInstance(
                        payload as unknown as AssemblyRoomLoadItem & { select?: boolean; focus?: boolean }
                    );
                    respond(source, event.origin, id, res);
                    break;
                }
                case 'studio:removeRoomInstance': {
                    if (!bridge.removeRoomInstance) {
                        throw new Error('removeRoomInstance is not supported in this renderer');
                    }
                    const res = bridge.removeRoomInstance(payload?.instanceId as string);
                    respond(source, event.origin, id, res);
                    break;
                }
                case 'studio:selectRoomInstance': {
                    if (!bridge.selectRoomInstance) {
                        throw new Error('selectRoomInstance is not supported in this renderer');
                    }
                    const res = bridge.selectRoomInstance(
                        (payload?.instanceId as string | null | undefined) ?? null,
                        Boolean(payload?.focus)
                    );
                    respond(source, event.origin, id, res);
                    break;
                }
                case 'studio:setRoomTransform': {
                    if (!bridge.setRoomTransform) {
                        throw new Error('setRoomTransform is not supported in this renderer');
                    }
                    const res = bridge.setRoomTransform(
                        payload?.instanceId as string,
                        (payload?.transform as Partial<RoomTransformDto> | undefined) ?? {}
                    );
                    respond(source, event.origin, id, res);
                    break;
                }
                case 'studio:setRoomVisibility': {
                    if (!bridge.setRoomVisibility) {
                        throw new Error('setRoomVisibility is not supported in this renderer');
                    }
                    const res = bridge.setRoomVisibility(payload?.instanceId as string, Boolean(payload?.visible));
                    respond(source, event.origin, id, res);
                    break;
                }
                case 'studio:alignFloorY': {
                    if (!bridge.alignFloorY) {
                        throw new Error('alignFloorY is not supported in this renderer');
                    }
                    const res = bridge.alignFloorY(
                        payload?.instanceId as string,
                        payload?.targetFloorY as number | undefined,
                        payload?.referenceInstanceId as string | undefined
                    );
                    respond(source, event.origin, id, res);
                    break;
                }
                case 'studio:setGizmoMode': {
                    if (!bridge.setGizmoMode) {
                        throw new Error('setGizmoMode is not supported in this renderer');
                    }
                    const res = bridge.setGizmoMode((payload?.mode as GizmoMode | undefined) ?? 'none');
                    respond(source, event.origin, id, res);
                    break;
                }
                case 'studio:setRoomCropBox': {
                    if (!bridge.setRoomCropBox) {
                        throw new Error('setRoomCropBox is not supported in this renderer');
                    }
                    const res = bridge.setRoomCropBox(
                        payload?.instanceId as string,
                        (payload?.bounds as CropBoxBounds | { min: number[]; max: number[] } | null | undefined) ?? null
                    );
                    respond(source, event.origin, id, res);
                    break;
                }
                case 'studio:setCameraPose': {
                    if (!bridge.setCameraPose) {
                        throw new Error('setCameraPose is not supported in this renderer');
                    }
                    const res = bridge.setCameraPose(
                        payload?.position as [number, number, number],
                        payload?.target as [number, number, number],
                        payload?.fov as number | undefined,
                        payload?.speed as number | undefined
                    );
                    respond(source, event.origin, id, res);
                    break;
                }
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            respond(source, event.origin, id, undefined, message);
        }
    });

    notifyParent({ type: 'studio:ready' });
};

const tmpCropCenter = new Vec3();
const tmpPosePos = new Vec3();
const tmpPoseTarget = new Vec3();

export const initStudioBridge = (events: Events, scene: Scene): StudioBridgeAPI => {
    let cropBoxShape: BoxShape | null = null;
    let currentCropBounds: CropBoxBounds = [-5, 5, -5, 5, -5, 5];
    let currentFloorTilt = 0;
    let isPickingActive = false;
    let currentPickCallback: ((coords: [number, number, number]) => void) | null = null;

    // Multi-room assembly state (O(1) Map keyed by instanceId)
    const roomsById = new Map<string, GlbModelElement>();
    let activeInstanceId: string | null = null;
    let assemblyLoadGeneration = 0;
    let isGizmoDragging = false;
    let transformThrottleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastTransformEmitAt = 0;
    let pointerDownInfo: { x: number; y: number } | null = null;

    const getCanvas = (): HTMLCanvasElement | null => {
        const deviceCanvas = (scene.app?.graphicsDevice as { canvas?: HTMLCanvasElement } | undefined)?.canvas;
        const sceneCanvas = (scene as unknown as { canvas?: HTMLCanvasElement }).canvas;
        return deviceCanvas || sceneCanvas || document.querySelector('canvas');
    };

    const getActiveGlbModel = (instanceId?: string): GlbModelElement | null => {
        if (instanceId) {
            return roomsById.get(instanceId) ?? null;
        }
        if (activeInstanceId) {
            const active = roomsById.get(activeInstanceId);
            if (active) return active;
        }
        const models = scene.getElementsByType(ElementType.model) as GlbModelElement[];
        return models[0] ?? null;
    };

    const updateCropBoxVisual = (bounds: CropBoxBounds | null, room?: GlbModelElement | null) => {
        if (!bounds) {
            if (cropBoxShape) {
                cropBoxShape.pivot.enabled = false;
                scene.forceRender = true;
            }
            return;
        }

        const [minX, maxX, minY, maxY, minZ, maxZ] = bounds;
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const cz = (minZ + maxZ) / 2;
        const lx = Math.max(0.01, maxX - minX);
        const ly = Math.max(0.01, maxY - minY);
        const lz = Math.max(0.01, maxZ - minZ);

        if (!cropBoxShape) {
            cropBoxShape = new BoxShape();
            scene.add(cropBoxShape);
        }

        cropBoxShape.pivot.enabled = true;
        if (room) {
            const worldTransform = room.entity.getWorldTransform();
            tmpCropCenter.set(cx, cy, cz);
            worldTransform.transformPoint(tmpCropCenter, tmpCropCenter);
            const sc = room.entity.getLocalScale();
            cropBoxShape.lenX = lx * Math.max(0.01, sc.x);
            cropBoxShape.lenY = ly * Math.max(0.01, sc.y);
            cropBoxShape.lenZ = lz * Math.max(0.01, sc.z);
            cropBoxShape.pivot.setLocalPosition(tmpCropCenter);
            cropBoxShape.pivot.setLocalRotation(room.entity.getRotation());
        } else {
            cropBoxShape.lenX = lx;
            cropBoxShape.lenY = ly;
            cropBoxShape.lenZ = lz;
            cropBoxShape.pivot.setLocalPosition(cx, cy, cz);
            cropBoxShape.pivot.setLocalEulerAngles(0, 0, 0);
        }
        cropBoxShape.updateBound();
    };

    const emitRoomTransform = (model: GlbModelElement, isFinal: boolean) => {
        notifyParent({
            type: 'studio:roomTransformChanged',
            instanceId: model.instanceId,
            transform: model.getTransformDto(),
            isFinal
        });
    };

    const flushPendingTransformThrottle = () => {
        if (transformThrottleTimer !== null) {
            clearTimeout(transformThrottleTimer);
            transformThrottleTimer = null;
        }
    };

    events.on('pivot.started', () => {
        isGizmoDragging = true;
    });

    events.on('pivot.ended', () => {
        isGizmoDragging = false;
    });

    events.on('glb.transformMoving', (model: GlbModelElement) => {
        if (model.instanceId === activeInstanceId && model.cropBounds) {
            updateCropBoxVisual(model.cropBounds, model);
        }

        const now = performance.now();
        const elapsed = now - lastTransformEmitAt;
        if (elapsed >= 66) {
            flushPendingTransformThrottle();
            lastTransformEmitAt = now;
            emitRoomTransform(model, false);
        } else if (transformThrottleTimer === null) {
            transformThrottleTimer = setTimeout(() => {
                transformThrottleTimer = null;
                lastTransformEmitAt = performance.now();
                emitRoomTransform(model, false);
            }, 66 - elapsed);
        }
    });

    events.on('glb.transformEnded', (model: GlbModelElement, changed: boolean) => {
        flushPendingTransformThrottle();
        if (model.instanceId === activeInstanceId && model.cropBounds) {
            updateCropBoxVisual(model.cropBounds, model);
        }
        if (changed) {
            lastTransformEmitAt = performance.now();
            emitRoomTransform(model, true);
        }
    });

    events.on('scene.clear', () => {
        flushPendingTransformThrottle();
        roomsById.clear();
        activeInstanceId = null;
        cropBoxShape = null;
    });

    events.on('scene.elementRemoved', (el) => {
        if (el.type === ElementType.model) {
            const glb = el as GlbModelElement;
            if (roomsById.get(glb.instanceId) === glb) {
                roomsById.delete(glb.instanceId);
            }
            if (activeInstanceId === glb.instanceId) {
                activeInstanceId = null;
            }
        }
    });

    events.on('selection.changed', (sel) => {
        if (sel && sel.type === ElementType.model) {
            const glb = sel as GlbModelElement;
            if (activeInstanceId !== glb.instanceId) {
                activeInstanceId = glb.instanceId;
            }
            if (glb.cropBounds) {
                updateCropBoxVisual(glb.cropBounds, glb);
            } else {
                updateCropBoxVisual(null);
            }
        } else if (!sel && activeInstanceId !== null) {
            activeInstanceId = null;
            updateCropBoxVisual(null);
        }
    });

    const disableSplatPick = () => {
        isPickingActive = false;
        currentPickCallback = null;
        const canvas = getCanvas();
        if (canvas) {
            canvas.style.cursor = '';
        }
    };

    const enableSplatPick = (callback?: (coords: [number, number, number]) => void) => {
        isPickingActive = true;
        currentPickCallback = callback || null;
        const canvas = getCanvas();
        if (canvas) {
            canvas.style.cursor = 'crosshair';
        }
    };

    const focusSceneBound = (speed = 0) => {
        const bound = scene.bound;
        if (bound) {
            scene.camera.focus({
                focalPoint: bound.center,
                radius: Math.max(1, bound.halfExtents.length()),
                speed
            });
        }
    };

    const focusModel = (model: GlbModelElement, speed = 0.5) => {
        const bound = model.worldBound;
        if (bound) {
            scene.camera.focus({
                focalPoint: bound.center,
                radius: Math.max(1, bound.halfExtents.length()),
                speed
            });
        }
    };

    const selectModelInternal = (model: GlbModelElement | null, focus = false, notify = false) => {
        if (model && !model.visible) {
            return;
        }
        activeInstanceId = model ? model.instanceId : null;
        events.fire('selection', model);
        if (model) {
            if (model.cropBounds) {
                updateCropBoxVisual(model.cropBounds, model);
            } else {
                updateCropBoxVisual(null);
            }
            if (focus) {
                focusModel(model);
            }
        } else {
            updateCropBoxVisual(null);
        }
        if (notify) {
            notifyParent({
                type: 'studio:roomSelected',
                instanceId: activeInstanceId
            });
        }
    };

    // Canvas click listener for hotspot picking & multi-room selection
    const handlePointerDown = async (event: PointerEvent) => {
        if (event.button !== 0) return;

        if (!isPickingActive) {
            pointerDownInfo = { x: event.clientX, y: event.clientY };
            return;
        }

        const canvas = getCanvas();
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const nx = (event.clientX - rect.left) / rect.width;
        const ny = (event.clientY - rect.top) / rect.height;

        let coords: [number, number, number] | null = null;
        let hitInstanceId: string | null = activeInstanceId;

        try {
            const models = scene.getElementsByType(ElementType.model) as GlbModelElement[];
            if (models.length > 0) {
                const glbHit = raycastGlbModelsWithHit(scene, models, event.clientX, event.clientY, rect);
                if (glbHit) {
                    coords = [
                        Number(glbHit.point.x.toFixed(3)),
                        Number(glbHit.point.y.toFixed(3)),
                        Number(glbHit.point.z.toFixed(3))
                    ];
                    hitInstanceId = glbHit.model?.instanceId ?? activeInstanceId;
                }
            } else {
                const hit = await scene.camera.intersect(nx, ny);
                if (hit && hit.position) {
                    coords = [
                        Number(hit.position.x.toFixed(3)),
                        Number(hit.position.y.toFixed(3)),
                        Number(hit.position.z.toFixed(3))
                    ];
                }
            }
        } catch (err) {
            console.warn('[StudioBridge] Intersect calculation failed:', err);
        }

        if (!coords) {
            const focal = scene.camera.focalPoint;
            coords = [
                Number(focal.x.toFixed(3)),
                Number(focal.y.toFixed(3)),
                Number(focal.z.toFixed(3))
            ];
        }

        if (currentPickCallback) {
            currentPickCallback(coords);
        }

        notifyParent({
            type: 'studio:splatPicked',
            coords,
            instanceId: hitInstanceId
        });

        disableSplatPick();
    };

    const handlePointerUp = (event: PointerEvent) => {
        if (event.button !== 0 || isPickingActive || isGizmoDragging || !pointerDownInfo) {
            pointerDownInfo = null;
            return;
        }

        const dx = event.clientX - pointerDownInfo.x;
        const dy = event.clientY - pointerDownInfo.y;
        pointerDownInfo = null;
        if (dx * dx + dy * dy > 25) return; // Dragged camera

        const models = scene.getElementsByType(ElementType.model) as GlbModelElement[];
        if (models.length <= 1) return;

        const canvas = getCanvas();
        if (!canvas) return;

        const hit = raycastGlbModelsWithHit(scene, models, event.clientX, event.clientY, canvas.getBoundingClientRect());
        if (hit?.model && hit.model.instanceId !== activeInstanceId) {
            selectModelInternal(hit.model, false, true);
        }
    };

    const canvas = getCanvas();
    if (canvas) {
        canvas.addEventListener('pointerdown', handlePointerDown);
        canvas.addEventListener('pointerup', handlePointerUp);
    }

    const loadSingleRoomModel = async (item: AssemblyRoomLoadItem): Promise<GlbModelElement> => {
        const rawFilename = extractModelFilename(item.signedModelUrl, `${item.instanceId}.glb`);
        const model = await loadGlbModelElement(
            scene,
            item.signedModelUrl,
            rawFilename,
            item.instanceId,
            item.displayLabel || rawFilename
        );
        if (item.transform) {
            model.setTransformDto(item.transform, false);
        }
        if (item.cropBounds !== undefined) {
            model.setCropBounds(item.cropBounds);
        }
        model.visible = item.visible !== false;
        return model;
    };

    const bridge: StudioBridgeAPI = {
        loadSog: async (signedModelUrl: string): Promise<boolean> => {
            if (!signedModelUrl) {
                throw new Error('signedModelUrl is required');
            }

            assemblyLoadGeneration++;
            events.fire('scene.clear');

            const rawFilename = extractModelFilename(signedModelUrl, isGlbUrl(signedModelUrl) ? 'scene.glb' : 'scene.sog');
            if (isGlbUrl(signedModelUrl)) {
                const modelElement = await loadGlbModelElement(scene, signedModelUrl, rawFilename, 'legacy');
                await scene.add(modelElement);
                roomsById.set(modelElement.instanceId, modelElement);
                activeInstanceId = modelElement.instanceId;
                focusSceneBound(0);
            } else {
                const lower = rawFilename.toLowerCase();
                const filename = lower.endsWith('.sog') || lower.endsWith('.ply') ? rawFilename : `${rawFilename}.sog`;
                await events.invoke('import', [
                    {
                        filename,
                        url: signedModelUrl
                    }
                ]);
            }

            if (currentFloorTilt !== 0) {
                bridge.setFloorTilt(currentFloorTilt);
            }

            if (currentCropBounds) {
                bridge.setCropBox(currentCropBounds);
            }

            scene.forceRender = true;
            return true;
        },

        getCropBox: (): CropBoxBounds => {
            const activeGlb = getActiveGlbModel();
            if (activeGlb?.cropBounds) {
                return [...activeGlb.cropBounds];
            }
            if (currentCropBounds) {
                return [...currentCropBounds];
            }
            const splats = scene.getElementsByType(ElementType.splat) as Splat[];
            const targetBound = splats[0]?.worldBound ?? activeGlb?.worldBound;
            if (targetBound) {
                return [
                    Number((targetBound.center.x - targetBound.halfExtents.x).toFixed(2)),
                    Number((targetBound.center.x + targetBound.halfExtents.x).toFixed(2)),
                    Number((targetBound.center.y - targetBound.halfExtents.y).toFixed(2)),
                    Number((targetBound.center.y + targetBound.halfExtents.y).toFixed(2)),
                    Number((targetBound.center.z - targetBound.halfExtents.z).toFixed(2)),
                    Number((targetBound.center.z + targetBound.halfExtents.z).toFixed(2))
                ];
            }
            return [-5, 5, -5, 5, -5, 5];
        },

        setCropBox: (bounds: CropBoxBounds) => {
            currentCropBounds = [...bounds];
            const activeGlb = getActiveGlbModel();
            if (activeGlb) {
                activeGlb.setCropBounds(currentCropBounds);
                updateCropBoxVisual(currentCropBounds, activeGlb);
            } else {
                updateCropBoxVisual(currentCropBounds, null);
                const models = scene.getElementsByType(ElementType.model) as GlbModelElement[];
                for (const model of models) {
                    model.setCropBounds(currentCropBounds);
                }
            }

            scene.boundDirty = true;
            scene.forceRender = true;

            notifyParent({
                type: 'studio:cropBoxChanged',
                bounds: currentCropBounds,
                instanceId: activeGlb?.instanceId ?? null
            });
        },

        getFloorTilt: (): number => {
            return currentFloorTilt;
        },

        setFloorTilt: (degrees: number) => {
            currentFloorTilt = degrees;
            const splats = scene.getElementsByType(ElementType.splat) as Splat[];
            for (const splat of splats) {
                const cur = splat.entity.getLocalEulerAngles();
                splat.entity.setLocalEulerAngles(degrees, cur.y, cur.z);
            }
            const activeGlb = getActiveGlbModel();
            if (activeGlb) {
                const t = activeGlb.getTransformDto();
                activeGlb.setTransformDto({
                    rotationEulerDeg: [degrees, t.rotationEulerDeg[1], t.rotationEulerDeg[2]]
                });
            } else {
                const models = scene.getElementsByType(ElementType.model) as GlbModelElement[];
                for (const model of models) {
                    const t = model.getTransformDto();
                    model.setTransformDto({
                        rotationEulerDeg: [degrees, t.rotationEulerDeg[1], t.rotationEulerDeg[2]]
                    });
                }
            }
            scene.boundDirty = true;
            scene.forceRender = true;

            notifyParent({
                type: 'studio:floorTiltChanged',
                degrees: currentFloorTilt
            });
        },

        calibrateDoorScale: (
            doorHeightMeters = 2.1,
            instanceId?: string
        ): { scaleFactor: number; currentScale: number; instanceId?: string; transform?: RoomTransformDto } => {
            const splats = scene.getElementsByType(ElementType.splat) as Splat[];
            const targetGlb = getActiveGlbModel(instanceId);
            const target = targetGlb ?? splats[0];
            if (!target) {
                return { scaleFactor: 1, currentScale: 1 };
            }
            let measuredHeight = 0;

            const measureTarget = target as unknown as { measurePoints?: Vec3[] };
            if (measureTarget.measurePoints && measureTarget.measurePoints.length >= 2) {
                const pts = measureTarget.measurePoints;
                measuredHeight = pts[0].distance(pts[1]);
            } else if (target.worldBound) {
                measuredHeight = target.worldBound.halfExtents.y * 2 * 0.75;
            }

            if (measuredHeight <= 0.01) {
                measuredHeight = 2.1;
            }

            const scaleFactor = doorHeightMeters / measuredHeight;
            const curScale = target.entity.getLocalScale();
            const newScaleX = curScale.x * scaleFactor;

            if (targetGlb) {
                targetGlb.setTransformDto({ scale: newScaleX }, true);
                const dto = targetGlb.getTransformDto();
                emitRoomTransform(targetGlb, true);
                return {
                    scaleFactor,
                    currentScale: dto.scale,
                    instanceId: targetGlb.instanceId,
                    transform: dto
                };
            }

            target.entity.setLocalScale(newScaleX, curScale.y * scaleFactor, curScale.z * scaleFactor);
            scene.boundDirty = true;
            scene.forceRender = true;

            return {
                scaleFactor,
                currentScale: newScaleX
            };
        },

        captureSpawnPose: (instanceId?: string): SpawnPose => {
            const camera = scene.camera;
            const pos = camera.position;
            const target = camera.focalPoint;
            const rawMatrix = camera.mainCamera?.getWorldTransform()?.data;
            const matrix: number[] = rawMatrix ? Array.from(rawMatrix) : [];
            const fov = camera.fov;
            const pose = [
                Number(pos.x.toFixed(4)),
                Number(pos.y.toFixed(4)),
                Number(pos.z.toFixed(4)),
                Number(target.x.toFixed(4)),
                Number(target.y.toFixed(4)),
                Number(target.z.toFixed(4)),
                Number(fov.toFixed(2))
            ];

            const spawnPose: SpawnPose = {
                position: [pos.x, pos.y, pos.z],
                target: [target.x, target.y, target.z],
                matrix,
                fov,
                pose
            };

            notifyParent({
                type: 'studio:spawnPoseCaptured',
                pose: spawnPose,
                instanceId: instanceId ?? activeInstanceId
            });

            return spawnPose;
        },

        enableSplatPick,
        disableSplatPick,

        // -------------------------------------------------------------------
        // Multi-Room Assembly Commands
        // -------------------------------------------------------------------

        loadAssemblyRooms: async (payload: LoadAssemblyRoomsPayload): Promise<LoadAssemblyRoomsResult> => {
            const rooms = Array.isArray(payload?.rooms) ? payload.rooms : [];
            const gen = ++assemblyLoadGeneration;

            events.fire('scene.clear');
            events.fire('grid.setVisible', true);

            if (rooms.length === 0) {
                scene.forceRender = true;
                notifyParent({
                    type: 'studio:assemblyLoaded',
                    loadedCount: 0,
                    failedInstanceIds: [],
                    totalTriangles: 0
                });
                return { success: true, loadedCount: 0, failedInstanceIds: [], totalTriangles: 0 };
            }

            const concurrency = Math.max(1, Math.min(6, payload?.concurrency ?? 3));
            let nextIndex = 0;
            let loadedCount = 0;
            let totalTriangles = 0;
            const failedInstanceIds: string[] = [];

            const worker = async () => {
                while (true) {
                    const idx = nextIndex++;
                    if (idx >= rooms.length || gen !== assemblyLoadGeneration) return;

                    const item = rooms[idx];
                    if (!item?.instanceId || !item?.signedModelUrl) {
                        if (item?.instanceId) failedInstanceIds.push(item.instanceId);
                        continue;
                    }

                    try {
                        const model = await loadSingleRoomModel(item);
                        if (gen !== assemblyLoadGeneration) {
                            // Stale load: dispose asset without registering in scene
                            model.entity.destroy();
                            scene.app.assets.remove(model.asset);
                            model.asset.unload();
                            return;
                        }
                        await scene.add(model);
                        roomsById.set(model.instanceId, model);
                        loadedCount++;
                        totalTriangles += model.triangleCount;

                        notifyParent({
                            type: 'studio:assemblyLoadProgress',
                            loaded: loadedCount,
                            total: rooms.length,
                            instanceId: model.instanceId,
                            triangles: model.triangleCount
                        });
                    } catch (err) {
                        console.warn(`[StudioBridge] Failed to load room ${item.instanceId}:`, err);
                        failedInstanceIds.push(item.instanceId);
                    }
                }
            };

            await Promise.all(Array.from({ length: Math.min(concurrency, rooms.length) }, () => worker()));

            if (gen !== assemblyLoadGeneration) {
                return { success: false, loadedCount: 0, failedInstanceIds: [], totalTriangles: 0 };
            }

            const requestedActive = payload.activeInstanceId ? roomsById.get(payload.activeInstanceId) : null;
            const fallbackActive = Array.from(roomsById.values()).find((m) => m.visible) ?? null;
            selectModelInternal(requestedActive && requestedActive.visible ? requestedActive : fallbackActive, false, true);

            focusSceneBound(0);
            scene.forceRender = true;

            notifyParent({
                type: 'studio:assemblyLoaded',
                loadedCount,
                failedInstanceIds,
                totalTriangles
            });

            return {
                success: failedInstanceIds.length === 0,
                loadedCount,
                failedInstanceIds,
                totalTriangles
            };
        },

        addRoomInstance: async (
            payload: AssemblyRoomLoadItem & { select?: boolean; focus?: boolean }
        ): Promise<{ success: boolean; instanceId: string; triangles: number }> => {
            if (!payload?.instanceId || !payload?.signedModelUrl) {
                throw new Error('instanceId and signedModelUrl are required');
            }

            // Replace existing instance cleanly if re-added with the same instanceId
            const existing = roomsById.get(payload.instanceId);
            if (existing) {
                existing.destroy();
                roomsById.delete(payload.instanceId);
            }

            const model = await loadSingleRoomModel(payload);
            await scene.add(model);
            roomsById.set(model.instanceId, model);

            if (payload.select !== false && model.visible) {
                selectModelInternal(model, Boolean(payload.focus), true);
            } else if (payload.focus) {
                focusModel(model);
            }

            scene.forceRender = true;
            return {
                success: true,
                instanceId: model.instanceId,
                triangles: model.triangleCount
            };
        },

        removeRoomInstance: (instanceId: string): { success: boolean } => {
            const model = roomsById.get(instanceId);
            if (!model) {
                return { success: false };
            }
            const wasActive = activeInstanceId === instanceId;
            roomsById.delete(instanceId);
            model.destroy();

            if (wasActive) {
                const next = Array.from(roomsById.values()).find((m) => m.visible) ?? null;
                selectModelInternal(next, false, true);
            }

            scene.boundDirty = true;
            scene.forceRender = true;
            return { success: true };
        },

        selectRoomInstance: (
            instanceId: string | null,
            focus = false
        ): { success: boolean; instanceId: string | null } => {
            if (!instanceId) {
                selectModelInternal(null, false, false);
                return { success: true, instanceId: null };
            }
            const model = roomsById.get(instanceId) ?? null;
            if (!model) {
                return { success: false, instanceId: activeInstanceId };
            }
            selectModelInternal(model, focus, false);
            return { success: true, instanceId: model.instanceId };
        },

        setRoomTransform: (
            instanceId: string,
            transform: Partial<RoomTransformDto>
        ): { success: boolean; transform: RoomTransformDto | null } => {
            const model = roomsById.get(instanceId);
            if (!model) {
                return { success: false, transform: null };
            }
            model.setTransformDto(transform, true);
            if (model.instanceId === activeInstanceId && model.cropBounds) {
                updateCropBoxVisual(model.cropBounds, model);
            }
            return { success: true, transform: model.getTransformDto() };
        },

        setRoomVisibility: (instanceId: string, visible: boolean): { success: boolean } => {
            const model = roomsById.get(instanceId);
            if (!model) {
                return { success: false };
            }
            model.visible = visible;
            if (!visible && activeInstanceId === instanceId) {
                events.fire('selection', null);
                activeInstanceId = null;
                updateCropBoxVisual(null);
            }
            return { success: true };
        },

        alignFloorY: (
            instanceId: string,
            targetFloorY?: number,
            referenceInstanceId?: string
        ): { success: boolean; instanceId: string; transform: RoomTransformDto | null; worldMinY: number } => {
            const model = roomsById.get(instanceId);
            if (!model) {
                return { success: false, instanceId, transform: null, worldMinY: 0 };
            }

            let desiredFloorY = typeof targetFloorY === 'number' && Number.isFinite(targetFloorY) ? targetFloorY : 0;
            if (referenceInstanceId) {
                const ref = roomsById.get(referenceInstanceId);
                const refBound = ref?.worldBound;
                if (refBound) {
                    desiredFloorY = refBound.center.y - refBound.halfExtents.y;
                }
            }

            const wasVisible = model.visible;
            if (!wasVisible) model.entity.enabled = true;
            model.worldBoundStorage.setFromTransformedAabb(model.localBoundStorage, model.entity.getWorldTransform());
            const currentMinY = model.worldBoundStorage.center.y - model.worldBoundStorage.halfExtents.y;
            const dy = desiredFloorY - currentMinY;
            if (!wasVisible) model.entity.enabled = false;

            const curPos = model.entity.getLocalPosition();
            model.setTransformDto({ position: [curPos.x, curPos.y + dy, curPos.z] }, true);

            if (model.instanceId === activeInstanceId && model.cropBounds) {
                updateCropBoxVisual(model.cropBounds, model);
            }

            const dto = model.getTransformDto();
            emitRoomTransform(model, true);

            return {
                success: true,
                instanceId: model.instanceId,
                transform: dto,
                worldMinY: Number((currentMinY + dy).toFixed(4))
            };
        },

        setGizmoMode: (mode: GizmoMode): { success: boolean; mode: GizmoMode } => {
            const map: Record<GizmoMode, string | null> = {
                translate: 'move',
                rotate: 'rotate',
                scale: 'scale',
                none: null
            };
            const targetTool = map[mode] ?? null;
            const activeTool = events.invoke('tool.active') as string | null;

            if (targetTool === null) {
                if (activeTool !== null) {
                    events.fire('tool.deactivate');
                }
            } else if (activeTool !== targetTool) {
                // ToolManager toggles off if you fire an already-active tool, so guard with activeTool check.
                events.fire(`tool.${targetTool}`);
            }

            scene.forceRender = true;
            return { success: true, mode };
        },

        setRoomCropBox: (
            instanceId: string,
            bounds: CropBoxBounds | { min: number[]; max: number[] } | null
        ): { success: boolean } => {
            const model = roomsById.get(instanceId);
            if (!model) {
                return { success: false };
            }
            const normalized = normalizeCropBounds(bounds);
            model.setCropBounds(normalized);
            if (model.instanceId === activeInstanceId) {
                updateCropBoxVisual(normalized, model);
            }
            return { success: true };
        },

        setCameraPose: (
            position: [number, number, number],
            target: [number, number, number],
            fov?: number,
            speed = 1
        ): { success: boolean } => {
            if (!Array.isArray(position) || position.length < 3 || !Array.isArray(target) || target.length < 3) {
                return { success: false };
            }
            tmpPosePos.set(Number(position[0]) || 0, Number(position[1]) || 0, Number(position[2]) || 0);
            tmpPoseTarget.set(Number(target[0]) || 0, Number(target[1]) || 0, Number(target[2]) || 0);
            if (tmpPosePos.distance(tmpPoseTarget) < 1e-4) {
                tmpPoseTarget.z -= 1;
            }
            if (typeof fov === 'number' && Number.isFinite(fov) && fov > 10 && fov < 140) {
                scene.camera.fov = fov;
            }
            scene.camera.setPose(tmpPosePos, tmpPoseTarget, speed);
            scene.forceRender = true;
            return { success: true };
        }
    };

    registerStudioBridgeListener(bridge);
    return bridge;
};
