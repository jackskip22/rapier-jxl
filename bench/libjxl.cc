// SPDX-License-Identifier: MIT
// Persistent lossless RGBA8 benchmark. Input I/O and decoding are outside encode timing.
#include <jxl/encode.h>
#include <jxl/decode.h>
#include <jxl/color_encoding.h>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <vector>

using Bytes = std::vector<uint8_t>;
using Encoder = std::unique_ptr<JxlEncoder, decltype(&JxlEncoderDestroy)>;
using Decoder = std::unique_ptr<JxlDecoder, decltype(&JxlDecoderDestroy)>;
static void check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
static Bytes encode(const Bytes& rgba, uint32_t width, uint32_t height, int effort) {
  Encoder encoder(JxlEncoderCreate(nullptr), JxlEncoderDestroy);
  check(encoder != nullptr, "encoder allocation");
  check(JxlEncoderSetParallelRunner(encoder.get(), nullptr, nullptr) == JXL_ENC_SUCCESS, "single-thread runner");
  JxlBasicInfo info; JxlEncoderInitBasicInfo(&info);
  info.xsize = width; info.ysize = height; info.bits_per_sample = 8;
  info.num_color_channels = 3; info.num_extra_channels = 1; info.alpha_bits = 8;
  info.alpha_premultiplied = JXL_FALSE; info.uses_original_profile = JXL_TRUE;
  check(JxlEncoderSetBasicInfo(encoder.get(), &info) == JXL_ENC_SUCCESS, "basic info");
  JxlColorEncoding colour; JxlColorEncodingSetToSRGB(&colour, JXL_FALSE);
  check(JxlEncoderSetColorEncoding(encoder.get(), &colour) == JXL_ENC_SUCCESS, "sRGB profile");
  auto* frame = JxlEncoderFrameSettingsCreate(encoder.get(), nullptr);
  check(frame != nullptr, "frame settings");
  check(JxlEncoderSetFrameLossless(frame, JXL_TRUE) == JXL_ENC_SUCCESS, "lossless mode");
  check(JxlEncoderSetFrameDistance(frame, 0) == JXL_ENC_SUCCESS, "zero distance");
  check(JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_EFFORT, effort) == JXL_ENC_SUCCESS, "effort");
  check(JxlEncoderFrameSettingsSetOption(frame, JXL_ENC_FRAME_SETTING_KEEP_INVISIBLE, 1) == JXL_ENC_SUCCESS, "hidden RGB preservation");
  const JxlPixelFormat format = {4, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
  check(JxlEncoderAddImageFrame(frame, &format, rgba.data(), rgba.size()) == JXL_ENC_SUCCESS, "image frame");
  JxlEncoderCloseInput(encoder.get());
  Bytes bytes(4096); size_t used = 0;
  for (;;) {
    uint8_t* next = bytes.data() + used; size_t available = bytes.size() - used;
    const auto status = JxlEncoderProcessOutput(encoder.get(), &next, &available);
    used = bytes.size() - available;
    if (status == JXL_ENC_SUCCESS) break;
    check(status == JXL_ENC_NEED_MORE_OUTPUT, "encode output");
    bytes.resize(bytes.size() * 2);
  }
  bytes.resize(used); return bytes;
}
static void verify(const Bytes& bytes, const Bytes& rgba, uint32_t width, uint32_t height) {
  Decoder decoder(JxlDecoderCreate(nullptr), JxlDecoderDestroy);
  check(decoder != nullptr, "decoder allocation");
  check(JxlDecoderSetParallelRunner(decoder.get(), nullptr, nullptr) == JXL_DEC_SUCCESS, "decoder runner");
  check(JxlDecoderSetUnpremultiplyAlpha(decoder.get(), JXL_FALSE) == JXL_DEC_SUCCESS, "straight alpha");
  check(JxlDecoderSubscribeEvents(decoder.get(), JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE) == JXL_DEC_SUCCESS, "decoder events");
  check(JxlDecoderSetInput(decoder.get(), bytes.data(), bytes.size()) == JXL_DEC_SUCCESS, "decoder input");
  JxlDecoderCloseInput(decoder.get());
  const JxlPixelFormat format = {4, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
  Bytes decoded; int complete = 0;
  for (;;) {
    const auto status = JxlDecoderProcessInput(decoder.get());
    if (status == JXL_DEC_BASIC_INFO) {
      JxlBasicInfo info;
      check(JxlDecoderGetBasicInfo(decoder.get(), &info) == JXL_DEC_SUCCESS, "decoded info");
      check(info.xsize == width && info.ysize == height && !info.have_animation && info.uses_original_profile && !info.alpha_premultiplied, "decoded metadata");
    } else if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t size = 0;
      check(decoded.empty() && JxlDecoderImageOutBufferSize(decoder.get(), &format, &size) == JXL_DEC_SUCCESS && size == rgba.size(), "decoded size");
      decoded.resize(size);
      check(JxlDecoderSetImageOutBuffer(decoder.get(), &format, decoded.data(), decoded.size()) == JXL_DEC_SUCCESS, "decoded buffer");
    } else if (status == JXL_DEC_FULL_IMAGE) { ++complete; }
    else if (status == JXL_DEC_SUCCESS) break;
    else throw std::runtime_error("decoder refused output");
  }
  check(complete == 1 && decoded == rgba, "decoded RGBA differs, including invisible colours");
}
int main(int argc, char** argv) {
  std::ios::sync_with_stdio(false);
  std::cout << "{\"encoderVersion\":" << JxlEncoderVersion() << ",\"decoderVersion\":" << JxlDecoderVersion()
            << ",\"workerThreads\":0,\"callingThreads\":1,\"lossless\":true,\"keepInvisible\":true,\"format\":\"sRGB RGBA8 straight alpha\"}\n" << std::flush;
  if (argc == 2 && std::strcmp(argv[1], "--version") == 0) return 0;
  if (argc != 1) return 2;
  uint32_t width, height; int effort, warmups, repeats; size_t length;
  // A request is six decimal fields and newline, followed by exactly length RGBA bytes.
  while (std::cin >> width >> height >> effort >> warmups >> repeats >> length) {
    try {
      check(std::cin.get() == '\n' && width && height && width <= 16384 && height <= 16384 && uint64_t(width) * height <= 24000000 && length == uint64_t(width) * height * 4 && effort >= 1 && effort <= 9 && warmups >= 0 && repeats > 0, "request");
      Bytes rgba(length); std::cin.read(reinterpret_cast<char*>(rgba.data()), length); check(size_t(std::cin.gcount()) == length, "input bytes");
      for (int i = 0; i < warmups; ++i) { const auto bytes = encode(rgba, width, height, effort); verify(bytes, rgba, width, height); }
      Bytes output; std::vector<double> times;
      for (int i = 0; i < repeats; ++i) {
        const auto start = std::chrono::steady_clock::now(); auto bytes = encode(rgba, width, height, effort);
        const auto finish = std::chrono::steady_clock::now();
        times.push_back(std::chrono::duration<double, std::milli>(finish - start).count());
        verify(bytes, rgba, width, height);
        check(output.empty() || output == bytes, "repeat output differs"); output = std::move(bytes);
      }
      auto sorted = times; std::sort(sorted.begin(), sorted.end());
      const auto middle = sorted.size() / 2; const double median = sorted.size() % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      std::cout << std::setprecision(12) << "{\"ok\":true,\"bytes\":" << output.size() << ",\"rgbaExact\":true,\"deterministic\":true,\"warmups\":" << warmups << ",\"timesMs\":[";
      for (size_t i = 0; i < times.size(); ++i) std::cout << (i ? "," : "") << times[i];
      std::cout << "],\"medianMs\":" << median << "}\n";
      std::cout.write(reinterpret_cast<const char*>(output.data()), output.size()); std::cout.flush();
    } catch (const std::exception& error) { std::cerr << "libjxl benchmark: " << error.what() << '\n'; return 1; }
  }
  return std::cin.eof() ? 0 : 1;
}
