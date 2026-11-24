// SPDX-License-Identifier: MIT
import type {CSSProperties, ImgHTMLAttributes, ReactElement} from 'react';
import type {JxlDocumentMetadata} from './index.d.ts';

export interface PayloadUploadSize {
  url?: string | null;
  filename?: string | null;
  filesize?: number | null;
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
}

export interface PayloadMediaDoc {
  url?: string | null;
  alt?: string | null;
  filename?: string | null;
  filesize?: number | null;
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
  sizes?: Record<string, PayloadUploadSize | undefined> | null;
  jxl?: JxlDocumentMetadata | null;
}

export interface PictureOptions {
  /** Render a single named imageSizes rendition instead of all responsive renditions. */
  size?: string;
  /** Responsive sizes attribute for the fallback <img>. */
  sizes?: string;
  /** Custom media query per imageSizes name. Defaults to (max-width: <width>px). */
  mediaQueries?: Record<string, string>;
  alt?: string;
  className?: string;
  pictureClassName?: string;
  loading?: 'eager' | 'lazy';
  decoding?: 'async' | 'auto' | 'sync';
  fetchPriority?: 'high' | 'low' | 'auto';
  style?: CSSProperties;
}

export interface PictureProps extends PictureOptions, Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'sizes' | 'alt'> {
  doc?: PayloadMediaDoc | null;
  media?: PayloadMediaDoc | null;
  imgProps?: ImgHTMLAttributes<HTMLImageElement>;
}

export interface BuiltPictureProps {
  picture: {className?: string};
  sources: Array<{
    key: string;
    type: 'image/jxl';
    srcSet: string;
    media?: string;
    width?: number;
    height?: number;
  }>;
  img: {
    src: string;
    srcSet?: string;
    sizes?: string;
    alt: string;
    width?: number;
    height?: number;
    className?: string;
    loading?: 'eager' | 'lazy';
    decoding?: 'async' | 'auto' | 'sync';
    fetchPriority?: 'high' | 'low' | 'auto';
    style?: CSSProperties;
  };
}

export declare function pictureProps(doc: PayloadMediaDoc | null | undefined, options?: PictureOptions): BuiltPictureProps | null;
export declare function pictureHtml(doc: PayloadMediaDoc | null | undefined, options?: PictureOptions): string;
export declare function Picture(props: PictureProps): ReactElement | null;
export default Picture;
