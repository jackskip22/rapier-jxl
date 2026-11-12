import {variants} from 'jpegxl';

export function browserTools(effort) {
  return {
    variants: (source, options) => variants(source, {...options, effort})
  };
}
