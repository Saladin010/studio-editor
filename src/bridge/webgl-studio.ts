import type { Asset, CameraComponent, GraphicsDevice } from 'playcanvas';
import {
    BoundingBox,
    Color,
    Entity,
    Layer,
    Mat4,
    Quat,
    Ray,
    RotateGizmo,
    ScaleGizmo,
    TranslateGizmo,
    Vec3
} from 'playcanvas';

import { PCApp } from '../pc-app';

import {
    applyLocalCropBoundsToEntity,
    computeEntityMeshBound,
    extractModelFilename,
    isGlbUrl,
    loadGlbEntityOnApp,
    normalizeCropBounds,
    raycastCameraAgainstEntities
} from './glb-model';
import type { CropBoxBounds, RoomTransformDto } from './glb-model';
import { notifyParent, registerStudioBridgeListener } from './studio-bridge';
import type {
    AssemblyRoomLoadItem,
    GizmoMode,
    LoadAssemblyRoomsPayload,
    LoadAssemblyRoomsResult,
    SpawnPose,
    StudioBridgeAPI
} from './studio-bridge';

const GRID_COLOR = new Color(0.24, 0.3, 0.4, 1);
const CROP_BOX_COLOR = new Color(0.06, 0.73, 0.51, 1);
const RAD_TO_DEG = 180 / Math.PI;

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

interface WebglRoomInstance {
    instanceId: string;
    displayLabel: string;
    entity: Entity;
    asset: Asset;
    localBound: BoundingBox;
    worldBound: BoundingBox;
    triangleCount: number;
    cropBounds: CropBoxBounds | null;
    visible: boolean;
}

const drawGrid = (app: PCApp, halfExtent = 10, step = 1) => {
    const positions: Vec3[] = [];
    const colors: Color[] = [];
    for (let i = -halfExtent; i <= halfExtent; i += step) {
        positions.push(new Vec3(i, 0, -halfExtent), new Vec3(i, 0, halfExtent));
        colors.push(GRID_COLOR, GRID_COLOR);
        positions.push(new Vec3(-halfExtent, 0, i), new Vec3(halfExtent, 0, i));
        colors.push(GRID_COLOR, GRID_COLOR);
    }
    app.drawLines(positions, colors, true);
};

const drawCropBox = (app: PCApp, bounds: CropBoxBounds, worldTransform?: Mat4 | null) => {
    const [minX, maxX, minY, maxY, minZ, maxZ] = bounds;
    const c = [
        new Vec3(minX, minY, minZ),
        new Vec3(maxX, minY, minZ),
        new Vec3(maxX, minY, maxZ),
        new Vec3(minX, minY, maxZ),
        new Vec3(minX, maxY, minZ),
        new Vec3(maxX, maxY, minZ),
        new Vec3(maxX, maxY, maxZ),
        new Vec3(minX, maxY, maxZ)
    ];
    if (worldTransform) {
        for (let i = 0; i < c.length; i++) {
            worldTransform.transformPoint(c[i], c[i]);
        }
    }
    const edges: [number, number][] = [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
        [4, 5],
        [5, 6],
        [6, 7],
        [7, 4],
        [0, 4],
        [1, 5],
        [2, 6],
        [3, 7]
    ];
    const positions: Vec3[] = [];
    const colors: Color[] = [];
    for (const [a, b] of edges) {
        positions.push(c[a], c[b]);
        colors.push(CROP_BOX_COLOR, CROP_BOX_COLOR);
    }
    app.drawLines(positions, colors, true);
};

const getRoomTransformDto = (entity: Entity): RoomTransformDto => {
    const pos = entity.getLocalPosition();
    const euler = entity.getLocalEulerAngles();
    const sc = entity.getLocalScale();
    return {
        position: [round4(pos.x), round4(pos.y), round4(pos.z)],
        rotationEulerDeg: [round4(euler.x), round4(euler.y), round4(euler.z)],
        scale: round4((sc.x + sc.y + sc.z) / 3)
    };
};

const applyRoomTransformDto = (entity: Entity, transform: Partial<RoomTransformDto>): void => {
    if (Array.isArray(transform.position) && transform.position.length >= 3) {
        entity.setLocalPosition(
            Number(transform.position[0]) || 0,
            Number(transform.position[1]) || 0,
            Number(transform.position[2]) || 0
        );
    }
    if (Array.isArray(transform.rotationEulerDeg) && transform.rotationEulerDeg.length >= 3) {
        entity.setLocalEulerAngles(
            Number(transform.rotationEulerDeg[0]) || 0,
            Number(transform.rotationEulerDeg[1]) || 0,
            Number(transform.rotationEulerDeg[2]) || 0
        );
    }
    if (typeof transform.scale === 'number' && Number.isFinite(transform.scale)) {
        const safeScale = Math.max(0.01, transform.scale);
        entity.setLocalScale(safeScale, safeScale, safeScale);
    }
};

export const startWebglGlbStudio = async (
    canvas: HTMLCanvasElement,
    graphicsDevice: GraphicsDevice,
    urlParams: URLSearchParams
): Promise<void> => {
    canvas.id = 'canvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';

    const app = new PCApp(canvas, { graphicsDevice });
    const texHandler = app.loader.getHandler('texture') as { imgParser?: { crossOrigin?: string } } | null;
    if (texHandler?.imgParser) {
        texHandler.imgParser.crossOrigin = 'anonymous';
    }
    app.graphicsDevice.maxPixelRatio = window.devicePixelRatio || 1;

    const worldLayer = app.scene.layers.getLayerByName('World');
    const gizmoLayer = new Layer({
        name: 'Gizmo',
        clearDepthBuffer: true,
        clearStencilBuffer: true
    });
    app.scene.layers.push(gizmoLayer);

    const cameraEntity = new Entity('studioCamera', app);
    const cameraLayers = worldLayer ? [worldLayer.id, gizmoLayer.id] : [gizmoLayer.id];
    cameraEntity.addComponent('camera', {
        clearColor: new Color(0.08, 0.11, 0.16, 1),
        fov: 50,
        nearClip: 0.05,
        farClip: 500,
        layers: cameraLayers
    });
    app.root.addChild(cameraEntity);
    const cameraComponent = cameraEntity.camera as CameraComponent;

    // Subtle status badge positioned bottom-right so it never overlaps Angular's gizmo toolbar,
    // load-progress pill, or placement banner.
    const badge = document.createElement('div');
    badge.style.cssText = [
        'position:fixed',
        'bottom:10px',
        'right:10px',
        'z-index:20',
        'padding:4px 8px',
        'border-radius:6px',
        'background:rgba(15,23,42,0.72)',
        'border:1px solid rgba(56,189,248,0.28)',
        'color:#cbd5e1',
        'font-family:system-ui,sans-serif',
        'font-size:11px',
        'pointer-events:none'
    ].join(';');
    badge.textContent = 'WebGL2 Studio (.glb) | Drag: Orbit | Right/Shift+Drag: Pan | Wheel: Zoom';
    document.body.appendChild(badge);

    // Orbit + Pan + WASD camera state
    const focalPoint = new Vec3(0, 1, 0);
    let azimDeg = 35;
    let elevDeg = -20;
    let distance = 6;
    const pressedKeys = new Set<string>();

    const updateCameraTransform = () => {
        const az = (azimDeg * Math.PI) / 180;
        const el = (elevDeg * Math.PI) / 180;
        const cosEl = Math.cos(el);
        const cx = focalPoint.x + distance * cosEl * Math.sin(az);
        const cy = focalPoint.y - distance * Math.sin(el);
        const cz = focalPoint.z + distance * cosEl * Math.cos(az);
        cameraEntity.setPosition(cx, cy, cz);
        cameraEntity.lookAt(focalPoint);
    };
    updateCameraTransform();

    // Multi-room assembly state
    const roomsById = new Map<string, WebglRoomInstance>();
    let activeInstanceId: string | null = null;
    let assemblyLoadGeneration = 0;
    let currentCropBounds: CropBoxBounds = [-5, 5, -2, 4, -5, 5];
    let hasExplicitCropBox = false;
    let currentFloorTilt = 0;

    // Gizmo state
    let gizmoMode: GizmoMode = 'translate';
    let isGizmoDragging = false;
    let transformThrottleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastTransformEmitAt = 0;

    const gizmoPivotEntity = new Entity('webglGizmoPivot', app);
    app.root.addChild(gizmoPivotEntity);

    const translateGizmo = new TranslateGizmo(cameraComponent, gizmoLayer);
    const rotateGizmo = new RotateGizmo(cameraComponent, gizmoLayer);
    rotateGizmo.rotationMode = 'orbit';
    const scaleGizmo = new ScaleGizmo(cameraComponent, gizmoLayer);
    (['x', 'y', 'z', 'yz', 'xz', 'xy'] as const).forEach((axis) => {
        scaleGizmo.setShapeEnabled(axis, false);
    });
    scaleGizmo.lowerBoundScale.set(1e-6, 1e-6, 1e-6);

    const allGizmos = {
        translate: translateGizmo,
        rotate: rotateGizmo,
        scale: scaleGizmo
    };

    const updateGizmoSizes = () => {
        const maxDim = Math.max(1, Math.max(canvas.clientWidth, canvas.clientHeight));
        const size = 1200 / maxDim;
        translateGizmo.size = size;
        rotateGizmo.size = size;
        scaleGizmo.size = size;
    };

    const resizeToParent = () => {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        graphicsDevice.resizeCanvas(w, h);
        updateGizmoSizes();
    };
    const ro = new ResizeObserver(resizeToParent);
    ro.observe(canvas);
    window.addEventListener('resize', resizeToParent);

    const tmpPivotPos = new Vec3();
    const bindMat = new Mat4();
    const workMat = new Mat4();
    const workQuat = new Quat();

    const updateRoomWorldBound = (room: WebglRoomInstance) => {
        room.worldBound.setFromTransformedAabb(room.localBound, room.entity.getWorldTransform());
    };

    const placePivotOnRoom = (room: WebglRoomInstance) => {
        const hasValidBound =
            room.localBound.halfExtents.x > 0 ||
            room.localBound.halfExtents.y > 0 ||
            room.localBound.halfExtents.z > 0;
        if (hasValidBound) {
            room.entity.getLocalTransform().transformPoint(room.localBound.center, tmpPivotPos);
        } else {
            tmpPivotPos.copy(room.entity.getLocalPosition());
        }
        gizmoPivotEntity.setLocalPosition(tmpPivotPos);
        gizmoPivotEntity.setLocalRotation(room.entity.getLocalRotation());
        gizmoPivotEntity.setLocalScale(room.entity.getLocalScale());
    };

    const refreshGizmoAttachment = () => {
        translateGizmo.detach();
        rotateGizmo.detach();
        scaleGizmo.detach();

        if (gizmoMode === 'none' || !activeInstanceId) return;
        const room = roomsById.get(activeInstanceId);
        if (!room || !room.visible) return;

        placePivotOnRoom(room);
        updateGizmoSizes();
        allGizmos[gizmoMode].attach([gizmoPivotEntity]);
    };

    const flushTransformThrottle = () => {
        if (transformThrottleTimer !== null) {
            clearTimeout(transformThrottleTimer);
            transformThrottleTimer = null;
        }
    };

    const emitRoomTransform = (room: WebglRoomInstance, isFinal: boolean) => {
        notifyParent({
            type: 'studio:roomTransformChanged',
            instanceId: room.instanceId,
            transform: getRoomTransformDto(room.entity),
            isFinal
        });
    };

    let dragStartTransform: RoomTransformDto | null = null;
    let isDragging = false;

    for (const gizmo of [translateGizmo, rotateGizmo, scaleGizmo]) {
        gizmo.on('transform:start', () => {
            isGizmoDragging = true;
            isDragging = false;
            const room = activeInstanceId ? roomsById.get(activeInstanceId) : null;
            if (!room) return;
            dragStartTransform = getRoomTransformDto(room.entity);
            bindMat.setTRS(
                gizmoPivotEntity.getLocalPosition(),
                gizmoPivotEntity.getLocalRotation(),
                gizmoPivotEntity.getLocalScale()
            );
            bindMat.invert();
            bindMat.mul2(bindMat, room.entity.getLocalTransform());
        });

        gizmo.on('transform:move', () => {
            const room = activeInstanceId ? roomsById.get(activeInstanceId) : null;
            if (!room) return;

            workMat.setTRS(
                gizmoPivotEntity.getLocalPosition(),
                gizmoPivotEntity.getLocalRotation(),
                gizmoPivotEntity.getLocalScale()
            );
            workMat.mul2(workMat, bindMat);
            workQuat.setFromMat4(workMat);

            room.entity.setLocalPosition(workMat.getTranslation());
            room.entity.setLocalRotation(workQuat);
            room.entity.setLocalScale(workMat.getScale());
            updateRoomWorldBound(room);
            if (room.cropBounds) {
                applyLocalCropBoundsToEntity(room.entity, room.cropBounds);
            }

            const now = performance.now();
            const elapsed = now - lastTransformEmitAt;
            if (elapsed >= 66) {
                flushTransformThrottle();
                lastTransformEmitAt = now;
                emitRoomTransform(room, false);
            } else if (transformThrottleTimer === null) {
                transformThrottleTimer = setTimeout(() => {
                    transformThrottleTimer = null;
                    lastTransformEmitAt = performance.now();
                    emitRoomTransform(room, false);
                }, 66 - elapsed);
            }
        });

        gizmo.on('transform:end', () => {
            isGizmoDragging = false;
            flushTransformThrottle();
            const room = activeInstanceId ? roomsById.get(activeInstanceId) : null;
            if (!room) {
                dragStartTransform = null;
                return;
            }
            const endTransform = getRoomTransformDto(room.entity);
            const changed =
                !dragStartTransform ||
                dragStartTransform.position.some((v, i) => v !== endTransform.position[i]) ||
                dragStartTransform.rotationEulerDeg.some((v, i) => v !== endTransform.rotationEulerDeg[i]) ||
                dragStartTransform.scale !== endTransform.scale;
            dragStartTransform = null;
            if (changed) {
                lastTransformEmitAt = performance.now();
                emitRoomTransform(room, true);
            }
        });
    }

    // Pointer & picking state
    let dragMode: 'orbit' | 'pan' = 'orbit';
    let lastX = 0;
    let lastY = 0;
    let isPickingActive = false;
    let currentPickCallback: ((coords: [number, number, number]) => void) | null = null;
    let pointerDownInfo: { x: number; y: number } | null = null;

    const disableSplatPick = () => {
        isPickingActive = false;
        currentPickCallback = null;
        canvas.style.cursor = '';
    };

    const enableSplatPick = (callback?: (coords: [number, number, number]) => void) => {
        isPickingActive = true;
        currentPickCallback = callback || null;
        canvas.style.cursor = 'crosshair';
    };

    const raycastVisibleRooms = (
        clientX: number,
        clientY: number,
        rect: DOMRect
    ): { point: Vec3; room: WebglRoomInstance } | null => {
        if (rect.width <= 0 || rect.height <= 0) return null;
        const sx = clientX - rect.left;
        const sy = clientY - rect.top;
        const nearPt = cameraComponent.screenToWorld(sx, sy, cameraComponent.nearClip);
        const farPt = cameraComponent.screenToWorld(sx, sy, cameraComponent.farClip);
        const dir = farPt.clone().sub(nearPt).normalize();
        const ray = new Ray(nearPt, dir);
        const camPos = cameraEntity.getPosition();

        let closestDist = Infinity;
        let closestHit: Vec3 | null = null;
        let closestRoom: WebglRoomInstance | null = null;

        for (const room of roomsById.values()) {
            if (!room.visible || !room.entity.enabled) continue;
            if (!room.worldBound.intersectsRay(ray)) continue;

            const hit = raycastCameraAgainstEntities(cameraComponent, [room.entity], clientX, clientY, rect);
            if (!hit) continue;
            const d = camPos.distance(hit);
            if (d < closestDist) {
                closestDist = d;
                closestHit = hit;
                closestRoom = room;
            }
        }

        return closestHit && closestRoom ? { point: closestHit, room: closestRoom } : null;
    };

    const computeUnifiedWorldBound = (): BoundingBox | null => {
        let valid = false;
        const unified = new BoundingBox();
        for (const room of roomsById.values()) {
            if (!room.visible || !room.entity.enabled) continue;
            updateRoomWorldBound(room);
            if (!valid) {
                unified.copy(room.worldBound);
                valid = true;
            } else {
                unified.add(room.worldBound);
            }
        }
        return valid ? unified : null;
    };

    const focusBound = (bound: BoundingBox | null) => {
        if (!bound) return;
        focalPoint.copy(bound.center);
        distance = Math.max(1.5, Math.min(80, bound.halfExtents.length() * 1.6));
        updateCameraTransform();
    };

    const selectRoomInternal = (room: WebglRoomInstance | null, focus = false, notify = false) => {
        if (room && !room.visible) return;
        activeInstanceId = room ? room.instanceId : null;
        refreshGizmoAttachment();
        if (room && focus) {
            updateRoomWorldBound(room);
            focusBound(room.worldBound);
        }
        if (notify) {
            notifyParent({
                type: 'studio:roomSelected',
                instanceId: activeInstanceId
            });
        }
    };

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
        if (isGizmoDragging) return;

        if (isPickingActive && e.button === 0) {
            const rect = canvas.getBoundingClientRect();
            const hit = raycastVisibleRooms(e.clientX, e.clientY, rect);
            const coords: [number, number, number] = hit
                ? [Number(hit.point.x.toFixed(3)), Number(hit.point.y.toFixed(3)), Number(hit.point.z.toFixed(3))]
                : [Number(focalPoint.x.toFixed(3)), Number(focalPoint.y.toFixed(3)), Number(focalPoint.z.toFixed(3))];

            currentPickCallback?.(coords);
            notifyParent({
                type: 'studio:splatPicked',
                coords,
                instanceId: hit?.room.instanceId ?? activeInstanceId
            });
            disableSplatPick();
            return;
        }

        if (e.button === 0) {
            pointerDownInfo = { x: e.clientX, y: e.clientY };
        }
        isDragging = true;
        dragMode = e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'orbit';
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture?.(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e: PointerEvent) => {
        if (!isDragging || isGizmoDragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;

        if (dragMode === 'orbit') {
            azimDeg -= dx * 0.35;
            elevDeg = Math.max(-88, Math.min(88, elevDeg - dy * 0.35));
        } else {
            const panSpeed = Math.max(0.002, distance * 0.0018);
            const right = cameraEntity.right;
            const up = cameraEntity.up;
            focalPoint.addScaled(right, -dx * panSpeed);
            focalPoint.addScaled(up, dy * panSpeed);
        }
        updateCameraTransform();
    });

    const endDrag = (e: PointerEvent) => {
        isDragging = false;
        if (canvas.hasPointerCapture?.(e.pointerId)) {
            canvas.releasePointerCapture(e.pointerId);
        }

        if (e.button === 0 && !isPickingActive && !isGizmoDragging && pointerDownInfo) {
            const dx = e.clientX - pointerDownInfo.x;
            const dy = e.clientY - pointerDownInfo.y;
            pointerDownInfo = null;
            if (dx * dx + dy * dy <= 25 && roomsById.size > 1) {
                const hit = raycastVisibleRooms(e.clientX, e.clientY, canvas.getBoundingClientRect());
                if (hit?.room && hit.room.instanceId !== activeInstanceId) {
                    selectRoomInternal(hit.room, false, true);
                }
            }
        } else {
            pointerDownInfo = null;
        }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener(
        'wheel',
        (e: WheelEvent) => {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 1.12 : 0.89;
            distance = Math.max(0.25, Math.min(120, distance * factor));
            updateCameraTransform();
        },
        { passive: false }
    );

    window.addEventListener('keydown', (e) => pressedKeys.add(e.code));
    window.addEventListener('keyup', (e) => pressedKeys.delete(e.code));

    app.on('update', (dt: number) => {
        if (pressedKeys.size > 0) {
            const moveSpeed = Math.max(1.5, distance * 0.6) * dt;
            const forward = cameraEntity.forward;
            const right = cameraEntity.right;
            let moved = false;
            if (pressedKeys.has('KeyW') || pressedKeys.has('ArrowUp')) {
                focalPoint.addScaled(forward, moveSpeed);
                moved = true;
            }
            if (pressedKeys.has('KeyS') || pressedKeys.has('ArrowDown')) {
                focalPoint.addScaled(forward, -moveSpeed);
                moved = true;
            }
            if (pressedKeys.has('KeyD') || pressedKeys.has('ArrowRight')) {
                focalPoint.addScaled(right, moveSpeed);
                moved = true;
            }
            if (pressedKeys.has('KeyA') || pressedKeys.has('ArrowLeft')) {
                focalPoint.addScaled(right, -moveSpeed);
                moved = true;
            }
            if (pressedKeys.has('KeyE')) {
                focalPoint.y += moveSpeed;
                moved = true;
            }
            if (pressedKeys.has('KeyQ')) {
                focalPoint.y -= moveSpeed;
                moved = true;
            }
            if (moved) updateCameraTransform();
        }

        drawGrid(app);

        const activeRoom = activeInstanceId ? roomsById.get(activeInstanceId) : null;
        if (activeRoom?.visible && activeRoom.cropBounds) {
            drawCropBox(app, activeRoom.cropBounds, activeRoom.entity.getWorldTransform());
        } else if (hasExplicitCropBox) {
            drawCropBox(app, currentCropBounds);
        }
    });

    const disposeRoomInstance = (room: WebglRoomInstance) => {
        room.entity.destroy();
        app.assets.remove(room.asset);
        room.asset.unload();
    };

    const clearAllRooms = () => {
        flushTransformThrottle();
        translateGizmo.detach();
        rotateGizmo.detach();
        scaleGizmo.detach();
        for (const room of roomsById.values()) {
            disposeRoomInstance(room);
        }
        roomsById.clear();
        activeInstanceId = null;
        hasExplicitCropBox = false;
    };

    const loadSingleWebglRoom = async (item: AssemblyRoomLoadItem): Promise<WebglRoomInstance> => {
        const filename = extractModelFilename(item.signedModelUrl, `${item.instanceId}.glb`);
        const { asset, entity, triangleCount } = await loadGlbEntityOnApp(
            app,
            item.signedModelUrl,
            filename,
            item.instanceId
        );
        app.root.addChild(entity);

        const localBound = new BoundingBox();
        computeEntityMeshBound(entity, localBound);

        if (item.transform) {
            applyRoomTransformDto(entity, item.transform);
        }

        const visible = item.visible !== false;
        entity.enabled = visible;

        const cropBounds = normalizeCropBounds(item.cropBounds);
        if (cropBounds) {
            applyLocalCropBoundsToEntity(entity, cropBounds);
        }

        const worldBound = new BoundingBox();
        worldBound.setFromTransformedAabb(localBound, entity.getWorldTransform());

        return {
            instanceId: item.instanceId,
            displayLabel: item.displayLabel || filename,
            entity,
            asset,
            localBound,
            worldBound,
            triangleCount,
            cropBounds,
            visible
        };
    };

    const bridge: StudioBridgeAPI = {
        loadSog: async (signedModelUrl: string): Promise<boolean> => {
            if (!signedModelUrl) {
                throw new Error('signedModelUrl is required');
            }
            if (!isGlbUrl(signedModelUrl)) {
                throw new Error('WebGPU is required for .sog/.ply files. This WebGL2 Studio supports .glb meshes.');
            }

            assemblyLoadGeneration++;
            badge.textContent = 'Loading .glb mesh...';
            clearAllRooms();

            const filename = extractModelFilename(signedModelUrl, 'scene.glb');
            const room = await loadSingleWebglRoom({
                instanceId: 'legacy',
                signedModelUrl,
                displayLabel: filename,
                transform: currentFloorTilt !== 0 ? { rotationEulerDeg: [currentFloorTilt, 0, 0] } : undefined,
                cropBounds: hasExplicitCropBox ? currentCropBounds : null,
                visible: true
            });
            roomsById.set(room.instanceId, room);
            activeInstanceId = room.instanceId;
            refreshGizmoAttachment();
            focusBound(room.worldBound);

            badge.textContent = `WebGL2 Studio (${filename}) | Drag: Orbit | Right/Shift+Drag: Pan | Wheel: Zoom`;
            return true;
        },

        getCropBox: (): CropBoxBounds => {
            const activeRoom = activeInstanceId ? roomsById.get(activeInstanceId) : null;
            if (activeRoom?.cropBounds) {
                return [...activeRoom.cropBounds];
            }
            return [...currentCropBounds];
        },

        setCropBox: (bounds: CropBoxBounds) => {
            currentCropBounds = [...bounds];
            hasExplicitCropBox = true;
            const activeRoom = activeInstanceId ? roomsById.get(activeInstanceId) : null;
            if (activeRoom) {
                activeRoom.cropBounds = [...bounds];
                applyLocalCropBoundsToEntity(activeRoom.entity, activeRoom.cropBounds);
            } else {
                for (const room of roomsById.values()) {
                    room.cropBounds = [...bounds];
                    applyLocalCropBoundsToEntity(room.entity, room.cropBounds);
                }
            }
            notifyParent({
                type: 'studio:cropBoxChanged',
                bounds: currentCropBounds,
                instanceId: activeRoom?.instanceId ?? null
            });
        },

        getFloorTilt: (): number => currentFloorTilt,

        setFloorTilt: (degrees: number) => {
            currentFloorTilt = degrees;
            const activeRoom = activeInstanceId ? roomsById.get(activeInstanceId) : null;
            const targets = activeRoom ? [activeRoom] : Array.from(roomsById.values());
            for (const room of targets) {
                const cur = room.entity.getLocalEulerAngles();
                room.entity.setLocalEulerAngles(degrees, cur.y, cur.z);
                updateRoomWorldBound(room);
                if (room.cropBounds) {
                    applyLocalCropBoundsToEntity(room.entity, room.cropBounds);
                }
            }
            refreshGizmoAttachment();
            notifyParent({
                type: 'studio:floorTiltChanged',
                degrees: currentFloorTilt
            });
        },

        calibrateDoorScale: (
            doorHeightMeters = 2.1,
            instanceId?: string
        ): { scaleFactor: number; currentScale: number; instanceId?: string; transform?: RoomTransformDto } => {
            const targetId = instanceId ?? activeInstanceId;
            const room = targetId ? roomsById.get(targetId) : Array.from(roomsById.values())[0];
            if (!room) {
                return { scaleFactor: 1, currentScale: 1 };
            }

            updateRoomWorldBound(room);
            let measuredHeight = room.worldBound.halfExtents.y * 2 * 0.75;
            if (measuredHeight <= 0.01) measuredHeight = 2.1;

            const scaleFactor = doorHeightMeters / measuredHeight;
            const curScale = room.entity.getLocalScale();
            const nextScale = Math.max(0.01, curScale.x * scaleFactor);
            room.entity.setLocalScale(nextScale, nextScale, nextScale);
            updateRoomWorldBound(room);
            if (room.cropBounds) {
                applyLocalCropBoundsToEntity(room.entity, room.cropBounds);
            }
            if (room.instanceId === activeInstanceId) {
                refreshGizmoAttachment();
            }

            const transform = getRoomTransformDto(room.entity);
            emitRoomTransform(room, true);

            return {
                scaleFactor,
                currentScale: transform.scale,
                instanceId: room.instanceId,
                transform
            };
        },

        captureSpawnPose: (instanceId?: string): SpawnPose => {
            const pos = cameraEntity.getPosition();
            const rawMatrix = cameraEntity.getWorldTransform()?.data;
            const matrix: number[] = rawMatrix ? Array.from(rawMatrix) : [];
            const fov = cameraComponent.fov ?? 50;
            const pose = [
                Number(pos.x.toFixed(4)),
                Number(pos.y.toFixed(4)),
                Number(pos.z.toFixed(4)),
                Number(focalPoint.x.toFixed(4)),
                Number(focalPoint.y.toFixed(4)),
                Number(focalPoint.z.toFixed(4)),
                Number(fov.toFixed(2))
            ];

            const spawnPose: SpawnPose = {
                position: [pos.x, pos.y, pos.z],
                target: [focalPoint.x, focalPoint.y, focalPoint.z],
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
        // Multi-Room Assembly Commands (WebGL2 fallback parity)
        // -------------------------------------------------------------------

        loadAssemblyRooms: async (payload: LoadAssemblyRoomsPayload): Promise<LoadAssemblyRoomsResult> => {
            const rooms = Array.isArray(payload?.rooms) ? payload.rooms : [];
            const gen = ++assemblyLoadGeneration;

            clearAllRooms();

            if (rooms.length === 0) {
                badge.textContent = 'WebGL2 Assembly Studio (0 rooms)';
                notifyParent({
                    type: 'studio:assemblyLoaded',
                    loadedCount: 0,
                    failedInstanceIds: [],
                    totalTriangles: 0
                });
                return { success: true, loadedCount: 0, failedInstanceIds: [], totalTriangles: 0 };
            }

            badge.textContent = `Loading ${rooms.length} room(s)...`;
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
                        const loaded = await loadSingleWebglRoom(item);
                        if (gen !== assemblyLoadGeneration) {
                            disposeRoomInstance(loaded);
                            return;
                        }
                        roomsById.set(loaded.instanceId, loaded);
                        loadedCount++;
                        totalTriangles += loaded.triangleCount;

                        notifyParent({
                            type: 'studio:assemblyLoadProgress',
                            loaded: loadedCount,
                            total: rooms.length,
                            instanceId: loaded.instanceId,
                            triangles: loaded.triangleCount
                        });
                    } catch (err) {
                        console.warn(`[WebGLStudio] Failed to load room ${item.instanceId}:`, err);
                        failedInstanceIds.push(item.instanceId);
                    }
                }
            };

            await Promise.all(Array.from({ length: Math.min(concurrency, rooms.length) }, () => worker()));

            if (gen !== assemblyLoadGeneration) {
                return { success: false, loadedCount: 0, failedInstanceIds: [], totalTriangles: 0 };
            }

            const requestedActive = payload.activeInstanceId ? roomsById.get(payload.activeInstanceId) : null;
            const fallbackActive = Array.from(roomsById.values()).find((r) => r.visible) ?? null;
            selectRoomInternal(requestedActive && requestedActive.visible ? requestedActive : fallbackActive, false, true);

            focusBound(computeUnifiedWorldBound());
            badge.textContent = `WebGL2 Assembly Studio (${loadedCount} rooms) | Drag: Orbit | Right/Shift+Drag: Pan`;

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

            const existing = roomsById.get(payload.instanceId);
            if (existing) {
                disposeRoomInstance(existing);
                roomsById.delete(payload.instanceId);
            }

            const wasFirstRoom = roomsById.size === 0;
            const room = await loadSingleWebglRoom(payload);
            roomsById.set(room.instanceId, room);

            const shouldFocus = Boolean(payload.focus) || wasFirstRoom;
            if (payload.select !== false && room.visible) {
                selectRoomInternal(room, shouldFocus, true);
            } else if (shouldFocus) {
                focusBound(room.worldBound);
            }

            badge.textContent = `WebGL2 Assembly Studio (${roomsById.size} rooms) | Drag: Orbit | Right/Shift+Drag: Pan`;
            return {
                success: true,
                instanceId: room.instanceId,
                triangles: room.triangleCount
            };
        },

        removeRoomInstance: (instanceId: string): { success: boolean } => {
            const room = roomsById.get(instanceId);
            if (!room) {
                return { success: false };
            }
            const wasActive = activeInstanceId === instanceId;
            roomsById.delete(instanceId);
            disposeRoomInstance(room);

            if (wasActive) {
                const next = Array.from(roomsById.values()).find((r) => r.visible) ?? null;
                selectRoomInternal(next, false, true);
            }

            badge.textContent = `WebGL2 Assembly Studio (${roomsById.size} rooms) | Drag: Orbit | Right/Shift+Drag: Pan`;
            return { success: true };
        },

        selectRoomInstance: (
            instanceId: string | null,
            focus = false
        ): { success: boolean; instanceId: string | null } => {
            if (!instanceId) {
                selectRoomInternal(null, false, false);
                return { success: true, instanceId: null };
            }
            const room = roomsById.get(instanceId) ?? null;
            if (!room) {
                return { success: false, instanceId: activeInstanceId };
            }
            selectRoomInternal(room, focus, false);
            return { success: true, instanceId: room.instanceId };
        },

        setRoomTransform: (
            instanceId: string,
            transform: Partial<RoomTransformDto>
        ): { success: boolean; transform: RoomTransformDto | null } => {
            const room = roomsById.get(instanceId);
            if (!room) {
                return { success: false, transform: null };
            }
            applyRoomTransformDto(room.entity, transform);
            updateRoomWorldBound(room);
            if (room.cropBounds) {
                applyLocalCropBoundsToEntity(room.entity, room.cropBounds);
            }
            if (room.instanceId === activeInstanceId) {
                refreshGizmoAttachment();
            }
            return { success: true, transform: getRoomTransformDto(room.entity) };
        },

        setRoomVisibility: (instanceId: string, visible: boolean): { success: boolean } => {
            const room = roomsById.get(instanceId);
            if (!room) {
                return { success: false };
            }
            room.visible = visible;
            room.entity.enabled = visible;
            if (!visible && activeInstanceId === instanceId) {
                activeInstanceId = null;
                refreshGizmoAttachment();
            } else if (visible && activeInstanceId === instanceId) {
                refreshGizmoAttachment();
            }
            return { success: true };
        },

        alignFloorY: (
            instanceId: string,
            targetFloorY?: number,
            referenceInstanceId?: string
        ): { success: boolean; instanceId: string; transform: RoomTransformDto | null; worldMinY: number } => {
            const room = roomsById.get(instanceId);
            if (!room) {
                return { success: false, instanceId, transform: null, worldMinY: 0 };
            }

            let desiredFloorY = typeof targetFloorY === 'number' && Number.isFinite(targetFloorY) ? targetFloorY : 0;
            if (referenceInstanceId) {
                const ref = roomsById.get(referenceInstanceId);
                if (ref && ref.visible) {
                    updateRoomWorldBound(ref);
                    desiredFloorY = ref.worldBound.center.y - ref.worldBound.halfExtents.y;
                }
            }

            const wasEnabled = room.entity.enabled;
            if (!wasEnabled) room.entity.enabled = true;
            room.worldBound.setFromTransformedAabb(room.localBound, room.entity.getWorldTransform());
            const currentMinY = room.worldBound.center.y - room.worldBound.halfExtents.y;
            const dy = desiredFloorY - currentMinY;
            if (!wasEnabled) room.entity.enabled = false;

            const curPos = room.entity.getLocalPosition();
            room.entity.setLocalPosition(curPos.x, curPos.y + dy, curPos.z);
            updateRoomWorldBound(room);
            if (room.cropBounds) {
                applyLocalCropBoundsToEntity(room.entity, room.cropBounds);
            }
            if (room.instanceId === activeInstanceId) {
                refreshGizmoAttachment();
            }

            const dto = getRoomTransformDto(room.entity);
            emitRoomTransform(room, true);

            return {
                success: true,
                instanceId: room.instanceId,
                transform: dto,
                worldMinY: round4(currentMinY + dy)
            };
        },

        setGizmoMode: (mode: GizmoMode): { success: boolean; mode: GizmoMode } => {
            gizmoMode = mode;
            refreshGizmoAttachment();
            return { success: true, mode };
        },

        setRoomCropBox: (
            instanceId: string,
            bounds: CropBoxBounds | { min: number[]; max: number[] } | null
        ): { success: boolean } => {
            const room = roomsById.get(instanceId);
            if (!room) {
                return { success: false };
            }
            room.cropBounds = normalizeCropBounds(bounds);
            applyLocalCropBoundsToEntity(room.entity, room.cropBounds);
            return { success: true };
        },

        setCameraPose: (
            position: [number, number, number],
            target: [number, number, number],
            fov?: number
        ): { success: boolean } => {
            if (!Array.isArray(position) || position.length < 3 || !Array.isArray(target) || target.length < 3) {
                return { success: false };
            }
            const px = Number(position[0]) || 0;
            const py = Number(position[1]) || 0;
            const pz = Number(position[2]) || 0;
            const tx = Number(target[0]) || 0;
            const ty = Number(target[1]) || 0;
            const tz = Number(target[2]) || 0;

            focalPoint.set(tx, ty, tz);
            const dx = px - tx;
            const dy = py - ty;
            const dz = pz - tz;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist > 1e-4) {
                distance = Math.max(0.25, Math.min(120, dist));
                elevDeg = Math.max(-88, Math.min(88, Math.asin(Math.max(-1, Math.min(1, -dy / dist))) * RAD_TO_DEG));
                azimDeg = Math.atan2(dx, dz) * RAD_TO_DEG;
            }
            if (typeof fov === 'number' && Number.isFinite(fov) && fov > 10 && fov < 140) {
                cameraComponent.fov = fov;
            }
            updateCameraTransform();
            return { success: true };
        }
    };

    app.start();
    resizeToParent();
    registerStudioBridgeListener(bridge);

    const loadList = urlParams.getAll('load');
    if (loadList.length > 0) {
        await bridge.loadSog(decodeURIComponent(loadList[0]));
    }
};
