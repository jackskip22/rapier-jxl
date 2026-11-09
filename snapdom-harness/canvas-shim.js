// Headless Safari on the CI VM cannot read back a plain 2D canvas ("The object is in an invalid state").
// Harness pages only: every '2d' context is created with willReadFrequently: true.
;(() => {
  const proto = HTMLCanvasElement.prototype
  const getContext = proto.getContext
  proto.getContext = function (type, options) {
    if (type === '2d') return getContext.call(this, type, { ...(options || {}), willReadFrequently: true })
    return getContext.call(this, type, options)
  }
})()
