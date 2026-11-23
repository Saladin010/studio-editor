import { BoxShape } from '../box-shape';
import { ElementType } from '../element';
import type { Events } from '../events';
import type { Scene } from '../scene';
import type { Splat } from '../splat';

export type CropBoxBounds = [number, number, number, number, number, number];

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
    calibrateDoorScale(doorHeightMeters?: number): { scaleFactor: number; currentScale: number };
    captureSpawnPose(): SpawnPose;
    enableSplatPick(callback?: (coords: [number, number, number]) => void): void;
    disableSplatPick(): void;
}

export interface StudioMessage {
    type: string;
    id?: string;
    payload?: any;
    coords?: [number, number, number];
    pose?: SpawnPose;
    bounds?: CropBoxBounds;
    degrees?: number;
    data?: any;
    error?: string;
}

const notifyParent = (msg: StudioMessage) => {
    if (window.parent && window.parent !== window) {
        window.parent.postMessage(msg, '*');
    }
};

const respond = (targetWindow: Window, origin: string, id: string | undefined, data?: any, error?: string) => {
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

export const initStudioBridge = (events: Events, scene: Scene): StudioBridgeAPI => {
    let cropBoxShape: BoxShape | null = null;
    let currentCropBounds: CropBoxBounds = [-5, 5, -5, 5, -5, 5];
    let currentFloorTilt = 0;
    let isPickingActive = false;
    let currentPickCallback: ((coords: [number, number, number]) => void) | null = null;

    const getCanvas = (): HTMLCanvasElement | null => {
        return ((scene.app?.graphicsDevice as any)?.canvas || (scene as any).canvas || document.querySelector('canvas')) as HTMLCanvasElement;
    };

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

    // Canvas click listener for hotspot picking
    const handlePointerDown = async (event: PointerEvent) => {
        if (!isPickingActive || event.button !== 0) return;

        const canvas = getCanvas();
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const nx = (event.clientX - rect.left) / rect.width;
        const ny = (event.clientY - rect.top) / rect.height;

        let coords: [number, number, number] | null = null;

        try {
            const hit = await scene.camera.intersect(nx, ny);
            if (hit && hit.position) {
                coords = [
                    Number(hit.position.x.toFixed(3)),
                    Number(hit.position.y.toFixed(3)),
                    Number(hit.position.z.toFixed(3))
                ];
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
            coords
        });

        disableSplatPick();
    };

    const canvas = getCanvas();
    if (canvas) {
        canvas.addEventListener('pointerdown', handlePointerDown);
    }

    const bridge: StudioBridgeAPI = {
        loadSog: async (signedModelUrl: string): Promise<boolean> => {
            if (!signedModelUrl) {
                throw new Error('signedModelUrl is required');
            }

            // Clear previous splat layers
            events.fire('scene.clear');

            const urlWithoutQuery = signedModelUrl.split('?')[0];
            const rawFilename = urlWithoutQuery.split('/').pop() || 'scene.sog';
            const filename = rawFilename.toLowerCase().endsWith('.sog') ? rawFilename : `${rawFilename}.sog`;

            await events.invoke('import', [
                {
                    filename,
                    url: signedModelUrl
                }
            ]);

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
            if (currentCropBounds) {
                return [...currentCropBounds];
            }
            const splats = scene.getElementsByType(ElementType.splat) as Splat[];
            if (splats.length > 0 && splats[0].worldBound) {
                const b = splats[0].worldBound;
                return [
                    Number((b.center.x - b.halfExtents.x).toFixed(2)),
                    Number((b.center.x + b.halfExtents.x).toFixed(2)),
                    Number((b.center.y - b.halfExtents.y).toFixed(2)),
                    Number((b.center.y + b.halfExtents.y).toFixed(2)),
                    Number((b.center.z - b.halfExtents.z).toFixed(2)),
                    Number((b.center.z + b.halfExtents.z).toFixed(2))
                ];
            }
            return [-5, 5, -5, 5, -5, 5];
        },

        setCropBox: (bounds: CropBoxBounds) => {
            currentCropBounds = [...bounds];
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

            cropBoxShape.lenX = lx;
            cropBoxShape.lenY = ly;
            cropBoxShape.lenZ = lz;
            cropBoxShape.pivot.setPosition(cx, cy, cz);
            cropBoxShape.updateBound();

            scene.boundDirty = true;
            scene.forceRender = true;

            notifyParent({
                type: 'studio:cropBoxChanged',
                bounds: currentCropBounds
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
            scene.boundDirty = true;
            scene.forceRender = true;

            notifyParent({
                type: 'studio:floorTiltChanged',
                degrees: currentFloorTilt
            });
        },

        calibrateDoorScale: (doorHeightMeters = 2.1): { scaleFactor: number; currentScale: number } => {
            const splats = scene.getElementsByType(ElementType.splat) as Splat[];
            if (!splats.length) {
                return { scaleFactor: 1, currentScale: 1 };
            }
            const splat = splats[0];
            let measuredHeight = 0;

            if ((splat as any).measurePoints && (splat as any).measurePoints.length >= 2) {
                const pts = (splat as any).measurePoints;
                measuredHeight = pts[0].distance(pts[1]);
            } else if (splat.worldBound) {
                measuredHeight = splat.worldBound.halfExtents.y * 2 * 0.75;
            }

            if (measuredHeight <= 0.01) {
                measuredHeight = 2.1;
            }

            const scaleFactor = doorHeightMeters / measuredHeight;
            const curScale = splat.entity.getLocalScale();
            const newScaleX = curScale.x * scaleFactor;
            const newScaleY = curScale.y * scaleFactor;
            const newScaleZ = curScale.z * scaleFactor;

            splat.entity.setLocalScale(newScaleX, newScaleY, newScaleZ);
            scene.boundDirty = true;
            scene.forceRender = true;

            return {
                scaleFactor,
                currentScale: newScaleX
            };
        },

        captureSpawnPose: (): SpawnPose => {
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
                pose: spawnPose
            });

            return spawnPose;
        },

        enableSplatPick,
        disableSplatPick
    };

    // Attach to window for programmatic access
    (window as any).studioBridge = bridge;

    // Listen for postMessage commands from host/parent
    window.addEventListener('message', async (event: MessageEvent) => {
        const data = event.data;
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
                    const ok = await bridge.loadSog(payload?.signedModelUrl);
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
                        bridge.setCropBox(payload.bounds);
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
                    bridge.setFloorTilt(payload?.degrees ?? 0);
                    respond(source, event.origin, id, { success: true });
                    break;
                }
                case 'studio:calibrateDoorScale': {
                    const res = bridge.calibrateDoorScale(payload?.doorHeightMeters);
                    respond(source, event.origin, id, res);
                    break;
                }
                case 'studio:captureSpawnPose': {
                    const pose = bridge.captureSpawnPose();
                    respond(source, event.origin, id, { pose });
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
            }
        } catch (err: any) {
            respond(source, event.origin, id, undefined, err?.message || String(err));
        }
    });

    // Notify parent window that studio bridge is ready
    notifyParent({ type: 'studio:ready' });

    return bridge;
};
