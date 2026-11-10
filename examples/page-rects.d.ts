// Types for page-rects.js, beside it.
import type {ExactRect, CaptureRect} from 'rapier-jxl/capture-complete';

type Rect = {left: number; top: number; right: number; bottom: number};
/** The element's box, text, photos and (with edges) edges, in CSS pixels. */
export type Measurement = {
  readonly box: {left: number; top: number; width: number; height: number};
  readonly text: ReadonlyArray<{r: Rect; grow: number; solidText: boolean}>;
  readonly photos: ReadonlyArray<Rect>;
  /** Produced by measure(): every drawn DOM text box is represented, including when text is empty. */
  readonly textComplete?: true;
  readonly edges?: ReadonlyArray<Rect & {soft?: boolean}>;
};
/** edges: borders, outlines and strokes too, for efforts 4-9.
 * keep: the nodes a library drew. Every other element and its subtree adds nothing. */
export function measure(element: Element, options?: {edges?: boolean; keep?: {has(node: Node): boolean}}): Measurement;
/** area: the part of the element the canvas shows, in CSS pixels from its corner; the whole element by default. */
export function pageRects(page: Element | Measurement, canvas: {width: number; height: number},
  options?: {area?: {x?: number; y?: number; width?: number; height?: number}; edges?: boolean}): {
    exactRects: ExactRect[]; photoRects: CaptureRect[];
    /** Carried from measure(); pass the complete pageRects result to capture. Omitted for hand-built measurements. */
    readonly textComplete?: true;
  };
