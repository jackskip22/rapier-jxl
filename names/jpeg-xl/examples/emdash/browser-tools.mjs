import {variants} from 'jpeg-xl';

export function browserTools(effort) {
  return {
    variants: (source, options) => variants(source, {...options, effort})
  };
}
