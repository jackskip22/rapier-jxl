// SPDX-License-Identifier: MIT
// Development oracle only. One libjxl process, sequential bounded frames; no encoder code is shared.
// Build with the system libjxl development headers and library. The pipe is little-endian u32:
// greeting [0x314c584a, version], request [bytes, width, height]+JXL,
// reply [status, width, height, bytes]+RGBA (or an error sentence when status is nonzero).
#include <jxl/decode.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int read_u32(uint32_t *value) {
  unsigned char b[4]; if (fread(b, 1, 4, stdin) != 4) return 0;
  *value = (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24; return 1;
}
static void write_u32(uint32_t value) {
  unsigned char b[4] = {value, value >> 8, value >> 16, value >> 24}; fwrite(b, 1, 4, stdout);
}
static void reply(uint32_t status, uint32_t width, uint32_t height, const void *data, size_t size) {
  write_u32(status); write_u32(width); write_u32(height); write_u32((uint32_t)size);
  if (size) fwrite(data, 1, size, stdout);
  fflush(stdout);
}
int main(int argc, char **argv) {
  const int floats = argc == 2 && strcmp(argv[1], "--float") == 0;
  JxlDecoder *dec = JxlDecoderCreate(NULL); if (!dec) return 1;
  write_u32(0x314c584a); write_u32(JxlDecoderVersion()); fflush(stdout);
  uint32_t length, width, height;
  while (read_u32(&length)) {
    if (!read_u32(&width) || !read_u32(&height) || !length || length > 16777216 ||
        !width || !height || width > 16384 || height > 16384 || (uint64_t)width * height > 24000000) return 2;
    unsigned char *input = malloc(length), *pixels = NULL; size_t size = 0;
    if (!input || fread(input, 1, length, stdin) != length) return 3;
    JxlDecoderReset(dec); JxlBasicInfo info; memset(&info, 0, sizeof(info));
    const char *error = NULL; int complete = 0;
    JxlPixelFormat format = {4, floats ? JXL_TYPE_FLOAT : JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
    if (JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_COLOR_ENCODING | JXL_DEC_FULL_IMAGE) != JXL_DEC_SUCCESS ||
        JxlDecoderSetInput(dec, input, length) != JXL_DEC_SUCCESS) error = "libjxl initialization failed";
    JxlDecoderCloseInput(dec);
    while (!error) {
      JxlDecoderStatus status = JxlDecoderProcessInput(dec);
      if (status == JXL_DEC_BASIC_INFO) {
        if (JxlDecoderGetBasicInfo(dec, &info) != JXL_DEC_SUCCESS || info.xsize != width || info.ysize != height || info.have_animation)
          error = "libjxl dimensions or frame count differ";
      } else if (status == JXL_DEC_COLOR_ENCODING) {
        JxlColorEncoding colour; memset(&colour, 0, sizeof(colour));
        colour.color_space = info.num_color_channels == 1 ? JXL_COLOR_SPACE_GRAY : JXL_COLOR_SPACE_RGB;
        colour.white_point = JXL_WHITE_POINT_D65; colour.primaries = JXL_PRIMARIES_SRGB;
        colour.transfer_function = JXL_TRANSFER_FUNCTION_SRGB; colour.rendering_intent = JXL_RENDERING_INTENT_RELATIVE;
        if (JxlDecoderSetPreferredColorProfile(dec, &colour) != JXL_DEC_SUCCESS) error = "libjxl sRGB request failed";
      } else if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
        if (pixels || JxlDecoderImageOutBufferSize(dec, &format, &size) != JXL_DEC_SUCCESS || size != (size_t)width * height * 4 * (floats ? sizeof(float) : 1))
          error = "libjxl output size differs";
        else {
          pixels = malloc(size);
          if (!pixels || JxlDecoderSetImageOutBuffer(dec, &format, pixels, size) != JXL_DEC_SUCCESS) error = "libjxl output allocation failed";
        }
      } else if (status == JXL_DEC_FULL_IMAGE) {
        if (complete++) error = "libjxl returned more than one frame";
      } else if (status == JXL_DEC_SUCCESS) {
        if (complete != 1 || !pixels) error = "libjxl did not return a complete image";
        break;
      } else { error = "libjxl refused the returned codestream"; }
    }
    if (error) reply(1, info.xsize, info.ysize, error, strlen(error));
    else reply(0, info.xsize, info.ysize, pixels, size);
    free(pixels); free(input);
  }
  JxlDecoderDestroy(dec); return ferror(stdin) || ferror(stdout) ? 4 : 0;
}
