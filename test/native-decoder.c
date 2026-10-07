// SPDX-License-Identifier: MIT
// Development oracle only. One libjxl process, sequential bounded frames; no encoder code is shared.
// Build with libjxl 0.12.0 development headers and library. The pipe is little-endian u32:
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
  int floats = 0, shorts = 0, halves = 0, source = 0, metadata = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--float")) floats = 1;
    else if (!strcmp(argv[i], "--uint16")) shorts = 1;
    else if (!strcmp(argv[i], "--float16")) halves = 1;
    else if (!strcmp(argv[i], "--source")) source = 1;
    else if (!strcmp(argv[i], "--metadata")) metadata = 1;
    else return 2;
  }
  if (floats + shorts + halves > 1) return 2;
  const size_t sample_bytes = floats ? 4 : shorts || halves ? 2 : 1;
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
    JxlColorEncoding original; memset(&original, 0, sizeof(original));
    JxlPixelFormat format = {4, floats ? JXL_TYPE_FLOAT : halves ? JXL_TYPE_FLOAT16 : shorts ? JXL_TYPE_UINT16 : JXL_TYPE_UINT8, JXL_LITTLE_ENDIAN, 0};
    if ((source && JxlDecoderSetUnpremultiplyAlpha(dec, JXL_FALSE) != JXL_DEC_SUCCESS) ||
        JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_COLOR_ENCODING | JXL_DEC_FULL_IMAGE) != JXL_DEC_SUCCESS ||
        JxlDecoderSetInput(dec, input, length) != JXL_DEC_SUCCESS) error = "libjxl initialization failed";
    JxlDecoderCloseInput(dec);
    while (!error) {
      JxlDecoderStatus status = JxlDecoderProcessInput(dec);
      if (status == JXL_DEC_BASIC_INFO) {
        if (JxlDecoderGetBasicInfo(dec, &info) != JXL_DEC_SUCCESS || info.xsize != width || info.ysize != height || info.have_animation)
          error = "libjxl dimensions or frame count differ";
      } else if (status == JXL_DEC_COLOR_ENCODING) {
        if (metadata && JxlDecoderGetColorAsEncodedProfile(dec,
            JXL_COLOR_PROFILE_TARGET_ORIGINAL, &original) != JXL_DEC_SUCCESS)
          error = "libjxl original colour metadata is unavailable";
        JxlColorEncoding colour; memset(&colour, 0, sizeof(colour));
        colour.color_space = info.num_color_channels == 1 ? JXL_COLOR_SPACE_GRAY : JXL_COLOR_SPACE_RGB;
        colour.white_point = JXL_WHITE_POINT_D65; colour.primaries = JXL_PRIMARIES_SRGB;
        colour.transfer_function = JXL_TRANSFER_FUNCTION_SRGB; colour.rendering_intent = JXL_RENDERING_INTENT_RELATIVE;
        if (!source && JxlDecoderSetPreferredColorProfile(dec, &colour) != JXL_DEC_SUCCESS) error = "libjxl sRGB request failed";
      } else if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
        if (pixels || JxlDecoderImageOutBufferSize(dec, &format, &size) != JXL_DEC_SUCCESS || size != (size_t)width * height * 4 * sample_bytes)
          error = "libjxl output size differs";
        else {
          pixels = malloc(size);
          if (!pixels || JxlDecoderSetImageOutBuffer(dec, &format, pixels, size) != JXL_DEC_SUCCESS) error = "libjxl output allocation failed";
          if (source && shorts) {
            JxlBitDepth depth = {JXL_BIT_DEPTH_FROM_CODESTREAM, 0, 0};
            if (JxlDecoderSetImageOutBitDepth(dec, &depth) != JXL_DEC_SUCCESS) error = "libjxl source bit depth request failed";
          }
        }
      } else if (status == JXL_DEC_FULL_IMAGE) {
        if (complete++) error = "libjxl returned more than one frame";
      } else if (status == JXL_DEC_SUCCESS) {
        if (complete != 1 || !pixels) error = "libjxl did not return a complete image";
        break;
      } else { error = "libjxl refused the returned codestream"; }
    }
    if (error) reply(1, info.xsize, info.ysize, error, strlen(error));
    else if (metadata) {
      char json[1024];
      const int count = snprintf(json, sizeof(json),
        "{\"bitDepth\":%u,\"exponentBits\":%u,\"alphaBitDepth\":%u,\"alphaExponentBits\":%u,\"alphaPremultiplied\":%s,\"colorSpace\":%u,\"primaries\":%u,\"transferFunction\":%u,\"whitePoint\":%u,\"intensityTarget\":%.9g,\"usesOriginalProfile\":%s}",
        info.bits_per_sample, info.exponent_bits_per_sample, info.alpha_bits, info.alpha_exponent_bits,
        info.alpha_premultiplied ? "true" : "false", (unsigned)original.color_space, (unsigned)original.primaries,
        (unsigned)original.transfer_function, (unsigned)original.white_point, info.intensity_target, info.uses_original_profile ? "true" : "false");
      if (count < 0 || (size_t)count >= sizeof(json)) return 4;
      write_u32(0); write_u32(info.xsize); write_u32(info.ysize); write_u32((uint32_t)(4 + count + size));
      write_u32((uint32_t)count); fwrite(json, 1, (size_t)count, stdout); fwrite(pixels, 1, size, stdout); fflush(stdout);
    } else reply(0, info.xsize, info.ysize, pixels, size);
    free(pixels); free(input);
  }
  JxlDecoderDestroy(dec); return ferror(stdin) || ferror(stdout) ? 4 : 0;
}
