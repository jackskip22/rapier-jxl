import {variants} from 'rapier-jxl';

export function browserTools(effort) {
  return {
    variants: (source, options) => variants(source, {...options, effort})
  };
}
