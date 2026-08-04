import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

interface Props {
  src: string;
  alt: string;
  className?: string;
  autoFocus?: boolean;
}

const MIN_SCALE = 1;
const MAX_SCALE = 5;

interface Point {
  x: number;
  y: number;
}

function midpoint(points: Point[]): Point {
  return {
    x: (points[0]!.x + points[1]!.x) / 2,
    y: (points[0]!.y + points[1]!.y) / 2,
  };
}

function distance(points: Point[]): number {
  return Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
}

export function ZoomableImage({ src, alt, className = '', autoFocus = false }: Props) {
  const [scale, setScale] = useState(MIN_SCALE);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(scale);
  const offsetRef = useRef(offset);
  const pointersRef = useRef(new Map<number, Point>());
  const gestureRef = useRef<{ distance: number; scale: number; midpoint: Point; offset: Point } | null>(null);
  const dragRef = useRef<{ pointer: Point; offset: Point } | null>(null);

  const updateTransform = (nextScale: number, nextOffset = offsetRef.current): void => {
    const clampedScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    const clampedOffset = clampedScale === MIN_SCALE ? { x: 0, y: 0 } : nextOffset;
    scaleRef.current = clampedScale;
    offsetRef.current = clampedOffset;
    setScale(clampedScale);
    setOffset(clampedOffset);
  };

  useEffect(() => {
    updateTransform(MIN_SCALE, { x: 0, y: 0 });
    pointersRef.current.clear();
    if (autoFocus) requestAnimationFrame(() => stageRef.current?.focus());
  }, [src]);

  const beginPinch = (): void => {
    const points = Array.from(pointersRef.current.values());
    if (points.length < 2) return;
    gestureRef.current = {
      distance: distance(points),
      scale: scaleRef.current,
      midpoint: midpoint(points),
      offset: offsetRef.current,
    };
    dragRef.current = null;
  };
  const onPointerDown = (event: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 2) beginPinch();
    else if (pointersRef.current.size === 1) {
      dragRef.current = { pointer: { x: event.clientX, y: event.clientY }, offset: offsetRef.current };
    }
  };
  const onPointerMove = (event: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = Array.from(pointersRef.current.values());
    if (points.length >= 2 && gestureRef.current) {
      const gesture = gestureRef.current;
      const currentMidpoint = midpoint(points);
      updateTransform(gesture.scale * (distance(points) / gesture.distance), {
        x: gesture.offset.x + currentMidpoint.x - gesture.midpoint.x,
        y: gesture.offset.y + currentMidpoint.y - gesture.midpoint.y,
      });
    } else if (points.length === 1 && dragRef.current && scaleRef.current > MIN_SCALE) {
      updateTransform(scaleRef.current, {
        x: dragRef.current.offset.x + event.clientX - dragRef.current.pointer.x,
        y: dragRef.current.offset.y + event.clientY - dragRef.current.pointer.y,
      });
    }
  };
  const onPointerEnd = (event: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    pointersRef.current.delete(event.pointerId);
    gestureRef.current = null;
    const remaining = Array.from(pointersRef.current.values());
    dragRef.current = remaining.length === 1
      ? { pointer: remaining[0]!, offset: offsetRef.current }
      : null;
  };
  const onWheel = (event: JSX.TargetedWheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    updateTransform(scaleRef.current * Math.exp(-event.deltaY * 0.002));
  };

  return (
    <div
      ref={stageRef}
      class={`zoomable-image${scale > MIN_SCALE ? ' zoomed' : ''}${className ? ` ${className}` : ''}`}
      tabIndex={autoFocus ? -1 : undefined}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
      />
    </div>
  );
}